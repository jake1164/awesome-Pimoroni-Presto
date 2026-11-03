import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterAndSortCards, renderResultCount } from '../src/scripts/catalog-controls.js';
import { outDir } from '../site-config.mjs';

const siteDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(siteDirectory, '..');
const generator = path.join(repositoryRoot, 'tools', 'readme_catalog.py');
// Both default to the real README and `dist/`; the overrides let a different README build be verified.
const readmeUnderTest = process.env.PRESTO_README ? path.resolve(process.env.PRESTO_README) : path.join(repositoryRoot, 'README.md');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3');

function runGenerator(readmePath, outputPath) {
  const args = python === 'py' ? ['-3'] : [];
  return spawnSync(python, [...args, generator, '--readme', readmePath, '--output', outputPath], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  });
}

test('catalog generator writes projects, ordered categories, stable IDs and structured descriptions', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'presto-catalog-'));
  try {
    const output = path.join(temporary, 'catalog.json');
    const result = runGenerator(readmeUnderTest, output);
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(catalog.projects.length > 0);
    assert.ok(catalog.categories.length > 0);
    assert.equal(new Set(catalog.projects.map((project) => project.id)).size, catalog.projects.length);
    assert.ok(catalog.categories.every((category) => category.slug && category.name));
    assert.ok(catalog.projects.every((project) => Array.isArray(project.description_parts)));

    const builtPage = path.join(outDir, 'index.html');
    assert.ok(existsSync(builtPage), 'production build must generate dist/index.html before npm test');
    const html = await readFile(builtPage, 'utf8');
    assert.equal((html.match(/class="project-card"/g) ?? []).length, catalog.projects.length);
    for (const project of catalog.projects) assert.ok(html.includes(`data-id="${project.id}"`));
    for (const category of catalog.categories) assert.ok(html.includes(`data-category="${category.slug}"`));
    // Badges are editorial and may be absent entirely, so the expected count comes from the catalog itself.
    const badgeCount = catalog.projects.reduce((sum, project) => sum + project.badges.length, 0);
    assert.equal((html.match(/class="project-badge"/g) ?? []).length, badgeCount);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('badges parse from README entries and render on cards, with fixtures independent of the live README', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'presto-badges-'));
  try {
    const readme = path.join(temporary, 'README.md');
    const output = path.join(temporary, 'catalog.json');
    await writeFile(readme, [
      '# Fixture',
      '<!-- catalog:start -->',
      '### Things',
      '- [Plain](https://example.org/plain) — No badge.',
      '- [Fresh](https://example.org/fresh) — Has a badge. ![NEW](badges/new.svg)',
      '- [Older](https://example.org/older) — Has a badge. ![RECENT](badges/recent.svg)',
      '<!-- catalog:end -->',
      '',
    ].join('\n'), 'utf8');
    const result = runGenerator(readme, output);
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(await readFile(output, 'utf8'));
    const badgesByTitle = Object.fromEntries(catalog.projects.map((project) => [project.title, project.badges]));
    assert.deepEqual(badgesByTitle, { Plain: [], Fresh: ['NEW'], Older: ['RECENT'] });
    const card = await readFile(path.join(siteDirectory, 'src', 'components', 'ProjectCard.astro'), 'utf8');
    assert.match(card, /project\.badges\.length > 0/);
    assert.match(card, /project\.badges\.map\(\(badge\) => <span class="project-badge">\{badge\}<\/span>\)/);
    assert.match(card, /data-badges=\{project\.badges\.join\(','\)\}/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('README-only project addition and removal are reflected in generated catalog', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'presto-readme-mutation-'));
  try {
    const source = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const inserted = '- [Phase 2 Test Entry](https://example.invalid/phase-2-test-entry) — Catalog integration test.\n';
    const marker = '<!-- catalog:end -->';
    assert.ok(source.includes(marker));
    const mutated = source.replace(marker, `${inserted}${marker}`);
    assert.notEqual(mutated, source);
    const readme = path.join(temporary, 'README.md');
    const output = path.join(temporary, 'catalog.json');
    await writeFile(readme, mutated, 'utf8');
    let result = runGenerator(readme, output);
    assert.equal(result.status, 0, result.stderr);
    let catalog = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(catalog.projects.some((project) => project.title === 'Phase 2 Test Entry'));

    await writeFile(readme, source, 'utf8');
    result = runGenerator(readme, output);
    assert.equal(result.status, 0, result.stderr);
    catalog = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(!catalog.projects.some((project) => project.title === 'Phase 2 Test Entry'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('invalid README fails and leaves no stale generated catalog', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'presto-invalid-'));
  try {
    const readme = path.join(temporary, 'README.md');
    const output = path.join(temporary, 'catalog.json');
    await writeFile(readme, '# Invalid\n<!-- catalog:start -->\n### Category\n- [Unsafe](javascript:alert(1))\n<!-- catalog:end -->\n', 'utf8');
    await writeFile(output, '{"old":true}\n', 'utf8');
    const result = runGenerator(readme, output);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(output, 'utf8'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('cards render structured description links only as escaped text and safe http(s) anchors', async () => {
  const card = await readFile(path.join(siteDirectory, 'src', 'components', 'ProjectCard.astro'), 'utf8');
  assert.match(card, /project\.description_parts\.map/);
  assert.match(card, /safeHttpUrl\(part\.url\)/);
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(card, /set:html|innerHTML/);
});

test('site components never inject untrusted HTML', async () => {
  const files = [
    path.join(siteDirectory, 'src', 'pages', 'index.astro'),
    path.join(siteDirectory, 'src', 'components', 'ProjectCard.astro'),
    path.join(siteDirectory, 'src', 'layouts', 'Layout.astro'),
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /set:html|innerHTML/);
  }
});

test('gallery interaction source covers search, dynamic categories, sorts, badge filters and reset', async () => {
  const page = await readFile(path.join(siteDirectory, 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(page, /catalog\.categories/);
  assert.match(page, /catalog\.projects/);
  assert.match(page, /data-category=/);
  assert.match(page, /data-badge=/);
  assert.match(page, /sortBy: sort\.value/);
  assert.match(page, /search\.addEventListener\('input'/);
  assert.match(page, /function reset\(\)/);
  assert.match(page, /No projects found/);
});

test('client filter/sort behavior searches, filters categories and badges, and sorts by name/category', () => {
  const cards = [
    { dataset: { title: 'Zebra Clock', category: 'clocks', categoryName: 'Clocks', badges: 'NEW', search: 'zebra bedside' } },
    { dataset: { title: 'Alpha Dashboard', category: 'dash', categoryName: 'Dashboards', badges: '', search: 'alpha glucose health' } },
    { dataset: { title: 'Beta Clock', category: 'clocks', categoryName: 'Clocks', badges: 'RECENT', search: 'beta wall clock' } },
  ];
  assert.deepEqual(filterAndSortCards(cards).map((card) => card.dataset.title), ['Alpha Dashboard', 'Beta Clock', 'Zebra Clock']);
  assert.deepEqual(filterAndSortCards(cards, { query: 'GLUCOSE' }).map((card) => card.dataset.title), ['Alpha Dashboard']);
  assert.deepEqual(filterAndSortCards(cards, { category: 'clocks' }).map((card) => card.dataset.title), ['Beta Clock', 'Zebra Clock']);
  assert.deepEqual(filterAndSortCards(cards, { badge: 'NEW' }).map((card) => card.dataset.title), ['Zebra Clock']);
  assert.deepEqual(filterAndSortCards(cards, { sortBy: 'category' }).map((card) => card.dataset.title), ['Beta Clock', 'Zebra Clock', 'Alpha Dashboard']);
  assert.deepEqual(filterAndSortCards(cards, { query: 'absent' }), []);
});

test('a category whose slug is "all" is a real category; only null means unfiltered', () => {
  const cards = [
    { dataset: { title: 'In All', category: 'all', categoryName: 'All', badges: '', search: 'in all' } },
    { dataset: { title: 'In Other', category: 'other', categoryName: 'Other', badges: 'NEW', search: 'in other' } },
  ];
  assert.deepEqual(filterAndSortCards(cards, { category: 'all' }).map((card) => card.dataset.title), ['In All']);
  assert.deepEqual(filterAndSortCards(cards, { category: null }).map((card) => card.dataset.title), ['In All', 'In Other']);
  assert.deepEqual(filterAndSortCards(cards).map((card) => card.dataset.title), ['In All', 'In Other']);
  assert.deepEqual(filterAndSortCards(cards, { category: 'all', badge: 'NEW' }), []);
});

test('result count renders with text nodes and never parses markup', () => {
  const nodes = [];
  const fakeDocument = {
    createElement(tag) {
      assert.equal(tag, 'strong');
      return { textContent: '' };
    },
  };
  const container = { replaceChildren(...children) { nodes.push(...children); } };
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    renderResultCount(container, 2);
    assert.deepEqual(nodes.slice(0, 1), ['Showing ']);
    assert.equal(nodes[1].textContent, '2');
    assert.equal(nodes[2], ' projects');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});


test('category fallback includes generic unknown-category icon', async () => {
  const page = await readFile(path.join(siteDirectory, 'src', 'pages', 'index.astro'), 'utf8');
  const card = await readFile(path.join(siteDirectory, 'src', 'components', 'ProjectCard.astro'), 'utf8');
  assert.match(page, /categoryIcons\[project\.category_slug\] \?\? 'grid'/);
  assert.match(card, /iconPaths\[icon\] \?\? iconPaths\.grid/);
  assert.match(card, /data-category-fallback=\{icon\}/);
});

test('browser script imports the helpers it calls (frontmatter imports are not available in the browser)', async () => {
  const page = await readFile(path.join(siteDirectory, 'src', 'pages', 'index.astro'), 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  for (const name of ['filterAndSortCards', 'renderResultCount']) {
    assert.match(scripts[0], new RegExp(String.raw`import \{[^}]*\b${name}\b[^}]*\} from '\.\./scripts/catalog-controls\.js'`));
  }
});

test('built page has no third-party font requests, has a favicon and keeps the hidden state authoritative', async () => {
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(html, /rel="icon"[^>]*favicon\.svg/);
  const stylesheets = (await readdir(path.join(outDir, '_astro'))).filter((file) => file.endsWith('.css'));
  const css = (await Promise.all(stylesheets.map((file) => readFile(path.join(outDir, '_astro', file), 'utf8')))).join('\n');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.ok(existsSync(path.join(outDir, 'favicon.svg')));
});

test('no generated catalog JSON can be tracked by Git', () => {
  const result = spawnSync('git', ['ls-files', '--cached', '--', 'site'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return; // not a Git checkout; nothing to assert
  const tracked = result.stdout.split(/\r?\n/).filter((file) => /(^|\/)catalog\.json$/.test(file));
  assert.deepEqual(tracked, []);
  const ignored = spawnSync('git', ['check-ignore', 'site/src/data/catalog.json', 'site/scripts/src/data/catalog.json'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(ignored.stdout.trim().split(/\r?\n/).length, 2);
});
