import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { catalogFile, repositoryUrl, starCacheFile } from '../site-config.mjs';
import { classifyGithubUrl, formatStarCount, sanitizeStarsCache, starsFor } from '../src/lib/github-stars.mjs';
import { makePng } from '../tests/support/fixture-server.mjs';

// Browser smoke tests for the built gallery (`npm run build`, then `npm run test:browser`).
// Expected values come from the generated catalog or the page itself, never from a fixed project list.
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const total = catalog.projects.length;

const visibleCards = (page) => page.locator('.project-card:not([hidden])');
const names = (page) => visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.title));

async function open(page) {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));
  // Project images are loaded from the projects' own hosts, so this test stubs them: it must not depend on the
  // network, and it records everything that leaves the site. Only images may; anything else is refused.
  const external = [];
  const stub = makePng(600, 400, [90, 90, 90]);
  await page.route((url) => url.hostname !== '127.0.0.1', (route) => {
    const request = route.request();
    external.push({ url: request.url(), type: request.resourceType() });
    return request.resourceType() === 'image' ? route.fulfill({ status: 200, contentType: 'image/png', body: stub }) : route.abort();
  });
  await page.goto('./');
  await expect(visibleCards(page)).toHaveCount(total);
  return { problems, external };
}

async function expectCounter(page, expected) {
  await expect(visibleCards(page)).toHaveCount(expected);
  await expect(page.locator('#result-count')).toHaveText(new RegExp(`^Showing ${expected} projects?$`));
}

test('loads every project with no runtime errors and no third-party requests other than project images', async ({ page }) => {
  const { problems, external } = await open(page);
  expect(total).toBeGreaterThan(0);
  await expectCounter(page, total);
  await expect(page.locator('button[data-category]')).toHaveCount(catalog.categories.length);
  await expect(page.locator('button[data-all-categories]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#reset-filters')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(problems).toEqual([]);
  expect(external.filter((request) => request.type !== 'image')).toEqual([]);
  expect(external.every((request) => request.url.startsWith('https://'))).toBe(true);
});

// Search, category and sorting expectations are derived from the generated catalog, never from what the README happens to
// contain today: projects may be added or removed, categories may appear or vanish, and a query may match nothing or
// everything. The oracle mirrors how the page builds its search text (title, description and category, case-insensitive).
const haystack = (project) => `${project.title} ${project.description} ${project.category}`.toLowerCase();
const matching = (query) => catalog.projects.filter((project) => haystack(project).includes(query.trim().toLowerCase()));

// A query that matches nothing (checked against the catalog, so a README that contains it cannot break the test).
const noMatchQuery = (() => {
  let query = 'qqqq-no-such-project';
  while (matching(query).length > 0) query += 'q';
  return query;
})();
// A query that matches some but not all projects, or null when the catalog has none (one project, or all alike).
const words = [...new Set(catalog.projects.flatMap((project) => project.title.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((word) => word.length >= 3))].sort();
const partialQuery = words.find((word) => matching(word).length > 0 && matching(word).length < total) ?? null;
// A query that matches every project, or null when no single character is shared by all of them.
const everyQuery = [...'etaoinshrdlucmfwypvbgkjqxz0123456789'].find((character) => matching(character).length === total) ?? null;
const searchScenarios = [
  { name: 'no project', query: noMatchQuery },
  ...(partialQuery ? [{ name: 'some projects', query: partialQuery }] : []),
  ...(everyQuery ? [{ name: 'every project', query: everyQuery }] : []),
];
const anyQuery = partialQuery ?? everyQuery ?? noMatchQuery;

test('search narrows results immediately, shows the empty state for zero matches, and clearing restores everything', async ({ page }) => {
  const { problems } = await open(page);
  test.info().annotations.push({ type: 'search scenarios', description: searchScenarios.map(({ name, query }) => `${name}: "${query}" -> ${matching(query).length}/${total}`).join('; ') });
  for (const { query } of searchScenarios) {
    const expected = matching(query).length;
    await page.locator('#project-search').fill(query);
    await expectCounter(page, expected);
    await expect(page.locator('#reset-filters')).toBeVisible();
    if (expected === 0) {
      await expect(page.locator('#empty-state')).toBeVisible();
      await expect(page.locator('#project-grid')).toBeHidden();
    } else {
      await expect(page.locator('#empty-state')).toBeHidden();
      await expect(page.locator('#project-grid')).toBeVisible();
    }
    await page.locator('#project-search').fill('');
    await expectCounter(page, total);
    await expect(page.locator('#reset-filters')).toBeHidden();
    await expect(page.locator('#empty-state')).toBeHidden();
  }
  expect(problems).toEqual([]);
});

test('every category filter shows exactly its own projects, including a category named All', async ({ page }) => {
  await open(page);
  const unfiltered = page.locator('button[data-all-categories]');
  for (const category of catalog.categories) {
    const chip = page.locator(`button[data-category="${category.slug}"]`);
    const expected = catalog.projects.filter((project) => project.category_slug === category.slug).length;
    await chip.click();
    await expectCounter(page, expected);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(unfiltered).toHaveAttribute('aria-pressed', 'false');
    const slugs = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.category));
    expect(new Set(slugs)).toEqual(expected > 0 ? new Set([category.slug]) : new Set());
    await unfiltered.click();
    await expectCounter(page, total);
    await expect(unfiltered).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  }
});

