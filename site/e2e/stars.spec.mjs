import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// GitHub star counts in a real browser. The synthetic site is built from a README alone (see synthetic-site.mjs):
// the star lookup ran against a local stand-in for GitHub's API, which answers with a count, a failure, a malformed
// body or 404 depending on the fixture repository. Nothing here contacts GitHub.
const synthetic = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.synthetic');
const catalog = JSON.parse(await readFile(path.join(synthetic, 'catalog.json'), 'utf8'));
const cache = JSON.parse(await readFile(path.join(synthetic, 'star-cache.json'), 'utf8'));
const total = catalog.projects.length;

const card = (page, title) => page.locator(`.project-card[data-title="${title}"]`);
const visibleCards = (page) => page.locator('.project-card:not([hidden])');
const titles = (page) => visibleCards(page).evaluateAll((cards) => cards.map((item) => item.dataset.title));

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(visibleCards(page)).toHaveCount(total);
});

test('the star cache was produced from the README alone: counts, a real zero, and no entry for unknowns', () => {
  const { entries } = cache;
  expect(entries['fixture/with-image']).toMatchObject({ status: 'ok', stars: 1234, full_name: 'fixture/with-image' });
  expect(entries['fixture/hint-fallback']).toMatchObject({ status: 'ok', stars: 15200 });
  expect(entries['fixture/rejected-image']).toMatchObject({ status: 'ok', stars: 0 });
  expect(entries['fixture/large-image']).toEqual({ checked_at: expect.any(String), status: 'missing' }); // 404: deleted
  expect(entries['fixture/runtime-missing']).toBeUndefined(); // HTTP 500: unknown, not zero
  expect(entries['fixture/tall-image']).toBeUndefined(); // malformed answer: unknown, not zero
  // Several README entries into one repository share a cache entry, and nothing that is not a repository has one.
  expect(Object.keys(entries).every((key) => key.startsWith('fixture/'))).toBe(true);
  expect(Object.keys(entries)).toHaveLength(new Set(Object.keys(entries)).size);
});

test('cards show a compact star count that links to the repository, with an accessible name', async ({ page }) => {
  const link = card(page, 'Fixture With Image').locator('a.star-link');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText('1.2k');
  await expect(link).toHaveAttribute('href', 'https://github.com/fixture/with-image');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('aria-label', /^1\.2k \(1,234\) GitHub stars for Fixture With Image\./);
  await expect(card(page, 'Fixture With Image')).toHaveAttribute('data-stars', '1234');
  // The visible text is part of the accessible name, and the link is found by role and name.
  await expect(page.getByRole('link', { name: /1,234\) GitHub stars for Fixture With Image\./ })).toHaveCount(1);
  await expect(card(page, 'Fixture Hint Fallback').locator('a.star-link')).toHaveText('15.2k');
  await expect(card(page, 'Fixture No Image').locator('a.star-link')).toHaveText('87');
  // The project link is unchanged and separate.
  await expect(card(page, 'Fixture With Image').locator('a.project-link')).toHaveAttribute('href', 'https://github.com/fixture/with-image');
  // The count is GitHub's; it is not labelled or styled like a like or heart control.
  expect(await page.locator('.project-card [aria-label*="heart" i], .project-card [aria-label*="favorite" i], .project-card [aria-label*="like" i]').count()).toBe(0);
});

test('a real zero is shown; unknown and missing counts are not shown as zero', async ({ page }) => {
  await expect(card(page, 'Fixture Rejected Image').locator('a.star-link')).toHaveText('0');
  await expect(card(page, 'Fixture Rejected Image')).toHaveAttribute('data-stars', '0');
  for (const title of ['Fixture Runtime Missing', 'Fixture Tall Image', 'Fixture Large Image', 'Fixture Forced Icon']) {
    await expect(card(page, title).locator('.star-link')).toHaveCount(0);
    expect(await card(page, title).getAttribute('data-stars')).toBeNull();
  }
});

