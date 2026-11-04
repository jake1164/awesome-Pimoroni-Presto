import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Regression: a valid README category named "All" has slug `all`. It must stay independent of the
// unfiltered "All" control. Runs against a site built from a synthetic README (see synthetic-readme.mjs).
const catalogFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.synthetic', 'catalog.json');
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const total = catalog.projects.length;
const inCategory = (slug) => catalog.projects.filter((project) => project.category_slug === slug);
const withBadge = (badge, slug) => catalog.projects.filter((project) => project.badges.includes(badge) && (!slug || project.category_slug === slug));

const visibleCards = (page) => page.locator('.project-card:not([hidden])');
const unfiltered = (page) => page.locator('button[data-all-categories]');
const allCategory = (page) => page.locator('button[data-category="all"]');
const otherCategory = (page) => page.locator('button[data-category="other"]');
const pressed = (page) => page.locator('.filter-bar [aria-pressed="true"]');

async function expectCounter(page, expected) {
  await expect(visibleCards(page)).toHaveCount(expected);
  await expect(page.locator('#result-count')).toHaveText(new RegExp(`^Showing ${expected} projects?$`));
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expectCounter(page, total);
});

test('the synthetic catalog really contains a category whose slug is "all"', () => {
  expect(catalog.categories.map((category) => category.slug)).toEqual(['all', 'other']);
  expect(catalog.categories[0].name).toBe('All');
  expect(inCategory('all').length).toBeGreaterThan(0);
  expect(inCategory('other').length).toBeGreaterThan(0);
});

test('the unfiltered control and the real All category are separate, single-selection controls', async ({ page }) => {
  await expect(unfiltered(page)).toHaveCount(1);
  await expect(allCategory(page)).toHaveCount(1);
  await expect(unfiltered(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(allCategory(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pressed(page)).toHaveCount(1);

  await allCategory(page).click();
  await expectCounter(page, inCategory('all').length);
  expect(inCategory('all').length).toBeLessThan(total);
  await expect(allCategory(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(unfiltered(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pressed(page)).toHaveCount(1);
  const slugs = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.category));
  expect(new Set(slugs)).toEqual(new Set(['all']));

  await otherCategory(page).click();
  await expectCounter(page, inCategory('other').length);
  await expect(allCategory(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(otherCategory(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(pressed(page)).toHaveCount(1);

  await unfiltered(page).click();
  await expectCounter(page, total);
  await expect(unfiltered(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(allCategory(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pressed(page)).toHaveCount(1);
});

test('search, badges, sorting and reset work inside the All category', async ({ page }) => {
  await allCategory(page).click();

  await page.locator('button[data-badge="NEW"]').click();
  await expectCounter(page, withBadge('NEW', 'all').length);
  await page.locator('button[data-badge="NEW"]').click();

  // RECENT exists only outside the All category, so this combination must show the empty state.
  expect(withBadge('RECENT', 'all')).toHaveLength(0);
  await page.locator('button[data-badge="RECENT"]').click();
  await expectCounter(page, 0);
  await expect(page.locator('#empty-state')).toBeVisible();
  await page.locator('button[data-badge="RECENT"]').click();
  await expectCounter(page, inCategory('all').length);

  await page.locator('#project-search').fill('beta');
  await expectCounter(page, 1);
  await expect(visibleCards(page).first()).toHaveAttribute('data-title', 'All Beta');
  await page.locator('#project-search').fill('');

  await page.locator('#sort-projects').selectOption('category');
  await expectCounter(page, inCategory('all').length);
  const titles = await visibleCards(page).evaluateAll((cards) => cards.map((card) => card.dataset.title));
  expect(titles).toEqual([...titles].sort());

  await page.locator('#project-search').fill('gamma');
  await expectCounter(page, 0);
  await page.locator('#reset-filters').click();
  await expectCounter(page, total);
  await expect(unfiltered(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(allCategory(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pressed(page)).toHaveCount(1);
  await expect(page.locator('#project-search')).toHaveValue('');
  await expect(page.locator('#reset-filters')).toBeHidden();
});

test('badge filter combined with the unfiltered control still spans every category', async ({ page }) => {
  await page.locator('button[data-badge="RECENT"]').click();
  await expectCounter(page, withBadge('RECENT').length);
  await allCategory(page).click();
  await expectCounter(page, 0);
  await unfiltered(page).click();
  await expectCounter(page, withBadge('RECENT').length);
});
