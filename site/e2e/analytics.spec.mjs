import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { base, catalogFile } from '../site-config.mjs';
import { makePng } from '../tests/support/fixture-server.mjs';

// Browser privacy tests for the consent-gated Google Analytics (src/scripts/analytics.js), on the desktop and mobile projects.
//
// No real analytics is ever sent. The built site is served locally; "the live site" is simulated by answering requests to
// https://jake1164.github.io/awesome-Pimoroni-Presto/ from that local build (the page then really runs on the live origin and
// path), and every Google host is answered by this file: by default a small stand-in for gtag.js (deterministic, offline), or with
// PRESTO_E2E_REAL_GTAG=1 by Google's real gtag.js fetched at test time. Either way every collection request ("hit") is fulfilled
// here and recorded, and none reaches Google.
const LIVE = 'https://jake1164.github.io/awesome-Pimoroni-Presto/';
const LIVE_ORIGIN = new URL(LIVE).origin;
const MEASUREMENT_ID = 'G-K5XSTX64R3';
const COOKIE_ID = MEASUREMENT_ID.slice(2); // the per-property cookie is _ga_<ID without "G-">
const CONSENT_KEY = 'presto-analytics-consent';
const REAL = process.env.PRESTO_E2E_REAL_GTAG === '1';
const GOOGLE_HOST = /(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|gstatic\.com)$/;
const CUSTOM_EVENTS = ['page_view', 'search_used', 'sort_changed', 'category_selected', 'badge_filter_changed', 'project_opened', 'support_click'];

// Google's real library batches events and sends them a few seconds later, so the real-library run waits longer.
const expectSlow = expect.configure({ timeout: REAL ? 20_000 : 5_000 });
test.beforeEach(() => test.setTimeout(REAL ? 180_000 : 30_000));

test.skip(base !== '/awesome-Pimoroni-Presto', 'the live-site path is not this build\'s base (a fork build)');

const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const png = makePng(600, 400, [90, 90, 90]);

// Stands in for gtag.js: processes the dataLayer like gtag.js does (only `arguments` objects count, in order), keeps consent
// state, sets the Google cookies once analytics storage is granted, honours `ga-disable-<ID>`, and reports each event as a GA4
// collection request. Like Consent Mode "advanced", it still sends cookieless pings while consent is denied, which is why
// withdrawal must set `ga-disable`.
const STUB = `(() => {
  const ID = ${JSON.stringify(MEASUREMENT_ID)}, COOKIE = ${JSON.stringify(`_ga_${COOKIE_ID}`)};
  window.__gtagLoads = (window.__gtagLoads || 0) + 1;
  const consent = {};
  const page = {}; // page_location and page_referrer, as set by 'set' / 'config'
  let configured = false;
  const cookies = () => {
    document.cookie = '_ga=GA1.1.111.222; Path=/; Max-Age=63072000';
    document.cookie = COOKIE + '=GS2.1.s1; Path=/; Max-Age=63072000';
  };
  const send = (name, params) => {
    const { page_location, page_referrer, ...rest } = params || {};
    const location_ = page_location ?? page.page_location ?? location.href;
    const referrer_ = page_referrer ?? page.page_referrer ?? document.referrer;
    const query = new URLSearchParams({ v: '2', tid: ID, en: name, gcs: consent.analytics_storage === 'granted' ? 'G101' : 'G100', dl: location_ });
    if (referrer_) query.set('dr', referrer_);
    for (const [key, value] of Object.entries(rest)) query.set((typeof value === 'number' ? 'epn.' : 'ep.') + key, String(value));
    fetch('https://www.google-analytics.com/g/collect?' + query, { method: 'POST', mode: 'no-cors', keepalive: true });
  };
  const handle = (entry) => {
    if (Object.prototype.toString.call(entry) !== '[object Arguments]') return;
    const [command, first, second] = Array.from(entry);
    if (command === 'consent') { Object.assign(consent, second); if (configured && consent.analytics_storage === 'granted') cookies(); }
    else if (command === 'set') Object.assign(page, first);
    else if (command === 'config') { configured = true; const { page_location, page_referrer } = second || {}; Object.assign(page, { ...(page_location !== undefined && { page_location }), ...(page_referrer !== undefined && { page_referrer }) }); if (consent.analytics_storage === 'granted') cookies(); }
    else if (command === 'event') {
      if (window['ga-disable-' + ID]) return;
      if (consent.analytics_storage === 'granted') cookies();
      send(first, second);
    }
  };
  window.dataLayer = window.dataLayer || [];
  const queued = window.dataLayer.slice();
  window.dataLayer.push = (...items) => { items.forEach(handle); return Array.prototype.push.apply(window.dataLayer, items); };
  queued.forEach(handle);
})();`;

/**
 * Answers everything outside the local server for a whole browser context (so several tabs share it) and returns what was
 * recorded. `library`: 'stub' | 'real' | 'blocked' (aborted, like an ad blocker) | 'broken' (HTTP 500).
 * `stored`: a consent value present in localStorage before a page first loads (only if none exists yet).
 * `blockStorage`: `{ set, remove, session }` makes localStorage writes / removals and sessionStorage writes throw (reads still work).
 */
