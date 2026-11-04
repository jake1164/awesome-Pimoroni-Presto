import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterAndSortCards } from '../src/scripts/catalog-controls.js';
import { PipelineError, createHttp } from '../src/lib/image-discovery.mjs';
import {
  STAR_LIMITS,
  classifyGithubUrl,
  collectRepositories,
  emptyStarsCache,
  fetchRepositoryStars,
  formatStarCount,
  isFreshStars,
  readStarsCache,
  sanitizeStarsCache,
  starLinkLabel,
  starsFor,
  updateStars,
  writeStarsCache,
} from '../src/lib/github-stars.mjs';
import { startFixtureServer } from './support/fixture-server.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const FAST = { retryDelayMs: 1, timeoutMs: 5000, allowPrivateHosts: true };

const project = (name, url = `https://github.com/fixture/${name}`) => ({ id: `presto_${createHash('sha256').update(name).digest('hex')}`, title: name, url });
const catalogOf = (...projects) => ({ schema_version: 1, projects });
const okEntry = (stars, at = NOW, fullName = 'fixture/a') => ({ checked_at: new Date(at).toISOString(), status: 'ok', stars, full_name: fullName });
const cacheOf = (entries) => ({ schema_version: 1, entries });

// A stand-in for http.get that answers with prepared responses, so failures need no real server and no retry delays.
const answer = (body, extra = {}) => ({ ok: true, status: 200, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), truncated: false, ...extra });
const failure = (status, extra = {}) => ({ ok: false, status, transient: status === 0 || status >= 500 || status === 429, reason: `HTTP ${status}`, ...extra });
const fakeHttp = (responder) => {
  const calls = [];
  return { calls, state: { requests: 0, apiRequests: 0 }, get: async (url) => { calls.push(url); return responder(url, calls.length); } };
};

// ---------------------------------------------------------------------------------------------------------------
// GitHub URL classification and repository extraction

test('GitHub repository URLs, including files and directories, resolve to owner/repository', () => {
  const repo = (value) => classifyGithubUrl(value).repository;
  assert.deepEqual(repo('https://github.com/pimoroni/presto'), { owner: 'pimoroni', repo: 'presto', key: 'pimoroni/presto', url: 'https://github.com/pimoroni/presto' });
  for (const value of [
    'https://github.com/pimoroni/presto/',
    'https://github.com/pimoroni/presto.git',
    'https://www.github.com/pimoroni/presto',
    'http://github.com/pimoroni/presto',
    'https://GITHUB.COM/pimoroni/presto',
    'https://github.com/pimoroni/presto?tab=readme-ov-file#install',
    'https://github.com/pimoroni/presto/blob/main/examples/co2.py',
    'https://github.com/pimoroni/presto/blob/main/examples/co2.py#L10-L20',
    'https://github.com/pimoroni/presto/tree/main/examples/home_assistant',
    'https://github.com/pimoroni/presto/tree/main',
    'https://github.com/pimoroni/presto/tree/main/a%20b/c',
    'https://github.com/pimoroni/presto/releases',
    'https://github.com/pimoroni/presto/releases/',
    'https://github.com/pimoroni/presto/releases?page=2',
    'https://github.com/pimoroni/presto/releases/tag/v1.0.0',
    'https://github.com/pimoroni/presto/releases/tag/v1.0.0#assets',
    'https://github.com/pimoroni/presto/releases/tag/release%2F1.0',
    'https://github.com/pimoroni/presto/releases/tag/release/1.0',
    'https://github.com/pimoroni/presto/releases/latest',
  ]) {
    assert.equal(repo(value)?.key, 'pimoroni/presto', value);
    assert.equal(repo(value)?.url, 'https://github.com/pimoroni/presto', `${value} links to the repository itself`);
  }
  // The key ignores case (GitHub does), while the request keeps the first spelling.
  assert.equal(repo('https://github.com/Pimoroni/Presto').key, 'pimoroni/presto');
  assert.equal(repo('https://github.com/Pimoroni/Presto').repo, 'Presto');
  // Unusual but valid names.
  assert.equal(repo('https://github.com/o/r.js').repo, 'r.js');
  assert.equal(repo('https://github.com/o/.github').repo, '.github');
  assert.equal(repo('https://github.com/8bitkick/rp2350-bbc-micro').key, '8bitkick/rp2350-bbc-micro');
  assert.equal(repo('https://github.com/paulskpt/presto_attitude_indicator_for_x-plane12').repo, 'presto_attitude_indicator_for_x-plane12');
});

test('gists, profiles, issues, pull requests, other GitHub pages and other hosts are not repositories', () => {
  const reason = (value) => {
    const result = classifyGithubUrl(value);
    assert.equal(result.repository, undefined, `${value} must not be a repository`);
    assert.ok(result.reason, `${value} needs a reason`);
    return result.reason;
  };
  assert.match(reason('https://gist.github.com/someone/0123456789abcdef'), /Gist/);
  assert.match(reason('https://gist.github.com/0123456789abcdef'), /Gist/);
  for (const value of ['https://github.com/someone', 'https://github.com/', 'https://github.com']) assert.match(reason(value), /profile or organization/);
  for (const page of ['issues/1', 'issues', 'pull/3', 'pulls', 'releases/tag', 'releases/download/v1/file.uf2', 'releases/new', 'releases/edit/v1', 'releases/latest/extra', 'releases.atom', 'release', 'wiki', 'actions', 'discussions', 'commits/main', 'tree', 'blob', 'archive/main.zip', 'security']) {
    reason(`https://github.com/o/r/${page}`);
  }
  for (const value of ['https://github.com/orgs/acme', 'https://github.com/sponsors/someone', 'https://github.com/topics/presto', 'https://github.com/marketplace/actions', 'https://github.com/settings/profile', 'https://github.com/features/actions', 'https://github.com/explore/x']) reason(value);
  for (const value of [
    'https://raw.githubusercontent.com/o/r/main/a.py', 'https://o.github.io/r', 'https://gitlab.com/o/r', 'https://git.hack-hro.de/o/r',
    'https://github.com.evil.example/o/r', 'https://evil.example/github.com/o/r', 'https://notgithub.com/o/r', 'https://api.github.com/repos/o/r',
  ]) reason(value);
  for (const value of ['not a url', 'ftp://github.com/o/r', 'javascript:alert(1)', 'data:text/html,x', '']) reason(value);
  for (const value of ['https://github.com/o/r%', 'https://github.com/-bad/r', 'https://github.com/bad-/r x', `https://github.com/${'a'.repeat(40)}/r`, 'https://github.com/o/%00']) reason(value);
});

