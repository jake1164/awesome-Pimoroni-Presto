import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createHttp,
  emptyCache,
  fingerprint,
  hintProblem,
  isFresh,
  updateCache,
  usableImages,
  validateCatalog,
} from '../src/lib/image-discovery.mjs';
import { makePng, startFixtureServer } from './support/fixture-server.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = { retryDelayMs: 1, timeoutMs: 5000, allowPrivateHosts: true };
const noise = (w = 300, h = 200) => makePng(w, h, [0, 0, 0], { noise: true });
const id = (name) => `presto_${createHash('sha256').update(name).digest('hex')}`;
const project = (name, image, url = `https://github.com/fixture/${name}`) => ({ id: id(name), title: name, url, ...(image ? { image } : {}) });

const repos = () => ({
  // README image plus a hinted screenshots folder and a hinted file.
  'fixture/hinted': {
    files: {
      'README.md': '![Readme picture](images/readme.png)\n',
      'images/readme.png': noise(),
      'shots/hero.png': noise(320, 240),
      'shots/logo.png': noise(320, 240),
      'shots/zzz-extra.png': noise(320, 240),
      'photo.png': noise(310, 230),
      'docs/deep/demo.gif': noise(),
    },
  },
  'fixture/mono': {
    files: { 'app/README.md': 'No pictures.\n', 'app/shots/one.png': noise(), 'shots/wrong-place.png': noise(), 'one.png': noise() },
  },
  'fixture/other': { files: { 'README.md': 'x', 'assets/pic.png': noise(400, 300), 'assets/page.html': Buffer.from('<html></html>'), 'assets/small.png': makePng(10, 10) }, contentTypes: { 'assets/page.html': 'text/html' } },
  'fixture/plain': { files: { 'README.md': '![Plain](plain.png)\n', 'plain.png': noise() } },
});