async function arm(context, { library = REAL ? 'real' : 'stub', stored = null, blockStorage = null } = {}) {
  const localOrigin = new URL(test.info().project.use.baseURL).origin;
  const env = { context, google: [], pageErrors: [], elsewhere: [] };
  await context.route(() => true, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === localOrigin) return route.continue();
    if (url.origin === LIVE_ORIGIN) { // the live site, served from the local build
      const mapped = url.pathname.replace('/awesome-Pimoroni-Presto/preview/', '/awesome-Pimoroni-Presto/'); // a nested "preview" path serves the same build
      const response = await route.fetch({ url: `${localOrigin}${mapped}${url.search}` });
      return route.fulfill({ response });
    }
    if (GOOGLE_HOST.test(url.hostname)) {
      env.google.push({ url: request.url(), method: request.method(), body: request.postData() ?? '', type: request.resourceType() });
      const isLibrary = /\/gtag\/js/.test(url.pathname);
      if (library === 'blocked') return route.abort('blockedbyclient');
      if (isLibrary) {
        if (library === 'broken') return route.fulfill({ status: 500, contentType: 'text/plain', body: '' });
        if (library === 'real') return route.fulfill({ response: await route.fetch() });
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
      }
      return route.fulfill(request.resourceType() === 'image' ? { status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') } : { status: 204, body: '' });
    }
    env.elsewhere.push(request.url());
    return request.resourceType() === 'image' ? route.fulfill({ status: 200, contentType: 'image/png', body: png }) : route.abort();
  });
  // Opening a project must not navigate away or open a window; the click handlers still run.
  await context.addInitScript(() => {
    for (const type of ['click', 'auxclick']) {
      document.addEventListener(type, (event) => { if (event.target instanceof Element && event.target.closest('a[target="_blank"]')) event.preventDefault(); }, true);
    }
  });
  if (stored) {
    // Once per tab session (a reload of a tab does not seed again), and only where no choice exists yet.
    await context.addInitScript(([key, value]) => {
      try {
        if (sessionStorage.getItem('__seeded')) return;
        sessionStorage.setItem('__seeded', '1');
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      } catch { /* storage unavailable */ }
    }, [CONSENT_KEY, stored]);
  }
  if (blockStorage) { // after the seeding above, which must still be able to write
    await context.addInitScript((blocked) => {
      const { setItem, removeItem } = Storage.prototype;
      const fail = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
      Storage.prototype.setItem = function guardedSet(...args) { return (this === window.localStorage ? blocked.set : blocked.session) ? fail() : setItem.apply(this, args); };
      Storage.prototype.removeItem = function guardedRemove(...args) { return this === window.localStorage && blocked.remove ? fail() : removeItem.apply(this, args); };
    }, { set: false, remove: false, session: false, ...blockStorage });
  }
  return env;
}

/** Loads the gallery in `page` (a tab of an armed context). `live`: the simulated live origin; otherwise the local server. */
async function visit(page, env, { live = true, url = null, referer = undefined } = {}) {
  page.on('pageerror', (error) => env.pageErrors.push(error.message));
  await page.goto(url ?? (live ? LIVE : './'), referer ? { referer } : undefined);
  await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
}

async function open(page, options = {}) {
  const env = await arm(page.context(), options);
  await visit(page, env, options);
  return env;
}

/** The GA4 hits among the recorded requests: `{ name, params }`, one per event (batched bodies are split). */
function hits(google) {
  const result = [];
  for (const request of google) {
    if (!/\/collect/.test(new URL(request.url).pathname)) continue;
    const common = new URL(request.url).searchParams;
    const lines = request.body ? request.body.split(/\r?\n/).filter(Boolean) : [''];
    for (const line of lines) {
      const query = new URLSearchParams(line);
      const name = query.get('en') ?? common.get('en');
      if (!name) continue;
      const params = {};
      for (const [key, value] of [...common, ...query]) if (/^epn?\./.test(key)) params[key.replace(/^epn?\./, '')] = value;
      result.push({ name, params, gcs: query.get('gcs') ?? common.get('gcs'), dl: query.get('dl') ?? common.get('dl'), dr: query.get('dr') ?? common.get('dr') });
    }
  }
  return result;
}
const ours = (google) => hits(google).filter((hit) => CUSTOM_EVENTS.includes(hit.name));
const libraryLoads = (google) => google.filter((request) => /\/gtag\/js/.test(new URL(request.url).pathname));
const named = (google, name) => ours(google).filter((hit) => hit.name === name);
const quiet = (page, ms = 700) => page.waitForTimeout(REAL ? Math.max(ms, 9_000) : ms);
// Google's real library holds events for a few seconds before sending them. Waiting this out lets everything the visitor did
// while analytics was on leave before the visitor withdraws.
const flushWindow = (page) => page.waitForTimeout(REAL ? 7_000 : 0);
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY);
const cookies = (page) => page.evaluate(() => document.cookie);
const allow = (page) => page.locator('#consent-allow').click();
const decline = (page) => page.locator('#consent-decline').click();
const openSettings = (page) => page.locator('#privacy-settings').click();
const firstCard = (page) => page.locator('.project-card:not([hidden])').first();

/** Every kind of interaction the gallery reports, in one pass. */
async function interact(page) {
  await page.locator('#project-search').fill('presto');
  await page.locator('#project-search').fill('');
  await page.locator('button[data-category]').first().click();
  await page.locator('button[data-all-categories]').click();
  await page.locator('#sort-projects').selectOption('category');
  await page.locator('#sort-projects').selectOption('name');
  await page.locator('button[data-badge="NEW"]').click();
  await page.locator('button[data-badge="NEW"]').click();
  await firstCard(page).locator('a.project-link').click();
  await page.locator('header a[data-support="star"]').click();
  await page.locator('section.support a[data-support="github_sponsors"]').click();
}

