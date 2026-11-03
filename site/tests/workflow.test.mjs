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