// Badge rollover is an ordinary README edit, so any count of NEW and RECENT projects (including none) is valid.
// The generated catalog is the oracle; nothing here assumes how many projects carry a badge.
const BADGES = ['NEW', 'RECENT'];
const withBadge = (badge) => catalog.projects.filter((project) => project.badges.includes(badge));
const matchesQuery = (project, query) => `${project.title} ${project.description} ${project.category}`.toLowerCase().includes(query.toLowerCase());

test('NEW and RECENT filters match the catalog, including zero-result states, and toggle off', async ({ page }) => {
  await open(page);
  test.info().annotations.push({ type: 'badge scenario', description: BADGES.map((badge) => `${badge}=${withBadge(badge).length}`).join(' ') });
  for (const badge of BADGES) {
    const expected = withBadge(badge).length;
    const button = page.locator(`button[data-badge="${badge}"]`);
    await expect(button).toBeVisible();
    await button.click();
    await expectCounter(page, expected);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(visibleCards(page).locator('.project-badge', { hasText: badge })).toHaveCount(expected);
    await expect(page.locator('#reset-filters')).toBeVisible();
    if (expected === 0) {
      await expect(page.locator('#empty-state')).toBeVisible();
      await expect(page.locator('#project-grid')).toBeHidden();
    } else {
      await expect(page.locator('#empty-state')).toBeHidden();
    }
    await button.click();
    await expectCounter(page, total);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#empty-state')).toBeHidden();
  }
});

test('search, category and badge filters combine', async ({ page }) => {
  await open(page);
  const category = catalog.categories[0];
  await page.locator(`button[data-category="${category.slug}"]`).click();
  for (const badge of BADGES) {
    const inScope = catalog.projects.filter((project) => project.category_slug === category.slug && project.badges.includes(badge));
    await page.locator(`button[data-badge="${badge}"]`).click();
    await expectCounter(page, inScope.length);
    if (inScope.length > 0) {
      const target = inScope[0];
      const searched = inScope.filter((project) => matchesQuery(project, target.title));
      await page.locator('#project-search').fill(target.title);
      await expectCounter(page, searched.length);
      expect(await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.id))).toContain(target.id);
    }
    await page.locator('#project-search').fill(noMatchQuery);
    await expectCounter(page, 0);
    await page.locator('#project-search').fill('');
    await page.locator(`button[data-badge="${badge}"]`).click();
  }
  await expectCounter(page, catalog.projects.filter((project) => project.category_slug === category.slug).length);
});

