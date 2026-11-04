// GitHub star counts for project cards.
//
// The README catalog is the only project inventory. For every project whose link points at a GitHub repository
// (the repository itself, or a file or directory inside it) the build asks GitHub's REST API for
// `stargazers_count` and keeps the answer in a generated, disposable cache for 24 hours. Contributors never supply
// a count, the browser never talks to GitHub, and the counts never enter the generated catalog, so project IDs and
// the catalog stay exactly what the README says.
//
// "Unknown" is never "zero". A repository that cannot be looked up (rate limit, network, GitHub outage, malformed
// answer) keeps its previous cached count for a while; with none, the card simply shows no count. A repository
// that GitHub says does not exist (404) is remembered as missing and shows nothing.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ENDPOINTS, PipelineError, createHttp } from './image-discovery.mjs';

export const STARS_CACHE_SCHEMA_VERSION = 1;

export const STAR_LIMITS = {
  ttlHours: 24, // a looked-up count is trusted this long
  maxStaleDays: 30, // when refreshing keeps failing, an old count is shown for at most this long
  maxResponseBytes: 512 * 1024, // a repository answer is a few KiB
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GITHUB_WEB = 'https://github.com';

// ---------------------------------------------------------------------------------------------------------------
// URL classification

// First path segments that are GitHub features, not account names (github.com/orgs/<name>, github.com/topics/<name>...).
const RESERVED_OWNERS = new Set([
  'about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise',
  'events', 'explore', 'features', 'github', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications',
  'orgs', 'organizations', 'pricing', 'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'site', 'sponsors',
  'team', 'teams', 'topics', 'trending', 'users', 'watching',
]);
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Decides whether a project URL points into a GitHub repository.
 *
 * Accepted: `github.com/<owner>/<repo>`, links to a file or directory inside it (`.../blob/<ref>/<path>`,
 * `.../tree/<ref>/<path>`), and its releases (`.../releases`, `.../releases/tag/<tag>`, `.../releases/latest`).
 * Everything else is not a repository: profiles and organizations, gists (their own host), issues, pull requests,
 * wikis, other repository pages, GitHub feature pages, other hosts.
 *
 * Returns `{ repository: { owner, repo, key, url } }` or `{ reason }`. `key` is the lowercase `owner/repo`, the
 * identity used to share one API request between projects.
 */
export function classifyGithubUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { reason: 'not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { reason: 'not an http(s) URL' };
  const host = url.hostname.toLowerCase();
  if (host === 'gist.github.com') return { reason: 'GitHub Gist, not a repository' };
  if (host !== 'github.com' && host !== 'www.github.com') return { reason: 'not a github.com URL' };
  let segments;
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { reason: 'malformed path' };
  }
  if (segments.length < 2) return { reason: 'GitHub profile or organization page' };
  const [owner, rawRepo, kind, ref] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return { reason: `GitHub ${owner} page, not a repository` };
  if (!OWNER_NAME.test(owner) || !REPOSITORY_NAME.test(repo) || repo === '.' || repo === '..') return { reason: 'not a valid owner/repository name' };
  const inside = (kind === 'tree' || kind === 'blob') && ref; // a file or folder
  const release = kind === 'releases' && (segments.length === 3 || (ref === 'tag' && segments.length >= 5) || (ref === 'latest' && segments.length === 4)); // the releases page, or one release
  if (segments.length > 2 && !inside && !release) return { reason: `GitHub ${kind} page, not a project page` };
  return { repository: { owner, repo, key: `${owner}/${repo}`.toLowerCase(), url: `${GITHUB_WEB}/${owner}/${repo}` } };
}

/**
 * The distinct repositories behind a list of projects: a Map of repository key to
 * `{ owner, repo, key, url, projectIds }`, in catalog order. Several projects can share one repository (the
 * repository and a directory inside it, for example); each repository is looked up once. The spelling of the
 * first project that mentions a repository is the one used for the request.
 */
