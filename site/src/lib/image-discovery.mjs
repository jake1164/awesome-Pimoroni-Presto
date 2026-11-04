// Automatic project-image discovery.
//
// The README catalog is the only project inventory. For each project this module looks at the project's own URL
// and picks, by deterministic rules, one image that the author already publishes: a README image for GitHub
// repositories, otherwise an Open Graph / page image. Nothing is downloaded into the repository; the page uses
// the original image URL. Failure or "no suitable image" always means "show the category icon".
//
// A project's README entry may carry one optional directive (parsed by tools/readme_catalog.py and exposed as
// `project.image`): `{ mode: 'hint', value: 'screenshots/' }` prefers a file or directory in the project's own
// repository, `{ mode: 'url', value: 'https://...' }` prefers one image URL, `{ mode: 'none' }` forces the icon.
// Hints and URLs are tried first; if they give no usable image, normal discovery continues.
//
// The rules are heuristics. They prefer a photo of the device running the project, then a screenshot, then any
// other project-specific image, and they reject badges, logos, avatars, banners, diagrams and generic product
// photos. They cannot prove that an image is the right one; see site/README.md "Project images".

import { createHash } from 'node:crypto';
import { BlockedDestinationError, InvalidResponseError, pinnedGet, resolveHost, vetDestination } from './safe-network.mjs';

export const DISCOVERY_VERSION = 3; // raise whenever rules, cache identity or cache format change
export const CACHE_SCHEMA_VERSION = 1;

export const DEFAULT_ENDPOINTS = {
  githubRaw: 'https://raw.githubusercontent.com',
  githubApi: 'https://api.github.com',
  githubWeb: 'https://github.com',
};

export const LIMITS = {
  maxImageBytes: 4 * 1024 * 1024, // heavier images are rejected: they are loaded straight from the author's host
  maxTextBytes: 1024 * 1024, // README / HTML read limit
  probeBytes: 256 * 1024, // enough of an image to read its dimensions
  minWidth: 240,
  minHeight: 120,
  maxAspect: 3.5, // wider than this is a banner
  minAspect: 1 / 3, // taller than this is a long strip
  validationsPerProject: 5,
  genericImageProjects: 3, // an image shared by this many projects is a site-level image, not a project image
  foundTtlDays: 7,
  noneTtlDays: 3,
};

const DAY = 24 * 60 * 60 * 1000;
const USER_AGENT = 'awesome-presto-gallery-build (+https://github.com/jake1164/awesome-Pimoroni-Presto)';
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.MD'];
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)$/i;

// ---------------------------------------------------------------------------------------------------------------
// URLs

const BLOCKED_HOSTS = [
  'img.shields.io', 'shields.io', 'badgen.net', 'badge.fury.io', 'travis-ci.org', 'travis-ci.com', 'codecov.io',
  'coveralls.io', 'codacy.com', 'sonarcloud.io', 'visitor-badge.laobi.icu', 'hits.seeyoufarm.com', 'komarev.com',
  'star-history.com', 'api.star-history.com', 'contrib.rocks', 'buymeacoffee.com', 'img.buymeacoffee.com',
  'ko-fi.com', 'storage.ko-fi.com', 'liberapay.com', 'opencollective.com', 'paypalobjects.com', 'awesome.re',
  'avatars.githubusercontent.com', 'gravatar.com', 'secure.gravatar.com', 'opengraph.githubassets.com',
  'camo.githubusercontent.com', // proxies other hosts' images; the original URL is what we want
  'githubassets.com', 'github.githubassets.com',
  'cdn.discordapp.com', 'discord.com', 'discordapp.com', // chat-service branding, not a project
];
const VIDEO_THUMBNAIL_HOSTS = ['img.youtube.com', 'i.ytimg.com', 'i.vimeocdn.com']; // acceptable, but only as a last resort
const GENERIC_PRODUCT_HOSTS = ['shop.pimoroni.com', 'cdn.shopify.com'];
const REJECT_TOKENS = new Set([
  'logo', 'logos', 'favicon', 'badge', 'badges', 'shield', 'avatar', 'sponsor', 'sponsors', 'donate', 'donation',
  'icon', 'icons', 'placeholder', 'spacer', 'blank', 'emoji', 'qr', 'qrcode', 'pixel', 'tracking', 'diagram',
  'architecture', 'flowchart', 'wiring', 'schematic', 'pinout', 'circuit', 'license', 'licence', 'twitter', 'opengraph',
]);
// Alt text is prose, so only the unambiguous words count there ("weather icons shown on the display" is fine).
const ALT_REJECT_TOKENS = new Set(['logo', 'badge', 'avatar', 'sponsor', 'donate', 'placeholder']);

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return host.includes(':') || !host.includes('.'); // IPv6 literals and single-label names
}

/**
 * Normalizes a discovered image URL: absolute https only, no credentials or fragment, GitHub blob/raw page links
 * turned into raw file URLs. Returns `{ url }` or `{ reason }`.
 */
