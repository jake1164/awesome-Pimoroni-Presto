import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { base, defaultDevHost, defaultDevPort, devServerOptions } from '../site-config.mjs';

// `npm run dev -- --host H --port P` does not work on every Windows setup: npm's argument forwarding loses the flags, and
// Astro then tries its default port 4321, which Windows may reserve (EACCES). `npm run dev` therefore needs no arguments:
// host and port come from the Astro configuration, which reads PRESTO_DEV_HOST and PRESTO_DEV_PORT.
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file) => JSON.parse(await readFile(path.join(site, file), 'utf8'));
const withoutDevSettings = () => {
  const env = { ...process.env };
  delete env.PRESTO_DEV_HOST;
  delete env.PRESTO_DEV_PORT;
  return env;
};

test('the development server defaults to localhost port 8088, which Windows does not reserve like 4321', () => {
  assert.equal(defaultDevHost, 'localhost');
  assert.equal(defaultDevPort, 8088);
  assert.deepEqual(devServerOptions({}), { host: 'localhost', port: 8088 });
  assert.deepEqual(devServerOptions({ PRESTO_DEV_PORT: '', PRESTO_DEV_HOST: '' }), { host: 'localhost', port: 8088 });
  assert.notEqual(devServerOptions({}).port, 4321);
});

test('host and port can be configured through the environment, and bad values are refused with a clear message', () => {
  assert.deepEqual(devServerOptions({ PRESTO_DEV_PORT: '9000' }), { host: 'localhost', port: 9000 });
  assert.deepEqual(devServerOptions({ PRESTO_DEV_HOST: '127.0.0.1', PRESTO_DEV_PORT: '8765' }), { host: '127.0.0.1', port: 8765 });
  assert.deepEqual(devServerOptions({ PRESTO_DEV_HOST: '0.0.0.0' }), { host: '0.0.0.0', port: 8088 });
  assert.deepEqual(devServerOptions({ PRESTO_DEV_HOST: '::1' }), { host: '::1', port: 8088 });
  // cmd.exe: `set PRESTO_DEV_PORT=9000 && npm run dev` leaves a trailing space in the value.
  assert.deepEqual(devServerOptions({ PRESTO_DEV_PORT: '9000 ', PRESTO_DEV_HOST: '127.0.0.1 ' }), { host: '127.0.0.1', port: 9000 });
  for (const port of ['0', '65536', '-1', '80.5', 'abc', '80 80', '1e3x']) assert.throws(() => devServerOptions({ PRESTO_DEV_PORT: port }), /PRESTO_DEV_PORT/, port);
  for (const host of ['bad host', 'a;b', 'x&y', '$HOME']) assert.throws(() => devServerOptions({ PRESTO_DEV_HOST: host }), /PRESTO_DEV_HOST/, host);
});

test('the Astro configuration applies that host and port to astro dev and astro preview without command-line flags', async () => {
  const configured = (env) => {
    const result = spawnSync(process.execPath, ['-e', "import('./astro.config.mjs').then((m) => console.log(JSON.stringify(m.default.server)))"], { cwd: site, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(configured(withoutDevSettings()), { host: 'localhost', port: 8088 });
  assert.deepEqual(configured({ ...withoutDevSettings(), PRESTO_DEV_PORT: '9123', PRESTO_DEV_HOST: '127.0.0.1' }), { host: '127.0.0.1', port: 9123 });
  const source = await readFile(path.join(site, 'astro.config.mjs'), 'utf8');
  assert.match(source, /server: devServerOptions\(\)/);
});

test('package scripts work in cmd.exe, PowerShell and POSIX shells without relying on npm argument forwarding', async () => {
  const { scripts } = await readJson('package.json');
  for (const name of ['dev', 'build', 'preview']) {
    const script = scripts[name];
    assert.ok(script, `${name} script exists`);
    assert.doesNotMatch(script, /--port|--host|\s--\s/, `${name} must not need forwarded or hard-coded flags`);
    assert.doesNotMatch(script, /(^|&&\s*)[A-Za-z_]+=\S/, `${name} must not use POSIX-only VAR=value prefixes`);
    assert.doesNotMatch(script, /\$[A-Za-z{(]|`|\bcross-env\b|;/, `${name} must use only commands every shell understands`);
  }
  assert.match(scripts.dev, /&& astro dev$/);
  assert.equal(scripts.preview, 'astro preview');
  // Star counts are collected after the catalog and before images and Astro, in both the dev and production builds.
  for (const name of ['dev', 'build']) {
    const order = ['build-catalog', 'fetch-stars', 'discover-images', 'astro'].map((step) => scripts[name].indexOf(step));
    assert.ok(order.every((index) => index >= 0) && order.every((index, position) => position === 0 || index > order[position - 1]), `${name} runs its steps in order`);
  }
});

test('the browser-test servers are started without npm argument forwarding', async () => {
  const code = async (...parts) => (await readFile(path.join(site, ...parts), 'utf8')).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const playwright = await code('playwright.config.mjs');
  assert.doesNotMatch(playwright, /npm run [\w:-]+ --/);
  assert.match(playwright, /node node_modules\/astro\/astro\.js preview --host 127\.0\.0\.1 --port/);
  const synthetic = await code('e2e', 'synthetic-site.mjs');
  assert.doesNotMatch(synthetic, /npm run [\w:-]+ --/);
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('astro dev started with no arguments serves the site on the configured port', { timeout: 120_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join('node_modules', 'astro', 'astro.js'), 'dev'], {
    cwd: site,
    env: { ...withoutDevSettings(), PRESTO_DEV_PORT: String(port), PRESTO_DEV_HOST: 'localhost', ASTRO_TELEMETRY_DISABLED: '1', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => child.once('exit', () => resolve('exited')));
  try {
    const root = `${base.replace(/\/$/, '')}/`;
    let response = null;
    for (let attempt = 0; attempt < 100 && !response; attempt += 1) {
      const outcome = await Promise.race([
        fetch(`http://localhost:${port}${root}`).then((result) => result, () => null),
        exited,
      ]);
      if (outcome === 'exited') assert.fail(`astro dev exited early:\n${output}`);
      if (outcome) response = outcome;
      else await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(response, `astro dev did not answer on port ${port}:\n${output}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Awesome Presto/);
    assert.doesNotMatch(output, /EACCES|4321/);
  } finally {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
});
