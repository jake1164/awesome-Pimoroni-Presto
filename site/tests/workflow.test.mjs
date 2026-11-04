import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowText = () => readFile(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

function job(workflow, name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `job ${name} must exist`);
  return match[1];
}

test('Pages workflow gates build on the reusable catalog validation job and the tests', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /uses: \.\/\.github\/workflows\/catalog\.yml/);
  const build = job(workflow, 'build');
  assert.match(build, /needs: catalog-validation/);
  assert.match(build, /actions\/download-artifact@v4/);
  assert.match(build, /name: presto-catalog/);
  assert.match(build, /PRESTO_CATALOG_ARTIFACT: src\/data\/catalog\.json/);
  for (const step of ['npm ci', 'npm run build', 'npm test', 'npx playwright install', 'npm run test:browser']) {
    assert.ok(build.includes(step), `build job must run ${step}`);
  }
  assert.ok(build.indexOf('npm run build') < build.indexOf('npm run test:browser'), 'browser tests need the production build first');
  assert.doesNotMatch(workflow, /paths:/);
  // The catalog workflow already runs the Python suite; the site build must not repeat it.
  assert.doesNotMatch(build, /unittest/);
});

test('Pages workflow validates pull requests but only deploys main', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /^on:\n  pull_request:/m);
  const build = job(workflow, 'build');
  assert.match(build, /actions\/upload-pages-artifact@v3/);
  assert.ok(build.indexOf('npm run test:browser') < build.indexOf('actions/upload-pages-artifact@v3'), 'browser tests must pass before the Pages artifact exists');
  assert.ok(build.indexOf('npm test') < build.indexOf('actions/upload-pages-artifact@v3'));
  assert.match(build, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);

  const deploy = job(workflow, 'deploy');
  assert.match(deploy, /needs: \[catalog-validation, build\]/);
  assert.match(deploy, /github\.event_name != 'pull_request'/);
  assert.match(deploy, /github\.ref == 'refs\/heads\/main'/);
  assert.match(deploy, /actions\/deploy-pages@v4/);
  assert.match(deploy, /pages: write/);
  assert.match(deploy, /id-token: write/);
});

test('Pages workflow never cancels a deployment and keeps permissions minimal', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
  const top = workflow.split(/^jobs:/m)[0];
  assert.match(top, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(job(workflow, 'build'), /pages: write|id-token: write/);
});