export function normalizeImageUrl(value, { allowPrivateHosts = false, allowSigned = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value.startsWith('//') ? `https:${value}` : value);
  } catch {
    return { reason: 'not an absolute URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { reason: `unsupported protocol ${parsed.protocol}` };
  if (parsed.username || parsed.password) return { reason: 'URL contains credentials' };
  if (!allowPrivateHosts && isPrivateHost(parsed.hostname)) return { reason: 'private or local host' };
  if (parsed.protocol === 'http:' && !(allowPrivateHosts && isPrivateHost(parsed.hostname))) parsed.protocol = 'https:'; // mixed content would be blocked
  parsed.hash = '';

  const host = parsed.hostname.toLowerCase();
  if (host === 'raw.github.com') parsed.hostname = 'raw.githubusercontent.com';
  if (host === 'github.com' || host === 'www.github.com') {
    // github.com/o/r/blob/<ref>/<path> and /raw/<ref>/<path> are web pages or redirects; the raw host is the file.
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (match) {
      parsed.hostname = 'raw.githubusercontent.com';
      parsed.pathname = `/${match[1]}/${match[2]}/${match[3]}`;
      parsed.search = '';
    }
  }
  if (parsed.hostname === 'raw.githubusercontent.com') parsed.search = ''; // ?raw=true and cache busters
  if (!allowSigned && /(^|[?&])(jwt|X-Amz-Signature|token)=/i.test(parsed.search)) return { reason: 'expiring signed URL' };
  return { url: parsed.href };
}

/** Classifies a project URL for discovery. */
export function parseProjectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { type: 'web', url: null };
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return { type: 'web', url };
  let segments;
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { type: 'unsupported', reason: 'malformed percent-encoding in the project URL' };
  }
  if (segments.length < 2) return { type: 'unsupported', reason: 'GitHub profile or organization page' };
  const [owner, rawRepo, kind, branch, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (segments.length === 2) return { type: 'github', owner, repo, branch: null, directory: '' };
  if (kind === 'tree' && branch) {
    // The first path segment after "tree" is taken as the branch; branch names containing "/" are not supported.
    return { type: 'github', owner, repo, branch, directory: rest.join('/') };
  }
  if (kind === 'blob') return { type: 'unsupported', reason: 'link to a single file, not a project page' };
  return { type: 'unsupported', reason: `GitHub ${kind ?? 'page'} link, not a project page` };
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

// ---------------------------------------------------------------------------------------------------------------
// Candidate extraction

function stripCode(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[`~]*[ \t]*$/gm, ' ');
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => characterReference(Number(code)));
}

// HTML turns a reference to NUL, a surrogate or a code point beyond U+10FFFF into U+FFFD; String.fromCodePoint would throw.
function characterReference(code) {
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
}

/** Image references in README Markdown (inline, reference-style and HTML `<img>`), in document order. */
export function extractMarkdownImages(markdown) {
  const text = stripCode(markdown);
  const found = [];
  const definitions = new Map();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm)) definitions.set(match[1].toLowerCase(), match[2]);

  for (const match of text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
    found.push({ index: match.index, url: match[2], alt: match[1], linked: text[match.index - 1] === '[' });
  }
  for (const match of text.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const url = definitions.get((match[2] || match[1]).toLowerCase());
    if (url) found.push({ index: match.index, url, alt: match[1], linked: text[match.index - 1] === '[' });
  }
  // Plain links to image files ("[photo](docs/photo.png)"): READMEs often link to pictures instead of embedding them.
  for (const match of text.matchAll(/(?<!!)\[(?!!)([^\]]*)\]\(\s*<?([^)\s>]+\.(?:png|jpe?g|gif|webp|svg))(?:\?[^)\s>]*)?>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi)) {
    found.push({ index: match.index, url: match[2], alt: match[1], linked: false, linkOnly: true });
  }
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const url = htmlAttribute(match[0], 'src');
    if (url) found.push({ index: match.index, url, alt: htmlAttribute(match[0], 'alt') ?? '', width: Number(htmlAttribute(match[0], 'width')) || null, linked: false });
  }
  return found.sort((a, b) => a.index - b.index);
}

function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (htmlAttribute(tag, 'property') ?? htmlAttribute(tag, 'name') ?? '').toLowerCase();
    if (name === key) return htmlAttribute(tag, 'content');
  }
  return null;
}

/** Open Graph / page images of an HTML document, most specific first. URLs are resolved against `baseUrl`. */
export function extractHtmlImages(html, baseUrl) {
  const found = [];
  const add = (value, extra) => {
    if (!value) return;
    try {
      found.push({ url: new URL(value.trim(), baseUrl).href, ...extra });
    } catch { /* ignore unresolvable values */ }
  };
  const alt = metaContent(html, 'og:image:alt') ?? metaContent(html, 'twitter:image:alt') ?? '';
  for (const key of ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
    add(metaContent(html, key), { alt, origin: 'og' });
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if ((htmlAttribute(tag, 'rel') ?? '').toLowerCase() === 'image_src') add(htmlAttribute(tag, 'href'), { alt, origin: 'og' });
  }
  const scope = html.match(/<(main|article)\b[\s\S]*<\/\1>/i)?.[0] ?? html;
  let count = 0;
  for (const match of scope.matchAll(/<img\b[^>]*>/gi)) {
    if (count++ >= 12) break;
    add(htmlAttribute(match[0], 'src') ?? htmlAttribute(match[0], 'data-src'), { alt: htmlAttribute(match[0], 'alt') ?? '', origin: 'page' });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

function tokens(text) {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fileStem(urlOrPath) {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath).pathname;
  } catch { /* already a relative path */ }
  let name = path.split('/').pop() ?? '';
  try {
    name = decodeURIComponent(name);
  } catch { /* keep the raw name */ }
  return name.replace(/\.[a-z0-9]+$/i, '');
}

const PHOTO_WORDS = new Set(['photo', 'photos', 'photograph', 'device', 'running']);
const SCREEN_WORDS = new Set(['screenshot', 'screenshots', 'screen', 'ui', 'demo', 'preview', 'shot', 'display', 'dashboard', 'animation', 'anim']);
const CAMERA_NAME = /^(img|dsc|dscn|pxl|image|photo)[_-]?\d+|^\d{8}[_-]\d{6}|^\d{4}-\d{2}-\d{2}[_-]/i;

/**
 * Decides whether a candidate may be considered and ranks it. Returns `{ reject }` or `{ score, kind }`.
 * Tiers: 1 photo of the device (90), 2 screenshot or animation (60), 3 other project-specific image (10-40).
 * A "presto" mention in the name or alt text adds 12, and appearing earlier in the README adds up to 10.
 * `position` is the order of appearance; earlier images win ties, and the URL breaks any remaining tie.
 */
export function classifyCandidate({ url, alt = '', origin = 'readme', position = 0, linked = false, linkOnly = false }) {
  if (url.includes('\uFFFD') || /%EF%BF%BD/i.test(url)) return { reject: 'malformed character reference in the image URL' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { reject: 'invalid URL' };
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
    return { reject: host === 'avatars.githubusercontent.com' || host.includes('gravatar') ? 'avatar' : host.includes('opengraph.githubassets') ? 'generated GitHub social card' : 'badge or tracking image' };
  }
  if (GENERIC_PRODUCT_HOSTS.some((blocked) => host === blocked)) return { reject: 'generic Pimoroni product photo' };
  if (/\/(badge|badges|shield|shields)(\/|\.|$)/i.test(parsed.pathname) || /\/workflows\/[^/]+\/badge/i.test(parsed.pathname)) return { reject: 'badge' };
  if (/^\/[^/]+\.(png|jpg|jpeg)$/i.test(parsed.pathname) && host === 'github.com') return { reject: 'avatar' };
  if (/\.(ico|bmp|tiff?)$/i.test(parsed.pathname)) return { reject: 'unsupported image type' };
  if (/\/(avatar|avatars)\//i.test(parsed.pathname) && !host.endsWith('githubusercontent.com')) return { reject: 'avatar' };

  const stem = fileStem(url);
  const nameTokens = tokens(stem);
  const altTokens = tokens(alt);
  const folderTokens = tokens(parsed.pathname.split('/').slice(-2, -1)[0] ?? ''); // last folder only: repository names are not evidence
  const hit = [...nameTokens, ...folderTokens].find((token) => REJECT_TOKENS.has(token)) ?? altTokens.find((token) => ALT_REJECT_TOKENS.has(token));
  if (hit) return { reject: `looks like a ${hit === 'qr' || hit === 'qrcode' ? 'QR code' : hit} image` };
  if (nameTokens.includes('default') || /\/default[-_]?(og|share|social|preview)/i.test(parsed.pathname)) return { reject: 'looks like a default image' };
  if (linked && /badge|status|build|license/i.test(alt)) return { reject: 'badge' };

  // Evidence for what the image shows: its file name, its alt text and the folder it sits in ("screenshots/").
  const all = new Set([...nameTokens, ...altTokens, ...folderTokens]);
  let kind;
  let score;
  if (VIDEO_THUMBNAIL_HOSTS.includes(host)) {
    kind = 'image';
    score = 10;
  } else if (CAMERA_NAME.test(stem) || [...all].some((token) => PHOTO_WORDS.has(token))) {
    kind = 'device-photo';
    score = 90;
  } else if ([...all].some((token) => SCREEN_WORDS.has(token)) || /\.gif$/i.test(parsed.pathname)) {
    kind = 'screenshot';
    score = 60;
  } else {
    kind = 'image';
    score = origin === 'og' ? 40 : 25;
  }
  if (all.has('presto')) score += 12;
  if (linkOnly) score -= 5; // linked from the text rather than shown in the README
  // An unlabelled picture somewhere in an article body proves nothing about the project; only a share image
  // (og:image), which the page picked as its own representation, may lack a photo/screenshot cue.
  if (origin === 'page' && kind === 'image') return { reject: 'page image with no sign of being a photo or screenshot' };
  return { kind, score: score - Math.min(position, 10) };
}

/** Candidate checks that need the image's real size. Returns a rejection reason or null. */
export function checkDimensions({ width, height }) {
  if (!width || !height) return 'dimensions unknown';
  if (width < LIMITS.minWidth || height < LIMITS.minHeight) return `too small (${width}x${height})`;
  if (width / height > LIMITS.maxAspect) return `banner-shaped (${width}x${height})`;
  if (width / height < LIMITS.minAspect) return `too tall (${width}x${height})`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Image header parsing (no dependencies)

/** Returns `{ type, width, height }` from the first bytes of a PNG, JPEG, GIF, WebP or SVG file, else null. */
export function readImageInfo(bytes) {
  const b = bytes;
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { type: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const format = b.toString('latin1', 12, 16);
    if (format === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (format === 'VP8 ') return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (format === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) { offset += 1; continue; }
      const marker = b[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      if (marker >= 0xd0 && marker <= 0xd9) { offset += 2; continue; }
      const length = b.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'image/jpeg', height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { type: 'image/jpeg', width: null, height: null };
  }
  const head = b.toString('utf8', 0, Math.min(b.length, 4096));
  const svg = head.match(/<svg\b[^>]*>/i);
  if (svg) {
    const size = (name) => {
      const value = htmlAttribute(svg[0], name);
      return value && /^\s*[\d.]+(px)?\s*$/.test(value) ? Math.round(parseFloat(value)) : null;
    };
    let width = size('width');
    let height = size('height');
    const box = (htmlAttribute(svg[0], 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if ((!width || !height) && box.length === 4 && box.every(Number.isFinite)) [width, height] = [Math.round(box[2]), Math.round(box[3])];
    return { type: 'image/svg+xml', width, height };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP: timeouts, retries, manual redirects, rate-limit and offline awareness. Never throws for a failed request;
// returns `{ ok, status, transient, ... }` so that one bad project cannot fail the build.

/** A failure of the build itself (bad catalog, bad configuration, unwritable output, a bug), as opposed to a recoverable lookup failure. */
export class PipelineError extends Error {}

/** Rejects when `signal` aborts first; used so a slow DNS answer counts against the request timeout. */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject);
    return undefined;
  });
}

/**
 * Every request of the build goes through `get`, and every attempt (each retry and each redirect hop) first passes
 * `vetDestination` (see safe-network.mjs): http(s) only, no credentials, and every address of the host must be public.
 * The default transport then connects only to the validated addresses.
 *
 * Options that exist for tests only:
 *   - `allowPrivateHosts`: also accepts loopback addresses (the local fixture servers). Other private, link-local,
 *     multicast and reserved ranges stay refused. Production and ordinary local builds never set it.
 *   - `fetchImpl`: replaces the transport with a fetch-like function to simulate network failures. It is not pinned and
 *     host names are not resolved, so it must never be used outside tests; IP literals and URL rules still apply.
 *   - `transport(url, { headers, signal, addresses })` and `resolve(hostname)`: stand-ins for the pinned connection and
 *     the DNS lookup, used to test the policy without real DNS. They run after / instead of the matching default step.
 */
export function createHttp({
  fetchImpl = null,
  transport = null,
  resolve = null,
  tlsOptions = {},
  timeoutMs = 15_000,
  retries = 2,
  retryDelayMs = 400,
  githubToken = '',
  githubApiOrigin = new URL(DEFAULT_ENDPOINTS.githubApi).origin,
  apiReserve = 5,
  offlineAfter = 4,
  deadline = Infinity,
  maxRedirects = 5,
  maxRequests = 2_000,
  allowPrivateHosts = false,
  log = () => {},
} = {}) {
  const state = { requests: 0, apiRequests: 0, blocked: 0, consecutiveNetworkFailures: 0, offline: false, apiExhausted: false, limitedHosts: new Set(), refused: new Set() };
  const resolver = resolve ?? (fetchImpl ? null : resolveHost);
  const send = transport
    ?? (fetchImpl
      ? (url, init) => fetchImpl(url.href, { headers: init.headers, redirect: 'manual', signal: init.signal })
      : (url, init) => pinnedGet(url, { ...init, tlsOptions }));

  /** GET with manual redirects. A result carries the final response URL (`url`), which relative links must resolve against. */
  async function get(url, { accept = '*/*', maxBytes = LIMITS.maxTextBytes, stopAfter = Infinity } = {}) {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const result = await attempt(current, { accept, maxBytes, stopAfter });
      if (!result.redirect) return { ...result, url: current };
      let next;
      try {
        next = new URL(result.redirect, current);
      } catch {
        return { ok: false, status: 0, transient: false, url: current, reason: `malformed redirect Location ${JSON.stringify(result.redirect.slice(0, 120))}` };
      }
      next.hash = '';
      current = next.href; // checked like any other request when the next attempt starts
    }
    return { ok: false, status: 0, transient: false, url: current, reason: 'too many redirects' };
  }

  async function attempt(url, { accept, maxBytes, stopAfter }) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { ok: false, status: 0, transient: false, reason: 'invalid URL' };
    }
    const { host, origin } = parsedUrl;
    const isApi = origin === githubApiOrigin;
    for (let tries = 0; ; tries += 1) {
      if (state.offline) return { ok: false, status: 0, transient: true, reason: 'network unavailable' };
      if (Date.now() > deadline) return { ok: false, status: 0, transient: true, reason: 'build time budget used' };
      if (state.requests >= maxRequests) return { ok: false, status: 0, transient: true, reason: 'request limit reached' };
      if (state.limitedHosts.has(host)) return { ok: false, status: 429, transient: true, reason: `rate-limited by ${host}` };
      if (isApi && state.apiExhausted) return { ok: false, status: 403, transient: true, reason: 'GitHub API budget used' };
      const headers = { 'user-agent': USER_AGENT, accept };
      if (isApi) {
        headers['x-github-api-version'] = '2022-11-28';
        if (githubToken) headers.authorization = `Bearer ${githubToken}`; // sent to the API origin only
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const addresses = await abortable(vetDestination(parsedUrl, { allowLoopback: allowPrivateHosts, resolve: resolver }), controller.signal);
        state.requests += 1;
        if (isApi) state.apiRequests += 1;
        const response = await send(parsedUrl, { headers, signal: controller.signal, addresses });
        state.consecutiveNetworkFailures = 0;
        if (isApi) {
          const remaining = Number(response.headers.get('x-ratelimit-remaining'));
          if (Number.isFinite(remaining) && response.headers.has('x-ratelimit-remaining') && remaining <= apiReserve) state.apiExhausted = true;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          return location ? { redirect: location } : { ok: false, status: response.status, transient: false, reason: 'redirect without location' };
        }
        const limited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
        if (limited) {
          await response.body?.cancel();
          const wait = Number(response.headers.get('retry-after'));
          if (Number.isFinite(wait) && wait > 0 && wait <= 5 && tries < retries) {
            await sleep(wait * 1000);
            continue;
          }
          state.limitedHosts.add(host);
          if (isApi) state.apiExhausted = true;
          log(`rate limited by ${host}`);
          return { ok: false, status: response.status, transient: true, reason: `rate-limited by ${host}` };
        }
        if (response.status >= 500) {
          await response.body?.cancel();
          if (tries < retries) { await sleep(retryDelayMs * 2 ** tries); continue; }
          return { ok: false, status: response.status, transient: true, reason: `HTTP ${response.status}` };
        }
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel();
          return { ok: false, status: response.status, transient: false, reason: `HTTP ${response.status}` };
        }
        const declared = Number(response.headers.get('content-length'));
        const declaredLength = response.headers.has('content-length') && Number.isFinite(declared) ? declared : null;
        // With a declared length, the start of the file is enough; without one the whole file must fit the limit.
        const { body, truncated } = await readBody(response, declaredLength === null ? maxBytes : Math.min(stopAfter, maxBytes));
        return { ok: true, status: response.status, headers: response.headers, body, truncated, declaredLength };
      } catch (error) {
        if (error instanceof BlockedDestinationError) {
          // Refused before any connection was made. Not a network failure and not worth retrying.
          state.blocked += 1;
          if (!state.refused.has(url)) {
            state.refused.add(url);
            log(`request refused, ${error.message}: ${url}`);
          }
          return { ok: false, status: 0, transient: false, blocked: true, reason: `destination not allowed (${error.message})` };
        }
        if (error instanceof InvalidResponseError) {
          // A server answered, so the network is up; the answer was not valid HTTP. Like a server error it is transient
          // (an earlier result is kept), but retrying the same server would not help and it says nothing about other hosts.
          state.consecutiveNetworkFailures = 0;
          log(`${host} sent an invalid HTTP response (${error.message}): ${url}`);
          return { ok: false, status: 0, transient: true, reason: `invalid HTTP response (${error.message})` };
        }
        state.consecutiveNetworkFailures += 1;
        if (state.consecutiveNetworkFailures >= offlineAfter) {
          state.offline = true;
          log('network appears to be unavailable; skipping remaining lookups');
        }
        if (tries < retries && !state.offline) { await sleep(retryDelayMs * 2 ** tries); continue; }
        return { ok: false, status: 0, transient: true, reason: error?.name === 'AbortError' ? 'timeout' : `network error (${error?.cause?.code ?? error?.code ?? error?.message ?? 'unknown'})` };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return { get, state };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(response, limit) {
  if (!response.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > limit) { truncated = true; break; }
  }
  await reader.cancel().catch(() => {});
  return { body: Buffer.concat(chunks).subarray(0, limit), truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// README directives and catalog validation

const HINT_SEGMENT = /^[\p{L}\p{N}_.+@()-]+(?: [\p{L}\p{N}_.+@()-]+)*$/u;

/** Why a hint path is unsafe or ambiguous, or null if it is acceptable. Mirrors tools/readme_catalog.py. */
export function hintProblem(value) {
  if (typeof value !== 'string' || !value) return 'empty hint';
  if (value.length > 200) return 'hint too long';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith('//')) return 'a hint is a path, not a URL';
  if (value.startsWith('/')) return 'a hint must be relative';
  const isDirectory = value.endsWith('/');
  const segments = (isDirectory ? value.slice(0, -1) : value).split('/');
  if (segments.length > 6) return 'hint too deep';
  for (const segment of segments) {
    if (['', '.', '..'].includes(segment)) return 'unsafe path segment';
    if (!HINT_SEGMENT.test(segment)) return 'unsupported character in hint';
  }
  if (!isDirectory && !IMAGE_EXTENSIONS.test(segments.at(-1))) return 'ambiguous hint (no trailing "/" and not an image file name)';
  return null;
}

/**
 * Checks the generated catalog's shape before anything is done with it. A catalog that fails this is a broken
 * pipeline (not a recoverable lookup problem), so the caller must stop with an error.
 */
export function validateCatalog(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new PipelineError('catalog is not a JSON object');
  if (catalog.schema_version !== 1) problems.push(`unsupported catalog schema_version ${JSON.stringify(catalog.schema_version)} (expected 1)`);
  if (!Array.isArray(catalog.projects) || catalog.projects.length === 0) problems.push('"projects" must be a non-empty array');
  const seen = new Set();
  (Array.isArray(catalog.projects) ? catalog.projects : []).forEach((project, index) => {
    const where = `projects[${index}]`;
    if (!project || typeof project !== 'object') { problems.push(`${where} is not an object`); return; }
    if (typeof project.id !== 'string' || !/^presto_[0-9a-f]{64}$/.test(project.id)) problems.push(`${where}.id is not a project ID`);
    else if (seen.has(project.id)) problems.push(`${where}.id duplicates an earlier project`);
    else seen.add(project.id);
    if (typeof project.title !== 'string' || !project.title) problems.push(`${where}.title must be text`);
    if (typeof project.url !== 'string' || !/^https?:\/\//.test(project.url)) problems.push(`${where}.url must be an http(s) URL`);
    if (project.image !== undefined) {
      const { mode, value } = project.image ?? {};
      if (!['none', 'hint', 'url'].includes(mode)) problems.push(`${where}.image.mode must be none, hint or url`);
      else if (mode === 'none' && value !== undefined) problems.push(`${where}.image has a value but mode none`);
      else if (mode === 'hint' && hintProblem(value)) problems.push(`${where}.image hint: ${hintProblem(value)}`);
      else if (mode === 'url' && !(typeof value === 'string' && /^https:\/\//.test(value))) problems.push(`${where}.image URL must be an https URL`);
    }
  });
  if (problems.length > 0) {
    throw new PipelineError(`invalid catalog: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}`);
  }
  return catalog;
}

const directiveOf = (project) => (project.image && ['none', 'hint', 'url'].includes(project.image.mode) ? project.image : null);

/** Tries the README's explicit `image: URL`. Returns `{ image }` or `{ reason, transient }`. */
async function tryExplicitUrl(directive, ctx) {
  let parsed;
  try {
    parsed = new URL(directive.value);
  } catch {
    return { reason: 'not an absolute URL' };
  }
  const local = ctx.allowPrivateHosts && isPrivateHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) return { reason: 'only https URLs are accepted' };
  const normalized = normalizeImageUrl(directive.value, { allowPrivateHosts: ctx.allowPrivateHosts });
  if (!normalized.url) return { reason: normalized.reason };
  const outcome = await validateImage(ctx.http, { url: normalized.url });
  return outcome.image ? { image: { ...outcome.image, alt: '', kind: 'image' } } : { reason: outcome.reason, transient: outcome.transient };
}

/**
 * Tries the README's `image-hint`, relative to the repository or to the linked directory. A file hint is fetched
 * directly. A directory hint lists that one directory through the GitHub API (no recursion) and checks at most a
 * handful of its image files, ranked by the normal rules.
 */
async function tryHint(directive, target, ctx) {
  const problem = hintProblem(directive.value);
  if (problem) return { reason: problem };
  const { owner, repo, directory } = target;
  const branch = target.branch ?? 'HEAD';
  const rawRoot = `${ctx.endpoints.githubRaw.replace(/\/$/, '')}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`;
  const base = directory ? `${directory}/` : '';
  const hint = directive.value;
  if (!hint.endsWith('/')) {
    const outcome = await validateImage(ctx.http, { url: `${rawRoot}/${encodePath(base + hint)}` });
    return outcome.image ? { image: { ...outcome.image, alt: fileStem(hint).replace(/[-_]+/g, ' '), kind: 'image' } } : { reason: outcome.reason, transient: outcome.transient };
  }
  const folder = `${base}${hint}`.replace(/\/$/, '');
  const query = target.branch ? `?ref=${encodeURIComponent(target.branch)}` : '';
  const listing = await ctx.http.get(`${ctx.endpoints.githubApi.replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(folder)}${query}`, { accept: 'application/vnd.github+json' });
  if (!listing.ok) return { reason: listing.status === 404 ? 'directory not found' : `directory listing unavailable (${listing.reason})`, transient: listing.transient };
  let entries = [];
  try {
    entries = JSON.parse(listing.body.toString('utf8'));
  } catch { /* handled below */ }
  if (!Array.isArray(entries)) return { reason: 'the hint is not a directory' };
  const candidates = entries
    .filter((entry) => entry && entry.type === 'file' && typeof entry.name === 'string' && typeof entry.path === 'string' && IMAGE_EXTENSIONS.test(entry.name) && (!entry.size || (entry.size <= LIMITS.maxImageBytes && entry.size >= 1024)))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .slice(0, 50)
    .map((entry, position) => ({ url: `${rawRoot}/${encodePath(entry.path)}`, alt: fileStem(entry.name).replace(/[-_]+/g, ' '), position, origin: 'hint' }));
  const rejected = [];
  const flags = { transient: false };
  const image = await pickFirstValid(ctx.http, candidates, rejected, flags);
  if (image) return { image };
  return { reason: candidates.length === 0 ? 'no image files in that directory' : `no usable image in that directory (${rejected[0]?.reason ?? 'none passed the checks'})`, transient: flags.transient };
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery

/** Fetches `candidate.url` and checks that it really is a usable, reasonably sized image. */
export async function validateImage(http, candidate) {
  const result = await http.get(candidate.url, { accept: 'image/*', maxBytes: LIMITS.maxImageBytes, stopAfter: LIMITS.probeBytes });
  if (!result.ok) return { transient: result.transient, reason: result.reason ?? `HTTP ${result.status}` };
  const type = (result.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return { reason: `not an image (${type || 'no content type'})` };
  if (result.declaredLength && result.declaredLength > LIMITS.maxImageBytes) return { reason: `too large (${Math.round(result.declaredLength / 1024)} KiB)` };
  if (!result.declaredLength && result.truncated) return { reason: 'too large' };
  const info = readImageInfo(result.body);
  if (!info) return { reason: 'unsupported or corrupt image data' };
  const problem = checkDimensions(info);
  if (problem) return { reason: problem };
  return { image: { url: candidate.url, width: info.width, height: info.height, bytes: result.declaredLength ?? null, type: info.type } };
}

const cleanAlt = (alt) => alt.replace(/\s+/g, ' ').replace(/[\[\]<>]/g, '').trim().slice(0, 160);

async function pickFirstValid(http, candidates, rejected, flags) {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, ...classifyCandidate(candidate) }))
    .filter((candidate) => {
      if (candidate.reject) {
        if (rejected.length < 8) rejected.push({ url: candidate.url, reason: candidate.reject });
        return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score || a.position - b.position || (a.url < b.url ? -1 : 1));
  const seen = new Set();
  let checked = 0;
  for (const candidate of ranked) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    if (checked++ >= LIMITS.validationsPerProject) break;
    const outcome = await validateImage(http, candidate);
    if (outcome.image) {
      return { ...outcome.image, alt: cleanAlt(candidate.alt ?? ''), kind: candidate.kind };
    }
    if (outcome.transient) flags.transient = true;
    if (rejected.length < 8) rejected.push({ url: candidate.url, reason: outcome.reason });
  }
  return null;
}

async function fetchText(http, url, accept) {
  const result = await http.get(url, { accept, maxBytes: LIMITS.maxTextBytes });
  // `url` is where the answer really came from (after redirects); relative links in it resolve against that.
  return result.ok ? { text: result.body.toString('utf8'), contentType: result.headers.get('content-type') ?? '', url: result.url } : { failed: result };
}

function readmeCandidates(images, { base, owner, repo, branch, endpoints, allowPrivateHosts }) {
  const out = [];
  const rawRoot = `${endpoints.githubRaw.replace(/\/$/, '')}/${owner}/${repo}/${branch}`;
  images.forEach((image, position) => {
    let absolute;
    const ref = image.url.trim();
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) absolute = ref;
    else if (ref.startsWith('/')) absolute = `${rawRoot}${ref}`;
    else {
      try {
        absolute = new URL(ref, base).href;
      } catch {
        out.push({ url: ref, position, reject: 'invalid URL' });
        return;
      }
      if (!absolute.startsWith(`${rawRoot}/`)) {
        out.push({ url: ref, position, reject: 'relative path leaves the repository' });
        return;
      }
    }
    const normalized = normalizeImageUrl(absolute, { allowPrivateHosts });
    if (!normalized.url) out.push({ url: ref, position, reject: normalized.reason });
    else out.push({ url: normalized.url, alt: image.alt, position, linked: image.linked, linkOnly: Boolean(image.linkOnly), origin: 'readme' });
  });
  return out;
}

async function discoverGithub(project, target, ctx, rejected, flags) {
  const { http, endpoints } = ctx;
  const { owner, repo, directory } = target;
  const branch = target.branch ?? 'HEAD';
  const rawRoot = `${endpoints.githubRaw.replace(/\/$/, '')}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`;
  const prefix = directory ? `${encodePath(directory)}/` : '';

  // 1. Images embedded in the README (of the repository, or of the linked directory).
  let readmeSeen = false;
  for (const name of README_NAMES) {
    const result = await fetchText(http, `${rawRoot}/${prefix}${name}`, 'text/plain');
    if (result.failed) {
      if (result.failed.transient) { flags.transient = true; break; }
      continue;
    }
    readmeSeen = true;
    const images = extractMarkdownImages(result.text);
    if (images.length === 0 && rejected.length < 8) rejected.push({ url: `${rawRoot}/${prefix}${name}`, reason: 'README has no images' });
    const candidates = readmeCandidates(images, { base: `${rawRoot}/${prefix}${name}`, owner, repo, branch, endpoints, allowPrivateHosts: ctx.allowPrivateHosts });
    for (const candidate of candidates.filter((c) => c.reject)) if (rejected.length < 8) rejected.push({ url: candidate.url, reason: candidate.reject });
    const image = await pickFirstValid(http, candidates.filter((c) => !c.reject), rejected, flags);
    if (image) return { source: 'github-readme', image };
    break;
  }
  if (!readmeSeen && !flags.transient && rejected.length < 8) rejected.push({ url: `${rawRoot}/${prefix}README.md`, reason: 'no README found' });

  // 2. Image files in documentation folders (needs the GitHub API; skipped quietly when its budget is used up).
  if (!ctx.skipApi) {
    const tree = await http.get(`${endpoints.githubApi.replace(/\/$/, '')}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { accept: 'application/vnd.github+json' });
    if (tree.ok) {
      let entries = [];
      try {
        const parsed = JSON.parse(tree.body.toString('utf8'));
        entries = Array.isArray(parsed?.tree) ? parsed.tree : [];
      } catch { /* an unreadable listing is no listing */ }
      const candidates = treeCandidates(entries, directory).map((candidate, position) => ({ ...candidate, url: `${rawRoot}/${encodePath(candidate.path)}`, position, origin: 'docs' }));
      const image = await pickFirstValid(http, candidates, rejected, flags);
      if (image) return { source: 'github-docs', image };
    } else if (tree.transient) {
      flags.incomplete = true; // API unavailable or rate-limited: try again at the next build instead of caching "none"
    } else if (tree.status !== 404 && rejected.length < 8) {
      rejected.push({ url: 'GitHub API tree', reason: tree.reason });
    }
  }

  // 3. A custom social-preview image chosen by the repository owner (generated cards are rejected by classifyCandidate).
  if (!directory) {
    const page = await fetchText(http, `${endpoints.githubWeb.replace(/\/$/, '')}/${owner}/${repo}`, 'text/html');
    if (page.failed) {
      if (page.failed.transient) flags.transient = true;
    } else {
      const social = extractHtmlImages(page.text, page.url)
        .filter((candidate) => candidate.origin === 'og')
        .map((candidate, position) => ({ ...candidate, position }))
        .filter((candidate) => {
          const host = new URL(candidate.url).hostname;
          if (host === 'repository-images.githubusercontent.com' || ctx.allowPrivateHosts) return true;
          if (rejected.length < 8) rejected.push({ url: candidate.url, reason: classifyCandidate(candidate).reject ?? 'generated GitHub social card' });
          return false;
        });
      const image = await pickFirstValid(http, social, rejected, flags);
      if (image) return { source: 'github-social', image };
    }
  }
  return null;
}

