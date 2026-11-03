import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { catalogFile } from '../site-config.mjs';

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
  const external = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1') && !request.url().startsWith('data:')) external.push(request.url());
  });
  await page.goto('./');
  await expect(visibleCards(page)).toHaveCount(total);
  return { problems, external };
}

async function expectCounter(page, expected) {
  await expect(visibleCards(page)).toHaveCount(expected);
  await expect(page.locator('#result-count')).toHaveText(new RegExp(`^Showing ${expected} projects?$`));
}

test('loads every project with no runtime errors and no third-party requests', async ({ page }) => {
  const { problems, external } = await open(page);
  expect(total).toBeGreaterThan(0);
  await expectCounter(page, total);
  await expect(page.locator('button[data-category]')).toHaveCount(catalog.categories.length);
  await expect(page.locator('button[data-all-categories]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#reset-filters')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
});

test('search narrows results immediately and clearing restores them', async ({ page }) => {
  const { problems } = await open(page);
  await page.locator('#project-search').fill('clock');
  const matches = catalog.projects.filter((project) => `${project.title} ${project.description} ${project.category}`.toLowerCase().includes('clock'));
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.length).toBeLessThan(total);
  await expectCounter(page, matches.length);
  await expect(page.locator('#reset-filters')).toBeVisible();
  await page.locator('#project-search').fill('');
  await expectCounter(page, total);
  expect(problems).toEqual([]);
});

test('category filter shows only that category', async ({ page }) => {
  await open(page);
  const games = page.getByRole('button', { name: 'Games', exact: true });
  const chip = (await games.count()) ? games : page.locator('button[data-category]').first();
  const slug = await chip.getAttribute('data-category');
  const expected = catalog.projects.filter((project) => project.category_slug === slug).length;
  expect(expected).toBeGreaterThan(0);
  expect(expected).toBeLessThan(total);
  await chip.click();
  await expectCounter(page, expected);
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[data-all-categories]')).toHaveAttribute('aria-pressed', 'false');
  const slugs = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.category));
  expect(new Set(slugs)).toEqual(new Set([slug]));
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
    await page.locator('#project-search').fill('qqqq-no-such-project');
    await expectCounter(page, 0);
    await page.locator('#project-search').fill('');
    await page.locator(`button[data-badge="${badge}"]`).click();
  }
  await expectCounter(page, catalog.projects.filter((project) => project.category_slug === category.slug).length);
});

test('sorting by name and by category reorders the cards', async ({ page }) => {
  await open(page);
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const byName = await names(page);
  expect(byName).toEqual([...byName].sort(collator.compare));

  await page.locator('#sort-projects').selectOption('category');
  await expect.poll(() => names(page)).not.toEqual(byName);
  const categories = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.categoryName));
  expect(categories).toEqual([...categories].sort(collator.compare));
  expect(await names(page)).toHaveLength(total);

  await page.locator('#sort-projects').selectOption('name');
  await expect.poll(() => names(page)).toEqual(byName);
});

test('reset and clear-filters restore every project', async ({ page }) => {
  await open(page);
  await page.locator('#project-search').fill('clock');
  await page.locator('button[data-badge="NEW"]').click();
  await page.locator('button[data-category]').first().click();
  await page.locator('#reset-filters').click();
  await expectCounter(page, total);
  await expect(page.locator('#project-search')).toHaveValue('');
  await expect(page.locator('button[data-all-categories]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[data-badge="NEW"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#reset-filters')).toBeHidden();

  await page.locator('#project-search').fill('qqqq-no-such-project');
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
  await page.keyboard.type('clock');
  await expect(visibleCards(page)).not.toHaveCount(total);
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
  await expect(visibleCards(page)).not.toHaveCount(total);
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
