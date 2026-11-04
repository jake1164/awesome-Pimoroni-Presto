import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createHttp,
  emptyCache,
  extractHtmlImages,
  extractMarkdownImages,
  parseProjectUrl,
  treeCandidates,
  updateCache,
  usableImages,
} from '../src/lib/image-discovery.mjs';
import { makePng, startFixtureServer } from './support/fixture-server.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = (name) => `presto_${createHash('sha256').update(name).digest('hex')}`;
const project = (name, url, image) => ({ id: id(name), title: name, url, ...(image ? { image } : {}) });
const FAST = { retryDelayMs: 1, timeoutMs: 5000, allowPrivateHosts: true };
const photo = makePng(640, 400, [0, 0, 0], { noise: true });

/** A small web server standing in for project sites. `pages` maps a path to `{ status, headers, body }`; `hits` records every path. */
async function webServer(pages) {
  const hits = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://web').pathname;
    hits.push(pathname);
    const page = pages[pathname];
    if (!page) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      return response.end('not found');
    }
    response.writeHead(page.status ?? 200, { 'content-type': page.type ?? 'text/html', ...page.headers });
    return response.end(page.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Finding 4: relative image URLs resolve against the page that answered, not the URL that was requested

test('relative images in a page reached through a redirect resolve against the final URL', async () => {
  const pages = {
    '/old': { status: 302, headers: { location: '/docs/project.html' } },
    '/docs/project.html': { body: '<html><head><meta property="og:image" content="shot.png"></head><body></body></html>' },
    '/docs/shot.png': { type: 'image/png', body: photo },
    '/old2': { status: 301, headers: { location: '/guide/index.html' } },
    '/guide/index.html': { body: '<html><body><main><img src="../media/photo.png" alt="Photo of the device running it"></main></body></html>' },
    '/media/photo.png': { type: 'image/png', body: photo },
    '/old3': { status: 302, headers: { location: 'http://10.0.0.1/shot.png' } },
  };
  const web = await webServer(pages);
  try {
    const projects = [project('og', `${web.origin}/old`), project('inline', `${web.origin}/old2`), project('unsafe', `${web.origin}/old3`)];
    const { cache } = await updateCache({ projects }, emptyCache(), { allowPrivateHosts: true, httpOptions: FAST });
    assert.equal(cache.entries[projects[0].id].image.url, `${web.origin}/docs/shot.png`);
    assert.equal(cache.entries[projects[1].id].image.url, `${web.origin}/media/photo.png`);
    assert.equal(cache.entries[projects[2].id].image, null, 'a redirect to a non-loopback private address is still refused');
    assert.ok(!web.hits.includes('/shot.png') && !web.hits.includes('/photo.png'), `no root-relative guess: ${web.hits.join(' ')}`);
  } finally {
    await web.close();
  }
});

test('the HTTP client reports the final response URL, including after several redirects', async () => {
  const web = await webServer({
    '/a': { status: 302, headers: { location: '/b/c' } },
    '/b/c': { status: 307, headers: { location: 'd?x=1#frag' } },
    '/b/d': { body: 'end' },
  });
  try {
    const result = await createHttp(FAST).get(`${web.origin}/a`);
    assert.equal(result.ok, true);
    assert.equal(result.url, `${web.origin}/b/d?x=1`);
  } finally {
    await web.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 3: malformed external data is unusable input, never a crash

test('character references beyond Unicode or in the surrogate range are replaced, not thrown on', () => {
  for (const reference of ['&#1114112;', '&#99999999999999999999;', '&#0;', '&#55357;', '&#4294967296;']) {
    const [image] = extractHtmlImages(`<meta property="og:image" content="/a${reference}.png">`, 'https://example.org/');
    assert.match(image.url, /^https:\/\/example\.org\/a%EF%BF%BD\.png$/, reference);
    const [readme] = extractMarkdownImages(`<img src="x${reference}.png" alt="${reference}">`);
    assert.ok(readme.url.includes('�'), reference);
  }
  const [valid] = extractHtmlImages('<meta property="og:image" content="/a&#1114111;&#65;.png">', 'https://example.org/');
  assert.match(valid.url, /A\.png$/); // the highest valid code point and an ordinary one still decode
});

test('a malformed percent-encoding in a GitHub project URL is an unsupported URL, not an exception', () => {
  for (const url of ['https://github.com/o/r/tree/main/%FF', 'https://github.com/o/r/tree/%E0%A4%A/x', 'https://github.com/%/r']) {
    const target = parseProjectUrl(url);
    assert.equal(target.type, 'unsupported', url);
    assert.match(target.reason, /malformed/);
  }
  assert.equal(parseProjectUrl('https://github.com/o/r/tree/main/%E2%9C%93').directory, '✓'); // valid encodings still decode
});

test('malformed entries in GitHub API listings are skipped', () => {
  const entries = [null, 7, 'x', {}, { type: 'blob' }, { type: 'blob', path: 5 }, { type: 'blob', path: 'docs/screenshot.png', size: 9000 }];
  assert.deepEqual(treeCandidates(entries).map((candidate) => candidate.path), ['docs/screenshot.png']);
});

test('a redirect whose Location cannot be parsed fails that lookup only', async () => {
  const web = await webServer({ '/bad': { status: 302, headers: { location: 'http://[' } }, '/fine': { body: 'ok' } });
  try {
    const client = createHttp(FAST);
    const bad = await client.get(`${web.origin}/bad`);
    assert.equal(bad.ok, false);
    assert.equal(bad.transient, false);
    assert.match(bad.reason, /malformed redirect Location "http:\/\/\["/);
    assert.equal((await client.get(`${web.origin}/fine`)).ok, true);
  } finally {
    await web.close();
  }
});

function runScript(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(site, 'scripts', script)], { cwd: site, env: { ...process.env, GITHUB_ACTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('the three original crashes, run through the real build scripts: exit 0, icon fallback, other projects unaffected, clear warnings', async () => {
  const web = await webServer({
    '/entity': { body: '<html><head><meta property="og:image" content="/pic&#1114112;.png"></head><body></body></html>' },
    '/pic%EF%BF%BD.png': { type: 'image/png', body: photo },
    '/redirect': { status: 302, headers: { location: 'http://[' } },
    '/good': { body: '<html><head><meta property="og:image" content="/good.png"></head><body></body></html>' },
    '/good.png': { type: 'image/png', body: photo },
  });
  const fixture = await startFixtureServer({
    'fixture/with-image': { stars: 42, files: { 'README.md': '![Presto photo](images/demo.png)\n', 'images/demo.png': photo } },
    'fixture/readme-entity': { stars: 7, files: { 'README.md': '<img src="&#1114112;" alt="Screenshot of it">\n' } },
  });
  const area = await mkdtemp(path.join(os.tmpdir(), 'presto-robust-'));
  try {
    const projects = [
      project('entity-page', `${web.origin}/entity`),
      project('bad-redirect', `${web.origin}/redirect`),
      project('bad-path', 'https://github.com/fixture/with-image/tree/main/%FF'),
      project('readme-entity', 'https://github.com/fixture/readme-entity'),
      project('good-page', `${web.origin}/good`),
      project('good-repo', 'https://github.com/fixture/with-image'),
    ];
    const catalogFile = path.join(area, 'catalog.json');
    const imageCache = path.join(area, 'images.json');
    const starCache = path.join(area, 'stars.json');
    await writeFile(catalogFile, JSON.stringify({ schema_version: 1, projects }));
    const env = {
      PRESTO_CATALOG_FILE: catalogFile, PRESTO_IMAGE_CACHE: imageCache, PRESTO_STARS_CACHE: starCache, PRESTO_IMAGE_ALLOW_LOCAL: '1',
      PRESTO_GITHUB_RAW_URL: fixture.endpoints.githubRaw, PRESTO_GITHUB_API_URL: fixture.endpoints.githubApi, PRESTO_GITHUB_WEB_URL: fixture.endpoints.githubWeb,
    };
    const images = await runScript('discover-images.mjs', env);
    assert.equal(images.code, 0, images.output);
    assert.match(images.output, /Project images: \d of 6 projects have an image/);
    assert.match(images.output, /"entity-page": malformed character reference in the image URL/);
    assert.match(images.output, /"bad-redirect": page unavailable \(malformed redirect Location "http:\/\/\["\)/);
    assert.match(images.output, /"bad-path": malformed percent-encoding in the project URL <https:\/\/github\.com\/fixture\/with-image\/tree\/main\/%FF>/);
    assert.match(images.output, /"readme-entity": malformed character reference in the image URL/);
    assert.doesNotMatch(images.output, /RangeError|TypeError|URIError|unexpectedly/);

    const cache = JSON.parse(await readFile(imageCache, 'utf8'));
    for (const name of ['entity-page', 'bad-redirect', 'bad-path', 'readme-entity']) {
      assert.equal(cache.entries[id(name)].status, 'none', name);
      assert.equal(cache.entries[id(name)].image, null, name);
    }
    assert.equal(cache.entries[id('good-page')].status, 'found');
    assert.equal(cache.entries[id('good-repo')].status, 'found');

    const stars = await runScript('fetch-stars.mjs', env);
    assert.equal(stars.code, 0, stars.output);
    assert.doesNotMatch(stars.output, /RangeError|TypeError|URIError|unexpectedly/);
    const counts = JSON.parse(await readFile(starCache, 'utf8')).entries;
    assert.equal(counts['fixture/with-image'].stars, 42); // the %FF project is not a repository page, the others still count
  } finally {
    await fixture.close();
    await web.close();
    await rm(area, { recursive: true, force: true });
  }
});

test('genuine pipeline failures still stop the build with a non-zero exit', async () => {
  const area = await mkdtemp(path.join(os.tmpdir(), 'presto-robust-'));
  try {
    const catalogFile = path.join(area, 'catalog.json');
    const env = { PRESTO_CATALOG_FILE: catalogFile, PRESTO_IMAGE_CACHE: path.join(area, 'images.json'), PRESTO_STARS_CACHE: path.join(area, 'stars.json') };
    await writeFile(catalogFile, JSON.stringify({ schema_version: 99, projects: [project('a', 'https://example.org/')] }));
    for (const script of ['discover-images.mjs', 'fetch-stars.mjs']) {
      const wrongSchema = await runScript(script, env);
      assert.equal(wrongSchema.code, 1, wrongSchema.output);
      assert.match(wrongSchema.output, /invalid catalog/);
    }
    await writeFile(catalogFile, '{ not json');
    assert.equal((await runScript('discover-images.mjs', env)).code, 1);
    await writeFile(catalogFile, JSON.stringify({ schema_version: 1, projects: [project('a', 'https://example.org/')] }));
    const badConfiguration = await runScript('discover-images.mjs', { ...env, PRESTO_GITHUB_RAW_URL: 'not a url' });
    assert.equal(badConfiguration.code, 1);
    assert.match(badConfiguration.output, /PRESTO_GITHUB_RAW_URL is not a valid URL/);
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});

test('a programming error inside discovery is not swallowed as a lookup failure', async () => {
  const projects = [{ id: id('a'), title: 'a', url: 'https://github.com/o/r', image: { mode: 'hint', value: 'shots/' } }];
  // Endpoints without the expected shape make the code itself fail (a bug, not a network condition).
  await assert.rejects(() => updateCache({ projects }, emptyCache(), { endpoints: {}, allowPrivateHosts: true, httpOptions: FAST }), TypeError);
});

// ---------------------------------------------------------------------------------------------------------------
// An upstream HTTP status that `Response` cannot represent (600) used to throw inside the http response callback,
// outside the Promise, and end the process with an uncaught RangeError.

test('an invalid upstream status fails that lookup only: no retry, no offline mode, the connection is released', async () => {
  const sockets = new Set();
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    if (request.url.startsWith('/bad')) {
      response.writeHead(600, { 'content-type': 'text/html' });
      return response.end('<html>not valid</html>');
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end('fine');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);
  try {
    const logs = [];
    const client = createHttp({ ...FAST, log: (message) => logs.push(message) });
    // More bad answers than `offlineAfter` (4): none of them may switch the client offline or be retried.
    for (let number = 0; number < 6; number += 1) {
      const bad = await client.get(`${origin}/bad${number}`);
      assert.equal(bad.ok, false);
      assert.equal(bad.transient, true, 'a server fault keeps an earlier result');
      assert.equal(bad.blocked, undefined);
      assert.match(bad.reason, /invalid HTTP response \(invalid HTTP status 600\)/);
    }
    assert.deepEqual(hits.filter((hit) => hit.startsWith('/bad')).sort(), ['/bad0', '/bad1', '/bad2', '/bad3', '/bad4', '/bad5'], 'one request each, no retries');
    assert.equal(client.state.offline, false);
    assert.equal((await client.get(`${origin}/good`)).ok, true);
    assert.equal(logs.filter((message) => /invalid HTTP response/.test(message)).length, 6);

    // The response stream and socket of a rejected response are destroyed, not left open until the server times out.
    const deadline = Date.now() + 3000;
    while (sockets.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sockets.size, 0, 'no connection is left open');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUnhandled);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP 600 from a project site, through the real build scripts: exit 0, warning, cached image kept, icon otherwise, others continue', async () => {
  const page = (image) => ({ body: `<html><head><meta property="og:image" content="${image}"></head><body></body></html>` });
  const pages = {
    '/a': page('/a.png'), '/a.png': { type: 'image/png', body: photo },
    '/c': page('/c.png'), '/c.png': { type: 'image/png', body: photo },
    '/d': { status: 600, body: 'never valid' }, // 600 from the very first build: no earlier image exists
  };
  const web = await webServer(pages);
  const area = await mkdtemp(path.join(os.tmpdir(), 'presto-robust-'));
  try {
    const projects = [project('a', `${web.origin}/a`), project('c', `${web.origin}/c`), project('d', `${web.origin}/d`)];
    const catalogFile = path.join(area, 'catalog.json');
    const imageCache = path.join(area, 'images.json');
    await writeFile(catalogFile, JSON.stringify({ schema_version: 1, projects }));
    const env = { PRESTO_CATALOG_FILE: catalogFile, PRESTO_IMAGE_CACHE: imageCache, PRESTO_STARS_CACHE: path.join(area, 'stars.json'), PRESTO_IMAGE_ALLOW_LOCAL: '1' };
    const bad = /RangeError|TypeError|Unhandled|unexpectedly|uncaught/i;

    const first = await runScript('discover-images.mjs', env);
    assert.equal(first.code, 0, first.output);
    assert.doesNotMatch(first.output, bad);
    assert.match(first.output, /invalid HTTP response \(invalid HTTP status 600\)/);
    const firstCache = JSON.parse(await readFile(imageCache, 'utf8'));
    assert.equal(firstCache.entries[id('a')].status, 'found');
    assert.equal(firstCache.entries[id('c')].status, 'found');
    assert.equal(usableImages(firstCache, projects).has(id('d')), false, 'no earlier image and none now: the category icon');

    // Now an earlier image exists for "a" and the site starts answering with an invalid status.
    pages['/a'] = { status: 600 };
    const second = await runScript('discover-images.mjs', { ...env, PRESTO_IMAGE_REFRESH: '1' });
    assert.equal(second.code, 0, second.output);
    assert.doesNotMatch(second.output, bad);
    assert.match(second.output, /invalid HTTP response/);
    const secondCache = JSON.parse(await readFile(imageCache, 'utf8'));
    const usable = usableImages(secondCache, projects);
    assert.equal(usable.has(id('a')), true, 'the cached image survives a transient upstream fault');
    assert.equal(usable.get(id('a')).image.url, firstCache.entries[id('a')].image.url);
    assert.equal(usable.has(id('c')), true, 'other projects are still processed');
    assert.equal(usable.has(id('d')), false);
  } finally {
    await web.close();
    await rm(area, { recursive: true, force: true });
  }
});

test('HTTP 600 from the GitHub API stand-in does not crash the star lookup', async () => {
  const fixture = await startFixtureServer({
    'fixture/odd': { stars: { status: 600, body: '{}' }, files: {} },
    'fixture/fine': { stars: 11, files: {} },
  });
  const area = await mkdtemp(path.join(os.tmpdir(), 'presto-robust-'));
  try {
    const catalogFile = path.join(area, 'catalog.json');
    const starCache = path.join(area, 'stars.json');
    await writeFile(catalogFile, JSON.stringify({ schema_version: 1, projects: [project('odd', 'https://github.com/fixture/odd'), project('fine', 'https://github.com/fixture/fine')] }));
    const result = await runScript('fetch-stars.mjs', {
      PRESTO_CATALOG_FILE: catalogFile, PRESTO_IMAGE_CACHE: path.join(area, 'images.json'), PRESTO_STARS_CACHE: starCache, PRESTO_IMAGE_ALLOW_LOCAL: '1',
      PRESTO_GITHUB_RAW_URL: fixture.endpoints.githubRaw, PRESTO_GITHUB_API_URL: fixture.endpoints.githubApi, PRESTO_GITHUB_WEB_URL: fixture.endpoints.githubWeb,
    });
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /RangeError|unexpectedly|Unhandled|uncaught/i);
    const entries = JSON.parse(await readFile(starCache, 'utf8')).entries;
    assert.equal(entries['fixture/fine'].stars, 11);
    assert.notEqual(entries['fixture/odd']?.stars, 0, 'unknown is never shown as zero');
  } finally {
    await fixture.close();
    await rm(area, { recursive: true, force: true });
  }
});