const DOC_DIRECTORIES = new Set(['docs', 'doc', 'images', 'image', 'img', 'screenshots', 'screenshot', 'media', 'assets', 'pics', 'photos', 'pictures', 'preview', 'previews']);
const STRONG_WORDS = new Set([...PHOTO_WORDS, ...SCREEN_WORDS, 'presto']);

/** Image files in the repository tree whose name clearly says "screenshot", "photo", "demo", "preview", ... */
export function treeCandidates(entries, directory = '') {
  const base = directory ? `${directory}/` : '';
  return entries
    .filter((entry) => entry && entry.type === 'blob' && typeof entry.path === 'string' && IMAGE_EXTENSIONS.test(entry.path) && entry.path.startsWith(base))
    .filter((entry) => !entry.size || (entry.size <= LIMITS.maxImageBytes && entry.size >= 4096))
    .map((entry) => ({ path: entry.path, relative: entry.path.slice(base.length) }))
    .filter(({ relative }) => {
      const parts = relative.split('/');
      if (parts.length > 3) return false;
      const folders = parts.slice(0, -1).map((part) => part.toLowerCase());
      if (folders.length > 0 && !folders.every((folder) => DOC_DIRECTORIES.has(folder))) return false;
      return [...tokens(fileStem(relative)), ...folders.flatMap(tokens)].some((token) => STRONG_WORDS.has(token)) || CAMERA_NAME.test(fileStem(relative));
    })
    .sort((a, b) => (a.relative < b.relative ? -1 : 1))
    .map((entry) => ({ path: entry.path, alt: fileStem(entry.relative).replace(/[-_]+/g, ' ') }));
}