test('first visit: the banner asks, and Google is not contacted, no script, no cookie, no stored choice, whatever the visitor does', async ({ page }) => {
  const { google, pageErrors } = await open(page);
  await expect(page.locator('#consent-banner')).toBeVisible();
  await expect(page.locator('#consent-banner')).toContainText('Google Analytics');
  await expect(page.locator('#consent-banner')).toContainText('never send your gallery search text as a custom event');
  await expect(page.locator('#consent-banner')).not.toContainText(/anonymous/i);
  await expect(page.locator('#privacy-footer')).toBeVisible();
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);
  expect(await page.evaluate(() => ({ layer: typeof window.dataLayer, scripts: document.querySelectorAll('script[src*="google"]').length }))).toEqual({ layer: 'undefined', scripts: 0 });
  expect(await cookies(page)).not.toMatch(/_ga/);
  expect(await stored(page)).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('declining persists: nothing is requested, not after a reload either, and interactions stay silent', async ({ page }) => {
  const { google, pageErrors } = await open(page);
  await decline(page);
  await expect(page.locator('#consent-banner')).toBeHidden();
  await expect(page.locator('#privacy-status')).toHaveText('Analytics declined');
  expect(await stored(page)).toBe('denied');
  await interact(page);
  await page.reload();
  await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
  await expect(page.locator('#consent-banner')).toBeHidden();
  await expect(page.locator('#privacy-status')).toHaveText('Analytics declined');
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);
  expect(await page.evaluate(() => typeof window.dataLayer)).toBe('undefined');
  expect(pageErrors).toEqual([]);
});

test('accepting initialises Google once, sends one page view, and an accepted reload starts again with one of each, not more', async ({ page }) => {
  const { google, pageErrors } = await open(page);
  await allow(page);
  await expect(page.locator('#privacy-status')).toHaveText('Analytics allowed');
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  expect(libraryLoads(google)).toHaveLength(1);
  expect(await stored(page)).toBe('granted');
  expect(await cookies(page)).toMatch(/_ga=/);
  expect(await cookies(page)).toContain(`_ga_${COOKIE_ID}=`);
  if (!REAL) expect(await page.evaluate(() => window.__gtagLoads)).toBe(1);
  await page.locator('button[data-category]').first().click();
  await expectSlow.poll(() => named(google, 'category_selected').length).toBe(1);
  await quiet(page);
  expect(named(google, 'page_view')).toHaveLength(1);
  expect(libraryLoads(google)).toHaveLength(1);

  // A reload is a new page load: one library, one page view, and no banner.
  google.length = 0;
  await page.reload();
  await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
  await expect(page.locator('#consent-banner')).toBeHidden();
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await quiet(page);
  expect(libraryLoads(google)).toHaveLength(1);
  expect(named(google, 'page_view')).toHaveLength(1);
  if (!REAL) expect(await page.evaluate(() => window.__gtagLoads)).toBe(1);
  expect(pageErrors).toEqual([]);
});

test('withdrawing stops collection at once, in the same session and after a reload, and deletes the cookies; allowing again resumes', async ({ page }) => {
  const { google, pageErrors } = await open(page, { stored: 'granted' });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  expect(await cookies(page)).toMatch(/_ga=/);

  // Withdraw in the same session.
  await openSettings(page);
  await expect(page.locator('#consent-banner')).toBeVisible();
  await expect(page.locator('#consent-decline')).toBeFocused();
  await flushWindow(page);
  await decline(page);
  expect(await stored(page)).toBe('denied');
  expect(await page.evaluate((id) => window[`ga-disable-${id}`], MEASUREMENT_ID)).toBe(true);
  expect(await cookies(page)).not.toMatch(/_ga/);
  google.length = 0;
  await interact(page);
  await quiet(page, 900);
  expect(hits(google), 'no collection request of any kind after withdrawal').toEqual([]);
  expect(google.filter((request) => /\/collect/.test(request.url))).toEqual([]);

  // After a reload the choice is still withdrawn and nothing is loaded.
  await page.reload();
  await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);

  // Allowing again: collection resumes (this is a new page load, so it has its own page view).
  await openSettings(page);
  await expect(page.locator('#consent-allow')).toBeFocused();
  await allow(page);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await page.locator('button[data-category]').first().click();
  await expectSlow.poll(() => named(google, 'category_selected').length).toBe(1);
  expect(libraryLoads(google)).toHaveLength(1);
  expect(await cookies(page)).toMatch(/_ga=/);
  expect(pageErrors).toEqual([]);
});

// Limit of Google's library, not of this site: events the visitor generated while analytics was on may still be sitting in
// the library's batch when they withdraw, and are sent a few seconds later. Nothing generated after the withdrawal is.
test('after withdrawal nothing new is sent; at most what was already queued is flushed', async ({ page }) => {
  const { google } = await open(page, { stored: 'granted' });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await page.locator('button[data-category]').first().click(); // generated while consented, possibly still queued
  await page.waitForTimeout(150);
  const mark = google.length;
  await openSettings(page);
  await decline(page);
  // Generated after the withdrawal: none of these may ever be sent, by us or by Google's automatic measurement.
  await page.locator('#sort-projects').selectOption('category');
  await firstCard(page).locator('a.project-link').click();
  await page.locator('header a[data-support="star"]').click();
  await page.locator('button[data-badge="RECENT"]').click(); // may match no project; the filter still changes
  await page.locator('button[data-badge="RECENT"]').click();
  await page.locator('#project-search').fill('after-withdrawal');
  await quiet(page, 1500);
  const after = hits(google.slice(mark)).map((hit) => hit.name);
  const queuedBefore = ['category_selected', 'scroll', 'user_engagement'];
  for (const name of after) expect(queuedBefore, `${name} was generated after the withdrawal`).toContain(name);
  if (!REAL) expect(after).toEqual([]); // the stand-in sends immediately, so nothing can be left queued
  await page.waitForTimeout(REAL ? 7_000 : 300);
  const settled = google.length;
  await page.locator('button[data-category]').nth(1).click();
  await quiet(page, 1500);
  expect(google.length, 'the flush is a one-off: nothing further follows').toBe(settled);
});