test('sorting by name and by category orders the cards and never loses one', async ({ page }) => {
  await open(page);
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const titles = catalog.projects.map((project) => project.title);
  const byName = await names(page);
  expect(byName).toHaveLength(total);
  expect([...byName].sort()).toEqual([...titles].sort());
  expect(byName).toEqual([...byName].sort(collator.compare));

  await page.locator('#sort-projects').selectOption('category');
  await expect(page.locator('#sort-projects')).toHaveValue('category');
  const grouped = () => visibleCards(page).evaluateAll((cards) => cards.map((card) => ({ category: card.dataset.categoryName, title: card.dataset.title })));
  const isGrouped = (cards) => cards.every((card, index) => index === 0
    || collator.compare(cards[index - 1].category, card.category) < 0
    || (collator.compare(cards[index - 1].category, card.category) === 0 && collator.compare(cards[index - 1].title, card.title) <= 0));
  await expect.poll(async () => isGrouped(await grouped())).toBe(true);
  expect(await grouped()).toHaveLength(total);
  expect((await grouped()).map((card) => card.title).sort()).toEqual([...titles].sort());

  await page.locator('#sort-projects').selectOption('name');
  await expect.poll(() => names(page)).toEqual(byName);
});

test('reset and clear-filters restore every project', async ({ page }) => {
  await open(page);
  await page.locator('#project-search').fill(anyQuery);
  await page.locator('button[data-badge="NEW"]').click();
  await page.locator('button[data-category]').first().click();
  await expect(page.locator('#reset-filters')).toBeVisible();
  await page.locator('#reset-filters').click();
  await expectCounter(page, total);
  await expect(page.locator('#project-search')).toHaveValue('');
  await expect(page.locator('button[data-all-categories]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[data-badge="NEW"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#reset-filters')).toBeHidden();

  await page.locator('#project-search').fill(noMatchQuery);
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#project-grid')).toBeHidden();
  await expectCounter(page, 0);
  await page.locator('#empty-reset').click();
  await expect(page.locator('#empty-state')).toBeHidden();
  await expectCounter(page, total);
});

test('keyboard shortcuts focus and clear the search, and chips work from the keyboard', async ({ page }) => {
  await open(page);
  const search = page.locator('#project-search');
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await page.keyboard.type(anyQuery);
  await expect(search).toHaveValue(anyQuery);
  await expectCounter(page, matching(anyQuery).length);
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expectCounter(page, total);

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Meta+k');
  await expect(search).toBeFocused();

  const chip = page.locator('button[data-category]').first();
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expectCounter(page, catalog.projects.filter((project) => project.category_slug === catalog.categories[0].slug).length);
});

test('cards keep consistent structure and safe project links', async ({ page }) => {
  await open(page);
  const cards = await page.locator('.project-card').evaluateAll((items) => items.map((item) => ({
    icon: item.querySelectorAll('.card-preview svg').length,
    heading: item.querySelectorAll('h2').length,
    link: item.querySelector('.project-link')?.getAttribute('href') ?? '',
    rel: item.querySelector('.project-link')?.getAttribute('rel') ?? '',
  })));
  expect(cards).toHaveLength(total);
  for (const card of cards) {
    expect(card.icon).toBe(1);
    expect(card.heading).toBe(1);
    expect(card.link).toMatch(/^https?:\/\//);
    expect(card.rel).toBe('noopener noreferrer');
  }
  const favicon = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.href);
  expect((await page.request.get(favicon)).ok()).toBe(true);
});

// GitHub star counts on the real catalog. The oracle is the build's own star cache, so the test needs no network and no
// fixed numbers; with no known counts at all (a first offline build) the page offers no star sorting and these checks end.
const starCache = sanitizeStarsCache(JSON.parse(await readFile(starCacheFile, 'utf8').catch(() => 'null')));
const withStars = catalog.projects.filter((project) => starsFor(starCache, project));