// The share image of a site's front page is its logo or default card, not a picture of one project.
function siteDefaultImage(ctx, origin) {
  ctx.siteDefaults ??= new Map();
  if (!ctx.siteDefaults.has(origin)) {
    ctx.siteDefaults.set(origin, (async () => {
      const root = `${origin}/`;
      const page = await fetchText(ctx.http, root, 'text/html');
      if (page.failed) return null;
      const first = extractHtmlImages(page.text, page.url).find((candidate) => candidate.origin === 'og');
      return first ? new URL(first.url).pathname : null;
    })());
  }
  return ctx.siteDefaults.get(origin);
}

async function discoverWeb(project, target, ctx, rejected, flags) {
  const page = await fetchText(ctx.http, target.url.href, 'text/html,application/xhtml+xml');
  if (page.failed) {
    if (page.failed.transient) flags.transient = true;
    else if (rejected.length < 8) rejected.push({ url: target.url.href, reason: `page unavailable (${page.failed.reason})` });
    return null;
  }
  if (!/html/i.test(page.contentType)) {
    rejected.push({ url: target.url.href, reason: `not an HTML page (${page.contentType || 'unknown type'})` });
    return null;
  }
  const candidates = [];
  const pageUrl = new URL(page.url); // the page that answered, after any redirects: its relative image links resolve against this
  const all = extractHtmlImages(page.text, pageUrl.href);
  const isFrontPage = `${pageUrl.origin}/` === pageUrl.href;
  const defaultPath = isFrontPage ? all.find((candidate) => candidate.origin === 'og')?.url : await siteDefaultImage(ctx, pageUrl.origin);
  const defaultImage = defaultPath ? new URL(defaultPath, pageUrl.origin).pathname : null;
  all.forEach((candidate, position) => {
    const normalized = normalizeImageUrl(candidate.url, { allowPrivateHosts: ctx.allowPrivateHosts });
    if (!normalized.url) {
      if (rejected.length < 8) rejected.push({ url: candidate.url, reason: normalized.reason });
    } else if (candidate.origin === 'og' && defaultImage && new URL(normalized.url).pathname === defaultImage) {
      if (rejected.length < 8) rejected.push({ url: normalized.url, reason: "the site's default share image" });
    } else {
      candidates.push({ ...candidate, url: normalized.url, position });
    }
  });
  const image = await pickFirstValid(ctx.http, candidates, rejected, flags);
  return image ? { source: candidates.find((c) => c.url === image.url)?.origin === 'og' ? 'open-graph' : 'page-image', image } : null;
}