test('Pages workflow caches discovered project images and star counts and treats the GitHub token as optional', async () => {
  const workflow = await workflowText();
  const build = job(workflow, 'build');
  assert.match(build, /uses: actions\/cache@v4/);
  assert.match(build, /path: site\/\.cache/);
  assert.match(build, /key: gallery-cache-\$\{\{ github\.run_id \}\}/);
  assert.match(build, /restore-keys: gallery-cache-\n/);
  assert.match(build, /Restore generated build cache \(project images, GitHub stars\)/);
  assert.ok(build.indexOf('actions/cache@v4') < build.indexOf('npm run build'), 'the cache must be restored before the build');
  // The token only raises a rate limit: it comes from the built-in token, with no secret to configure.
  assert.match(build, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /secrets\./);
  // Image discovery cannot fail the build, so no step may depend on it.
  const script = await readFile(path.join(root, 'site', 'scripts', 'discover-images.mjs'), 'utf8');
  assert.match(script, /process\.exitCode = 0/);
  assert.doesNotMatch(script, /GITHUB_TOKEN[^\n]*(throw|exit\(1\))/);
  // Neither does the star step: both live in the one restored directory, and the token is optional there too.
  const stars = await readFile(path.join(root, 'site', 'scripts', 'fetch-stars.mjs'), 'utf8');
  assert.match(stars, /process\.exitCode = 0/);
  assert.doesNotMatch(stars, /GITHUB_TOKEN[^\n]*(throw|exit\(1\))/);
  assert.doesNotMatch(stars.split('\n').filter((line) => !line.startsWith('//')).join('\n'), /process\.exit\(/);
  const { starCacheFile, imageCacheFile } = await import('../site-config.mjs');
  assert.equal(path.dirname(starCacheFile), path.dirname(imageCacheFile), 'one cache directory, one cache step');
  assert.equal(path.basename(path.dirname(starCacheFile)), '.cache');
});

test('weekly scheduled refresh runs the full validation and tests, keeps deploy restrictions, and always deploys what it built', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /^  schedule:\n    - cron: '\d+ \d+ \* \* \d'$/m, 'one weekly cron entry');
  const cron = workflow.match(/- cron: '([^']+)'/)[1].split(' ');
  assert.equal(cron.length, 5);
  assert.deepEqual(cron.slice(2, 4), ['*', '*'], 'weekly: only the weekday is fixed');
  assert.match(cron[4], /^[0-6]$/);

  // No job or step skips validation or tests for scheduled runs; the schedule changes only the image refresh.
  const build = job(workflow, 'build');
  assert.match(build, /needs: catalog-validation/);
  assert.doesNotMatch(workflow.replace(/^\s*PRESTO_IMAGE_REFRESH: .*$/m, ''), /github\.event_name == 'schedule'/);
  for (const step of ['npm run build', 'npm test', 'npm run test:browser']) assert.ok(build.includes(step));

  // The same deploy restrictions as a push, with no extra condition that could silently skip a deployment.
  assert.match(build, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'\n/);
  assert.match(job(workflow, 'deploy'), /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main' && github\.repository == 'jake1164\/awesome-Pimoroni-Presto'\n/);
  assert.doesNotMatch(workflow, /steps\.changed|needs\.build\.outputs|outputs:/);

  // The old "compare with the live page" shortcut is gone: it needed the network, depended on the Pages URL and on
  // byte-identical output, and star counts make a skip rare anyway.
  assert.doesNotMatch(workflow, /curl|sha256sum|LIVE_URL|github\.io/);
  assert.doesNotMatch(workflow, /Detect whether/);

  // Scheduled runs refresh images, use the same cache, the built-in token and minimal permissions.
  assert.match(build, /PRESTO_IMAGE_REFRESH: \$\{\{ github\.event_name == 'schedule' && '1' \|\| '' \}\}/);
  assert.match(build, /uses: actions\/cache@v4/);
  assert.doesNotMatch(workflow, /secrets\./);
  const top = workflow.split(/^jobs:/m)[0];
  assert.match(top, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(build, /contents: write|pages: write|id-token: write/);
  assert.doesNotMatch(workflow, /git (add|commit|push)/, 'generated image and star data is never committed');
});

test('star counts are refreshed by the normal build: expired data is looked up again, with no extra permission, step or secret', async () => {
  const workflow = await workflowText();
  const build = job(workflow, 'build');
  const packageJson = JSON.parse(await readFile(path.join(root, 'site', 'package.json'), 'utf8'));
  assert.match(packageJson.scripts.build, /fetch-stars\.mjs/);
  assert.equal(workflow.match(/npm run build/g).length, 1, 'one build, which includes the star step');
  assert.doesNotMatch(workflow, /fetch-stars|stars:report/, 'no separate workflow step to maintain');
  // The build job stays read-only, with the built-in token, and pull requests build the same way without deploying.
  assert.match(build, /permissions:\n      contents: read\n/);
  assert.doesNotMatch(build, /(issues|pull-requests|actions|checks|statuses|packages|id-token|pages): (read|write)/);
  assert.match(workflow, /^on:\n  pull_request:/m);
  assert.match(build, /if: github\.event_name != 'pull_request'/);
  // The 24 hour rule that makes the weekly run refresh a restored cache lives in the library.
  const { STAR_LIMITS } = await import('../src/lib/github-stars.mjs');
  assert.equal(STAR_LIMITS.ttlHours, 24);
});