export function collectRepositories(projects) {
  const repositories = new Map();
  for (const project of projects) {
    const { repository } = classifyGithubUrl(project.url);
    if (!repository) continue;
    const known = repositories.get(repository.key);
    if (known) known.projectIds.push(project.id);
    else repositories.set(repository.key, { ...repository, projectIds: [project.id] });
  }
  return repositories;
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting

const isCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `1234` -> `1.2k`, `15200` -> `15.2k`, `1000000` -> `1M`. Truncates (never rounds up to a bigger unit): 999999 -> `999.9k`. */
export function formatStarCount(count) {
  if (!isCount(count)) throw new TypeError(`not a star count: ${count}`);
  const compact = (divisor, unit) => `${String(Math.floor(count / (divisor / 10)) / 10).replace(/\.0$/, '')}${unit}`;
  if (count >= 1_000_000) return compact(1_000_000, 'M');
  if (count >= 1_000) return compact(1_000, 'k');
  return String(count);
}

/** Accessible name for a card's star link. It contains the visible text, and the exact number when that is abbreviated. */
export function starLinkLabel(count, title) {
  const compact = formatStarCount(count);
  const exact = count.toLocaleString('en-US');
  const noun = count === 1 ? 'GitHub star' : 'GitHub stars';
  return `${compact === exact ? exact : `${compact} (${exact})`} ${noun} for ${title}. Opens the repository on GitHub.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Cache: generated, disposable, keyed by repository (`owner/repo`, lowercase), never by project ID.

export function emptyStarsCache() {
  return { schema_version: STARS_CACHE_SCHEMA_VERSION, entries: {} };
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || !Number.isFinite(Date.parse(entry.checked_at))) return null;
  if (entry.status === 'missing') return { checked_at: entry.checked_at, status: 'missing' };
  if (entry.status === 'ok' && isCount(entry.stars) && typeof entry.full_name === 'string' && classifyGithubUrl(`${GITHUB_WEB}/${entry.full_name}`).repository) {
    return { checked_at: entry.checked_at, status: 'ok', stars: entry.stars, full_name: entry.full_name };
  }
  return null;
}

/** Reads a parsed cache object defensively: anything unexpected is dropped, never trusted. */
export function sanitizeStarsCache(value) {
  if (!value || value.schema_version !== STARS_CACHE_SCHEMA_VERSION || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    return emptyStarsCache();
  }
  const cache = emptyStarsCache();
  for (const [key, entry] of Object.entries(value.entries)) {
    const clean = validEntry(entry);
    if (clean && /^[^/]+\/[^/]+$/.test(key) && key === key.toLowerCase()) cache.entries[key] = clean;
  }
  return cache;
}

const ageOf = (entry, now) => now - Date.parse(entry.checked_at);

/** Looked up within the last 24 hours (a timestamp in the future is not trusted). */
export function isFreshStars(entry, now) {
  const age = ageOf(entry, now);
  return age >= 0 && age < STAR_LIMITS.ttlHours * HOUR;
}

const isUsableOld = (entry, now) => entry?.status === 'ok' && ageOf(entry, now) >= 0 && ageOf(entry, now) < STAR_LIMITS.maxStaleDays * DAY;

/**
 * Reads the cache file. A missing, damaged or outdated file is an empty cache (`warn` hears about damage); a file
 * that cannot be read at all (a directory, no permission) is a pipeline failure, since it could not be replaced either.
 */
export async function readStarsCache(file, { warn = () => {} } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStarsCache();
    throw new PipelineError(`cannot read the star cache ${file} (${error.code ?? error.message}); delete it or fix its permissions`);
  }
  try {
    return sanitizeStarsCache(JSON.parse(text));
  } catch {
    warn(`the star cache ${file} is damaged; discarding it and looking star counts up again`);
    return emptyStarsCache();
  }
}

export async function writeStarsCache(file, cache) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new PipelineError(`cannot write the star cache ${file} (${error.code ?? error.message})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup

/**
 * Asks the GitHub REST API for one repository. Every expected failure comes back as data:
 *   { status: 'ok', stars, full_name }
 *   { status: 'missing' }                          GitHub says the repository does not exist (404, 410, 451)
 *   { status: 'error', reason, transient }         anything else; the caller keeps what it had
 * A 200 answer without a usable `stargazers_count` is an error, not zero stars.
 */
export async function fetchRepositoryStars(http, repository, endpoints = DEFAULT_ENDPOINTS) {
  const api = endpoints.githubApi.replace(/\/$/, '');
  const url = `${api}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const response = await http.get(url, { accept: 'application/vnd.github+json', maxBytes: STAR_LIMITS.maxResponseBytes });
  if (!response.ok) {
    if ([404, 410, 451].includes(response.status)) return { status: 'missing' };
    return { status: 'error', reason: response.reason ?? `HTTP ${response.status}`, transient: Boolean(response.transient) };
  }
  if (response.truncated) return { status: 'error', reason: 'response too large', transient: false };
  let data;
  try {
    data = JSON.parse(response.body.toString('utf8'));
  } catch {
    return { status: 'error', reason: 'response is not valid JSON', transient: false };
  }
  if (!data || typeof data !== 'object' || !isCount(data.stargazers_count)) {
    return { status: 'error', reason: 'response has no valid stargazers_count', transient: false };
  }
  // A renamed or transferred repository answers (after a redirect) with its current name, which is the link target.
  const named = typeof data.full_name === 'string' ? classifyGithubUrl(`${GITHUB_WEB}/${data.full_name}`).repository : null;
  const fullName = named ? `${named.owner}/${named.repo}` : `${repository.owner}/${repository.repo}`;
  return { status: 'ok', stars: data.stargazers_count, full_name: fullName };
}

/**
 * Brings the star cache up to date for the current catalog and returns `{ cache, stats }`.
 * - One request per distinct repository, however many projects point into it.
 * - A count looked up within 24 hours is reused. Older ones (and everything with `refresh`) are looked up again.
 * - A failed lookup never erases a valid cached count (at most 30 days old); with none, there is simply no entry.
 * - `missing` (404) replaces any earlier count: the repository is gone.
 * - Repositories no longer in the catalog are dropped. Output order is sorted, so the file is reproducible.
 * `offline` makes no request and keeps whatever usable counts are cached.
 */
export async function updateStars(catalog, previous, options = {}) {
  const now = options.now ?? Date.now();
  const repositories = collectRepositories(catalog.projects);
  const stats = {
    projects: catalog.projects.length,
    repositories: repositories.size,
    projectsWithRepository: [...repositories.values()].reduce((sum, repository) => sum + repository.projectIds.length, 0),
    cached: 0, fetched: 0, missing: 0, stale: 0, unavailable: 0, requests: 0, apiRequests: 0, networkUnavailable: false, rateLimited: false,
  };
  const entries = new Map();
  const queue = [];
  for (const [key, repository] of repositories) {
    const old = validEntry(previous?.entries?.[key]);
    if (options.offline === true) {
      if (isUsableOld(old, now)) { entries.set(key, old); stats.stale += 1; }
    } else if (!options.refresh && old && isFreshStars(old, now)) {
      entries.set(key, old);
      stats.cached += 1;
    } else {
      queue.push(repository);
    }
  }
  if (queue.length > 0) {
    const http = options.http ?? createHttp(options.httpOptions);
    const endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const repository = queue[next++];
        const result = await fetchRepositoryStars(http, repository, endpoints);
        const old = validEntry(previous?.entries?.[repository.key]);
        if (result.status === 'ok') {
          entries.set(repository.key, { checked_at: new Date(now).toISOString(), status: 'ok', stars: result.stars, full_name: result.full_name });
          stats.fetched += 1;
        } else if (result.status === 'missing') {
          entries.set(repository.key, { checked_at: new Date(now).toISOString(), status: 'missing' });
          stats.missing += 1;
          options.log?.(`${repository.owner}/${repository.repo} was not found on GitHub; no star count is shown for it`);
        } else {
          options.log?.(`could not read the star count of ${repository.owner}/${repository.repo}: ${result.reason}${isUsableOld(old, now) ? '; keeping the earlier count' : ''}`);
          if (isUsableOld(old, now)) { entries.set(repository.key, old); stats.stale += 1; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 6, queue.length) }, worker));
    stats.requests = http.state?.requests ?? 0;
    stats.apiRequests = http.state?.apiRequests ?? 0;
    stats.networkUnavailable = Boolean(http.state?.offline);
    stats.rateLimited = Boolean(http.state?.limitedHosts?.size > 0 || http.state?.apiExhausted);
  }
  const cache = emptyStarsCache();
  for (const key of [...entries.keys()].sort()) cache.entries[key] = entries.get(key);
  stats.withCount = [...repositories.keys()].filter((key) => cache.entries[key]?.status === 'ok').length;
  stats.unavailable = repositories.size - stats.withCount - [...repositories.keys()].filter((key) => cache.entries[key]?.status === 'missing').length;
  return { cache, stats };
}

/**
 * What a card may show for a project: `{ count, formatted, label, url, title }` or null. Null for every project
 * that is not a GitHub repository link, whose repository is missing, or whose count is unknown or malformed, or
 * whose count is older than the 30 day limit (the build rewrites the cache first, so this only guards a cache
 * that was not refreshed, for example `astro build` run on its own).
 */
export function starsFor(cache, project, { now = Date.now() } = {}) {
  const { repository } = classifyGithubUrl(project.url);
  const entry = repository ? validEntry(cache?.entries?.[repository.key]) : null;
  if (!entry || !isUsableOld(entry, now)) return null;
  return {
    count: entry.stars,
    formatted: formatStarCount(entry.stars),
    label: starLinkLabel(entry.stars, project.title),
    title: `${entry.stars.toLocaleString('en-US')} ${entry.stars === 1 ? 'star' : 'stars'} on GitHub`,
    url: `${GITHUB_WEB}/${entry.full_name}`,
  };
}
