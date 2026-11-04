import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePng, startFixtureServer } from '../tests/support/fixture-server.mjs';

// Builds and serves the synthetic site for the browser tests (see playwright.config.mjs):
//   1. writes the synthetic README (e2e/synthetic-readme.mjs) into `.synthetic/`,
//   2. starts a local stand-in for GitHub holding the fixture repositories that README points to,
//   3. runs the normal build (catalog, image discovery, Astro) against it, with no cache and no network,
//   4. makes one fixture image disappear, as an upstream image can after a build,
//   5. serves the result with `astro preview` and keeps the fixture server running for the browser.
// `stars` on a fixture repository is what the stand-in GitHub API answers for it (see tests/support/fixture-server.mjs):
// a count, a failure (500), a malformed body, or nothing (404, a deleted repository: large-image and forced-icon).
// The real catalog, caches and `dist/` are never touched.
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const synthetic = path.join(site, '.synthetic');
const fixturePort = Number(process.env.PRESTO_E2E_FIXTURE_PORT ?? 8773);
const previewPort = Number(process.env.PRESTO_E2E_SYNTHETIC_PORT ?? 8772);
const readme = (text) => `# Fixture\n\n${text}\n`;

const fixture = await startFixtureServer({
  'fixture/with-image': { stars: 1234, files: { 'README.md': readme('![Presto showing the demo](images/demo.png)'), 'images/demo.png': makePng(640, 400, [40, 120, 200]) } },
  'fixture/no-image': { stars: 87, files: { 'README.md': readme('Only text, and a badge: ![build](https://img.shields.io/badge/build-passing-green.svg)') } },
  'fixture/rejected-image': { stars: 0, files: { 'README.md': readme('![Screenshot](images/gone.png)\n![Screenshot](images/tiny.png)'), 'images/tiny.png': makePng(8, 8) } },
  'fixture/runtime-missing': { stars: { status: 500 }, files: { 'README.md': readme('![Screenshot of the app](images/shot.png)'), 'images/shot.png': makePng(640, 400, [200, 120, 40]) } },
  'fixture/large-image': { files: { 'README.md': readme('![Presto photo](photo.png)'), 'photo.png': makePng(3000, 2000, [60, 160, 90]) } },
  'fixture/hinted': { stars: 87, files: { 'README.md': readme('![Readme picture](images/readme.png)'), 'images/readme.png': makePng(640, 400, [90, 90, 200]), 'shots/hero.png': makePng(300, 200, [20, 20, 20], { noise: true }) } },
  'fixture/hint-fallback': { stars: 15200, files: { 'README.md': readme('![Readme picture](images/readme.png)'), 'images/readme.png': makePng(640, 400, [200, 90, 200]) } },
  'fixture/forced-icon': { files: { 'README.md': readme('![Readme picture](images/readme.png)'), 'images/readme.png': makePng(640, 400, [90, 200, 90]) } },
  'fixture/tall-image': { stars: { body: '{"stargazers_count":"many"}' }, files: { 'README.md': readme('![Presto photo](photo.png)'), 'photo.png': makePng(500, 1300, [160, 60, 160]) } },
}, { port: fixturePort });

const env = {
  ...process.env,
  PRESTO_README: '.synthetic/README.md',
  PRESTO_CATALOG_FILE: '.synthetic/catalog.json',
  PRESTO_OUT_DIR: '.synthetic/dist',
  PRESTO_IMAGE_CACHE: '.synthetic/image-cache.json',
  PRESTO_STARS_CACHE: '.synthetic/star-cache.json',
  PRESTO_GITHUB_RAW_URL: fixture.endpoints.githubRaw,
  PRESTO_GITHUB_API_URL: fixture.endpoints.githubApi,
  PRESTO_GITHUB_WEB_URL: fixture.endpoints.githubWeb,
  PRESTO_IMAGE_ALLOW_LOCAL: '1',
};

rmSync(path.join(synthetic, 'image-cache.json'), { force: true });
rmSync(path.join(synthetic, 'star-cache.json'), { force: true });
mkdirSync(synthetic, { recursive: true });
// Asynchronous on purpose: a blocking spawn would also block this process's fixture server, which the build needs.
const run = (command, args = []) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: site, env, stdio: 'inherit', shell: args.length === 0 });
  child.on('exit', (code) => resolve(code ?? 1));
});
for (const [command, args] of [[process.execPath, ['e2e/synthetic-readme.mjs']], ['npm run build', []]]) {
  const status = await run(command, args);
  if (status !== 0) {
    await fixture.close();
    process.exit(status);
  }
}
fixture.hide('images/shot.png'); // valid when the site was built, a 404 when the browser asks for it

const preview = spawn(process.execPath, [path.join(site, 'node_modules', 'astro', 'astro.js'), 'preview', '--host', '127.0.0.1', '--port', String(previewPort)], { cwd: site, env, stdio: 'inherit' });
const stop = async () => {
  preview.kill();
  await fixture.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
preview.on('exit', stop);
