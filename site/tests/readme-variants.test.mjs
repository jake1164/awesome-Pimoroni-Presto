import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { categoriesOf, joinReadme, splitReadme, variants, withoutCategory } from '../e2e/readme-variant-builders.mjs';

// The README-variant runner (e2e/readme-variants.mjs, `npm run test:readme-variants`) must work for any valid README, not
// only for today's. Its variants are pure functions (e2e/readme-variant-builders.mjs), so this test applies every one of them to
// several READMEs, including ones without Games, without Clocks and with a single category, and has the real catalog
// generator accept each result. The browser run itself is `npm run test:readme-variants` (optionally with
// PRESTO_VARIANT_SOURCE pointing at another README).
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(site, '..');
const readmePath = path.join(repositoryRoot, 'README.md');
const generator = path.join(repositoryRoot, 'tools', 'readme_catalog.py');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3');

async function catalogOf(text) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presto-variants-'));
  try {
    const readme = path.join(directory, 'README.md');
    const output = path.join(directory, 'catalog.json');
    await writeFile(readme, text, 'utf8');
    const result = spawnSync(python, [...(python === 'py' ? ['-3'] : []), generator, '--readme', readme, '--output', output], { encoding: 'utf8', cwd: repositoryRoot });
    assert.equal(result.status, 0, `the catalog generator rejected the README: ${result.stderr}`);
    return JSON.parse(await readFile(output, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const real = await readFile(readmePath, 'utf8');
const realCategories = categoriesOf(splitReadme(real).body);

/** Only the first category that has projects: a valid single-category README. */
function singleCategory(text) {
  const parts = splitReadme(text);
  const keep = categoriesOf(parts.body).find((category) => category.projects > 0);
  return joinReadme({ ...parts, body: ['', ...parts.body.slice(keep.start, keep.end), ''] });
}

const scenarios = [
  { name: 'the current README', text: real },
  { name: 'a README without Games', text: withoutCategory(real, 'Games') },
  { name: 'a README without Clocks (category and clock projects)', text: withoutCategory(real, 'Clocks') },
  { name: 'a README without Games and Clocks', text: withoutCategory(withoutCategory(real, 'Games') ?? real, 'Clocks') },
  { name: 'a single-category README', text: singleCategory(real) },
  { name: 'a single-category, single-project README', text: variants['one category, one project'](real) },
];

for (const scenario of scenarios) {
  test(`every README variant stays valid for ${scenario.name}`, async (t) => {
    if (scenario.text === null) return t.skip('this README has no such category today');
    const base = await catalogOf(scenario.text);
    const populated = categoriesOf(splitReadme(scenario.text).body).filter((category) => category.projects > 0).length;
    for (const [name, build] of Object.entries(variants)) {
      const changed = build(scenario.text);
      if (typeof changed !== 'string') {
        assert.ok(changed.skip, `${name}: a skipped variant says why`);
        assert.ok(populated < 2 && /two categories/.test(changed.skip), `${name} may only be skipped for a README with fewer than two populated categories`);
        continue;
      }
      const catalog = await catalogOf(changed);
      assert.ok(catalog.categories.length > 0, `${name}: still has a category`);
      if (name === 'a whole category disappears') {
        assert.equal(catalog.categories.length, base.categories.length - 1, name);
        assert.ok(catalog.projects.length > 0 && catalog.projects.length < base.projects.length, name);
      }
      if (name === 'a category named All') {
        assert.ok(catalog.categories.some((category) => category.name.toLowerCase() === 'all'), name);
        assert.equal(catalog.categories.length, base.categories.length, name);
        assert.equal(catalog.projects.length, base.projects.length, name);
      }
      if (name === 'a project added to the README only') assert.equal(catalog.projects.length, base.projects.length + 1, name);
      if (name === 'no NEW or RECENT badges') {
        assert.equal(catalog.projects.length, base.projects.length, name);
        assert.ok(catalog.projects.every((project) => project.badges.length === 0), name);
      }
      if (name === 'one category, one project') assert.deepEqual([catalog.categories.length, catalog.projects.length], [1, 1], name);
      if (name === 'every description shares a word') assert.ok(catalog.projects.every((project) => /everywhere/i.test(project.description)), name);
    }
  });
}

test('the variants name no category and the runner reads no hard-coded one', async () => {
  const builders = await readFile(path.join(site, 'e2e', 'readme-variant-builders.mjs'), 'utf8');
  const runner = await readFile(path.join(site, 'e2e', 'readme-variants.mjs'), 'utf8');
  for (const category of realCategories) {
    assert.ok(!builders.includes(`'${category.name}'`) && !builders.includes(`### ${category.name}`), `the builders must not name "${category.name}"`);
    assert.ok(!runner.includes(`'${category.name}'`) && !runner.includes(`### ${category.name}`), `the runner must not name "${category.name}"`);
  }
  assert.doesNotMatch(runner, /has no ".*" category/);
});

test('applying the variants never writes to the real README', async () => {
  const before = await readFile(readmePath, 'utf8');
  for (const build of Object.values(variants)) build(before);
  assert.equal(await readFile(readmePath, 'utf8'), before);
  assert.equal(before, real);
});
