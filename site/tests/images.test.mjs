import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIMITS,
  checkDimensions,
  classifyCandidate,
  createHttp,
  emptyCache,
  extractHtmlImages,
  extractMarkdownImages,
  fingerprint,
  imageProps,
  normalizeImageUrl,
  parseProjectUrl,
  readImageInfo,
  treeCandidates,
  updateCache,
  usableImages,
} from '../src/lib/image-discovery.mjs';
import { makePng, startFixtureServer } from './support/fixture-server.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = (name, url = `https://github.com/fixture/${name}`) => ({ id: `presto_${name}`, title: name, url });
const catalogOf = (...projects) => ({ projects });
const FAST = { retryDelayMs: 1, timeoutMs: 5000, allowPrivateHosts: true };

// ---------------------------------------------------------------------------------------------------------------
// URL handling

test('GitHub image URLs are normalised to raw files and made https', () => {
  const n = (value) => normalizeImageUrl(value).url;
  assert.equal(n('https://github.com/o/r/blob/main/docs/a.png?raw=true'), 'https://raw.githubusercontent.com/o/r/main/docs/a.png');
  assert.equal(n('https://github.com/o/r/raw/refs/heads/main/a.png'), 'https://raw.githubusercontent.com/o/r/refs/heads/main/a.png');
  assert.equal(n('https://raw.github.com/o/r/main/a.png'), 'https://raw.githubusercontent.com/o/r/main/a.png');
  assert.equal(n('http://example.org/a.png#frag'), 'https://example.org/a.png');
  assert.equal(n('//example.org/a.png'), 'https://example.org/a.png');
  assert.equal(n('https://github.com/user-attachments/assets/abc'), 'https://github.com/user-attachments/assets/abc');
  assert.equal(n('https://raw.githubusercontent.com/o/r/main/a.png?token=xyz'), 'https://raw.githubusercontent.com/o/r/main/a.png');
});

test('unsafe or unusable image URLs are refused', () => {
  for (const value of ['data:image/png;base64,AAAA', 'javascript:alert(1)', 'ftp://example.org/a.png', 'https://user:pw@example.org/a.png', 'http://127.0.0.1/a.png', 'http://localhost:8080/a.png', 'http://169.254.169.254/latest', 'https://192.168.1.2/a.png', 'https://intranet/a.png', 'not a url']) {
    assert.ok(normalizeImageUrl(value).reason, `${value} must be refused`);
  }
  assert.match(normalizeImageUrl('https://private-user-images.githubusercontent.com/1/a.png?jwt=eyJ').reason, /expiring/);
});

test('project URLs are classified for discovery', () => {
  assert.deepEqual(parseProjectUrl('https://github.com/o/r'), { type: 'github', owner: 'o', repo: 'r', branch: null, directory: '' });
  assert.equal(parseProjectUrl('https://github.com/o/r.git').repo, 'r');
  assert.deepEqual(parseProjectUrl('https://github.com/o/r/tree/dev/examples/x'), { type: 'github', owner: 'o', repo: 'r', branch: 'dev', directory: 'examples/x' });
  assert.equal(parseProjectUrl('https://github.com/o/r/blob/main/a.py').type, 'unsupported');
  assert.equal(parseProjectUrl('https://github.com/o/r/releases').type, 'unsupported');
  assert.equal(parseProjectUrl('https://github.com/o').type, 'unsupported');
  assert.equal(parseProjectUrl('https://example.org/page').type, 'web');
  assert.equal(parseProjectUrl('https://gist.github.com/o/abc').type, 'web');
});

// ---------------------------------------------------------------------------------------------------------------
// Extraction and rules