/**
 * Discovers the image for one catalog project and returns a cache entry body, or `{ status: 'error' }` when a
 * temporary failure left the question open.
 *
 * Every expected failure (404, 403, timeout, rate limit, no image, a bad hint or URL) comes back as data. Anything
 * this function throws is a programming error and must stop the build, so it is deliberately not caught here.
 */
export async function discoverProject(project, ctx) {
  const rejected = [];
  const flags = { transient: false, incomplete: false };
  const directive = directiveOf(project);
  const note = directive ? { mode: directive.mode, ...(directive.value ? { value: directive.value } : {}) } : null;

  if (directive?.mode === 'none') {
    // The README says: no image. No lookup, no remote request.
    return { status: 'none', source: null, image: null, rejected, directive: { ...note, outcome: 'used' } };
  }
  const target = parseProjectUrl(project.url);

  // Hint or explicit URL first. If it gives nothing usable, say so and carry on with normal discovery.
  let preferred = null;
  if (directive) {
    if (directive.mode === 'hint' && target.type !== 'github') {
      preferred = { reason: 'image-hint only works for GitHub repository projects' };
    } else if (directive.mode === 'hint' && target.type === 'github') {
      preferred = await tryHint(directive, target, ctx);
    } else if (directive.mode === 'url') {
      preferred = await tryExplicitUrl(directive, ctx);
    }
    if (preferred?.image) {
      return { status: 'found', source: directive.mode === 'url' ? 'readme-image' : 'readme-hint', image: preferred.image, rejected, directive: { ...note, outcome: 'used' } };
    }
    note.outcome = 'failed';
    note.reason = preferred?.reason ?? 'no usable image';
    note.transient = Boolean(preferred?.transient);
  }

  const finish = (found) => {
    const extra = note ? { directive: note } : {};
    if (found) return { status: 'found', source: found.source, image: found.image, rejected, ...extra, ...(note?.transient ? { partial: true } : {}) };
    if (flags.transient || flags.incomplete) return { status: 'error', rejected, ...extra };
    return { status: 'none', source: null, image: null, rejected, ...extra, ...(note?.transient ? { partial: true } : {}) };
  };
  if (target.type === 'unsupported') {
    rejected.push({ url: project.url, reason: target.reason });
    return finish(null);
  }
  if (target.type === 'github') return finish(await discoverGithub(project, target, ctx, rejected, flags));
  if (target.url) return finish(await discoverWeb(project, target, ctx, rejected, flags));
  rejected.push({ url: project.url, reason: 'invalid project URL' });
  return finish(null);
}