test('re-enabling in the same page load resumes events with no second library and no second page view', async ({ page }) => {
  const { google } = await open(page, { stored: 'granted' });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await openSettings(page);
  await decline(page);
  await page.locator('button[data-category]').first().click();
  await quiet(page);
  expect(named(google, 'category_selected')).toHaveLength(0);
  await openSettings(page);
  await allow(page);
  await page.locator('button[data-category]').nth(1).click();
  await expectSlow.poll(() => named(google, 'category_selected').length).toBe(1);
  await quiet(page);
  expect(named(google, 'page_view'), 'exactly one page view per page load').toHaveLength(1);
  expect(libraryLoads(google), 'one initialisation per page load').toHaveLength(1);
  if (!REAL) expect(await page.evaluate(() => window.__gtagLoads)).toBe(1);
  expect(await page.evaluate((id) => window[`ga-disable-${id}`], MEASUREMENT_ID)).toBe(false);
});

test('on the live origin the page works; anywhere else analytics is unavailable even with a stored "granted"', async ({ page }) => {
  const { google } = await open(page, { live: false, stored: 'granted' });
  expect(new URL(page.url()).origin).not.toBe(LIVE_ORIGIN);
  await expect(page.locator('#consent-banner')).toBeHidden();
  await expect(page.locator('#privacy-footer')).toBeHidden();
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);
  expect(await page.evaluate(() => ({ layer: typeof window.dataLayer, scripts: document.querySelectorAll('script[src*="google"]').length }))).toEqual({ layer: 'undefined', scripts: 0 });
  expect(await cookies(page)).not.toMatch(/_ga/);
});

test('the live-origin simulation is the real site: same page, every card, banner shown', async ({ page }) => {
  await open(page);
  expect(page.url()).toBe(LIVE);
  await expect(page.getByRole('heading', { name: 'Help improve this community project' })).toBeVisible();
  await expect(page.locator('#privacy-settings')).toHaveText('Privacy / Analytics settings');
});

test('search text is never transmitted: one search_used per search, no text anywhere in any request', async ({ page }) => {
  const { google } = await open(page, { stored: 'granted' });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  const secret = 'zzsecretsearchterm';
  const search = page.locator('#project-search');
  await search.pressSequentially(secret, { delay: 10 });
  await expectSlow.poll(() => named(google, 'search_used').length).toBe(1);
  await search.fill('');
  await search.pressSequentially(`${secret}two`, { delay: 5 });
  await expectSlow.poll(() => named(google, 'search_used').length).toBe(2); // a new search after clearing, not each keystroke
  await page.keyboard.press('Escape');
  await search.fill('another-private-query');
  await expectSlow.poll(() => named(google, 'search_used').length).toBe(3);
  await quiet(page);
  const everything = decodeURIComponent(JSON.stringify(google)).toLowerCase();
  for (const text of [secret, 'private-query', 'another']) expect(everything).not.toContain(text);
  expect(named(google, 'search_used').every((hit) => Object.keys(hit.params).length === 0)).toBe(true);
});