test('README images are found in Markdown, reference, HTML and link form, and code is ignored', () => {
  const markdown = [
    '![One](docs/one.png "title")',
    '<img src="two.jpg" alt="Two" width="300">',
    '![Three][ref]',
    '[a photo](images/photo.jpg)',
    '```',
    '![ignored](ignored.png)',
    '```',
    '<!-- ![hidden](hidden.png) -->',
    '[ref]: https://example.org/three.png',
    '[![CI](https://img.shields.io/x.svg)](https://ci)',
  ].join('\n');
  const found = extractMarkdownImages(markdown);
  assert.deepEqual(found.map((image) => image.url).sort(), ['docs/one.png', 'two.jpg', 'https://example.org/three.png', 'images/photo.jpg', 'https://img.shields.io/x.svg'].sort());
  assert.ok(found.find((image) => image.url === 'images/photo.jpg').linkOnly);
  assert.ok(!found.some((image) => /ignored|hidden/.test(image.url)));
});

test('badges, logos, avatars, generated cards and generic product photos are rejected', () => {
  const rejected = [
    'https://img.shields.io/badge/license-MIT-green.svg',
    'https://github.com/o/r/actions/workflows/ci.yml/badge.svg',
    'https://raw.githubusercontent.com/o/r/main/logo.svg',
    'https://raw.githubusercontent.com/o/r/main/assets/icons/app.png',
    'https://avatars.githubusercontent.com/u/1?v=4',
    'https://github.com/someone.png',
    'https://opengraph.githubassets.com/abc/o/r',
    'https://cdn.shopify.com/s/files/1/0174/1800/files/presto-2.jpg',
    'https://shop.pimoroni.com/cdn/shop/files/presto-4.jpg',
    'https://raw.githubusercontent.com/o/r/main/docs/wiring-diagram.png',
    'https://raw.githubusercontent.com/o/r/main/placeholder.png',
    'https://example.org/uploads/twitter_card.jpg',
    'https://raw.githubusercontent.com/o/r/main/x.ico',
  ];
  for (const url of rejected) assert.ok(classifyCandidate({ url }).reject, `${url} must be rejected`);
  assert.ok(classifyCandidate({ url: 'https://raw.githubusercontent.com/o/r/main/a.png', alt: 'Project logo' }).reject);
  // Ordinary words in alt text are not enough to reject a good screenshot.
  assert.ok(!classifyCandidate({ url: 'https://raw.githubusercontent.com/o/r/main/screen.png', alt: 'Weather icons shown on the display' }).reject);
});

test('selection prefers a device photo, then a screenshot, then other images, deterministically', () => {
  const score = (url, extra = {}) => classifyCandidate({ url: `https://raw.githubusercontent.com/o/r/main/${url}`, ...extra }).score;
  assert.ok(score('IMG_1234.jpg') > score('screenshot.png'));
  assert.ok(score('device-home.jpg') > score('screenshot.png'));
  assert.ok(score('screenshot.png') > score('picture.png'));
  assert.ok(score('screenshots/presto.png') > score('screenshots/tufty.png'));
  assert.ok(score('a.png', { position: 0 }) > score('a.png', { position: 3 }));
  assert.ok(score('a.png') > score('a.png', { linkOnly: true }));
  assert.deepEqual(classifyCandidate({ url: 'https://raw.githubusercontent.com/o/r/main/screenshot.png' }), classifyCandidate({ url: 'https://raw.githubusercontent.com/o/r/main/screenshot.png' }));
  assert.equal(classifyCandidate({ url: 'https://img.youtube.com/vi/x/maxresdefault.jpg' }).score < score('a.png'), true);
  assert.ok(classifyCandidate({ url: 'https://example.org/a.jpg', origin: 'page' }).reject, 'unlabelled page images are not trusted');
  assert.ok(!classifyCandidate({ url: 'https://example.org/a.jpg', origin: 'og' }).reject);
});

test('Open Graph and page images are extracted and resolved against the page URL', () => {
  const html = `<html><head><meta property="og:image" content="/img/share.png"><meta name="twitter:image" content="https://cdn.example.org/t.png"></head>
    <body><main><img src="shot.png" alt="Screenshot"></main></body></html>`;
  const found = extractHtmlImages(html, 'https://example.org/blog/post');
  assert.deepEqual(found.map((i) => [i.origin, i.url]), [['og', 'https://example.org/img/share.png'], ['og', 'https://cdn.example.org/t.png'], ['page', 'https://example.org/blog/shot.png']]);
});

