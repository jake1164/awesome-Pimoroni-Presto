import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Automatic project images in a real browser. The synthetic site is built from a README alone (see
// synthetic-site.mjs): image discovery ran against local fixture repositories, with no manifest and no cache.
const synthetic = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.synthetic');
const catalog = JSON.parse(await readFile(path.join(synthetic, 'catalog.json'), 'utf8'));
const cache = JSON.parse(await readFile(path.join(synthetic, 'image-cache.json'), 'utf8'));
const total = catalog.projects.length;
const idOf = (title) => catalog.projects.find((project) => project.title === title)?.id;

const card = (page, title) => page.locator(`.project-card[data-title="${title}"]`);
const preview = (page, title) => card(page, title).locator('.card-preview');
const visibleCards = (page) => page.locator('.project-card:not([hidden])');

// Collects every request that does not go to the site itself.
async function open(page) {
  const site = new URL(test.info().project.use.baseURL).origin;
  const thirdParty = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== site && !request.url().startsWith('data:')) thirdParty.push({ url: request.url(), type: request.resourceType() });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(visibleCards(page)).toHaveCount(total);
  // Lazy images start loading when they come near the viewport; scroll through the page once.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  });
  return { thirdParty, errors };
}

test('the discovery cache was produced from the README alone and holds the expected results', () => {
  expect(cache.entries[idOf('Fixture With Image')].status).toBe('found');
  expect(cache.entries[idOf('Fixture Runtime Missing')].status).toBe('found');
  expect(cache.entries[idOf('Fixture No Image')].status).toBe('none');
  expect(cache.entries[idOf('Fixture Rejected Image')].status).toBe('none');
  // The README directives travel through the catalog and the cache.
  expect(catalog.projects.find((project) => project.title === 'Fixture Hinted').image).toEqual({ mode: 'hint', value: 'shots/' });
  expect(catalog.projects.find((project) => project.title === 'Fixture Forced Icon').image).toEqual({ mode: 'none' });
  expect(cache.entries[idOf('Fixture Forced Icon')].directive).toEqual({ mode: 'none', outcome: 'used' });
  expect(cache.entries[idOf('Fixture Hint Fallback')].directive.outcome).toBe('failed');
});

test('A: a README-only project shows the image discovered from its repository', async ({ page }) => {
  const { errors } = await open(page);
  const image = card(page, 'Fixture With Image').locator('img.card-image');
  await expect(image).toHaveCount(1);
  await expect(preview(page, 'Fixture With Image')).toHaveAttribute('data-image-state', 'loaded');
  expect(await image.evaluate((element) => element.naturalWidth)).toBe(640);
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('loading', 'lazy');
  await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(image).toHaveAttribute('width', '640');
  await expect(image).toHaveAttribute('height', '400');
  expect(await image.getAttribute('alt')).toBe('Presto showing the demo');
  expect(await image.getAttribute('src')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/raw\/fixture\/with-image\/HEAD\/images\/demo\.png$/);
  expect(errors).toEqual([]);
});

test('image-hint: the hinted folder wins over the README image; a missing hint falls back to it', async ({ page }) => {
  await open(page);
  const hinted = card(page, 'Fixture Hinted').locator('img.card-image');
  await expect(hinted).toBeVisible();
  expect(await hinted.getAttribute('src')).toMatch(/\/fixture\/hinted\/HEAD\/shots\/hero\.png$/);
  const fallback = card(page, 'Fixture Hint Fallback').locator('img.card-image');
  await expect(fallback).toBeVisible();
  expect(await fallback.getAttribute('src')).toMatch(/\/fixture\/hint-fallback\/HEAD\/images\/readme\.png$/);
  // The directive text never reaches the rendered description.
  await expect(card(page, 'Fixture Hinted')).not.toContainText('image-hint');
  await expect(card(page, 'Fixture Hinted')).not.toContainText('<!--');
});