test('duplicate repository references are collected once, in catalog order, with every project that uses them', () => {
  const projects = [
    project('repo', 'https://github.com/Pimoroni/Presto'),
    project('elsewhere', 'https://example.org/page'),
    project('file', 'https://github.com/pimoroni/presto/blob/main/examples/co2.py'),
    project('dir', 'https://github.com/pimoroni/presto/tree/main/examples/home_assistant'),
    project('releases', 'https://github.com/pimoroni/presto/releases'),
    project('release', 'https://github.com/pimoroni/presto/releases/tag/v1.0.0'),
    project('issue', 'https://github.com/pimoroni/presto/issues/4'),
    project('other', 'https://github.com/pimoroni/presto-boilerplate'),
    project('gist', 'https://gist.github.com/someone/abc'),
  ];
  const repositories = collectRepositories(projects);
  assert.deepEqual([...repositories.keys()], ['pimoroni/presto', 'pimoroni/presto-boilerplate']);
  const first = repositories.get('pimoroni/presto');
  assert.equal(first.owner, 'Pimoroni', 'the first spelling is used for the request');
  assert.deepEqual(first.projectIds, [projects[0].id, projects[2].id, projects[3].id, projects[4].id, projects[5].id], 'a releases link joins the repository it belongs to; the issue link does not');
  assert.deepEqual(repositories.get('pimoroni/presto-boilerplate').projectIds, [projects[7].id]);
});

// ---------------------------------------------------------------------------------------------------------------
// Formatting

test('star counts are formatted compactly without rounding up to the next unit', () => {
  const cases = [[0, '0'], [1, '1'], [98, '98'], [999, '999'], [1000, '1k'], [1234, '1.2k'], [1999, '1.9k'], [9999, '9.9k'], [10000, '10k'], [15200, '15.2k'],
    [99999, '99.9k'], [999999, '999.9k'], [1_000_000, '1M'], [1_234_567, '1.2M'], [12_000_000, '12M']];
  for (const [count, text] of cases) assert.equal(formatStarCount(count), text, String(count));
  for (const bad of [-1, 1.5, NaN, Infinity, '12', null, undefined, 2 ** 60]) assert.throws(() => formatStarCount(bad), TypeError);
});

test('star link labels contain the visible text and the exact count, and name the project and the GitHub destination', () => {
  assert.equal(starLinkLabel(1234, 'Cool Clock'), '1.2k (1,234) GitHub stars for Cool Clock. Opens the repository on GitHub.');
  assert.equal(starLinkLabel(87, 'Cool Clock'), '87 GitHub stars for Cool Clock. Opens the repository on GitHub.');
  assert.equal(starLinkLabel(1, 'Cool Clock'), '1 GitHub star for Cool Clock. Opens the repository on GitHub.');
  assert.equal(starLinkLabel(0, 'Cool Clock'), '0 GitHub stars for Cool Clock. Opens the repository on GitHub.');
  assert.equal(starLinkLabel(1000, 'X'), '1k (1,000) GitHub stars for X. Opens the repository on GitHub.');
});

// ---------------------------------------------------------------------------------------------------------------
// Reading one repository: valid, missing, malformed and unavailable answers

const target = { owner: 'fixture', repo: 'a', key: 'fixture/a' };

test('a valid answer yields the star count; zero is a real count', async () => {
  const http = fakeHttp(() => answer({ full_name: 'fixture/a', stargazers_count: 1234 }));
  assert.deepEqual(await fetchRepositoryStars(http, target), { status: 'ok', stars: 1234, full_name: 'fixture/a' });
  assert.equal(http.calls[0], 'https://api.github.com/repos/fixture/a');
  assert.deepEqual(await fetchRepositoryStars(fakeHttp(() => answer({ full_name: 'fixture/a', stargazers_count: 0 })), target), { status: 'ok', stars: 0, full_name: 'fixture/a' });
});

test('a renamed or transferred repository is linked under its current name', async () => {
  const result = await fetchRepositoryStars(fakeHttp(() => answer({ full_name: 'New-Owner/New-Name', stargazers_count: 5 })), target);
  assert.equal(result.full_name, 'New-Owner/New-Name');
  // A full_name that is not a repository name is ignored; the requested name is kept.
  assert.equal((await fetchRepositoryStars(fakeHttp(() => answer({ full_name: '../../evil', stargazers_count: 5 })), target)).full_name, 'fixture/a');
  assert.equal((await fetchRepositoryStars(fakeHttp(() => answer({ stargazers_count: 5 })), target)).full_name, 'fixture/a');
});