async function withFixture(run, options) {
  const fixture = await startFixtureServer(repos(), options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
const run = (fixture, projects, previous = emptyCache(), extra = {}) =>
  updateCache({ projects }, previous, { endpoints: fixture.endpoints, allowPrivateHosts: true, httpOptions: FAST, ...extra });
const urlOf = (cache, p) => cache.entries[p.id].image?.url;
const overrideUrl = (fixture, file) => `${fixture.origin}/raw/fixture/other/HEAD/${file}`;

// ---------------------------------------------------------------------------------------------------------------

test('hint paths: safe ones pass, unsafe or ambiguous ones are refused (same rules as the parser)', () => {
  for (const ok of ['screenshots/', 'images/presto.jpg', 'demo.gif', 'My Photos/été.png', 'a/b/c/d/e/f/']) assert.equal(hintProblem(ok), null, ok);
  for (const bad of ['', '../x/', 'a/../b/', 'a//b/', './a/', '/etc/', 'a\\b/', 'a%2e/', 'a?b/', 'a#b/', 'https://x.org/a.png', '//x/a/', 'shots', 'notes.txt', 'a/b/c/d/e/f/g/', 'x'.repeat(201)]) {
    assert.ok(hintProblem(bad), `${JSON.stringify(bad)} must be refused`);
  }
});

test('validateCatalog accepts a well-formed catalog and rejects broken ones with a useful message', () => {
  const good = { schema_version: 1, projects: [project('alpha', { mode: 'none' }), project('beta', { mode: 'hint', value: 'shots/' }), project('gamma', { mode: 'url', value: 'https://e.org/a.png' }), project('delta')] };
  assert.equal(validateCatalog(good), good);
  const broken = [
    [null, /not a JSON object/],
    [{ schema_version: 2, projects: good.projects }, /schema_version/],
    [{ schema_version: 1 }, /non-empty array/],
    [{ schema_version: 1, projects: [] }, /non-empty array/],
    [{ schema_version: 1, projects: [{ id: 'x', title: 't', url: 'https://e.org' }] }, /not a project ID/],
    [{ schema_version: 1, projects: [project('a'), project('a')] }, /duplicates/],
    [{ schema_version: 1, projects: [{ ...project('a'), url: 'javascript:1' }] }, /http\(s\) URL/],
    [{ schema_version: 1, projects: [project('a', { mode: 'sideways' })] }, /image\.mode/],
    [{ schema_version: 1, projects: [project('a', { mode: 'hint', value: '../x/' })] }, /unsafe path segment/],
    [{ schema_version: 1, projects: [project('a', { mode: 'url', value: 'http://e.org/a.png' })] }, /https URL/],
    [{ schema_version: 1, projects: [project('a', { mode: 'none', value: 'x' })] }, /mode none/],
  ];
  for (const [catalog, pattern] of broken) assert.throws(() => validateCatalog(catalog), pattern);
});

test('fingerprint includes the directive type and value, and nothing else about the entry', () => {
  const base = project('alpha');
  const keys = [base, project('alpha', { mode: 'none' }), project('alpha', { mode: 'hint', value: 'a/' }), project('alpha', { mode: 'hint', value: 'b/' }), project('alpha', { mode: 'url', value: 'https://e.org/a.png' }), project('alpha', { mode: 'url', value: 'https://e.org/b.png' })].map(fingerprint);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(fingerprint(base), fingerprint({ ...base, title: 'Renamed', description: 'changed' }));
});

// ---------------------------------------------------------------------------------------------------------------
// image-hint

test('a file hint beats the README image', async () => {
  await withFixture(async (fixture) => {
    const hinted = project('hinted', { mode: 'hint', value: 'photo.png' });
    const { cache } = await run(fixture, [hinted]);
    assert.equal(cache.entries[hinted.id].source, 'readme-hint');
    assert.match(urlOf(cache, hinted), /\/fixture\/hinted\/HEAD\/photo\.png$/);
    assert.deepEqual(cache.entries[hinted.id].directive, { mode: 'hint', value: 'photo.png', outcome: 'used' });
    const auto = project('hinted');
    assert.match(urlOf((await run(fixture, [auto])).cache, auto), /images\/readme\.png$/);
  });
});

test('a directory hint lists that one directory, ranks by the normal rules, and skips logos', async () => {
  await withFixture(async (fixture) => {
    const hinted = project('hinted', { mode: 'hint', value: 'shots/' });
    const { cache } = await run(fixture, [hinted]);
    const entry = cache.entries[hinted.id];
    assert.equal(entry.source, 'readme-hint');
    assert.match(entry.image.url, /\/shots\/(hero|zzz-extra)\.png$/);
    assert.doesNotMatch(entry.image.url, /logo/);
    // One directory listing, no recursive tree walk and no crawling of other folders.
    assert.equal(fixture.requests.filter((p) => p.includes('/git/trees/')).length, 0);
    assert.equal(fixture.requests.filter((p) => p.includes('/contents/')).length, 1);
    assert.equal(fixture.requests.filter((p) => p.includes('/docs/')).length, 0);
  });
});

test('hints resolve relative to the linked directory of a /tree/ project, never above it', async () => {
  await withFixture(async (fixture) => {
    const inFolder = project('mono', { mode: 'hint', value: 'shots/' }, 'https://github.com/fixture/mono/tree/main/app');
    const { cache } = await run(fixture, [inFolder]);
    assert.match(urlOf(cache, inFolder), /\/mono\/main\/app\/shots\/one\.png$/);
    const file = project('mono2', { mode: 'hint', value: 'one.png' }, 'https://github.com/fixture/mono/tree/main/app');
    const second = await run(fixture, [file]);
    assert.equal(second.cache.entries[file.id].directive.outcome, 'failed'); // app/one.png does not exist; ../one.png is never tried
    assert.equal(second.cache.entries[file.id].status, 'none');
  });
});

test('a hint that finds nothing falls back to normal discovery and records why', async () => {
  await withFixture(async (fixture) => {
    for (const value of ['nowhere/', 'missing.png', 'docs/']) {
      const hinted = project('hinted', { mode: 'hint', value });
      const { cache } = await run(fixture, [hinted]);
      const entry = cache.entries[hinted.id];
      assert.equal(entry.status, 'found', value);
      assert.equal(entry.source, 'github-readme', value);
      assert.equal(entry.directive.outcome, 'failed', value);
      assert.ok(entry.directive.reason, value);
      assert.ok(!entry.partial, 'a definite miss is cached normally');
    }
  });
});

test('a hint on a non-GitHub project is ignored with a reason', async () => {
  await withFixture(async (fixture) => {
    const web = project('web', { mode: 'hint', value: 'shots/' }, `${fixture.origin}/web/fixture/plain`);
    const { cache } = await run(fixture, [web]);
    assert.equal(cache.entries[web.id].directive.outcome, 'failed');
    assert.match(cache.entries[web.id].directive.reason, /only works for GitHub/);
  });
});

test('a hint that cannot be checked right now (API limit) still falls back, but is retried next build', async () => {
  await withFixture(async (fixture) => {
    const hinted = project('hinted', { mode: 'hint', value: 'shots/' });
    const { cache } = await run(fixture, [hinted]);
    assert.equal(cache.entries[hinted.id].source, 'readme-hint');
    await fixture.close();
  });
  await withFixture(async (fixture) => {
    const hinted = project('hinted', { mode: 'hint', value: 'shots/' });
    const { cache } = await run(fixture, [hinted]);
    const entry = cache.entries[hinted.id];
    assert.equal(entry.status, 'found');
    assert.equal(entry.source, 'github-readme', 'fell back to the README image');
    assert.equal(entry.partial, true);
    assert.ok(!isFresh(entry, hinted, Date.now()), 'partial results are looked up again next build');
    // And a partial result never replaces an earlier complete one.
    const good = { ...entry, partial: undefined, source: 'readme-hint', image: { ...entry.image, url: 'https://example.org/earlier.png' }, directive: { mode: 'hint', value: 'shots/', outcome: 'used' } };
    const kept = await run(fixture, [hinted], { ...emptyCache(), entries: { [hinted.id]: good } });
    assert.equal(kept.cache.entries[hinted.id].image.url, 'https://example.org/earlier.png');
  }, { rateLimitApi: true });
});

// ---------------------------------------------------------------------------------------------------------------
// image: URL

test('an explicit image URL is preferred over the README image', async () => {
  await withFixture(async (fixture) => {
    const explicit = project('plain', { mode: 'url', value: overrideUrl(fixture, 'assets/pic.png') });
    const { cache } = await run(fixture, [explicit]);
    const entry = cache.entries[explicit.id];
    assert.equal(entry.source, 'readme-image');
    assert.equal(entry.image.url, overrideUrl(fixture, 'assets/pic.png'));
    assert.deepEqual([entry.image.width, entry.image.height], [400, 300]);
    assert.equal(fixture.requests.filter((p) => p.includes('/plain/')).length, 0, 'no automatic lookup was needed');
  });
});

test('an explicit URL that is unusable falls back to automatic discovery with a clear reason', async () => {
  await withFixture(async (fixture) => {
    const cases = {
      'missing.png': /HTTP 404/,
      'assets/page.html': /not an image/,
      'assets/small.png': /too small/,
    };
    for (const [file, reason] of Object.entries(cases)) {
      const explicit = project('plain', { mode: 'url', value: overrideUrl(fixture, file) });
      const { cache } = await run(fixture, [explicit]);
      const entry = cache.entries[explicit.id];
      assert.equal(entry.directive.outcome, 'failed', file);
      assert.match(entry.directive.reason, reason, file);
      assert.equal(entry.source, 'github-readme', `${file}: automatic discovery took over`);
      assert.ok(!entry.partial, file);
    }
  });
});

test('an explicit image URL must be https and public; nothing is fetched otherwise', async () => {
  const fetched = [];
  const spy = async (url) => { fetched.push(String(url)); return new Response('x', { status: 404 }); };
  const projects = [
    project('plain1', { mode: 'url', value: 'http://example.org/a.png' }, 'https://example.org/p1'),
    project('plain2', { mode: 'url', value: 'https://user:pw@example.org/a.png' }, 'https://example.org/p2'),
    project('plain3', { mode: 'url', value: 'https://127.0.0.1/a.png' }, 'https://example.org/p3'),
    project('plain4', { mode: 'url', value: 'https://169.254.169.254/latest/meta-data' }, 'https://example.org/p4'),
  ];
  const { cache } = await updateCache({ projects }, emptyCache(), { http: createHttp({ ...FAST, allowPrivateHosts: false, fetchImpl: spy, retries: 0 }), allowPrivateHosts: false });
  for (const p of projects) assert.equal(cache.entries[p.id].directive.outcome, 'failed', p.title);
  assert.deepEqual(fetched.filter((url) => /a\.png|meta-data/.test(url)), [], 'the unusable override URLs were never requested');
  assert.match(cache.entries[projects[0].id].directive.reason, /https/);
});

test('an explicit URL that fails temporarily falls back but is marked to be retried', async () => {
  await withFixture(async (fixture) => {
    const explicit = project('plain', { mode: 'url', value: `${fixture.origin.replace(/:\d+$/, ':1')}/down.png` });
    const { cache } = await run(fixture, [explicit]);
    const entry = cache.entries[explicit.id];
    assert.equal(entry.directive.outcome, 'failed');
    assert.equal(entry.directive.transient, true);
    assert.equal(entry.partial, true);
    assert.equal(entry.source, 'github-readme');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// image: none

test('image: none forces the icon, makes no request, and beats a previously cached image', async () => {
  await withFixture(async (fixture) => {
    const auto = project('plain');
    const first = await run(fixture, [auto]);
    assert.equal(first.cache.entries[auto.id].status, 'found');
    const before = fixture.requests.length;

    const forced = project('plain', { mode: 'none' });
    for (const options of [{}, { offline: true }, { refresh: true }]) {
      const result = await run(fixture, [forced], first.cache, options);
      assert.equal(fixture.requests.length, before, `no requests (${JSON.stringify(options)})`);
      assert.equal(result.cache.entries[forced.id].status, 'none');
      assert.equal(usableImages(result.cache, [forced]).size, 0);
      assert.equal(result.stats.forcedIcon, 1);
    }
    // Even if a stale cache entry that still carries an image is presented for the same fingerprint, it is not shown.
    const poisoned = { ...emptyCache(), entries: { [forced.id]: { ...first.cache.entries[auto.id], fingerprint: fingerprint(forced) } } };
    assert.equal(usableImages(poisoned, [forced]).size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Cache identity across directive changes

test('changing, adding or removing a directive re-runs discovery; unchanged projects reuse the cache', async () => {
  await withFixture(async (fixture) => {
    const steps = [];
    let cache = emptyCache();
    const step = async (label, p, expectRequests) => {
      const before = fixture.requests.length;
      ({ cache } = await run(fixture, [p], cache));
      const made = fixture.requests.length - before;
      steps.push([label, made]);
      if (expectRequests) assert.ok(made > 0, `${label} should look the project up`);
      else assert.equal(made, 0, `${label} should use the cache`);
      return cache.entries[p.id];
    };
    let entry = await step('automatic', project('hinted'), true);
    assert.match(entry.image.url, /images\/readme\.png$/);
    await step('automatic again', project('hinted'), false);
    entry = await step('add a hint', project('hinted', { mode: 'hint', value: 'photo.png' }), true);
    assert.match(entry.image.url, /\/photo\.png$/);
    await step('same hint again', project('hinted', { mode: 'hint', value: 'photo.png' }), false);
    entry = await step('change the hint', project('hinted', { mode: 'hint', value: 'shots/hero.png' }), true);
    assert.match(entry.image.url, /shots\/hero\.png$/);
    entry = await step('change to an explicit URL', project('hinted', { mode: 'url', value: overrideUrl(fixture, 'assets/pic.png') }), true);
    assert.equal(entry.source, 'readme-image');
    entry = await step('change the explicit URL', project('hinted', { mode: 'url', value: `${fixture.origin}/raw/fixture/plain/HEAD/plain.png` }), true);
    assert.match(entry.image.url, /plain\.png$/);
    entry = await step('image: none', project('hinted', { mode: 'none' }), false);
    assert.equal(entry.status, 'none');
    assert.equal(usableImages(cache, [project('hinted', { mode: 'none' })]).size, 0);
    entry = await step('remove the directive', project('hinted'), true);
    assert.match(entry.image.url, /images\/readme\.png$/);
    await step('unchanged after removal', project('hinted'), false);
  });
});

test('removed projects are pruned and a network failure keeps an earlier valid result', async () => {
  await withFixture(async (fixture) => {
    const a = project('hinted', { mode: 'hint', value: 'photo.png' });
    const b = project('plain');
    const first = await run(fixture, [a, b]);
    assert.deepEqual(Object.keys((await run(fixture, [b], first.cache)).cache.entries), [b.id]);

    const down = createHttp({ ...FAST, retries: 0, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    const later = Date.now() + 30 * 24 * 3600 * 1000;
    const result = await updateCache({ projects: [a, b] }, first.cache, { http: down, endpoints: fixture.endpoints, now: later });
    assert.equal(result.cache.entries[a.id].image.url, first.cache.entries[a.id].image.url);
    assert.equal(result.cache.entries[b.id].image.url, first.cache.entries[b.id].image.url);
    assert.equal(result.stats.networkUnavailable, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pipeline failures end the process with a non-zero status; recoverable ones do not.

async function runScript(env, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(site, 'scripts', 'discover-images.mjs')], { cwd: cwd ?? site, env: { ...process.env, GITHUB_ACTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

async function scratch(catalog, { cache } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presto-images-'));
  const files = { PRESTO_CATALOG_FILE: path.join(directory, 'catalog.json'), PRESTO_IMAGE_CACHE: path.join(directory, 'cache', 'cache.json') };
  if (catalog !== undefined) await writeFile(files.PRESTO_CATALOG_FILE, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
  if (cache !== undefined) {
    await mkdir(path.dirname(files.PRESTO_IMAGE_CACHE), { recursive: true });
    await writeFile(files.PRESTO_IMAGE_CACHE, cache);
  }
  return { directory, env: files, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const goodCatalog = (projects) => ({ schema_version: 1, projects });

test('pipeline failure: an invalid or missing catalog fails with a clear message', async () => {
  const cases = [
    [undefined, /cannot read the generated catalog/],
    ['{not json', /not valid JSON/],
    [{ schema_version: 9, projects: [] }, /invalid catalog/],
    [goodCatalog([{ id: 'nope', title: 't', url: 'https://e.org' }]), /not a project ID/],
    [goodCatalog([project('a', { mode: 'hint', value: '../escape/' })]), /unsafe path segment/],
  ];
  for (const [catalog, pattern] of cases) {
    const area = await scratch(catalog);
    try {
      const { code, output } = await runScript({ ...area.env, PRESTO_IMAGE_DISCOVERY: 'off' });
      assert.equal(code, 1, output);
      assert.match(output, pattern);
    } finally {
      await area.cleanup();
    }
  }
});

test('pipeline failure: broken configuration fails', async () => {
  const area = await scratch(goodCatalog([project('a')]));
  try {
    for (const env of [{ PRESTO_GITHUB_RAW_URL: 'not a url' }, { PRESTO_IMAGE_BUDGET_SECONDS: 'soon' }, { PRESTO_IMAGE_BUDGET_SECONDS: '-5' }, { PRESTO_IMAGE_DISCOVERY: 'maybe' }]) {
      const { code, output } = await runScript({ ...area.env, ...env });
      assert.equal(code, 1, JSON.stringify(env));
      assert.match(output, /PRESTO_/);
    }
  } finally {
    await area.cleanup();
  }
});

test('pipeline failure: a cache that cannot be read or replaced fails; a merely damaged one is recovered', async () => {
  // Cache path is a directory: it can be neither read nor replaced.
  const asDirectory = await scratch(goodCatalog([project('a')]));
  try {
    await mkdir(asDirectory.env.PRESTO_IMAGE_CACHE, { recursive: true });
    const { code, output } = await runScript({ ...asDirectory.env, PRESTO_IMAGE_DISCOVERY: 'off' });
    assert.equal(code, 1, output);
    assert.match(output, /cannot read the image cache/);
  } finally {
    await asDirectory.cleanup();
  }
  // Output location cannot be created: its parent is a regular file. Both messages are legitimate for this path, and
  // which one appears depends on the platform: Linux reports ENOTDIR when reading `parent/cache.json`, so the read
  // fails first ("cannot read"); Windows reports ENOENT, which means "no cache yet", so the write fails ("cannot write").
  const blocked = await scratch(goodCatalog([project('a')]));
  try {
    const parentFile = path.join(blocked.directory, 'parent');
    await writeFile(parentFile, 'x');
    const { code, output } = await runScript({ ...blocked.env, PRESTO_IMAGE_CACHE: path.join(parentFile, 'cache.json'), PRESTO_IMAGE_DISCOVERY: 'off' });
    assert.equal(code, 1, output);
    assert.match(output, /cannot (read|write) the image cache/);
  } finally {
    await blocked.cleanup();
  }
  // Damaged JSON: the cache is disposable, so it is discarded with a warning and rewritten.
  const damaged = await scratch(goodCatalog([project('a')]), { cache: '{"entries": [' });
  try {
    const { code, output } = await runScript({ ...damaged.env, PRESTO_IMAGE_DISCOVERY: 'off' });
    assert.equal(code, 0, output);
    assert.match(output, /damaged/);
    assert.equal(JSON.parse(await readFile(damaged.env.PRESTO_IMAGE_CACHE, 'utf8')).schema_version, 1);
  } finally {
    await damaged.cleanup();
  }
});

test('recoverable failures never fail the process: network down, rate limited, 404s and bad directives', async () => {
  await withFixture(async (fixture) => {
    const projects = [
      project('plain'),
      project('hinted', { mode: 'hint', value: 'nowhere/' }),
      project('missing', undefined, 'https://github.com/fixture/does-not-exist'),
      project('badurl', { mode: 'url', value: 'https://127.0.0.1:1/missing.png' }),
    ];
    const area = await scratch(goodCatalog(projects));
    try {
      const env = { ...area.env, PRESTO_GITHUB_RAW_URL: fixture.endpoints.githubRaw, PRESTO_GITHUB_API_URL: fixture.endpoints.githubApi, PRESTO_GITHUB_WEB_URL: fixture.endpoints.githubWeb, PRESTO_IMAGE_ALLOW_LOCAL: '1' };
      let result = await runScript(env);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Project images: \d of 4/);
      assert.match(result.output, /README `<!-- (image|image-hint): .* was not used/);
      const cache = JSON.parse(await readFile(area.env.PRESTO_IMAGE_CACHE, 'utf8'));
      assert.equal(cache.entries[projects[0].id].status, 'found');
      // Now the network is gone entirely: still exit 0, and the cached results survive.
      result = await runScript({ ...env, PRESTO_GITHUB_RAW_URL: 'http://127.0.0.1:1', PRESTO_GITHUB_API_URL: 'http://127.0.0.1:1', PRESTO_GITHUB_WEB_URL: 'http://127.0.0.1:1', PRESTO_IMAGE_REFRESH: '1' });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /network unavailable/);
      const after = JSON.parse(await readFile(area.env.PRESTO_IMAGE_CACHE, 'utf8'));
      assert.equal(after.entries[projects[0].id].image.url, cache.entries[projects[0].id].image.url);
    } finally {
      await area.cleanup();
    }
  });
});

test('GitHub rate limiting alone never fails the process', async () => {
  await withFixture(async (fixture) => {
    const projects = [project('hinted', { mode: 'hint', value: 'shots/' }), project('plain')];
    const area = await scratch(goodCatalog(projects));
    try {
      const { code, output } = await runScript({ ...area.env, PRESTO_GITHUB_RAW_URL: fixture.endpoints.githubRaw, PRESTO_GITHUB_API_URL: fixture.endpoints.githubApi, PRESTO_GITHUB_WEB_URL: fixture.endpoints.githubWeb, PRESTO_IMAGE_ALLOW_LOCAL: '1' });
      assert.equal(code, 0, output);
      assert.match(output, /rate limited/);
    } finally {
      await area.cleanup();
    }
  }, { rateLimitApi: true });
});

test('the script never calls process.exit (Windows-safe exit handling)', async () => {
  const text = await readFile(path.join(site, 'scripts', 'discover-images.mjs'), 'utf8');
  assert.doesNotMatch(text.replace(/\/\/[^\n]*/g, ''), /process\.exit\(/); // comments may mention it
  assert.match(text, /process\.exitCode = 1/);
  assert.match(text, /process\.exitCode = 0/);
});