test('files and folders resolve to their repository; gists, profiles, issues and other sites get no count', async ({ page }) => {
  await expect(card(page, 'Fixture With Image File').locator('a.star-link')).toHaveText('1.2k');
  await expect(card(page, 'Fixture With Image File').locator('a.star-link')).toHaveAttribute('href', 'https://github.com/fixture/with-image');
  await expect(card(page, 'Fixture No Image Folder').locator('a.star-link')).toHaveText('87');
  await expect(card(page, 'Fixture No Image Folder').locator('a.star-link')).toHaveAttribute('href', 'https://github.com/fixture/no-image');
  for (const title of ['Fixture Gist', 'Fixture Profile', 'Fixture Issue', 'All Alpha', 'Other Gamma']) {
    await expect(card(page, title)).toHaveCount(1);
    await expect(card(page, title).locator('.star-link')).toHaveCount(0);
    expect(await card(page, title).getAttribute('data-stars')).toBeNull();
  }
});

test('the star link is keyboard reachable and has no placeholder anywhere on the page', async ({ page }) => {
  const link = card(page, 'Fixture With Image').locator('a.star-link');
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(link).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card(page, 'Fixture With Image').locator('a.project-link')).toBeFocused();
  // Only cards with a known count have a star control.
  const withLink = await page.locator('.project-card .star-link').count();
  const withData = await page.locator('.project-card[data-stars]').count();
  expect(withLink).toBe(withData);
  expect(withLink).toBe(Object.values(cache.entries).filter((entry) => entry.status === 'ok').length + 2); // two entries share repositories
});

test('sorting by GitHub stars puts known counts first, highest first, with deterministic ties, and unknowns last', async ({ page }) => {
  const select = page.locator('#sort-projects');
  await expect(select.locator('option[value="stars"]')).toHaveText('GitHub stars');
  await expect(select).toHaveValue('name'); // the default sorting is unchanged
  await select.selectOption('stars');
  const order = await titles(page);
  expect(order.slice(0, 7)).toEqual([
    'Fixture Hint Fallback', // 15200
    'Fixture With Image', // 1234 (tie broken by title)
    'Fixture With Image File', // 1234
    'Fixture Hinted', // 87
    'Fixture No Image', // 87
    'Fixture No Image Folder', // 87
    'Fixture Rejected Image', // a real zero still ranks above unknown
  ]);
  const unknown = order.slice(7);
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  expect(unknown).toEqual([...unknown].sort(collator.compare));
  const counts = await visibleCards(page).evaluateAll((cards) => cards.map((item) => item.dataset.stars ?? null));
  expect(counts.slice(0, 7)).toEqual(['15200', '1234', '1234', '87', '87', '87', '0']);
  expect(counts.slice(7).every((value) => value === null)).toBe(true);
  expect(order).toHaveLength(total);

  await select.selectOption('name');
  const byName = await titles(page);
  expect(byName).toEqual([...byName].sort(collator.compare));
});

test('stars sorting works with search, category and badge filters', async ({ page }) => {
  await page.locator('#sort-projects').selectOption('stars');
  await page.locator('#project-search').fill('no image');
  await expect(visibleCards(page)).toHaveCount(2);
  expect(await titles(page)).toEqual(['Fixture No Image', 'Fixture No Image Folder']);

  await page.locator('#project-search').fill('');
  await page.locator('button[data-category="other"]').click();
  const other = await titles(page);
  expect(other[0]).toBe('Fixture Hint Fallback');
  expect(other).not.toContain('All Alpha');

  // A category and badge whose cards have no counts at all still list, alphabetically.
  await page.locator('button[data-category="all"]').click();
  await page.locator('button[data-badge="NEW"]').click();
  expect(await titles(page)).toEqual(['All Alpha']);
  await page.locator('#reset-filters').click();
  await expect(visibleCards(page)).toHaveCount(total);
  await expect(page.locator('#sort-projects')).toHaveValue('stars');
  expect((await titles(page))[0]).toBe('Fixture Hint Fallback');
});

test('the page never contacts GitHub for counts', async ({ page }) => {
  const hosts = [];
  page.on('request', (request) => hosts.push(new URL(request.url()).hostname));
  await page.reload();
  await expect(visibleCards(page)).toHaveCount(total);
  expect(hosts.filter((host) => /github/i.test(host))).toEqual([]);
});