test('malformed answers are errors, never zero stars', async () => {
  const bodies = [
    {}, { stargazers_count: '12' }, { stargazers_count: -1 }, { stargazers_count: 1.5 }, { stargazers_count: null }, { stargazers_count: NaN },
    { stargazers_count: 2 ** 60 }, { stargazers_count: [1] }, { stargazers_count: true }, [], null, 'text',
  ];
  for (const body of bodies) {
    const result = await fetchRepositoryStars(fakeHttp(() => answer(JSON.stringify(body))), target);
    assert.equal(result.status, 'error', JSON.stringify(body));
    assert.notEqual(result.stars, 0);
  }
  assert.equal((await fetchRepositoryStars(fakeHttp(() => answer('{not json')), target)).status, 'error');
  assert.equal((await fetchRepositoryStars(fakeHttp(() => answer('')), target)).status, 'error');
  assert.equal((await fetchRepositoryStars(fakeHttp(() => answer({ stargazers_count: 5 }, { truncated: true })), target)).status, 'error');
});

test('deleted repositories are missing; every other failure is an error that keeps its transient flag', async () => {
  for (const status of [404, 410, 451]) assert.deepEqual(await fetchRepositoryStars(fakeHttp(() => failure(status)), target), { status: 'missing' });
  for (const [status, transient] of [[401, false], [403, false], [500, true], [502, true], [429, true], [0, true]]) {
    const result = await fetchRepositoryStars(fakeHttp(() => failure(status, { transient })), target);
    assert.equal(result.status, 'error', String(status));
    assert.equal(result.transient, transient);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Cache behaviour, with a stand-in GitHub API

const repoCatalog = () => catalogOf(
  project('alpha'),
  project('beta'),
  project('alpha-file', 'https://github.com/fixture/alpha/blob/main/src/main.py'),
  project('alpha-dir', 'https://github.com/Fixture/Alpha/tree/main/docs'),
  project('site', 'https://example.org/site'),
  project('gist', 'https://gist.github.com/someone/abc'),
  project('alpha-releases', 'https://github.com/fixture/alpha/releases/tag/v1'),
  project('alpha-issue', 'https://github.com/fixture/alpha/issues/1'),
);

test('each repository is requested once, however many projects point into it, and the token goes only to the API', async () => {
  const server = await startFixtureServer({ 'fixture/alpha': { stars: 42, files: {} }, 'fixture/beta': { stars: 7, files: {} } });
  try {
    const http = createHttp({ ...FAST, githubToken: 'secret-token', githubApiOrigin: new URL(server.endpoints.githubApi).origin });
    const { cache, stats } = await updateStars(repoCatalog(), emptyStarsCache(), { http, endpoints: server.endpoints, now: NOW });
    assert.deepEqual(server.requests.filter((request) => request.startsWith('/api/')).sort(), ['/api/repos/fixture/alpha', '/api/repos/fixture/beta'], 'two repositories, two requests');
    assert.deepEqual(Object.keys(cache.entries), ['fixture/alpha', 'fixture/beta']);
    assert.equal(cache.entries['fixture/alpha'].stars, 42);
    assert.equal(cache.entries['fixture/beta'].stars, 7);
    assert.equal(stats.repositories, 2);
    assert.equal(stats.projectsWithRepository, 5, 'the repository, a file, a folder and a releases link; not the issue');
    assert.equal(stats.withCount, 2);
    assert.equal(stats.requests, 2);
    assert.ok(server.authHeaders.length === 2 && server.authHeaders.every((header) => header === 'api:Bearer secret-token'));
    // Every project that points into a repository gets the same count; others get none.
    const counts = repoCatalog().projects.map((p) => starsFor(cache, p)?.count ?? null);
    assert.deepEqual(counts, [42, 7, 42, 42, null, null, 42, null]);
  } finally {
    await server.close();
  }
});

test('without a token no Authorization header is sent and the lookup still works', async () => {
  const server = await startFixtureServer({ 'fixture/alpha': { stars: 3, files: {} } });
  try {
    const http = createHttp({ ...FAST, githubApiOrigin: new URL(server.endpoints.githubApi).origin });
    const { cache } = await updateStars(catalogOf(project('alpha')), emptyStarsCache(), { http, endpoints: server.endpoints, now: NOW });
    assert.equal(cache.entries['fixture/alpha'].stars, 3);
    assert.deepEqual(server.authHeaders, []);
  } finally {
    await server.close();
  }
});

test('cached counts are reused for 24 hours and looked up again afterwards (or when a refresh is asked for)', async () => {
  const catalog = catalogOf(project('alpha'));
  const previous = cacheOf({ 'fixture/alpha': okEntry(10, NOW, 'fixture/alpha') });
  const run = (now, options = {}) => {
    const http = fakeHttp(() => answer({ full_name: 'fixture/alpha', stargazers_count: 11 }));
    return updateStars(catalog, previous, { http, now, ...options }).then((result) => ({ ...result, http }));
  };

  let result = await run(NOW + HOUR);
  assert.equal(result.http.calls.length, 0, 'an hour-old count is a cache hit');
  assert.equal(result.cache.entries['fixture/alpha'].stars, 10);
  assert.equal(result.stats.cached, 1);

  result = await run(NOW + 24 * HOUR - 1);
  assert.equal(result.http.calls.length, 0, 'just under 24 hours is still a hit');

  result = await run(NOW + 24 * HOUR);
  assert.equal(result.http.calls.length, 1, 'exactly 24 hours is expired');
  assert.equal(result.cache.entries['fixture/alpha'].stars, 11);
  assert.equal(result.cache.entries['fixture/alpha'].checked_at, new Date(NOW + 24 * HOUR).toISOString());

  result = await run(NOW + 7 * DAY);
  assert.equal(result.http.calls.length, 1, 'the weekly scheduled run finds everything expired');

  result = await run(NOW + HOUR, { refresh: true });
  assert.equal(result.http.calls.length, 1, 'refresh ignores the cache');

  assert.equal(isFreshStars(okEntry(1, NOW + HOUR), NOW), false, 'a timestamp in the future is not trusted');
  assert.equal(STAR_LIMITS.ttlHours, 24);
});

test('a failed refresh never erases a valid cached count; a deleted repository does', async () => {
  const catalog = catalogOf(project('alpha'));
  const previous = cacheOf({ 'fixture/alpha': okEntry(10, NOW - 2 * DAY, 'fixture/alpha') });
  const later = NOW;
  const logs = [];
  const refreshWith = (responder) => updateStars(catalog, previous, { http: fakeHttp(responder), now: later, log: (message) => logs.push(message) });

  for (const failureResponse of [failure(500), failure(429), failure(403, { transient: false }), failure(0, { reason: 'timeout' }), answer('{broken'), answer({ stargazers_count: 'many' })]) {
    const { cache, stats } = await refreshWith(() => failureResponse);
    assert.equal(cache.entries['fixture/alpha'].stars, 10, 'the earlier count survives');
    assert.equal(cache.entries['fixture/alpha'].checked_at, previous.entries['fixture/alpha'].checked_at, 'and is looked up again next build');
    assert.equal(stats.stale, 1);
    assert.equal(stats.fetched, 0);
  }
  assert.ok(logs.length >= 6 && logs.every((message) => /fixture\/alpha/.test(message)));

  for (const status of [404, 410, 451]) {
    const { cache, stats } = await refreshWith(() => failure(status));
    assert.equal(cache.entries['fixture/alpha'].status, 'missing', `HTTP ${status} drops the obsolete count`);
    assert.equal(cache.entries['fixture/alpha'].stars, undefined);
    assert.equal(starsFor(cache, catalog.projects[0], { now: later }), null);
    assert.equal(stats.missing, 1);
    assert.equal(stats.withCount, 0);
  }
});

test('without an earlier count a failed lookup leaves no entry: unknown, never zero', async () => {
  const catalog = catalogOf(project('alpha'));
  for (const response of [failure(500), failure(0), answer({ stargazers_count: null }), answer('<html>')]) {
    const { cache, stats } = await updateStars(catalog, emptyStarsCache(), { http: fakeHttp(() => response), now: NOW });
    assert.deepEqual(cache.entries, {});
    assert.equal(starsFor(cache, catalog.projects[0]), null);
    assert.equal(stats.withCount, 0);
    assert.equal(stats.unavailable, 1);
  }
});

test('a count that could not be refreshed is shown for at most 30 days', async () => {
  const catalog = catalogOf(project('alpha'));
  const run = (age) => updateStars(catalog, cacheOf({ 'fixture/alpha': okEntry(10, NOW - age, 'fixture/alpha') }), { http: fakeHttp(() => failure(500)), now: NOW });
  assert.equal((await run(29 * DAY)).cache.entries['fixture/alpha']?.stars, 10);
  assert.equal((await run(31 * DAY)).cache.entries['fixture/alpha'], undefined);
});

test('a deleted repository is remembered for 24 hours, then asked about again; a restored one gets its count back', async () => {
  const catalog = catalogOf(project('alpha'));
  const previous = cacheOf({ 'fixture/alpha': { checked_at: new Date(NOW).toISOString(), status: 'missing' } });
  const hit = fakeHttp(() => failure(404));
  const first = await updateStars(catalog, previous, { http: hit, now: NOW + HOUR });
  assert.equal(hit.calls.length, 0);
  assert.equal(first.cache.entries['fixture/alpha'].status, 'missing');
  const second = await updateStars(catalog, previous, { http: fakeHttp(() => answer({ full_name: 'fixture/alpha', stargazers_count: 4 })), now: NOW + 2 * DAY });
  assert.equal(second.cache.entries['fixture/alpha'].stars, 4);
});

test('rate limits are handled: no count is invented, earlier counts stay, and requests stop quickly', async () => {
  const repos = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`fixture/r${index}`, { stars: index, files: {} }]));
  const server = await startFixtureServer(repos, { rateLimitApi: true });
  try {
    const catalog = catalogOf(...Array.from({ length: 14 }, (_, index) => project(`r${index}`)));
    const previous = cacheOf({ 'fixture/r0': okEntry(99, NOW - 2 * DAY, 'fixture/r0') });
    const http = createHttp({ ...FAST, githubApiOrigin: new URL(server.endpoints.githubApi).origin });
    const logs = [];
    const { cache, stats } = await updateStars(catalog, previous, { http, endpoints: server.endpoints, now: NOW, log: (message) => logs.push(message) });
    assert.equal(stats.rateLimited, true);
    assert.equal(stats.withCount, 1);
    assert.equal(cache.entries['fixture/r0'].stars, 99, 'the cached count survives the rate limit');
    assert.deepEqual(Object.keys(cache.entries), ['fixture/r0']);
    assert.ok(stats.requests <= 6, `lookups stop once GitHub says the limit is reached (${stats.requests} requests)`);
    assert.ok(logs.some((message) => /rate/i.test(message)));
  } finally {
    await server.close();
  }
});