test('star counts match the build cache: shown only for GitHub repositories with a known count, linked to the repository', async ({ page }) => {
  await open(page);
  const cards = await page.locator('.project-card').evaluateAll((items) => items.map((item) => ({
    id: item.dataset.id,
    stars: item.dataset.stars ?? null,
    text: item.querySelector('.star-link')?.textContent?.trim() ?? null,
    href: item.querySelector('.star-link')?.getAttribute('href') ?? null,
    label: item.querySelector('.star-link')?.getAttribute('aria-label') ?? null,
  })));
  expect(cards).toHaveLength(total);
  for (const project of catalog.projects) {
    const shown = cards.find((item) => item.id === project.id);
    const expected = starsFor(starCache, project);
    if (!expected) {
      expect(shown.stars, `${project.title} must not show a count`).toBeNull();
      expect(shown.text).toBeNull();
      continue;
    }
    expect(classifyGithubUrl(project.url).repository).toBeTruthy();
    expect(shown.stars).toBe(String(expected.count));
    expect(shown.text).toBe(formatStarCount(expected.count));
    expect(shown.href).toBe(expected.url);
    expect(shown.label).toBe(expected.label);
  }
  await expect(page.locator('#sort-projects option[value="stars"]')).toHaveCount(withStars.length > 0 ? 1 : 0);
});

test('sorting by GitHub stars keeps the other filters working', async ({ page }) => {
  test.skip(withStars.length === 0, 'no star counts are available in this build');
  await open(page);
  const select = page.locator('#sort-projects');
  await select.selectOption('stars');
  const counts = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.stars ?? null));
  const known = counts.filter((value) => value !== null).map(Number);
  expect(known).toHaveLength(withStars.length);
  expect(known).toEqual([...known].sort((a, b) => b - a));
  expect(counts.slice(0, known.length).every((value) => value !== null)).toBe(true); // unknowns only after known
  expect(counts.slice(known.length).every((value) => value === null)).toBe(true);

  const category = catalog.categories.find((item) => catalog.projects.some((project) => project.category_slug === item.slug && starsFor(starCache, project)));
  await page.locator(`button[data-category="${category.slug}"]`).click();
  const inCategory = catalog.projects.filter((project) => project.category_slug === category.slug);
  await expectCounter(page, inCategory.length);
  const filtered = (await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.stars ?? null))).filter((value) => value !== null).map(Number);
  expect(filtered).toEqual([...filtered].sort((a, b) => b - a));
  await select.selectOption('name');
});

// Support and sponsorship: the header Star action and the "Support this list" section (desktop and mobile projects).
const SPONSORS = 'https://github.com/sponsors/jake1164';
const COFFEE = 'https://buymeacoffee.com/jake1164s';
const supportActions = [
  { name: 'Star on GitHub', href: repositoryUrl },
  { name: 'GitHub Sponsors', href: SPONSORS },
  { name: 'Buy Me a Coffee', href: COFFEE },
];

// Tabs until the element has focus, the way a keyboard user reaches it (so :focus-visible applies).
async function tabTo(page, locator, limit = 12) {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('the element cannot be reached with the Tab key');
}
const focusRing = (locator) => locator.evaluate((element) => {
  const style = getComputedStyle(element);
  return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
});

test('header Star action points to the list, not a project, and fits the header', async ({ page }) => {
  const { problems } = await open(page);
  const star = page.locator('header.panel-header a.star-repo');
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('href', repositoryUrl);
  await expect(star).toHaveAttribute('target', '_blank');
  await expect(star).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(star).toHaveAccessibleName('Star Awesome Presto on GitHub');
  await expect(star.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  // Not a project card and not a card's star count.
  await expect(page.locator('.project-card a.star-repo, a.star-link.star-repo')).toHaveCount(0);
  await expect(page.locator(`.project-card a[href="${repositoryUrl}"]`)).toHaveCount(0);

  const viewport = page.viewportSize();
  const box = await star.boundingBox();
  const heading = await page.locator('h1').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.x).toBeGreaterThanOrEqual(heading.x + heading.width - 1); // beside the title, never on top of it
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await tabTo(page, star);
  const ring = await focusRing(star);
  expect(ring.style).not.toBe('none');
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(problems).toEqual([]);
});