// ---------------------------------------------------------------------------------------------------------------
// Cache: generated, disposable, keyed by stable project ID. Not a source of truth.

/**
 * What a cached result was computed from: the discovery rules version, the project URL, and the README directive
 * (type and value). Change any of them and the old result is no longer used.
 */
export const fingerprint = (project) => {
  const directive = directiveOf(project);
  return createHash('sha256')
    .update(`${DISCOVERY_VERSION}\n${project.url}\n${directive ? `${directive.mode}\n${directive.value ?? ''}` : ''}`)
    .digest('hex')
    .slice(0, 16);
};

export function emptyCache() {
  return { schema_version: CACHE_SCHEMA_VERSION, discovery_version: DISCOVERY_VERSION, entries: {} };
}

/** Reads a parsed cache object defensively; anything unexpected becomes an empty cache. */
export function sanitizeCache(value) {
  if (!value || value.schema_version !== CACHE_SCHEMA_VERSION || value.discovery_version !== DISCOVERY_VERSION) return emptyCache();
  if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return emptyCache();
  return { ...emptyCache(), entries: { ...value.entries } };
}

export function isFresh(entry, project, now) {
  if (!entry || entry.fingerprint !== fingerprint(project)) return false;
  if (entry.partial) return false; // a hint or URL could not be checked (network, rate limit): try again next build
  const age = now - Date.parse(entry.checked_at);
  if (!Number.isFinite(age) || age < 0) return false;
  return age < (entry.status === 'found' ? LIMITS.foundTtlDays : LIMITS.noneTtlDays) * DAY;
}