test('a rate limit that arrives mid-run (the quota is nearly used) stops further lookups but keeps what was read', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const remaining = calls >= 3 ? '2' : '40';
    return new Response(JSON.stringify({ full_name: `fixture/r${calls}`, stargazers_count: calls }), { status: 200, headers: { 'x-ratelimit-remaining': remaining } });
  };
  const http = createHttp({ ...FAST, fetchImpl, githubApiOrigin: 'https://api.github.com' });
  const catalog = catalogOf(...Array.from({ length: 10 }, (_, index) => project(`r${index}`)));
  const { stats, cache } = await updateStars(catalog, emptyStarsCache(), { http, now: NOW, concurrency: 1 });
  assert.equal(calls, 3);
  assert.equal(stats.rateLimited, true);
  assert.equal(Object.keys(cache.entries).length, 3);
});

test('a network that is down never fails the run, and is detected after a few failures', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  const http = createHttp({ ...FAST, retries: 0, fetchImpl, githubApiOrigin: 'https://api.github.com' });
  const catalog = catalogOf(...Array.from({ length: 12 }, (_, index) => project(`r${index}`)));
  const previous = cacheOf({ 'fixture/r1': okEntry(8, NOW - 3 * DAY, 'fixture/r1') });
  const { cache, stats } = await updateStars(catalog, previous, { http, now: NOW, concurrency: 1 });
  assert.equal(stats.networkUnavailable, true);
  assert.ok(calls <= 5, `the remaining lookups are skipped (${calls} attempts)`);
  assert.deepEqual(Object.keys(cache.entries), ['fixture/r1']);
});

