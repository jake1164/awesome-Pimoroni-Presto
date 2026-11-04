import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from './readme-variant-builders.mjs';

// Proves that the live-site browser tests (e2e/gallery.spec.mjs) do not depend on what the README contains today:
//   npm run test:readme-variants            run every variant
//   npm run test:readme-variants -- clocks  run the variants whose name contains "clocks"
// Each variant is a changed copy of the real README.md in a temporary directory. The site is built from it (catalog,
// no network, no image or star lookups) into the same directory and the desktop and mobile browser tests run against that
// build. The real README, catalog, caches and `dist/` are never read for writing, so there is nothing to restore.
// The variants (and the rule that none of them names a category) live in e2e/readme-variant-builders.mjs.
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The variants are derived from the real README by default. PRESTO_VARIANT_SOURCE names another README to derive them from
// (for example a copy without a category), which proves the runner does not depend on what the real one contains.
const sourcePath = process.env.PRESTO_VARIANT_SOURCE ? path.resolve(process.env.PRESTO_VARIANT_SOURCE) : path.join(site, '..', 'README.md');
const realReadme = await readFile(sourcePath, 'utf8');
const run = (command, args, env) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: site, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  child.on('exit', (code) => resolve({ code: code ?? 1, output }));
});

const filter = process.argv.slice(2).join(' ').toLowerCase();
const selected = Object.entries(variants).filter(([name]) => name.toLowerCase().includes(filter));
if (selected.length === 0) {
  console.error(`No variant matches "${filter}". Variants: ${Object.keys(variants).join('; ')}`);
  process.exitCode = 1;
} else {
  const results = [];
  let index = 0;
  for (const [name, mutate] of selected) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'presto-variant-'));
    const env = {
      ...process.env,
      PRESTO_README: path.join(directory, 'README.md'),
      PRESTO_CATALOG_FILE: path.join(directory, 'catalog.json'),
      PRESTO_OUT_DIR: path.join(directory, 'dist'),
      PRESTO_IMAGE_CACHE: path.join(directory, 'image-cache.json'),
      PRESTO_STARS_CACHE: path.join(directory, 'star-cache.json'),
      PRESTO_IMAGE_DISCOVERY: 'off',
      PRESTO_GITHUB_STARS: 'off',
      PRESTO_E2E_VARIANT: '1',
      PRESTO_E2E_PORT: String(8780 + index),
      ASTRO_TELEMETRY_DISABLED: '1',
    };
    index += 1;
    let outcome = 'passed';
    let detail = '';
    try {
      const changed = mutate(realReadme);
      if (typeof changed !== 'string') {
        outcome = 'skipped';
        detail = changed.skip;
        results.push({ name, outcome, detail });
        console.log(`${outcome.padEnd(13)} ${name} (${detail})`);
        continue;
      }
      await writeFile(env.PRESTO_README, changed, 'utf8');
      for (const args of [['scripts/build-catalog.mjs'], ['scripts/fetch-stars.mjs'], ['scripts/discover-images.mjs'], ['node_modules/astro/astro.js', 'build']]) {
        const step = await run(process.execPath, args, env);
        if (step.code !== 0) { outcome = 'BUILD FAILED'; detail = step.output.slice(-1500); break; }
      }
      if (outcome === 'passed') {
        const catalog = JSON.parse(await readFile(env.PRESTO_CATALOG_FILE, 'utf8'));
        detail = `${catalog.projects.length} projects in ${catalog.categories.length} categories`;
        const tests = await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/gallery.spec.mjs', '--project=desktop', '--project=mobile', '--reporter=line'], env);
        const summary = tests.output.match(/\d+ (passed|failed|skipped|did not run).*$/gm)?.join(', ') ?? '';
        detail += summary ? `; ${summary}` : '';
        if (tests.code !== 0) { outcome = 'TESTS FAILED'; detail += `\n${tests.output.slice(-2500)}`; }
      }
    } catch (error) {
      outcome = 'ERROR';
      detail = error.message;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    results.push({ name, outcome, detail });
    console.log(`${outcome.padEnd(13)} ${name} (${detail.split('\n')[0]})`);
    if (outcome !== 'passed' && outcome !== 'skipped') console.log(detail.split('\n').slice(1).join('\n'));
  }
  if (results.some((result) => !['passed', 'skipped'].includes(result.outcome))) process.exitCode = 1;
}