test('image: none shows the icon and loads no image for that project, with the normal card layout', async ({ page }) => {
  const { thirdParty } = await open(page);
  await expect(card(page, 'Fixture Forced Icon').locator('img')).toHaveCount(0);
  await expect(preview(page, 'Fixture Forced Icon')).toHaveAttribute('data-image-state', 'none');
  await expect(preview(page, 'Fixture Forced Icon').locator('svg')).toBeVisible();
  expect(thirdParty.filter((request) => request.url.includes('/forced-icon/'))).toEqual([]);
  await expect(card(page, 'Fixture Forced Icon')).not.toContainText('image: none');
  const box = await preview(page, 'Fixture Forced Icon').boundingBox();
  const other = await preview(page, 'Fixture No Image').boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([Math.round(other.width), Math.round(other.height)]);
});

test('B and C: projects without a usable image show only the category icon', async ({ page }) => {
  await open(page);
  for (const title of ['Fixture No Image', 'Fixture Rejected Image', 'Other Gamma']) {
    await expect(card(page, title).locator('img')).toHaveCount(0);
    await expect(preview(page, title)).toHaveAttribute('data-image-state', 'none');
    await expect(preview(page, title).locator('svg')).toBeVisible();
  }
});

test('C: an image that fails after the build falls back to the icon without a broken-image indicator', async ({ page }) => {
  await open(page);
  const title = 'Fixture Runtime Missing';
  await expect(preview(page, title)).toHaveAttribute('data-image-state', 'failed');
  const image = card(page, title).locator('img.card-image');
  await expect(image).toBeHidden(); // display:none, so the browser's broken-image glyph and alt text are not drawn
  await expect(preview(page, title).locator('svg')).toBeVisible();
  const heights = await page.locator('.card-preview').evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
});

test('every card preview keeps the same box whatever size or shape the image has, and nothing overflows', async ({ page }) => {
  await open(page);
  const boxes = await page.locator('.card-preview').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }));
  expect(new Set(boxes).size).toBe(1);
  for (const title of ['Fixture Large Image', 'Fixture Tall Image', 'Fixture With Image']) {
    const image = card(page, title).locator('img.card-image');
    await expect(image).toBeVisible();
    const fits = await image.evaluate((element) => {
      const box = element.parentElement.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return rect.width <= box.width + 0.5 && rect.height <= box.height + 0.5;
    });
    expect(fits, title).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('only images are requested from other origins; no scripts, styles, fonts, frames or XHR', async ({ page }) => {
  const { thirdParty } = await open(page);
  expect(thirdParty.length).toBeGreaterThan(0);
  expect(thirdParty.filter((request) => request.type !== 'image')).toEqual([]);
  // The gallery page has no analytics, tracking or remote scripts of its own.
  expect(await page.locator('script[src^="http"], link[href^="http"], iframe').count()).toBe(0);
});

test('search, filters and sorting keep each image with its own card', async ({ page }) => {
  await open(page);
  const imageOf = (title) => card(page, title).locator('img.card-image').getAttribute('src');
  const before = await imageOf('Fixture With Image');
  await page.locator('#project-search').fill('Fixture');
  await expect(visibleCards(page)).toHaveCount(9);
  await page.locator('#sort-projects').selectOption('category');
  await page.locator('button[data-category="other"]').click();
  expect(await imageOf('Fixture With Image')).toBe(before);
  await expect(card(page, 'Fixture With Image').locator('img.card-image')).toBeVisible();
  await page.locator('#reset-filters').click();
  await expect(visibleCards(page)).toHaveCount(total);
  expect(await imageOf('Fixture With Image')).toBe(before);
});

test('the gallery says where preview images come from', async ({ page }) => {
  await open(page);
  await expect(page.locator('.gallery-note')).toContainText("loaded directly from each project's own repository or website");
  await expect(page.getByText('Image credits')).toHaveCount(0);
});