test('offline mode makes no request and keeps usable cached counts', async () => {
  const catalog = catalogOf(project('alpha'), project('beta'), project('gamma'));
  const previous = cacheOf({
    'fixture/alpha': okEntry(10, NOW - 10 * DAY, 'fixture/alpha'),
    'fixture/beta': okEntry(5, NOW - 40 * DAY, 'fixture/beta'),
  });
  const http = fakeHttp(() => { throw new Error('offline mode must not make requests'); });
  const { cache, stats } = await updateStars(catalog, previous, { http, offline: true, now: NOW });
  assert.equal(http.calls.length, 0);
  assert.deepEqual(Object.keys(cache.entries), ['fixture/alpha']);
  assert.equal(stats.stale, 1);
});

test('repositories that left the catalog are dropped, and the cache is sorted so identical input gives identical bytes', async () => {
  const catalog = catalogOf(project('zeta'), project('alpha'));
  const previous = cacheOf({ 'fixture/gone': okEntry(1, NOW, 'fixture/gone'), 'fixture/zeta': okEntry(2, NOW, 'fixture/zeta') });
  const run = () => updateStars(catalog, previous, { http: fakeHttp((url) => answer({ full_name: url.endsWith('/alpha') ? 'fixture/alpha' : 'fixture/zeta', stargazers_count: 3 })), now: NOW });
  const first = await run();
  assert.deepEqual(Object.keys(first.cache.entries), ['fixture/alpha', 'fixture/zeta']);
  assert.equal(JSON.stringify((await run()).cache), JSON.stringify(first.cache));
});

// ---------------------------------------------------------------------------------------------------------------
// Cache files: recovery and safety

async function withTemporaryDirectory(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presto-stars-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a missing, damaged, outdated or hostile cache file recovers to an empty or cleaned cache', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'nested', 'stars.json');
    const warnings = [];
    const warn = (message) => warnings.push(message);
    assert.deepEqual(await readStarsCache(file, { warn }), emptyStarsCache());
    await mkdir(path.dirname(file), { recursive: true });

    await writeFile(file, '{ this is not json', 'utf8');
    assert.deepEqual(await readStarsCache(file, { warn }), emptyStarsCache());
    assert.equal(warnings.length, 1);

    await writeFile(file, JSON.stringify({ schema_version: 99, entries: { 'a/b': okEntry(1) } }), 'utf8');
    assert.deepEqual(await readStarsCache(file, { warn }), emptyStarsCache());
    await writeFile(file, 'null', 'utf8');
    assert.deepEqual(await readStarsCache(file, { warn }), emptyStarsCache());
    await writeFile(file, JSON.stringify({ schema_version: 1, entries: [] }), 'utf8');
    assert.deepEqual(await readStarsCache(file, { warn }), emptyStarsCache());

    // Bad entries are dropped one by one; good ones survive.
    await writeFile(file, JSON.stringify(cacheOf({
      'ok/repo': okEntry(5, NOW, 'ok/repo'),
      'neg/repo': okEntry(-5, NOW, 'neg/repo'),
      'str/repo': { ...okEntry(5, NOW, 'str/repo'), stars: '5' },
      'float/repo': okEntry(1.5, NOW, 'float/repo'),
      'date/repo': { ...okEntry(5, NOW, 'date/repo'), checked_at: 'yesterday' },
      'name/repo': { ...okEntry(5, NOW, 'name/repo'), full_name: '../../evil' },
      'status/repo': { checked_at: new Date(NOW).toISOString(), status: 'zero' },
      'Upper/Repo': okEntry(5, NOW, 'Upper/Repo'),
      'noslash': okEntry(5, NOW, 'noslash'),
      'gone/repo': { checked_at: new Date(NOW).toISOString(), status: 'missing', stars: 123 },
    })), 'utf8');
    const cache = await readStarsCache(file, { warn });
    assert.deepEqual(Object.keys(cache.entries).sort(), ['gone/repo', 'ok/repo']);
    assert.equal(cache.entries['gone/repo'].stars, undefined, 'a missing repository carries no count');
  });
});

test('a cache path that cannot be read or replaced is a pipeline failure, not a silent reset', async () => {
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(readStarsCache(directory), PipelineError); // a directory
    const blocked = path.join(directory, 'file-not-folder');
    await writeFile(blocked, 'x', 'utf8');
    await assert.rejects(writeStarsCache(path.join(blocked, 'stars.json'), emptyStarsCache()), PipelineError);
    const file = path.join(directory, 'stars.json');
    await writeStarsCache(file, cacheOf({ 'a/b': okEntry(1, NOW, 'a/b') }));
    assert.equal((await readStarsCache(file)).entries['a/b'].stars, 1);
  });
});