test('events and parameters: project clicks use the stable catalog id; support clicks name their type; no duplicates', async ({ page }) => {
  const { google } = await open(page, { stored: 'granted' });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);

  const card = firstCard(page);
  const expected = { id: await card.getAttribute('data-id'), category: await card.getAttribute('data-category') };
  expect(expected.id).toMatch(/^presto_[0-9a-f]{64}$/);
  expect(catalog.projects.find((project) => project.id === expected.id)).toBeTruthy();
  await card.locator('a.project-link').click();
  await expectSlow.poll(() => named(google, 'project_opened').length).toBe(1);
  await card.locator('a.project-link').click({ button: 'middle' });
  await expectSlow.poll(() => named(google, 'project_opened').length).toBe(2);
  await card.locator('a.project-link').click({ modifiers: ['Control'] });
  await expectSlow.poll(() => named(google, 'project_opened').length).toBe(3);
  for (const hit of named(google, 'project_opened')) expect(hit.params).toEqual({ project_id: expected.id, category: expected.category });

  // A project's own GitHub star count is not a project open and not support.
  const starLink = page.locator('.project-card a.star-link').first();
  if (await starLink.count()) await starLink.click();

  const support = [
    ['header a[data-support="star"]', { support_type: 'star', placement: 'header' }],
    ['section.support a[data-support="star"]', { support_type: 'star', placement: 'footer' }],
    ['section.support a[data-support="github_sponsors"]', { support_type: 'github_sponsors', placement: 'footer' }],
    ['section.support a[data-support="buy_me_a_coffee"]', { support_type: 'buy_me_a_coffee', placement: 'footer' }],
  ];
  for (const [index, [selector, params]] of support.entries()) {
    await page.locator(selector).click();
    await expectSlow.poll(() => named(google, 'support_click').length).toBe(index + 1);
    expect(named(google, 'support_click').at(-1).params).toEqual(params);
  }
  await page.locator('section.support a[data-support="buy_me_a_coffee"]').click({ button: 'middle' });
  await expectSlow.poll(() => named(google, 'support_click').length).toBe(5);

  // Filters: category (incl. all), sort, badge. Re-selecting the current category is not a change.
  const first = page.locator('button[data-category]').first();
  const slug = await first.getAttribute('data-category');
  await first.click();
  await first.click();
  await page.locator('button[data-all-categories]').click();
  await page.locator('#sort-projects').selectOption('category');
  await page.locator('button[data-badge="RECENT"]').click();
  await page.locator('button[data-badge="RECENT"]').click();
  await expectSlow.poll(() => named(google, 'badge_filter_changed').length).toBe(2);
  await quiet(page);
  expect(named(google, 'category_selected').map((hit) => hit.params)).toEqual([{ category: slug }, { category: '_all' }]);
  expect(named(google, 'sort_changed').map((hit) => hit.params)).toEqual([{ sort_by: 'category' }]);
  expect(named(google, 'badge_filter_changed').map((hit) => hit.params)).toEqual([{ badge: 'RECENT', enabled: 'true' }, { badge: 'RECENT', enabled: 'false' }]);
  expect(named(google, 'page_view')).toHaveLength(1);
  expect(named(google, 'project_opened')).toHaveLength(3);
  expect(named(google, 'support_click')).toHaveLength(5);
  expect(ours(google).every((hit) => hit.gcs === 'G101'), 'every event is sent with analytics storage granted and everything else denied').toBe(true);
});