/**
 * Brings the cache up to date for the current catalog and returns `{ cache, stats }`.
 * - Entries for projects no longer in the catalog are dropped.
 * - Entries whose project URL changed, or that outlived their time to live, are rediscovered.
 * - If rediscovery fails (offline, rate limit), a previous entry is kept; with none, the project has no entry and
 *   simply shows its category icon until a later build succeeds.
 */
export async function updateCache(catalog, previous, options = {}) {
  const now = options.now ?? Date.now();
  const refresh = Boolean(options.refresh);
  const concurrency = options.concurrency ?? 6;
  const cache = emptyCache();
  const stats = { projects: catalog.projects.length, forcedIcon: 0, cached: 0, discovered: 0, found: 0, none: 0, unavailable: 0, stale: 0, requests: 0, apiRequests: 0, networkUnavailable: false, rateLimited: false };
  const queue = [];
  for (const project of catalog.projects) {
    const entry = previous.entries[project.id];
    const sameSource = entry && entry.fingerprint === fingerprint(project);
    if (directiveOf(project)?.mode === 'none') {
      // `image: none` needs no lookup and wins over anything cached, offline or not.
      cache.entries[project.id] = { fingerprint: fingerprint(project), checked_at: new Date(now).toISOString(), status: 'none', source: null, image: null, rejected: [], directive: { mode: 'none', outcome: 'used' } };
      stats.forcedIcon += 1;
    } else if (options.offline === true) {
      // No network by request: use whatever is cached for the same project URL, however old.
      if (sameSource) { cache.entries[project.id] = entry; stats.stale += 1; }
    } else if (!refresh && isFresh(entry, project, now)) {
      cache.entries[project.id] = entry;
      stats.cached += 1;
    } else {
      queue.push(project);
    }
  }
  if (queue.length > 0) {
    const http = options.http ?? createHttp(options.httpOptions);
    const ctx = { http, endpoints: options.endpoints ?? DEFAULT_ENDPOINTS, allowPrivateHosts: Boolean(options.allowPrivateHosts), skipApi: false };
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const project = queue[next++];
        const result = await discoverProject(project, ctx);
        const old = previous.entries[project.id];
        // Malformed external data (a bad URL, redirect or character reference) is skipped, never fatal, but never silent.
        for (const item of result.rejected) if (/malformed/i.test(item.reason)) options.log?.(`"${project.title}": ${item.reason} <${item.url}>`);
        if (result.status === 'error') {
          options.log?.(`image lookup incomplete for "${project.title}": ${result.directive?.reason ?? result.rejected[0]?.reason ?? 'temporary failure'}`);
          if (old && old.fingerprint === fingerprint(project)) { cache.entries[project.id] = old; stats.stale += 1; }
          continue;
        }
        // A partial result (the README's hint or URL could not be checked right now) must not replace an earlier,
        // complete result for the same project and directive.
        if (result.partial && old && old.fingerprint === fingerprint(project) && old.status === 'found' && !old.partial) {
          cache.entries[project.id] = old;
          stats.stale += 1;
          continue;
        }
        cache.entries[project.id] = { fingerprint: fingerprint(project), checked_at: new Date(now).toISOString(), ...result };
        stats.discovered += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    stats.requests = http.state.requests;
    stats.blocked = http.state.blocked;
    stats.apiRequests = http.state.apiRequests;
    stats.networkUnavailable = http.state.offline;
    stats.rateLimited = http.state.limitedHosts.size > 0 || http.state.apiExhausted;
  }
  const usable = usableImages(cache, catalog.projects);
  stats.found = usable.size;
  stats.directiveProblems = catalog.projects.filter((project) => cache.entries[project.id]?.directive?.outcome === 'failed').length;
  stats.unavailable = catalog.projects.filter((project) => !cache.entries[project.id]).length;
  stats.none = catalog.projects.length - usable.size;
  return { cache, stats };
}