test('only valid, non-negative integer counts for a repository are ever displayed', () => {
  const p = project('alpha');
  const show = (entries) => starsFor(cacheOf(entries), p, { now: NOW });
  assert.equal(show({ 'fixture/alpha': okEntry(5, NOW, 'fixture/alpha') }).count, 5);
  assert.equal(show({ 'fixture/alpha': okEntry(0, NOW, 'fixture/alpha') }).count, 0);
  assert.equal(show({ 'fixture/alpha': okEntry(1234, NOW, 'Other/Name') }).url, 'https://github.com/Other/Name');
  assert.equal(show({ 'fixture/alpha': okEntry(1234, NOW, 'fixture/alpha') }).formatted, '1.2k');
  for (const bad of [-1, 1.5, NaN, '5', null, undefined, 2 ** 60]) assert.equal(show({ 'fixture/alpha': { ...okEntry(5, NOW, 'fixture/alpha'), stars: bad } }), null);
  assert.equal(show({ 'fixture/alpha': { checked_at: new Date(NOW).toISOString(), status: 'missing' } }), null);
  assert.equal(show({}), null);
  // A count that was not refreshed for 30 days is not presented as current, however the cache got that old.
  const aged = (age) => starsFor(cacheOf({ 'fixture/alpha': okEntry(5, NOW - age, 'fixture/alpha') }), p, { now: NOW });
  assert.equal(aged(29 * DAY)?.count, 5);
  assert.equal(aged(30 * DAY), null);
  assert.equal(aged(-HOUR), null, 'a timestamp in the future is not trusted');
  assert.equal(starsFor(null, p), null);
  assert.equal(starsFor(emptyStarsCache(), project('site', 'https://example.org/x')), null);
  assert.equal(starsFor(cacheOf({ 'someone/abc': okEntry(5, NOW, 'someone/abc') }), project('gist', 'https://gist.github.com/someone/abc')), null);
  assert.deepEqual(sanitizeStarsCache(undefined), emptyStarsCache());
});

// ---------------------------------------------------------------------------------------------------------------
// Sorting

const card = (title, stars, extra = {}) => ({ dataset: { id: `id-${title}`, title, category: 'c', categoryName: 'C', badges: '', search: title.toLowerCase(), ...(stars === undefined ? {} : { stars: String(stars) }), ...extra } });
const order = (cards, options) => filterAndSortCards(cards, { sortBy: 'stars', ...options }).map((item) => item.dataset.title);

test('sorting by stars lists known counts first (highest first), then unknown, with deterministic ties', () => {
  const cards = [card('Delta'), card('Alpha', 5), card('Echo'), card('Bravo', 50), card('Charlie', 5), card('Zero', 0)];
  assert.deepEqual(order(cards), ['Bravo', 'Alpha', 'Charlie', 'Zero', 'Delta', 'Echo']);
  // The result never depends on the current order of the input.
  assert.deepEqual(order([...cards].reverse()), ['Bravo', 'Alpha', 'Charlie', 'Zero', 'Delta', 'Echo']);
  // Equal counts and equal titles fall back to the project ID.
  const twins = [card('Twin', 5, { id: 'b' }), card('Twin', 5, { id: 'a' })];
  assert.deepEqual(filterAndSortCards(twins, { sortBy: 'stars' }).map((item) => item.dataset.id), ['a', 'b']);
  assert.deepEqual(filterAndSortCards([...twins].reverse(), { sortBy: 'stars' }).map((item) => item.dataset.id), ['a', 'b']);
  assert.deepEqual(order([]), []);
});

test('malformed or missing star data counts as unknown, never as zero', () => {
  const cards = [card('Zero', 0), card('Broken', 'lots'), card('Negative', -4), card('Fraction', 1.5), card('Empty', ''), card('None'), card('Real', 3)];
  assert.deepEqual(order(cards), ['Real', 'Zero', 'Broken', 'Empty', 'Fraction', 'Negative', 'None']);
});

test('sorting by stars works together with search, category and badge filters, and other sorts are unchanged', () => {
  const cards = [
    card('Clock A', 10, { category: 'clocks', categoryName: 'Clocks', badges: 'NEW', search: 'clock a clocks' }),
    card('Clock B', 99, { category: 'clocks', categoryName: 'Clocks', badges: '', search: 'clock b clocks' }),
    card('Clock C', undefined, { category: 'clocks', categoryName: 'Clocks', badges: 'NEW', search: 'clock c clocks' }),
    card('Game D', 500, { category: 'games', categoryName: 'Games', badges: 'NEW', search: 'game d games' }),
    card('Game E', undefined, { category: 'games', categoryName: 'Games', badges: '', search: 'game e games' }),
  ];
  assert.deepEqual(order(cards), ['Game D', 'Clock B', 'Clock A', 'Clock C', 'Game E']);
  assert.deepEqual(order(cards, { category: 'clocks' }), ['Clock B', 'Clock A', 'Clock C']);
  assert.deepEqual(order(cards, { badge: 'NEW' }), ['Game D', 'Clock A', 'Clock C']);
  assert.deepEqual(order(cards, { query: 'clock', badge: 'NEW' }), ['Clock A', 'Clock C']);
  assert.deepEqual(order(cards, { category: 'games', query: 'game e' }), ['Game E']);
  assert.deepEqual(order(cards, { query: 'nothing' }), []);
  // The existing sorts do not look at stars.
  assert.deepEqual(filterAndSortCards(cards).map((item) => item.dataset.title), ['Clock A', 'Clock B', 'Clock C', 'Game D', 'Game E']);
  assert.deepEqual(filterAndSortCards(cards, { sortBy: 'category' }).map((item) => item.dataset.title), ['Clock A', 'Clock B', 'Clock C', 'Game D', 'Game E']);
});

// ---------------------------------------------------------------------------------------------------------------
// The build script, end to end: README-only additions, no token, failures, and an untouched catalog