test('the consent banner and settings work on a phone and with the keyboard only', async ({ page }) => {
  const { google, pageErrors } = await open(page);
  const viewport = page.viewportSize();
  const banner = page.locator('#consent-banner');
  await expect(banner).toBeVisible();
  const box = await banner.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  for (const id of ['#consent-allow', '#consent-decline']) {
    const button = await page.locator(id).boundingBox();
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.x + button.width).toBeLessThanOrEqual(viewport.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The banner is the first thing in the tab order; its buttons show a focus ring.
  await page.keyboard.press('Tab');
  await expect(page.locator('#consent-allow')).toBeFocused();
  const ring = await page.locator('#consent-allow').evaluate((element) => ({ style: getComputedStyle(element).outlineStyle, width: Number.parseFloat(getComputedStyle(element).outlineWidth) }));
  expect(ring.style).not.toBe('none');
  expect(ring.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Tab');
  await expect(page.locator('#consent-decline')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter'); // Allow analytics
  await expect(banner).toBeHidden();
  await expect(page.locator('#privacy-settings')).toBeFocused(); // focus is not lost when the banner goes
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);

  // Settings reopen the banner with the opposite choice focused; Enter withdraws.
  await page.keyboard.press('Enter');
  await expect(banner).toBeVisible();
  await expect(page.locator('#consent-decline')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(banner).toBeHidden();
  await expect(page.locator('#privacy-settings')).toBeFocused();
  await expect(page.locator('#privacy-status')).toHaveText('Analytics declined');
  google.length = 0;
  await page.locator('button[data-category]').first().click();
  await quiet(page);
  expect(hits(google)).toEqual([]);

  // The control is reachable and visible at the bottom of the page on a small screen.
  await page.locator('#privacy-settings').scrollIntoViewIfNeeded();
  const settings = await page.locator('#privacy-settings').boundingBox();
  expect(settings.height).toBeGreaterThanOrEqual(44);
  expect(settings.x + settings.width).toBeLessThanOrEqual(viewport.width);
  expect(pageErrors).toEqual([]);
});

for (const library of ['blocked', 'broken']) {
  test(`the gallery keeps working when Google is ${library === 'blocked' ? 'blocked (ad blocker)' : 'broken (HTTP 500)'}`, async ({ page }) => {
    const { pageErrors } = await open(page, { library });
    await allow(page);
    await expect(page.locator('#privacy-status')).toHaveText('Analytics allowed');
    expect(await stored(page)).toBe('granted');

    const search = page.locator('#project-search');
    await search.fill('zzzz-no-such-project');
    await expect(page.locator('.project-card:not([hidden])')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
    await page.locator('#empty-reset').click();
    await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
    await page.locator('button[data-category]').first().click();
    const inCategory = catalog.projects.filter((project) => project.category_slug === catalog.categories[0].slug).length;
    await expect(page.locator('.project-card:not([hidden])')).toHaveCount(inCategory);
    await page.locator('#reset-filters').click();
    await page.locator('#sort-projects').selectOption('category');
    await firstCard(page).locator('a.project-link').click();
    await page.locator('section.support a[data-support="star"]').click();
    await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);

    await openSettings(page);
    await decline(page);
    await expect(page.locator('#privacy-status')).toHaveText('Analytics declined');
    expect(pageErrors).toEqual([]);
  });
}

test('a browser that blocks storage keeps analytics off and the gallery working', async ({ page }) => {
  await page.context().addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  const { google, pageErrors } = await open(page);
  await expect(page.locator('#consent-banner')).toBeVisible();
  await allow(page);
  await expect(page.locator('#privacy-status')).toContainText('stays off');
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 1: several tabs, one consent. Two real tabs of one browser context share localStorage and cookies.

const collects = (google) => google.filter((request) => /\/collect/.test(new URL(request.url).pathname));
const gaDisabled = (page) => page.evaluate((id) => window[`ga-disable-${id}`], MEASUREMENT_ID);
const status = (page) => page.locator('#privacy-status');

test('tabs: withdrawing in tab A switches tab B off, and B generates no custom or automatic collection afterwards', async ({ page }) => {
  const env = await arm(page.context());
  const { google } = env;
  await visit(page, env);
  await allow(page);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);

  const tabB = await page.context().newPage();
  await visit(tabB, env);
  await expect(status(tabB)).toHaveText('Analytics allowed'); // B recognises the consent given in A
  await expect(tabB.locator('#consent-banner')).toBeHidden();
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(2); // one per page load
  await tabB.locator('button[data-category]').first().click();
  await expectSlow.poll(() => named(google, 'category_selected').length).toBe(1);
  expect(await cookies(tabB)).toMatch(/_ga=/);

  await openSettings(page);
  await flushWindow(page); // everything either tab did while consented has left
  await decline(page);
  await expect(status(tabB)).toHaveText('Analytics declined'); // the browser's storage event reaches B
  await expect(tabB.locator('#consent-banner')).toBeHidden();
  expect(await gaDisabled(tabB)).toBe(true);
  expect(await cookies(tabB)).not.toMatch(/_ga/);

  const mark = google.length;
  await tabB.bringToFront();
  await interact(tabB);
  await quiet(tabB, 1500);
  expect(collects(google.slice(mark)), 'no custom or automatic collection from B after it learned of the withdrawal').toEqual([]);
  expect(await cookies(tabB), 'analytics cookies are not recreated').not.toMatch(/_ga/);
  expect(await cookies(page)).not.toMatch(/_ga/);
  expect(env.pageErrors).toEqual([]);
});

test('tabs: a tab that loaded before consent is switched on by a grant in another tab, once, and off by its withdrawal', async ({ page }) => {
  const env = await arm(page.context());
  const { google } = env;
  await visit(page, env);
  const tabB = await page.context().newPage();
  await visit(tabB, env);
  await expect(page.locator('#consent-banner')).toBeVisible();
  await expect(tabB.locator('#consent-banner')).toBeVisible();
  await quiet(page);
  expect(google).toEqual([]);

  await allow(page);
  await expect(status(tabB)).toHaveText('Analytics allowed');
  await expect(tabB.locator('#consent-banner')).toBeHidden();
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(2); // A and B each report their own page load, once
  await quiet(page, 800);
  expect(named(google, 'page_view')).toHaveLength(2);
  expect(libraryLoads(google)).toHaveLength(2); // one library per page, none duplicated
  if (!REAL) {
    expect(await page.evaluate(() => window.__gtagLoads)).toBe(1);
    expect(await tabB.evaluate(() => window.__gtagLoads)).toBe(1);
  }
  await tabB.locator('button[data-category]').first().click();
  await expectSlow.poll(() => named(google, 'category_selected').length).toBe(1);

  await openSettings(page);
  await flushWindow(page);
  await decline(page);
  await expect(status(tabB)).toHaveText('Analytics declined');
  const mark = google.length;
  await interact(tabB);
  await quiet(tabB, 1500);
  expect(collects(google.slice(mark))).toEqual([]);
  expect(await cookies(tabB)).not.toMatch(/_ga/);
});

for (const [name, change] of [
  ['a malformed value', (page) => page.evaluate((key) => localStorage.setItem(key, 'garbage'), CONSENT_KEY)],
  ['a removed value', (page) => page.evaluate((key) => localStorage.removeItem(key), CONSENT_KEY)],
  ['a cleared storage', (page) => page.evaluate(() => localStorage.clear())],
]) {
  test(`tabs: ${name} in another tab is denial: B turns off, asks again, and a later valid grant turns it on without a second initialisation`, async ({ page }) => {
    const env = await arm(page.context(), { stored: 'granted' });
    const { google } = env;
    await visit(page, env);
    const tabB = await page.context().newPage();
    await visit(tabB, env);
    await expectSlow.poll(() => named(google, 'page_view').length).toBe(2);
    await flushWindow(page);

    await change(page);
    await expect(tabB.locator('#consent-banner')).toBeVisible(); // no valid choice: it asks
    await expect(status(tabB)).toHaveText('');
    expect(await gaDisabled(tabB)).toBe(true);
    expect(await cookies(tabB)).not.toMatch(/_ga/);
    const mark = google.length;
    await tabB.bringToFront();
    await interact(tabB);
    await quiet(tabB, 1500);
    expect(collects(google.slice(mark))).toEqual([]);
    expect(await cookies(tabB)).not.toMatch(/_ga/);

    await page.evaluate((key) => localStorage.setItem(key, 'granted'), CONSENT_KEY);
    await expect(status(tabB)).toHaveText('Analytics allowed');
    await expect(tabB.locator('#consent-banner')).toBeHidden();
    expect(await gaDisabled(tabB)).toBe(false);
    await quiet(tabB, 800);
    expect(libraryLoads(google), 'no second initialisation').toHaveLength(2);
    expect(named(google, 'page_view'), 'no second page view').toHaveLength(2);
    if (!REAL) expect(await tabB.evaluate(() => window.__gtagLoads)).toBe(1);
    expect(env.pageErrors).toEqual([]);
  });
}

test('tabs: a custom event re-checks the stored consent, so a tab that missed the storage event still sends nothing', async ({ page }) => {
  const env = await arm(page.context(), { stored: 'granted' });
  const { google } = env;
  await visit(page, env);
  const tabB = await page.context().newPage();
  // Tab B never hears of changes: its storage listeners are pre-empted.
  await tabB.addInitScript(() => window.addEventListener('storage', (event) => event.stopImmediatePropagation(), true));
  await visit(tabB, env);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(2);
  await openSettings(page);
  await flushWindow(page);
  await decline(page);
  await quiet(page, 500);
  await expect(status(tabB)).toHaveText('Analytics allowed'); // still believes it, as designed for this test

  const mark = google.length;
  await tabB.bringToFront();
  await tabB.locator('button[data-category]').first().click();
  await tabB.locator('#sort-projects').selectOption('category');
  await quiet(tabB, 1500);
  expect(ours(google.slice(mark)), 'no custom event from B').toEqual([]);
  await expect(status(tabB)).toHaveText('Analytics declined'); // and the check also brought its UI and switch up to date
  expect(await gaDisabled(tabB)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 2: a withdrawal the browser will not store

test('storage: writes and removals blocked, sessionStorage works: withdrawal holds for this tab and its reloads, and says so truthfully', async ({ page }) => {
  const env = await arm(page.context(), { stored: 'granted', blockStorage: { set: true, remove: true } });
  const { google } = env;
  await visit(page, env);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await openSettings(page);
  await flushWindow(page);
  await decline(page);
  await expect(status(page)).toContainText('off for this browser session');
  await expect(status(page)).toContainText('would not save your choice for later');
  await expect(status(page)).not.toContainText(/analytics declined/i);
  expect(await stored(page), 'the stale grant could not be replaced').toBe('granted');
  expect(await gaDisabled(page)).toBe(true);
  const mark = google.length;
  await interact(page);
  await quiet(page, 1500);
  expect(collects(google.slice(mark))).toEqual([]);

  google.length = 0;
  await page.reload(); // same tab, same session: the override holds
  await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
  await expect(status(page)).toHaveText('Analytics declined');
  await expect(page.locator('#consent-banner')).toBeHidden();
  expect(await page.evaluate(() => typeof window.dataLayer)).toBe('undefined');
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);

  // A different tab is a new session with no override: the stale grant applies there. Unavoidable, and the page shows it as
  // "allowed", never as "declined".
  const fresh = await page.context().newPage();
  await visit(fresh, env);
  await expect(status(fresh)).toHaveText('Analytics allowed');
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
});

test('storage: sessionStorage blocked too: this page stays off and says "this page only"; a reload resumes from the stale grant, as stated', async ({ page }) => {
  const env = await arm(page.context(), { stored: 'granted', blockStorage: { set: true, remove: true, session: true } });
  const { google } = env;
  await visit(page, env);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await openSettings(page);
  await flushWindow(page);
  await decline(page);
  await expect(status(page)).toContainText('off on this page only');
  await expect(status(page)).toContainText('may apply again when you reload or return');
  await expect(page.locator('#consent-banner')).toBeHidden();
  expect(await gaDisabled(page)).toBe(true);
  const mark = google.length;
  await interact(page);
  await quiet(page, 1500);
  expect(collects(google.slice(mark))).toEqual([]);

  google.length = 0;
  await page.reload();
  await expect(page.locator('.project-card:not([hidden])')).toHaveCount(catalog.projects.length);
  await expect(status(page)).toHaveText('Analytics allowed'); // honest: the stale grant is all the browser holds
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await openSettings(page); // and the visitor can withdraw again
  await flushWindow(page);
  await decline(page);
  await expect(status(page)).toContainText('off on this page only');
});

test('storage: writes blocked but removal works: the grant is removed, the page says the choice is not kept, and a reload asks again', async ({ page }) => {
  const env = await arm(page.context(), { stored: 'granted', blockStorage: { set: true } });
  const { google } = env;
  await visit(page, env);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  await openSettings(page);
  await flushWindow(page);
  await decline(page);
  await expect(status(page)).toContainText('would not save this choice, so you may be asked again');
  expect(await stored(page)).toBeNull();
  const mark = google.length;
  await interact(page);
  await quiet(page, 1500);
  expect(collects(google.slice(mark))).toEqual([]);
  google.length = 0;
  await page.reload();
  await expect(page.locator('#consent-banner')).toBeVisible();
  await quiet(page);
  expect(google).toEqual([]);
});

test('storage: nothing stored and nothing writable: declining is silent and honest, and the gallery works', async ({ page }) => {
  const env = await arm(page.context(), { blockStorage: { set: true, remove: true, session: true } });
  const { google } = env;
  await visit(page, env);
  await decline(page);
  await expect(status(page)).toContainText('would not save this choice');
  await interact(page);
  await quiet(page);
  expect(google).toEqual([]);
  await page.reload();
  await expect(page.locator('#consent-banner')).toBeVisible();
  await allow(page); // allowing needs a stored grant, so it stays off and says why
  await expect(status(page)).toContainText('stays off');
  await quiet(page);
  expect(google).toEqual([]);
  expect(env.pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 3: what Google is told about the page

const SENSITIVE = ['review-sensitive-query', 'utm_source', 'newsletter', 'frag-secret', 'secret-ref', '/some/path'];
// Automatic events of the GA4 data stream that code cannot switch off: `user_engagement` is always on; scroll, outbound click,
// downloads, video and form events are Enhanced measurement, a console setting (README: "Required GA4 Console Configuration").
const ALWAYS_AUTOMATIC = ['user_engagement'];

test('page location and referrer: only the canonical page and the referrer origin reach Google; no query value anywhere', async ({ page }) => {
  const env = await arm(page.context(), { stored: 'granted' });
  const { google } = env;
  await visit(page, env, {
    url: `${LIVE}?q=review-sensitive-query&utm_source=newsletter#frag-secret`,
    referer: 'https://external.example/some/path?token=secret-ref#h',
  });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  const address = new URL(page.url());
  expect(address.search, 'the query string is gone before Google\'s library loads').toBe('');
  expect(address.pathname).toBe('/awesome-Pimoroni-Presto/');

  await page.mouse.wheel(0, 8000);
  await page.locator('#project-search').fill('review-sensitive-query');
  await page.locator('#project-search').fill('');
  await firstCard(page).locator('a.project-link').click();
  await page.locator('header a[data-support="star"]').click();
  await page.waitForTimeout(REAL ? 12_000 : 500); // delayed requests too

  const everything = decodeURIComponent(JSON.stringify(google.map((request) => ({ url: request.url, body: request.body })))).toLowerCase();
  for (const text of SENSITIVE) expect(everything, `"${text}" must never be transmitted`).not.toContain(text);
  const all = hits(google);
  expect(all.length).toBeGreaterThan(0);
  for (const hit of all) {
    if (hit.dl) expect(hit.dl, `page location of ${hit.name}`).toBe(LIVE);
    expect(['', null, undefined, 'https://external.example/'], `referrer of ${hit.name}`).toContain(hit.dr);
  }
  const names = all.map((hit) => hit.name);
  expect(names, 'no automatic site-search event').not.toContain('view_search_results');
  expect(names.filter((name) => name === 'page_view')).toHaveLength(1);
  // Custom event payloads hold no free text and no URL.
  for (const hit of ours(google)) {
    for (const value of Object.values(hit.params)) expect(value, `${hit.name} parameter`).not.toMatch(/https?:|\/\/|\s|\?|#/);
  }
  const extra = [...new Set(names.filter((name) => !CUSTOM_EVENTS.includes(name) && !ALWAYS_AUTOMATIC.includes(name)))];
  test.info().annotations.push({ type: 'console-controlled automatic events observed', description: extra.length ? extra.join(', ') : 'none' });
  if (process.env.PRESTO_E2E_REQUIRE_CLEAN_GA === '1') expect(extra, 'switch these off in the GA4 console (Enhanced measurement)').toEqual([]);
  expect(env.pageErrors).toEqual([]);
});

test('a referrer with no usable origin sends none, and a plain visit leaves the address bar alone', async ({ page }) => {
  const env = await arm(page.context(), { stored: 'granted' });
  const { google } = env;
  await visit(page, env, { url: `${LIVE}#support` });
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);
  expect(new URL(page.url()).hash).toBe('#support');
  for (const hit of hits(google)) {
    expect(hit.dl ?? LIVE).toBe(LIVE);
    expect(['', null, undefined]).toContain(hit.dr);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 5: every project destination counts, once

const withLinks = catalog.projects.find((project) => (project.description_parts ?? []).some((part) => part.url));

test('project links inside a description (live demos, forum threads) count as project opens, once, by mouse, keyboard and middle click', async ({ page }) => {
  test.skip(!withLinks, 'no project description in this catalog contains a link');
  const env = await arm(page.context(), { stored: 'granted' });
  const { google } = env;
  await visit(page, env);
  await expectSlow.poll(() => named(google, 'page_view').length).toBe(1);

  const card = page.locator(`.project-card[data-id="${withLinks.id}"]`);
  const link = card.locator('.card-description a').first();
  await link.scrollIntoViewIfNeeded();
  const expected = { project_id: withLinks.id, category: withLinks.category_slug };
  const count = () => named(google, 'project_opened').length;

  await link.click();
  await expectSlow.poll(count).toBe(1);
  await link.focus();
  await page.keyboard.press('Enter');
  await expectSlow.poll(count).toBe(2);
  await link.click({ button: 'middle' });
  await expectSlow.poll(count).toBe(3);
  await card.locator('a.project-link').click();
  await expectSlow.poll(count).toBe(4);
  await quiet(page, 900);
  expect(count(), 'each activation counted exactly once').toBe(4);
  for (const hit of named(google, 'project_opened')) expect(hit.params).toEqual(expected); // IDs and categories only, never an address

  // Not project opens: the card's GitHub star link, and text that is not a link.
  const star = card.locator('a.star-link');
  if (await star.count()) await star.click();
  await card.locator('.card-description').click({ position: { x: 1, y: 1 } });
  await card.locator('h2').click();
  await quiet(page, 700);
  expect(count()).toBe(4);
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 6: only the exact live page

for (const pathname of ['/awesome-Pimoroni-Presto/index.html', '/awesome-Pimoroni-Presto/preview/']) {
  test(`${pathname} on the live origin is not the live page: analytics never loads, even with a stored "granted"`, async ({ page }) => {
    const env = await arm(page.context(), { stored: 'granted' });
    await visit(page, env, { url: `${LIVE_ORIGIN}${pathname}` });
    await expect(page.locator('#consent-banner')).toBeHidden();
    await expect(page.locator('#privacy-footer')).toBeHidden();
    await interact(page);
    await quiet(page);
    expect(env.google).toEqual([]);
    expect(await page.evaluate(() => typeof window.dataLayer)).toBe('undefined');
  });
}