/**
 * Images the page may show: a Map of project ID to the cached image. Only projects in the current catalog count,
 * so a removed project can never leave a stale card. An image URL shared by several projects is a site-level
 * image (a logo or default preview), not a project image, and is dropped.
 */
export function usableImages(cache, projects) {
  const byUrl = new Map();
  const candidates = new Map();
  for (const project of projects) {
    const entry = cache?.entries?.[project.id];
    if (directiveOf(project)?.mode === 'none') continue;
    if (!entry || entry.fingerprint !== fingerprint(project) || entry.status !== 'found' || !entry.image) continue;
    candidates.set(project.id, entry);
    byUrl.set(entry.image.url, (byUrl.get(entry.image.url) ?? 0) + 1);
  }
  const usable = new Map();
  for (const [id, entry] of candidates) {
    if (byUrl.get(entry.image.url) >= LIMITS.genericImageProjects) continue;
    usable.set(id, entry);
  }
  return usable;
}

/** Image props for the card component, or null when the cached image is not safe to render. */
export function imageProps(entry, project, { allowLoopbackHttp = false } = {}) {
  const image = entry?.image;
  if (!image || typeof image.url !== 'string') return null;
  let url;
  try {
    url = new URL(image.url);
  } catch {
    return null;
  }
  const loopback = allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) return null;
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) return null;
  const alt = typeof image.alt === 'string' && image.alt.length >= 4 && /[a-z]{3}/i.test(image.alt) ? image.alt : `Preview of ${project.title}`;
  return { src: url.href, width: image.width, height: image.height, alt, kind: image.kind ?? 'image', source: entry.source };
}