function runNode(args, env) {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ACTIONS', 'PRESTO_GITHUB_STARS', 'PRESTO_STARS_REFRESH', 'PRESTO_STARS_BUDGET_SECONDS', 'PRESTO_DEV_PORT', 'PRESTO_DEV_HOST']) delete clean[name];
    const child = spawn(process.execPath, args, { cwd: site, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

const fixtureReadme = (...lines) => ['# Fixture', '', '<!-- catalog:start -->', '', '### Things', '', ...lines, '', '<!-- catalog:end -->', ''].join('\n');

test('a project added to the README alone gets a star count; the catalog and its IDs never depend on stars', async () => {
  const server = await startFixtureServer({ 'fixture/one': { stars: 1500, files: {} }, 'fixture/two': { stars: 3, files: {} } });
  try {
    await withTemporaryDirectory(async (directory) => {
      const readme = path.join(directory, 'README.md');
      const catalogFile = path.join(directory, 'catalog.json');
      const starFile = path.join(directory, 'stars.json');
      const env = { PRESTO_README: readme, PRESTO_CATALOG_FILE: catalogFile, PRESTO_STARS_CACHE: starFile, PRESTO_GITHUB_API_URL: server.endpoints.githubApi, PRESTO_IMAGE_ALLOW_LOCAL: '1' };
      const base = ['- [One](https://github.com/fixture/one) — First project.'];
      const catalogRun = () => runNode(['scripts/build-catalog.mjs'], env);

      await writeFile(readme, fixtureReadme(...base), 'utf8');
      let result = await catalogRun();
      assert.equal(result.status, 0, result.stderr);
      const catalogBefore = await readFile(catalogFile, 'utf8');
      result = await runNode(['scripts/fetch-stars.mjs'], env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 of 1 GitHub repositories have a star count/);
      assert.equal(await readFile(catalogFile, 'utf8'), catalogBefore, 'fetching stars does not touch the catalog');
      assert.doesNotMatch(catalogBefore, /star/i, 'the catalog carries no star data');
      assert.equal(JSON.parse(await readFile(starFile, 'utf8')).entries['fixture/one'].stars, 1500);

      // README-only addition: one more line, nothing else changes.
      await writeFile(readme, fixtureReadme(...base, '- [Two](https://github.com/fixture/two/tree/main/docs) — Second project.', '- [Plain](https://example.org/plain) — No repository.'), 'utf8');
      result = await catalogRun();
      assert.equal(result.status, 0, result.stderr);
      const catalogAfter = JSON.parse(await readFile(catalogFile, 'utf8'));
      const before = JSON.parse(catalogBefore);
      assert.equal(catalogAfter.projects.find((p) => p.title === 'One').id, before.projects[0].id, 'existing IDs are stable');
      server.requests.length = 0;
      result = await runNode(['scripts/fetch-stars.mjs', '--report'], env);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(server.requests, ['/api/repos/fixture/two'], 'only the new repository is looked up; the other is a cache hit');
      assert.match(result.stdout, /\n1500\s+\| One \|/);
      assert.match(result.stdout, /\n3\s+\| Two \|/);
      assert.match(result.stdout, /\nn\/a\s+\| Plain \|/);
      assert.equal(JSON.stringify(JSON.parse(await readFile(catalogFile, 'utf8'))), JSON.stringify(catalogAfter), 'the catalog is the same after fetching stars');

      // Reproducible: regenerating the catalog gives the same bytes whatever the star cache holds.
      const first = await readFile(catalogFile, 'utf8');
      await rm(starFile);
      result = await catalogRun();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(catalogFile, 'utf8'), first);
    });
  } finally {
    await server.close();
  }
});

test('the star step needs no token, never fails on lookup problems, and stops only for pipeline failures', async () => {
  const server = await startFixtureServer({ 'fixture/one': { stars: 1, files: {} } });
  try {
    await withTemporaryDirectory(async (directory) => {
      const readme = path.join(directory, 'README.md');
      const catalogFile = path.join(directory, 'catalog.json');
      const starFile = path.join(directory, 'stars.json');
      const env = { PRESTO_README: readme, PRESTO_CATALOG_FILE: catalogFile, PRESTO_STARS_CACHE: starFile, PRESTO_GITHUB_API_URL: server.endpoints.githubApi, PRESTO_IMAGE_ALLOW_LOCAL: '1' };
      await writeFile(readme, fixtureReadme('- [One](https://github.com/fixture/one) — First.', '- [Gone](https://github.com/fixture/gone) — Deleted.'), 'utf8');
      assert.equal((await runNode(['scripts/build-catalog.mjs'], env)).status, 0);

      let result = await runNode(['scripts/fetch-stars.mjs'], env);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(server.authHeaders, [], 'no token, no Authorization header');
      assert.match(result.stderr, /fixture\/gone was not found/);
      const cache = JSON.parse(await readFile(starFile, 'utf8'));
      assert.equal(cache.entries['fixture/gone'].status, 'missing');

      // Lookups switched off: no request, cache kept.
      server.requests.length = 0;
      result = await runNode(['scripts/fetch-stars.mjs', '--refresh'], { ...env, PRESTO_GITHUB_STARS: 'off' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(server.requests, []);
      assert.equal(JSON.parse(await readFile(starFile, 'utf8')).entries['fixture/one'].stars, 1);

      // GitHub unreachable: exit 0, earlier counts kept (refresh forces a lookup).
      result = await runNode(['scripts/fetch-stars.mjs', '--refresh'], { ...env, PRESTO_GITHUB_API_URL: 'http://localhost:9/api' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /network unavailable|unavailable/);
      assert.equal(JSON.parse(await readFile(starFile, 'utf8')).entries['fixture/one'].stars, 1);

      // A damaged cache is recovered with a warning.
      await writeFile(starFile, '{damaged', 'utf8');
      result = await runNode(['scripts/fetch-stars.mjs'], env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /damaged/);
      assert.equal(JSON.parse(await readFile(starFile, 'utf8')).entries['fixture/one'].stars, 1);

      // GitHub failing with a server error or a rate limit: exit 0, a count younger than 30 days is kept, an older one is not.
      const aged = (days) => writeFile(starFile, JSON.stringify(cacheOf({ 'fixture/one': okEntry(9, Date.now() - days * DAY, 'fixture/one') })), 'utf8');
      for (const [label, repos, options] of [['HTTP 500', { 'fixture/one': { stars: { status: 500 }, files: {} } }, {}], ['rate limit', { 'fixture/one': { stars: 1, files: {} } }, { rateLimitApi: true }]]) {
        const failing = await startFixtureServer(repos, options);
        try {
          const failingEnv = { ...env, PRESTO_GITHUB_API_URL: failing.endpoints.githubApi };
          await aged(10);
          result = await runNode(['scripts/fetch-stars.mjs'], { ...failingEnv, PRESTO_STARS_REFRESH: '1' });
          assert.equal(result.status, 0, `${label}: ${result.stderr}`);
          assert.equal(JSON.parse(await readFile(starFile, 'utf8')).entries['fixture/one'].stars, 9, `${label}: the 10 day old count is kept`);
          await aged(40);
          result = await runNode(['scripts/fetch-stars.mjs'], { ...failingEnv, PRESTO_STARS_REFRESH: '1' });
          assert.equal(result.status, 0, `${label}: ${result.stderr}`);
          assert.equal(JSON.parse(await readFile(starFile, 'utf8')).entries['fixture/one'], undefined, `${label}: a 40 day old count is not kept, and is not turned into zero`);
        } finally {
          await failing.close();
        }
      }
      await writeFile(starFile, JSON.stringify(cache), 'utf8');

      // Pipeline failures: bad configuration, a missing catalog, a cache path that is a directory.
      assert.equal((await runNode(['scripts/fetch-stars.mjs'], { ...env, PRESTO_GITHUB_STARS: 'maybe' })).status, 1);
      assert.equal((await runNode(['scripts/fetch-stars.mjs'], { ...env, PRESTO_GITHUB_API_URL: 'not a url' })).status, 1);
      assert.equal((await runNode(['scripts/fetch-stars.mjs'], { ...env, PRESTO_STARS_BUDGET_SECONDS: '0' })).status, 1);
      assert.equal((await runNode(['scripts/fetch-stars.mjs'], { ...env, PRESTO_CATALOG_FILE: path.join(directory, 'absent.json') })).status, 1);
      assert.equal((await runNode(['scripts/fetch-stars.mjs'], { ...env, PRESTO_STARS_CACHE: directory })).status, 1);
    });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Built page and card component

const unescapeHtml = (text) => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the built page shows a star link exactly where the build cache has a known count', async () => {
  const { outDir, catalogFile, starCacheFile } = await import('../site-config.mjs');
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  const cache = sanitizeStarsCache(JSON.parse(await readFile(starCacheFile, 'utf8')));
  const cards = html.split('<li class="project-card"').slice(1);
  assert.equal(cards.length, catalog.projects.length);
  let shown = 0;
  for (const markup of cards) {
    const id = markup.match(/data-id="([^"]+)"/)[1];
    const expected = starsFor(cache, catalog.projects.find((p) => p.id === id));
    const link = markup.match(/<a class="star-link"[^>]*>/);
    if (!expected) {
      assert.equal(link, null, `${id} must not show stars`);
      assert.doesNotMatch(markup, /data-stars=/);
      continue;
    }
    shown += 1;
    assert.ok(link, `${id} must show stars`);
    assert.ok(link[0].includes(`href="${expected.url}"`));
    assert.match(link[0], /target="_blank"/);
    assert.match(link[0], /rel="noopener noreferrer"/);
    assert.equal(unescapeHtml(link[0].match(/aria-label="([^"]*)"/)[1]), expected.label);
    assert.ok(markup.includes(`data-stars="${expected.count}"`));
    assert.ok(markup.includes(`>${expected.formatted}</span>`));
  }
  assert.equal(html.includes('value="stars"'), shown > 0, 'the sort option exists exactly when some count is known');
  assert.doesNotMatch(html, /api\.github\.com/, 'the page never talks to the GitHub API');
});

test('the card component renders the star link as an accessible, external, keyboard-reachable anchor only for known counts', async () => {
  const card = await readFile(path.join(site, 'src', 'components', 'ProjectCard.astro'), 'utf8');
  assert.match(card, /\{stars && \(/);
  assert.match(card, /<a class="star-link" href=\{stars\.url\} target="_blank" rel="noopener noreferrer" aria-label=\{stars\.label\} title=\{stars\.title\}>/);
  assert.match(card, /<svg aria-hidden="true"/);
  assert.match(card, /data-stars=\{stars \? String\(stars\.count\) : undefined\}/);
  assert.doesNotMatch(card, /tabindex/i);
  assert.doesNotMatch(card, /heart|favorite|favourite|like/i, 'GitHub stars are not the deferred gallery hearts');
  const page = await readFile(path.join(site, 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(page, /\{hasStars && <option value="stars">GitHub stars<\/option>\}/);
  assert.match(page, /<option value="name">Name<\/option>/);
  assert.doesNotMatch(page, /GitHub stars<\/option>[\s\S]*<option value="name"/, 'the default sort stays first');
  assert.doesNotMatch(page, /fetch\(|api\.github\.com/, 'the browser never calls GitHub');
});