test('documentation-folder images need a clear photo or screenshot cue', () => {
  const entries = [
    { path: 'docs/screenshot.png', type: 'blob', size: 50000 },
    { path: 'docs/IMG_0001.jpg', type: 'blob', size: 50000 },
    { path: 'docs/architecture.png', type: 'blob', size: 50000 },
    { path: 'src/assets/demo.png', type: 'blob', size: 50000 },
    { path: 'logo.png', type: 'blob', size: 50000 },
    { path: 'big/demo.png', type: 'blob', size: 50000 },
    { path: 'screenshot-huge.png', type: 'blob', size: 99_000_000 },
    { path: 'tiny-demo.png', type: 'blob', size: 100 },
    { path: 'sub/dir/screenshot.png', type: 'blob', size: 50000 },
  ];
  assert.deepEqual(treeCandidates(entries).map((c) => c.path).sort(), ['docs/IMG_0001.jpg', 'docs/screenshot.png']);
  assert.deepEqual(treeCandidates(entries, 'sub/dir').map((c) => c.path), ['sub/dir/screenshot.png']);
});

test('image headers give dimensions without a dependency', () => {
  assert.deepEqual(readImageInfo(makePng(640, 400)), { type: 'image/png', width: 640, height: 400 });
  const gif = Buffer.from('GIF89a', 'latin1');
  assert.deepEqual(readImageInfo(Buffer.concat([gif, Buffer.from([0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0])])), { type: 'image/gif', width: 320, height: 240 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(readImageInfo(jpeg), { type: 'image/jpeg', width: 800, height: 600 });
  assert.deepEqual(readImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"></svg>')), { type: 'image/svg+xml', width: 480, height: 300 });
  assert.equal(readImageInfo(Buffer.from('<html>not an image</html>')), null);
  assert.ok(checkDimensions({ width: 16, height: 16 }));
  assert.ok(checkDimensions({ width: 1600, height: 200 }), 'banner-shaped');
  assert.ok(checkDimensions({ width: 200, height: 1200 }), 'long strip');
  assert.equal(checkDimensions({ width: 640, height: 400 }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Discovery, cache and failure behaviour against a local fixture "GitHub"

const readme = (body) => `# Project\n\n${body}\n`;
const fixtureRepos = () => ({
  'fixture/with-image': { files: { 'README.md': readme('![Presto running the demo](images/demo.png)'), 'images/demo.png': makePng(640, 400) } },
  'fixture/no-image': { files: { 'README.md': readme('Just text. ![badge](https://img.shields.io/badge/a-b-green.svg)') } },
  'fixture/broken-image': { files: { 'README.md': readme('![Screenshot](images/missing.png)\n![Screenshot](images/not-an-image.png)\n![Screenshot](images/tiny.png)'), 'images/not-an-image.png': Buffer.from('<html>oops</html>'), 'images/tiny.png': makePng(8, 8) }, contentTypes: { 'images/not-an-image.png': 'text/html' } },
  'fixture/docs-only': { files: { 'README.md': readme('No pictures here.'), 'docs/screenshot.png': makePng(300, 200, [0, 0, 0], { noise: true }) } },
  'fixture/relative': { files: { 'README.md': readme('![Presto photo](/assets/photo.png)\n![Escapes](../../../outside.png)'), 'assets/photo.png': makePng(500, 500) } },
});

async function withFixture(run, options = {}) {
  const fixture = await startFixtureServer(fixtureRepos(), options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
const discover = (fixture, projects, previous = emptyCache(), extra = {}) =>
  updateCache(catalogOf(...projects), previous, { endpoints: fixture.endpoints, allowPrivateHosts: true, httpOptions: FAST, ...extra });

test('A: a new README project gets its README image with no other source file involved', async () => {
  await withFixture(async (fixture) => {
    const added = project('with-image');
    const { cache } = await discover(fixture, [project('no-image'), added]);
    const entry = cache.entries[added.id];
    assert.equal(entry.status, 'found');
    assert.equal(entry.source, 'github-readme');
    assert.equal(entry.image.url, `${fixture.origin}/raw/fixture/with-image/HEAD/images/demo.png`);
    assert.deepEqual([entry.image.width, entry.image.height], [640, 400]);
    assert.equal(entry.image.alt, 'Presto running the demo');
    assert.equal(usableImages(cache, [added]).size, 1);
  });
});

test('B: a project with no suitable image is cached as "none" and keeps its icon', async () => {
  await withFixture(async (fixture) => {
    const bare = project('no-image');
    const { cache, stats } = await discover(fixture, [bare]);
    assert.equal(cache.entries[bare.id].status, 'none');
    assert.equal(stats.found, 0);
    assert.equal(imageProps(usableImages(cache, [bare]).get(bare.id), bare), null);
    assert.ok(cache.entries[bare.id].rejected.some((r) => /badge/.test(r.reason)));
  });
});

test('C: missing, non-image, tiny and path-escaping candidates are rejected with reasons', async () => {
  await withFixture(async (fixture) => {
    const broken = project('broken-image');
    const escaping = project('relative');
    const { cache } = await discover(fixture, [broken, escaping]);
    assert.equal(cache.entries[broken.id].status, 'none');
    const reasons = cache.entries[broken.id].rejected.map((r) => r.reason).join('\n');
    assert.match(reasons, /HTTP 404/);
    assert.match(reasons, /not an image/);
    assert.match(reasons, /too small/);
    // Root-relative paths resolve against the repository; "../" can never leave it.
    assert.equal(cache.entries[escaping.id].status, 'found');
    assert.ok(cache.entries[escaping.id].image.url.endsWith('/HEAD/assets/photo.png'));
    assert.ok(cache.entries[escaping.id].rejected.some((r) => /leaves the repository/.test(r.reason)));
  });
});

test('images in documentation folders are used when the README has none', async () => {
  await withFixture(async (fixture) => {
    const docs = project('docs-only');
    const { cache } = await discover(fixture, [docs]);
    assert.equal(cache.entries[docs.id].source, 'github-docs');
  });
});

test('E: a second run uses the cache and makes no requests; changed URLs and expired entries are looked up again', async () => {
  await withFixture(async (fixture) => {
    const a = project('with-image');
    const b = project('no-image');
    const first = await discover(fixture, [a, b]);
    const afterFirst = fixture.requests.length;
    assert.ok(afterFirst > 0);

    const second = await discover(fixture, [a, b], first.cache);
    assert.equal(fixture.requests.length, afterFirst, 'no network requests on a warm cache');
    assert.equal(second.stats.cached, 2);
    assert.equal(second.stats.requests, 0);

    // The source URL changed (new fingerprint): that project alone is looked up again.
    const moved = { ...a, url: 'https://github.com/fixture/relative' };
    await discover(fixture, [moved, b], first.cache);
    assert.ok(fixture.requests.some((p) => p.includes('/relative/')));
    assert.ok(fixture.requests.length > afterFirst);

    // Past its time to live an entry is looked up again.
    const later = Date.now() + (LIMITS.foundTtlDays + 1) * 24 * 3600 * 1000;
    const before = fixture.requests.length;
    await discover(fixture, [a], first.cache, { now: later });
    assert.ok(fixture.requests.length > before);
  });
});

test('removed projects leave no entry and can never be shown', async () => {
  await withFixture(async (fixture) => {
    const a = project('with-image');
    const b = project('docs-only');
    const first = await discover(fixture, [a, b]);
    assert.equal(Object.keys(first.cache.entries).length, 2);
    const second = await discover(fixture, [b], first.cache);
    assert.deepEqual(Object.keys(second.cache.entries), [b.id]);
    // Even a stale cache that still holds the removed project's entry cannot reach the page.
    assert.equal(usableImages(first.cache, [b]).has(a.id), false);
  });
});

test('F: with the network down the build keeps cached results and never throws', async () => {
  await withFixture(async (fixture) => {
    const a = project('with-image');
    const b = project('docs-only');
    const first = await discover(fixture, [a]);
    const failing = createHttp({ ...FAST, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, retries: 0 });
    const later = Date.now() + 30 * 24 * 3600 * 1000;
    const result = await updateCache(catalogOf(a, b), first.cache, { http: failing, endpoints: fixture.endpoints, now: later });
    assert.equal(result.cache.entries[a.id].image.url, first.cache.entries[a.id].image.url, 'stale result kept');
    assert.equal(result.cache.entries[b.id], undefined, 'no result and no negative cache entry');
    assert.equal(result.stats.networkUnavailable, true);
    assert.equal(result.stats.unavailable, 1);
    assert.equal(usableImages(result.cache, [a, b]).size, 1);
  });
});

test('F: offline mode uses the cache only and makes no requests', async () => {
  await withFixture(async (fixture) => {
    const a = project('with-image');
    const first = await discover(fixture, [a]);
    const before = fixture.requests.length;
    const result = await discover(fixture, [a, project('docs-only')], first.cache, { offline: true, now: Date.now() + 365 * 24 * 3600 * 1000 });
    assert.equal(fixture.requests.length, before);
    assert.equal(result.stats.found, 1);
  });
});

test('F: an exhausted GitHub API limit never fails the build, never caches "none", and still finds README images', async () => {
  await withFixture(async (fixture) => {
    const readmeProject = project('with-image');
    const needsApi = project('docs-only');
    const { cache, stats } = await discover(fixture, [readmeProject, needsApi]);
    assert.equal(cache.entries[readmeProject.id].status, 'found');
    assert.equal(cache.entries[needsApi.id], undefined, 'incomplete lookups are retried at the next build');
    assert.equal(stats.rateLimited, true);
  }, { rateLimitApi: true });
});

test('F: the optional token is sent to the API origin only', async () => {
  await withFixture(async (fixture) => {
    const http = createHttp({ ...FAST, githubToken: 'secret-token', githubApiOrigin: new URL(fixture.endpoints.githubApi).origin });
    await updateCache(catalogOf(project('docs-only'), project('with-image')), emptyCache(), { http, endpoints: fixture.endpoints, allowPrivateHosts: true });
    assert.ok(fixture.authHeaders.length > 0);
    assert.ok(fixture.authHeaders.every((header) => header.startsWith('api:')), `token leaked: ${fixture.authHeaders.join(', ')}`);
  });
});

test('an unexpected exception is a bug and is not swallowed (the build must stop)', async () => {
  await withFixture(async (fixture) => {
    const http = createHttp({ ...FAST });
    http.get = async () => { throw new Error('boom'); };
    await assert.rejects(
      updateCache(catalogOf(project('with-image')), emptyCache(), { http, endpoints: fixture.endpoints, allowPrivateHosts: true, concurrency: 1 }),
      /boom/,
    );
  });
});

test('an image shared by several projects is a site-level image and is dropped', () => {
  const projects = ['a', 'b', 'c', 'd'].map((n) => project(n));
  const entry = (url) => ({ status: 'found', image: { url, width: 600, height: 400 } });
  const cache = emptyCache();
  for (const [index, p] of projects.entries()) {
    cache.entries[p.id] = { fingerprint: fingerprint(p), checked_at: new Date().toISOString(), ...entry(index < 3 ? 'https://example.org/logo-card.png' : 'https://example.org/own.png') };
  }
  assert.deepEqual([...usableImages(cache, projects).keys()], [projects[3].id]);
});

test('cache files from another schema or discovery version, or damaged, are ignored', async () => {
  const { sanitizeCache } = await import('../src/lib/image-discovery.mjs');
  assert.deepEqual(sanitizeCache(null).entries, {});
  assert.deepEqual(sanitizeCache({ schema_version: 99, entries: { x: {} } }).entries, {});
  assert.deepEqual(sanitizeCache({ schema_version: 1, discovery_version: 0, entries: { x: {} } }).entries, {});
  assert.deepEqual(sanitizeCache({ schema_version: 1, discovery_version: 1, entries: [] }).entries, {});
});

test('cached images are only rendered when they are safe https URLs with real dimensions', () => {
  const p = project('x');
  const entry = (image) => ({ status: 'found', source: 'github-readme', image });
  const good = { url: 'https://raw.githubusercontent.com/o/r/HEAD/a.png', width: 600, height: 400, alt: 'A screenshot of the app', kind: 'screenshot' };
  assert.equal(imageProps(entry(good), p).src, good.url);
  assert.equal(imageProps(entry({ ...good, alt: '' }), p).alt, 'Preview of x');
  for (const bad of [{ url: 'http://example.org/a.png' }, { url: 'javascript:alert(1)' }, { url: 'data:image/png;base64,AA' }, { url: 'https://u:p@example.org/a.png' }, { width: 0 }, { height: 1.5 }, { url: 7 }]) {
    assert.equal(imageProps(entry({ ...good, ...bad }), p), null, JSON.stringify(bad));
  }
  assert.equal(imageProps(entry({ ...good, url: 'http://127.0.0.1:9/a.png' }), p, { allowLoopbackHttp: true }).src, 'http://127.0.0.1:9/a.png');
  assert.equal(imageProps(entry({ ...good, url: 'http://127.0.0.1:9/a.png' }), p), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Architecture: README stays the only thing a contributor edits

test('the manual image workflow is gone and nothing maintained by hand maps projects to images', async () => {
  const gone = ['src/data/project-images.json', 'public/project-images', 'scripts/add-project-image.mjs', 'scripts/check-project-images.mjs', 'src/pages/image-credits.astro', 'src/lib/project-images.mjs'];
  for (const file of gone) await assert.rejects(stat(path.join(site, file)), `${file} must not exist`);
  const pkg = JSON.parse(await readFile(path.join(site, 'package.json'), 'utf8'));
  assert.ok(!Object.keys(pkg.scripts).some((name) => /images:add|images:check/.test(name)));
  assert.match(pkg.scripts.build, /discover-images\.mjs/);
  const gitignore = await readFile(path.join(site, '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^\/site\/\.cache\/$/m, 'the generated cache must be ignored');
  const dataFiles = await readdir(path.join(site, 'src', 'data'));
  assert.deepEqual(dataFiles.filter((name) => name !== 'catalog.json' && !name.startsWith('.')), []);
});

test('the built page renders only well-formed remote card images with graceful degradation hooks', async () => {
  const html = await readFile(path.join(process.env.PRESTO_OUT_DIR ?? path.join(site, 'dist'), 'index.html'), 'utf8');
  const images = html.match(/<img[^>]*class="card-image"[^>]*>/g) ?? [];
  for (const tag of images) {
    assert.match(tag, /src="https:\/\/[^"]+"/);
    assert.match(tag, /loading="lazy"/);
    assert.match(tag, /decoding="async"/);
    assert.match(tag, /referrerpolicy="no-referrer"/);
    assert.match(tag, /width="\d+"/);
    assert.match(tag, /height="\d+"/);
    assert.match(tag, /alt="[^"]+"/);
  }
  // Every card keeps its category icon beneath the image, with or without an image.
  const previews = html.match(/<div class="card-preview"[^>]*>\s*<svg/g) ?? [];
  assert.equal(previews.length, (html.match(/class="project-card"/g) ?? []).length);
  assert.ok(!html.includes('image-credits'));
});