test('support section offers Star, GitHub Sponsors and Buy Me a Coffee as labelled, focusable links', async ({ page }) => {
  const { problems } = await open(page);
  const support = page.locator('section.support');
  await expect(support).toHaveCount(1);
  await support.scrollIntoViewIfNeeded();
  await expect(page.getByRole('region', { name: 'Support this list' })).toBeVisible();
  await expect(support.getByRole('heading', { name: 'Support this list' })).toBeVisible();
  await expect(support).toContainText('Giving this repository a GitHub star helps other Presto owners discover it');
  await expect(support).toContainText('Support is entirely optional and never affects which projects are listed.');
  await expect(support.getByRole('link')).toHaveCount(supportActions.length);

  for (const { name, href } of supportActions) {
    const link = support.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  }

  // Keyboard users arrive from the last project card, in order, and every action shows a focus ring.
  await visibleCards(page).last().locator('a.project-link').focus();
  for (const { name } of supportActions) {
    const link = support.getByRole('link', { name, exact: true });
    await tabTo(page, link, 2);
    const ring = await focusRing(link);
    expect(ring.style, `${name} focus ring`).not.toBe('none');
    expect(ring.width, `${name} focus ring`).toBeGreaterThanOrEqual(2);
  }
  expect(problems).toEqual([]);
});

test('support section is responsive: equal buttons, nothing outside the section or the viewport', async ({ page }) => {
  await open(page);
  const support = page.locator('section.support');
  await support.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize();
  const section = await support.boundingBox();
  const boxes = [];
  for (const { name } of supportActions) boxes.push(await support.getByRole('link', { name, exact: true }).boundingBox());
  const icons = await support.locator('svg').evaluateAll((items) => items.map((item) => [Math.round(item.getBoundingClientRect().width), Math.round(item.getBoundingClientRect().height)]));

  expect(new Set(boxes.map((box) => Math.round(box.height))).size).toBe(1);
  expect(boxes[0].height).toBeGreaterThanOrEqual(44);
  expect(icons).toEqual([[20, 20], [20, 20], [20, 20]]);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(section.x);
    expect(box.x + box.width).toBeLessThanOrEqual(section.x + section.width + 1);
  }
  expect(section.x).toBeGreaterThanOrEqual(0);
  expect(section.x + section.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (viewport.width <= 680) {
    // Mobile: one full-width button per row, in order.
    expect(new Set(boxes.map((box) => Math.round(box.width))).size).toBe(1);
    expect(boxes[1].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
    expect(boxes[2].y).toBeGreaterThan(boxes[1].y + boxes[1].height - 1);
  } else {
    // Desktop: a single row.
    expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(1);
  }
});

test('support adds no third-party widgets, frames or requests, and survives filtering', async ({ page }) => {
  const { problems, external } = await open(page);
  const support = page.locator('section.support');
  await expect(support.locator('img, script, iframe, object, embed')).toHaveCount(0);
  await expect(page.locator('iframe, object, embed')).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  const scripts = await page.locator('script[src]').evaluateAll((items) => items.map((item) => item.src));
  expect(scripts.every((source) => source.startsWith(origin))).toBe(true);

  await page.locator('#project-search').fill(noMatchQuery);
  await expectCounter(page, 0);
  await expect(support).toBeVisible();
  await page.locator('#empty-reset').click();
  await expectCounter(page, total);
  await expect(support).toBeVisible();
  expect(external.filter((request) => request.type !== 'image')).toEqual([]);
  expect(external.filter((request) => /buymeacoffee|sponsors/i.test(request.url))).toEqual([]);
  expect(problems).toEqual([]);
});
