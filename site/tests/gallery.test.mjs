import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterAndSortCards, renderResultCount } from '../src/scripts/catalog-controls.js';
import { coffeeUrl, outDir, repositoryUrl, sponsorsUrl } from '../site-config.mjs';

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

// Support and sponsorship. The destinations are plain links, identical in the gallery, the README and FUNDING.yml.
const AWESOME_LIST = 'https://github.com/jake1164/awesome-Pimoroni-Presto';
const SPONSORS = 'https://github.com/sponsors/jake1164';
const COFFEE = 'https://buymeacoffee.com/jake1164s';
const hrefsIn = (html) => [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((match) => match[1]);

test('the support destinations are the verified ones', () => {
  assert.equal(sponsorsUrl, SPONSORS);
  assert.equal(coffeeUrl, COFFEE);
  // Builds in a fork or with GITHUB_REPOSITORY set follow that repository; the default is this list.
  if (!process.env.GITHUB_REPOSITORY) assert.equal(repositoryUrl, AWESOME_LIST);
});

test('built page links the header Star action to the list and offers all three support actions', async () => {
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const header = html.match(/<header class="panel-header">[\s\S]*?<\/header>/)?.[0] ?? '';
  const star = header.match(/<a class="star-repo"[^>]*>/)?.[0] ?? '';
  assert.ok(star, 'header must contain the Star action');
  assert.ok(star.includes(`href="${repositoryUrl}"`), 'the header Star action must point to the list itself');
  assert.match(star, /rel="noopener noreferrer"/);
  assert.match(header, /Star<\/span><span class="visually-hidden"> Awesome Presto on GitHub</);

  const support = html.match(/<section class="support"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(support, /<h2 id="support-heading">Support this list<\/h2>/);
  assert.match(support, /aria-labelledby="support-heading"/);
  assert.match(support, /never affects which projects are listed/);
  assert.deepEqual(hrefsIn(support), [repositoryUrl, SPONSORS, COFFEE]);
  for (const label of ['Star on GitHub', 'GitHub Sponsors', 'Buy Me a Coffee']) assert.match(support, new RegExp(`${label}\\s*</a>`));
  // The support links are not project links: no card links to a sponsor or coffee page.
  const cards = html.match(/<li\s+class="project-card"[\s\S]*?<\/li>/g) ?? [];
  assert.ok(cards.length > 0);
  for (const card of cards) {
    for (const href of hrefsIn(card)) assert.ok(![SPONSORS, COFFEE].includes(href), `a card links to ${href}`);
  }
});

test('support adds no scripts, frames, widgets, tracking pixels or third-party images', async () => {
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const support = html.match(/<section class="support"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(support);
  assert.doesNotMatch(support, /<(img|script|iframe|link|style|object|embed|form)\b/i);
  assert.doesNotMatch(html, /<iframe\b|<object\b|<embed\b/i);
  assert.doesNotMatch(html, /cdn\.buymeacoffee|buymeacoffee\.com\/(widget|bmc)|bmc-button|bmc-widget|googletagmanager|google-analytics|gtag\(|ko-fi|paypal\.com\/sdk/i);
  // Every script on the page is the site's own bundled file or inline module; none loads from another origin.
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.doesNotMatch(tag, /\ssrc="(?:https?:)?\/\//i, tag);
});

test('analytics is consent-gated and exposes persistent privacy settings', async () => {
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const analytics = await readFile(path.join(repositoryRoot, 'site', 'src', 'scripts', 'analytics.js'), 'utf8');
  assert.match(html, /id="consent-banner"[^>]*hidden/);
  assert.match(html, /id="consent-allow"[^>]*>Allow analytics</);
  assert.match(html, /id="consent-decline"[^>]*>No thanks</);
  assert.match(html, /id="privacy-settings"[^>]*>Privacy \/ Analytics settings</);
  assert.match(analytics, /G-K5XSTX64R3/);
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/www\.googletagmanager\.com/);
  // Nothing of Google is in the shipped HTML or its stylesheet; the library is only ever added by the consent code.
  assert.doesNotMatch(html, /googletagmanager|google-analytics|gtag/i);
  // Both controls ship hidden and are revealed only on the live site; the banner comes first so keyboard users reach it first.
  assert.match(html, /id="privacy-footer"[^>]*hidden/);
  assert.ok(html.indexOf('id="consent-banner"') < html.indexOf('<main'), 'the consent banner precedes the page content');
  // The consent text says what Google Analytics is, in plain words: pseudonymous (not anonymous), cookies, device information,
  // optional, changeable, and that withdrawing is not a recall of what was sent or of what is already waiting to be sent.
  const banner = html.match(/<section class="consent-banner"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(banner, /With your permission, we use Google Analytics to understand how visitors use this project gallery\./);
  assert.match(banner, /Google Analytics uses cookies and pseudonymous identifiers and may collect browser and device information\./);
  assert.match(banner, /We never send your gallery search text as a custom event\./);
  assert.match(banner, /Analytics is optional, and you can change your choice at any time/);
  assert.match(banner, /does not delete data already sent, and a few events already waiting to be sent may still go out within seconds/);
  assert.doesNotMatch(html.replace(/<style[\s\S]*?<\/style>/g, ''), /anonymous|anonymised|no personal/i, 'no claim of anonymity anywhere on the page');
  // The support links carry the support type the analytics event reports.
  const types = [...html.matchAll(/data-support="([a-z_]+)" data-placement="([a-z]+)"/g)].map((match) => `${match[1]}:${match[2]}`);
  assert.deepEqual(types, ['star:header', 'star:footer', 'github_sponsors:footer', 'buy_me_a_coffee:footer']);
  // Support links and project links are the only outbound links reported; project stars are not support.
  assert.equal((html.match(/class="star-link"[^>]*data-support/g) ?? []).length, 0);
});

test('FUNDING.yml configures GitHub Sponsors and Buy Me a Coffee exactly, and nothing else', async () => {
  const file = path.join(repositoryRoot, '.github', 'FUNDING.yml');
  assert.ok(existsSync(file), '.github/FUNDING.yml must exist (exact name)');
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  assert.deepEqual(lines, ['github: [jake1164]', 'custom:', `  - ${COFFEE}`]);
  assert.deepEqual((await readdir(path.join(repositoryRoot, '.github'))).filter((name) => /funding/i.test(name)), ['FUNDING.yml']);
  assert.ok(!existsSync(path.join(repositoryRoot, 'FUNDING.yml')) && !existsSync(path.join(repositoryRoot, 'docs', 'FUNDING.yml')));
});

test('README, FUNDING.yml and the website agree on the support destinations', async () => {
  const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
  const funding = await readFile(path.join(repositoryRoot, '.github', 'FUNDING.yml'), 'utf8');
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const section = readme.match(/^### Support this project$[\s\S]*?(?=^### )/m)?.[0] ?? '';
  assert.ok(section, 'README keeps its "Support this project" section');
  // The introductory link resolves to that heading.
  assert.match(readme, /\[Support this list\]\(#support-this-project\)/);
  assert.match(section, /star/i);
  assert.match(section, /never affects which projects are listed/);
  // Both buttons link to the verified destinations at the same height, with alt text and a local or HTTPS image.
  const buttons = [...section.matchAll(/<a href="([^"]+)"><img src="([^"]+)" alt="([^"]+)" height="(\d+)"><\/a>/g)];
  assert.deepEqual(buttons.map((button) => button[1]), [SPONSORS, COFFEE]);
  assert.equal(new Set(buttons.map((button) => button[4])).size, 1, 'the two buttons must have the same height');
  assert.ok(buttons.every((button) => button[3].trim() !== ''));
  assert.deepEqual(buttons.map((button) => button[2]).filter((source) => !/^https:\/\//.test(source)), ['assets/sponsor-github.svg']);
  assert.ok(existsSync(path.join(repositoryRoot, 'assets', 'sponsor-github.svg')));
  // The README keeps a single copy of the section, FUNDING.yml names the same account, and the website the same links.
  assert.equal((readme.match(/^#{1,6} Support this project$/gm) ?? []).length, 1);
  assert.ok(funding.includes(`[${SPONSORS.split('/').pop()}]`) && funding.includes(COFFEE));
  const site = hrefsIn(html);
  for (const destination of [SPONSORS, COFFEE]) assert.ok(site.includes(destination), `website must link ${destination}`);
});

