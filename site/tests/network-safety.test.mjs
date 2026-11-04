import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHttp, emptyCache, updateCache, usableImages } from '../src/lib/image-discovery.mjs';
import { addressProblem, pinnedGet } from '../src/lib/safe-network.mjs';
import { makePng, startFixtureServer } from './support/fixture-server.mjs';

// Project URLs come from README contributions. Whatever they say, a build must not contact services on the build
// machine or its network. These tests use real sockets: a "protected service" is a local HTTP server that counts every
// request, and each scenario must leave that count at zero.
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = '93.184.216.34';

async function listen(handler, { host = '127.0.0.1', port = 0, secure = null } = {}) {
  const requests = [];
  const wrapped = (request, response) => {
    requests.push({ url: request.url, host: request.headers.host });
    handler(request, response);
  };
  const server = secure ? https.createServer(secure, wrapped) : http.createServer(wrapped);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
const reply = (body = 'secret', type = 'text/plain') => (_request, response) => { response.writeHead(200, { 'content-type': type }); response.end(body); };

/** A resolver stand-in: host name to addresses. Unknown names fail like NXDOMAIN. */
const names = (table) => async (host) => {
  if (!table[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
/**
 * A transport stand-in that runs after the policy: the address the policy validated (a "public" one, so the test needs no
 * internet) is replaced by the local fixture server, and every connection is recorded. If the policy let a private
 * destination through, the protected local server would receive the request.
 */
const routedToLocal = (calls) => (url, init) => {
  calls.push({ host: url.hostname, addresses: init.addresses.map(({ address }) => address) });
  return pinnedGet(url, { ...init, addresses: [{ address: '127.0.0.1', family: 4 }] });
};

// ---------------------------------------------------------------------------------------------------------------
// Address classification

test('non-public IPv4 and IPv6 addresses are refused, including mapped, NAT64 and 6to4 forms; public ones are not', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:a9fe:a9fe::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1',
    'ff02::1', 'ff0e::1', '2001::1', '2001:1::1', '2001:db8::1', '3fff::1', '100::1', '5f00::1', 'abcd::1',
  ];
  for (const address of blocked) assert.ok(addressProblem(address), `${address} must be refused`);
  const allowed = [
    '8.8.8.8', '1.1.1.1', PUBLIC, '140.82.112.3', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.3.1', '198.17.255.255',
    '198.20.0.1', '223.255.255.255', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '2001:4860:4860::8888', '2001:200::1',
    '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::',
  ];
  for (const address of allowed) assert.equal(addressProblem(address), null, `${address} must be accepted`);
  assert.ok(addressProblem('example.org'));
  assert.ok(addressProblem('1.2.3'));
});

test('the test-fixture allowance admits loopback only: every other private, link-local and reserved range stays refused', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) assert.equal(addressProblem(address, { allowLoopback: true }), null, address);
  for (const address of ['10.0.0.1', '192.168.0.1', '169.254.169.254', '172.16.0.1', '100.64.0.1', '0.0.0.0', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.ok(addressProblem(address, { allowLoopback: true }), `${address} must stay refused`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Direct requests

test('loopback and private destinations are refused before any connection: the protected service gets zero requests', async () => {
  const secret = await listen(reply());
  try {
    const port = secret.port;
    const urls = [
      `http://127.0.0.1:${port}/internal-api`, `http://127.1:${port}/`, `http://2130706433:${port}/`, `http://0x7f.0.0.1:${port}/`,
      `http://0.0.0.0:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://[::ffff:7f00:1]:${port}/`, `http://[::1]:${port}/`,
      `http://localhost:${port}/internal-api`, `http://LOCALHOST:${port}/`,
    ];
    for (const url of urls) {
      const client = createHttp({ retries: 0, timeoutMs: 3000 }); // production defaults: real DNS, pinned transport, no private hosts
      const result = await client.get(url);
      assert.equal(result.ok, false, url);
      assert.equal(result.blocked, true, `${url}: ${result.reason}`);
      assert.match(result.reason, /destination not allowed/);
      assert.equal(client.state.requests, 0, url);
    }
    assert.deepEqual(secret.requests, [], 'the protected service must not have been contacted');
  } finally {
    await secret.close();
  }
});

test('private IP literals, other schemes and URLs with credentials never reach a transport', async () => {
  const calls = [];
  const client = createHttp({
    retries: 0,
    resolve: async () => { throw new Error('IP literals must not be resolved'); },
    transport: async (url) => { calls.push(url.href); throw new Error('must not connect'); },
  });
  const urls = [
    'http://10.0.0.1/', 'http://10.255.255.255/', 'http://100.64.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://172.16.0.1/', 'http://172.31.0.1/',
    'http://192.168.0.1/', 'http://192.0.0.1/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://240.0.0.1/', 'http://255.255.255.255/',
    'http://[::]/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[ff02::1]/',
    'http://[::ffff:10.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:a00:1::]/', 'http://[2001:db8::1]/',
    'file:///etc/passwd', 'ftp://example.org/', 'gopher://example.org/', 'http://user:pass@8.8.8.8/', 'https://user@example.org/',
  ];
  for (const url of urls) {
    const result = await client.get(url);
    assert.equal(result.blocked, true, `${url}: ${result.reason}`);
  }
  assert.deepEqual(calls, []);
  assert.equal(client.state.requests, 0);
  assert.equal(client.state.blocked, urls.length);
});

test('host names are resolved by the client and every resolved address must be public (IPv4, IPv6, mapped, mixed answers)', async () => {
  const secret = await listen(reply());
  try {
    const table = {
      'internal.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'], 'private.example': ['10.1.2.3'], 'six.example': ['::1'],
      'mapped.example': ['::ffff:7f00:1'], 'nat64.example': ['64:ff9b::7f00:1'], 'ula.example': ['fd00::5'], 'mixed.example': [PUBLIC, '127.0.0.1'],
      'mixed6.example': ['2606:4700:4700::1111', '::1'],
    };
    const client = createHttp({ retries: 0, resolve: names(table) }); // the default pinned transport: a real socket would be opened
    for (const host of Object.keys(table)) {
      const result = await client.get(`http://${host}:${secret.port}/internal-api`);
      assert.equal(result.blocked, true, `${host}: ${result.reason}`);
      assert.match(result.reason, new RegExp(host.replace('.', '\\.')));
    }
    assert.equal(client.state.requests, 0);
    assert.deepEqual(secret.requests, []);
  } finally {
    await secret.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Redirects, public destinations, final URLs

async function redirectingSite() {
  const front = await listen((request, response) => {
    const url = new URL(request.url, 'http://front');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: url.searchParams.get('to') });
      return response.end();
    }
    if (url.pathname === '/loop') {
      response.writeHead(302, { location: '/loop' });
      return response.end();
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end('front ok');
  });
  return front;
}

test('every redirect hop is validated before connecting; redirects to private destinations never reach them', async () => {
  const front = await redirectingSite();
  const secret = await listen(reply());
  try {
    const calls = [];
    const logs = [];
    const table = { 'front.example': [PUBLIC], 'other-public.example': ['8.8.8.8'], 'secret.example': ['10.0.0.5'] };
    const client = createHttp({ retries: 0, resolve: names(table), transport: routedToLocal(calls), log: (message) => logs.push(message) });
    const targets = [
      `http://secret.example:${secret.port}/internal-api`,
      `http://127.0.0.1:${secret.port}/internal-api`,
      `http://[::ffff:127.0.0.1]:${secret.port}/`,
      `http://[::1]:${secret.port}/`,
      `//127.0.0.1:${secret.port}/protocol-relative`,
      'http://169.254.169.254/latest/meta-data/',
      'http://[fd00::1]/',
      `http://user:pw@front.example:${front.port}/ok`,
      'file:///etc/passwd',
      'ftp://front.example/',
    ];
    for (const target of targets) {
      const result = await client.get(`http://front.example:${front.port}/redirect?to=${encodeURIComponent(target)}`);
      assert.equal(result.ok, false, target);
      assert.equal(result.blocked, true, `${target}: ${result.reason}`);
    }
    // A longer chain: public host, public host, then private.
    const inner = `http://other-public.example:${front.port}/redirect?to=${encodeURIComponent(`http://secret.example:${secret.port}/chained`)}`;
    const chained = await client.get(`http://front.example:${front.port}/redirect?to=${encodeURIComponent(inner)}`);
    assert.equal(chained.blocked, true, chained.reason);

    assert.deepEqual(secret.requests, [], 'the protected service must not have been contacted');
    assert.ok(calls.length > 0 && calls.every((call) => ['front.example', 'other-public.example'].includes(call.host)), JSON.stringify(calls));
    assert.ok(logs.some((message) => /request refused/.test(message)), 'a refused request is reported');
  } finally {
    await front.close();
    await secret.close();
  }
});

test('public destinations still work, redirects are followed, and the result carries the final URL', async () => {
  const front = await redirectingSite();
  try {
    const calls = [];
    const client = createHttp({ retries: 0, resolve: names({ 'front.example': [PUBLIC], 'other-public.example': ['8.8.8.8'] }), transport: routedToLocal(calls) });
    const direct = await client.get(`http://front.example:${front.port}/ok`);
    assert.equal(direct.ok, true);
    assert.equal(direct.body.toString(), 'front ok');
    assert.equal(direct.url, `http://front.example:${front.port}/ok`);

    const followed = await client.get(`http://front.example:${front.port}/redirect?to=${encodeURIComponent(`http://other-public.example:${front.port}/ok#fragment`)}`);
    assert.equal(followed.ok, true);
    assert.equal(followed.url, `http://other-public.example:${front.port}/ok`);
    assert.deepEqual(calls.map((call) => call.host), ['front.example', 'front.example', 'other-public.example']);
    assert.deepEqual(calls[0].addresses, [PUBLIC]); // the connection used the validated address
    assert.equal(front.requests.at(-1).host, `other-public.example:${front.port}`); // and kept the intended Host header

    const relative = await client.get(`http://front.example:${front.port}/redirect?to=/ok`);
    assert.equal(relative.url, `http://front.example:${front.port}/ok`);
  } finally {
    await front.close();
  }
});

test('redirects, response sizes, time and request counts are bounded', async () => {
  const front = await redirectingSite();
  const endless = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => response.write('x'.repeat(8192)), 1);
    response.on('close', () => clearInterval(timer));
  });
  const silent = await listen(() => { /* never answers */ });
  try {
    const local = { retries: 0, allowPrivateHosts: true };
    const loop = await createHttp({ ...local, maxRedirects: 3 }).get(`http://127.0.0.1:${front.port}/loop`);
    assert.equal(loop.ok, false);
    assert.equal(loop.reason, 'too many redirects');
    assert.equal(front.requests.filter((request) => request.url === '/loop').length, 4); // the first request plus three redirects

    const big = await createHttp(local).get(`http://127.0.0.1:${endless.port}/`, { maxBytes: 20_000 });
    assert.equal(big.ok, true);
    assert.equal(big.truncated, true);
    assert.ok(big.body.length <= 20_000);

    const slow = await createHttp({ ...local, timeoutMs: 300 }).get(`http://127.0.0.1:${silent.port}/`);
    assert.equal(slow.ok, false);
    assert.equal(slow.reason, 'timeout');

    const limited = createHttp({ ...local, maxRequests: 2 });
    await limited.get(`http://127.0.0.1:${front.port}/ok`);
    await limited.get(`http://127.0.0.1:${front.port}/ok`);
    const third = await limited.get(`http://127.0.0.1:${front.port}/ok`);
    assert.equal(third.reason, 'request limit reached');
  } finally {
    await front.close();
    await endless.close();
    await silent.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// DNS rebinding and TLS

test('DNS rebinding cannot change where a validated connection goes', async (t) => {
  const front = await listen(reply('front'));
  let rebound;
  try {
    rebound = await listen(reply('SECRET'), { host: '127.0.0.2', port: front.port });
  } catch {
    await front.close();
    t.skip('127.0.0.2 is not available on this machine');
    return;
  }
  const originalLookup = dns.lookup;
  try {
    // From now on the system resolver (what an unpinned connection by name would use) answers with the "rebound" address.
    dns.lookup = (hostname, options, callback) => {
      if (typeof options === 'function') [options, callback] = [{}, options];
      return options?.all ? callback(null, [{ address: '127.0.0.2', family: 4 }]) : callback(null, '127.0.0.2', 4);
    };
    // Control: connecting by name really does follow the rebound answer, so this setup would catch an unpinned client.
    await new Promise((resolve) => http.get(`http://rebind.example:${front.port}/`, { agent: false }, (response) => { response.resume(); response.on('end', resolve); }).on('error', resolve));
    assert.equal(rebound.requests.length, 1, 'control: an unpinned request follows the rebound DNS answer');
    assert.equal(front.requests.length, 0);
    rebound.requests.length = 0;

    // The client validated 127.0.0.1 (allowed here as the fixture address); the second, rebound answer must never be used.
    const client = createHttp({ retries: 0, allowPrivateHosts: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const result = await client.get(`http://rebind.example:${front.port}/`);
    assert.equal(result.ok, true);
    assert.equal(result.body.toString(), 'front');
    assert.equal(front.requests.length, 1);
    assert.equal(front.requests[0].host, `rebind.example:${front.port}`, 'the Host header keeps the intended name');
    assert.deepEqual(rebound.requests, [], 'the rebound address must not have been contacted');
  } finally {
    dns.lookup = originalLookup;
    await front.close();
    await rebound.close();
  }
});

test('TLS verification uses the URL host name, not the pinned address', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presto-tls-'));
  try {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=secure.example', '-addext', 'subjectAltName=DNS:secure.example'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (made.error || made.status !== 0) {
      t.skip('openssl is not available to create a throwaway test certificate');
      return;
    }
    const credentials = { key: await readFile(key), cert: await readFile(cert) };
    const server = await listen(reply('secure ok'), { secure: credentials });
    try {
      const client = createHttp({ retries: 0, allowPrivateHosts: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], tlsOptions: { ca: credentials.cert } });
      const good = await client.get(`https://secure.example:${server.port}/`);
      assert.equal(good.ok, true, good.reason);
      assert.equal(good.body.toString(), 'secure ok');
      assert.equal(server.requests[0].host, `secure.example:${server.port}`);
      // The same socket address, but a name the certificate does not cover: the handshake must fail, before any request.
      const wrong = await client.get(`https://other.example:${server.port}/`);
      assert.equal(wrong.ok, false);
      assert.match(wrong.reason, /network error \(ERR_TLS_CERT_ALTNAME_INVALID\)/);
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The whole discovery pipeline

test('no discovery path bypasses the policy: project pages, redirects, README images, explicit URLs and GitHub endpoints', async () => {
  const secret = await listen(reply('SECRET', 'image/png'));
  const S = secret.port;
  const page = await listen((request, response) => {
    const url = new URL(request.url, 'http://page');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: url.searchParams.get('to') });
      return response.end();
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(`<html><head><meta property="og:image" content="https://secret.example:${S}/og.png"></head><body><img src="http://127.0.0.1:${S}/shot.png" alt="Screenshot"></body></html>`);
  });
  const fixture = await startFixtureServer({
    'fixture/readme-private': { files: { 'README.md': `![Screenshot](https://secret.example:${S}/shot.png)\n![Screenshot](http://127.0.0.1:${S}/loopback.png)\n![Screenshot of it](images/real.png)\n`, 'images/real.png': makePng(640, 400) } },
    'fixture/plain': { files: { 'README.md': 'nothing', 'photo.png': makePng(640, 400, [0, 0, 0], { noise: true }) } },
  });
  const id = (name) => `presto_${createHash('sha256').update(name).digest('hex')}`;
  const project = (name, url, image) => ({ id: id(name), title: name, url, ...(image ? { image } : {}) });
  try {
    const standIn = `stand-in.example:${new URL(fixture.origin).port}`;
    const calls = [];
    const table = { 'front.example': [PUBLIC], 'stand-in.example': ['8.8.8.8'], 'secret.example': ['10.0.0.5'] };
    const logs = [];
    const client = createHttp({ retries: 0, resolve: names(table), transport: routedToLocal(calls), log: (message) => logs.push(message) });
    const projects = [
      project('page-with-private-images', `http://front.example:${page.port}/page`),
      project('redirect-to-loopback', `http://front.example:${page.port}/redirect?to=${encodeURIComponent(`http://127.0.0.1:${S}/internal-api`)}`),
      project('redirect-to-private-name', `http://front.example:${page.port}/redirect?to=${encodeURIComponent(`http://secret.example:${S}/internal-api`)}`),
      project('loopback-literal', `http://127.0.0.1:${S}/internal-api`),
      project('private-name', `http://secret.example:${S}/internal-api`),
      project('metadata-service', 'http://169.254.169.254/latest/meta-data/'),
      project('readme-private-images', 'https://github.com/fixture/readme-private'),
      project('explicit-private-url', 'https://github.com/fixture/plain', { mode: 'url', value: `https://secret.example:${S}/x.png` }),
      project('explicit-loopback-url', 'https://github.com/fixture/plain', { mode: 'url', value: `https://127.0.0.1:${S}/x.png` }),
    ];
    const endpoints = { githubRaw: `http://${standIn}/raw`, githubApi: `http://${standIn}/api`, githubWeb: `http://${standIn}/web` };
    const { cache } = await updateCache({ projects }, emptyCache(), { http: client, endpoints, allowPrivateHosts: false, log: (message) => logs.push(message) });

    assert.deepEqual(secret.requests, [], 'the protected service must not have been contacted by any path');
    assert.ok(client.state.blocked > 0);
    assert.ok(calls.every((call) => ['front.example', 'stand-in.example'].includes(call.host)), JSON.stringify(calls));
    const plain = projects.filter((item) => !/readme-private|explicit/.test(item.title));
    for (const item of plain) assert.equal(cache.entries[item.id]?.image ?? null, null, `${item.title} must not get an image`);
    for (const entry of Object.values(cache.entries)) assert.ok(!entry.image || !String(entry.image.url).includes(`:${S}`), 'no image URL may point at the protected service');
    assert.equal(usableImages(cache, projects).has(id('explicit-private-url')), true, 'a failed explicit URL falls back to normal discovery'); // the plain repository has a photo
    assert.equal(cache.entries[id('explicit-private-url')].directive.outcome, 'failed');
    assert.equal(cache.entries[id('explicit-loopback-url')].directive.outcome, 'failed');

    // GitHub endpoints that point at a private host get the same treatment.
    const privateGithub = { githubRaw: `http://secret.example:${S}/raw`, githubApi: `http://secret.example:${S}/api`, githubWeb: `http://secret.example:${S}/web` };
    const hinted = project('github-private-endpoints', 'https://github.com/fixture/plain', { mode: 'hint', value: 'shots/' });
    const second = await updateCache({ projects: [hinted] }, emptyCache(), { http: client, endpoints: privateGithub, allowPrivateHosts: false });
    assert.equal(second.cache.entries[hinted.id]?.image ?? null, null);
    assert.deepEqual(secret.requests, []);
  } finally {
    await page.close();
    await fixture.close();
    await secret.close();
  }
});

test('the star lookup obeys the same policy: a GitHub API endpoint on a private host is never contacted', async () => {
  const { updateStars } = await import('../src/lib/github-stars.mjs');
  const secret = await listen(reply('{"stargazers_count": 5}', 'application/json'));
  try {
    const client = createHttp({ retries: 0, resolve: names({ 'api.secret.example': ['127.0.0.1'] }) });
    const endpoints = { githubApi: `http://api.secret.example:${secret.port}`, githubWeb: 'https://github.com', githubRaw: 'https://raw.githubusercontent.com' };
    const catalog = { projects: [{ id: 'presto_a', title: 'A', url: 'https://github.com/o/r' }] };
    const { cache, stats } = await updateStars(catalog, { entries: {} }, { http: client, endpoints });
    assert.deepEqual(secret.requests, []);
    assert.equal(stats.withCount, 0);
    assert.deepEqual(cache.entries, {});
  } finally {
    await secret.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Ordinary builds (no test-fixture switch) and the shape of the code

function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(site, 'scripts', script)], { cwd: site, env: { ...process.env, GITHUB_ACTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('an ordinary build (no fixture switch) refuses README URLs that point at local services and still exits successfully', async () => {
  const secret = await listen(reply('SECRET', 'text/html'));
  const area = await mkdtemp(path.join(os.tmpdir(), 'presto-ssrf-'));
  try {
    const id = (name) => `presto_${createHash('sha256').update(name).digest('hex')}`;
    const projects = [
      { id: id('a'), title: 'Loopback', url: `http://127.0.0.1:${secret.port}/internal-api` },
      { id: id('b'), title: 'Localhost', url: `http://localhost:${secret.port}/internal-api` },
      { id: id('c'), title: 'Mapped', url: `http://[::ffff:7f00:1]:${secret.port}/` },
      { id: id('d'), title: 'Repository', url: 'https://github.com/o/r' },
    ];
    await writeFile(path.join(area, 'catalog.json'), JSON.stringify({ schema_version: 1, projects }));
    const env = { PRESTO_CATALOG_FILE: path.join(area, 'catalog.json'), PRESTO_IMAGE_CACHE: path.join(area, 'images.json'), PRESTO_STARS_CACHE: path.join(area, 'stars.json') };

    const images = await runNode('discover-images.mjs', { ...env, PRESTO_IMAGE_ALLOW_LOCAL: '', PRESTO_GITHUB_RAW_URL: `http://127.0.0.1:${secret.port}/raw`, PRESTO_GITHUB_API_URL: `http://127.0.0.1:${secret.port}/api`, PRESTO_GITHUB_WEB_URL: `http://127.0.0.1:${secret.port}/web` });
    assert.equal(images.code, 0, images.output);
    assert.match(images.output, /request refused/);
    assert.match(images.output, /0 of 4 projects have an image/);

    const stars = await runNode('fetch-stars.mjs', { ...env, PRESTO_IMAGE_ALLOW_LOCAL: '', PRESTO_GITHUB_API_URL: `http://127.0.0.1:${secret.port}/api` });
    assert.equal(stars.code, 0, stars.output);
    assert.match(stars.output, /request refused/);

    assert.deepEqual(secret.requests, [], 'the protected service must not have been contacted');
  } finally {
    await secret.close();
    await rm(area, { recursive: true, force: true });
  }
});

test('only the shared client opens connections, and no build script weakens the policy', async () => {
  const strip = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
  const files = [];
  for (const directory of ['src/lib', 'scripts']) for (const name of await readdir(path.join(site, directory))) if (name.endsWith('.mjs')) files.push(`${directory}/${name}`);
  assert.ok(files.length >= 5);
  for (const file of files) {
    const code = strip(await readFile(path.join(site, file), 'utf8'));
    if (file !== 'src/lib/safe-network.mjs') {
      assert.doesNotMatch(code, /from 'node:(https?|net|tls|dgram|dns|http2)'|from 'undici'/, `${file} must not import a network module`);
      assert.doesNotMatch(code, /(^|[^.\w])fetch\(|globalThis\.fetch|XMLHttpRequest|WebSocket/, `${file} must not open connections itself`);
    }
    if (file.startsWith('scripts/')) {
      assert.doesNotMatch(code, /\b(fetchImpl|transport|resolve|tlsOptions)\s*:/, `${file} must not replace the transport, resolver or TLS settings`);
    }
  }
  // The private-host allowance is read from the explicit test switch only, in the two build scripts that talk to the network.
  for (const file of ['scripts/discover-images.mjs', 'scripts/fetch-stars.mjs']) {
    assert.match(await readFile(path.join(site, file), 'utf8'), /allowPrivateHosts: process\.env\.PRESTO_IMAGE_ALLOW_LOCAL === '1'/);
  }
});
