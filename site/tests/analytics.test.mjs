import assert from 'node:assert/strict';
import test from 'node:test';
import { base, siteOrigin } from '../site-config.mjs';
import {
  CONSENT_KEY, MEASUREMENT_ID, MESSAGES, OVERRIDE_KEY, PRODUCTION_ORIGIN, PRODUCTION_PATH, createAnalytics, isProductionSite, sanitizeReferrer,
} from '../src/scripts/analytics.js';

// The consent logic of src/scripts/analytics.js against a fake browser (several tabs can share one localStorage). The real
// browser behaviour (requests, cookies, Google's library, real tabs) is covered by e2e/analytics.spec.mjs.
const LIVE = 'https://jake1164.github.io/awesome-Pimoroni-Presto/';
const ID_COOKIE = `_ga_${MEASUREMENT_ID.slice(2)}`;

function element() {
  return {
    hidden: false, textContent: '', handlers: {}, focused: false,
    addEventListener(type, handler) { this.handlers[type] = handler; },
    click() { this.handlers.click(); },
    focus() { this.focused = true; },
  };
}

/** A Storage stand-in. `failing` lists the operations that throw ('get', 'set', 'remove'); a shared Map makes tabs share it. */
function storageArea(map, failing = []) {
  return {
    map,
    getItem(key) { if (failing.includes('get')) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (failing.includes('set')) throw new Error('quota'); map.set(key, String(value)); },
    removeItem(key) { if (failing.includes('remove')) throw new Error('blocked'); map.delete(key); },
  };
}

/** One tab. `local` is a Map shared between tabs; `session` is per tab. */
function browser({
  href = LIVE, stored = null, local = new Map(), session = new Map(), localFails = [], sessionFails = [], cookies = [], referrer = '',
} = {}) {
  if (stored) local.set(CONSENT_KEY, stored);
  const jar = new Map(cookies.map((cookie) => cookie.split('=')));
  const scripts = [];
  const listeners = {};
  const replaced = [];
  const document = {
    referrer,
    visibilityState: 'visible',
    get cookie() { return [...jar].map(([name, value]) => `${name}=${value}`).join('; '); },
    set cookie(text) {
      const [pair, ...attributes] = text.split(';').map((part) => part.trim());
      const [name, value] = pair.split('=');
      if (attributes.some((attribute) => /^max-age=0$/i.test(attribute))) jar.delete(name);
      else jar.set(name, value);
    },
    createElement: () => ({}),
    head: { append: (script) => scripts.push(script) },
    addEventListener(type, handler) { (listeners[`document:${type}`] ??= []).push(handler); },
  };
  const url = new URL(href);
  const window = {
    location: url,
    history: { state: null, replaceState(state, title, target) { replaced.push(target); } },
    localStorage: storageArea(local, localFails),
    sessionStorage: storageArea(session, sessionFails),
    addEventListener(type, handler) { (listeners[`window:${type}`] ??= []).push(handler); },
  };
  const elements = { banner: element(), allow: element(), decline: element(), settings: element(), status: element(), container: element() };
  elements.container.hidden = true; // both ship hidden
  elements.banner.hidden = true;
  const analytics = createAnalytics({ window, document });
  analytics.initAnalyticsConsent(elements);
  const commands = () => (window.dataLayer ?? []).map((entry) => [...entry]);
  const events = () => commands().filter(([command]) => command === 'event').map(([, name, parameters]) => [name, parameters]);
  const names = () => events().map(([name]) => name);
  // The browser tells the OTHER tabs about a localStorage change; call this on them.
  const storageEvent = (key = CONSENT_KEY) => (listeners['window:storage'] ?? []).forEach((handler) => handler({ key }));
  const becomeVisible = () => (listeners['document:visibilitychange'] ?? []).forEach((handler) => handler());
  return { analytics, window, document, scripts, elements, local, session, jar, replaced, commands, events, names, storageEvent, becomeVisible };
}
const disabledFlag = (page) => page.window[`ga-disable-${MEASUREMENT_ID}`];

test('the production constants are the site configuration, and only the live origin and exact path count', () => {
  if (!process.env.GITHUB_REPOSITORY) assert.equal(`${siteOrigin}${base}/`, `${PRODUCTION_ORIGIN}${PRODUCTION_PATH}`);
  assert.equal(MEASUREMENT_ID, 'G-K5XSTX64R3');
  assert.equal(isProductionSite(new URL(LIVE)), true);
  assert.equal(isProductionSite(new URL(`${LIVE}?q=1#top`)), true, 'a query string or fragment does not change the path');
  for (const href of [
    'https://jake1164.github.io/awesome-Pimoroni-Presto/preview/', 'https://jake1164.github.io/awesome-Pimoroni-Presto/pr-12/index.html',
    'https://jake1164.github.io/awesome-Pimoroni-Presto/index.html', 'https://jake1164.github.io/awesome-Pimoroni-Presto', 'https://jake1164.github.io/awesome-Pimoroni-Presto//',
    'https://jake1164.github.io/awesome-Pimoroni-Presto/a/..%2f', 'http://localhost:8088/awesome-Pimoroni-Presto/', 'http://127.0.0.1:8765/awesome-Pimoroni-Presto/',
    'http://jake1164.github.io/awesome-Pimoroni-Presto/', 'https://jake1164.github.io/', 'https://jake1164.github.io/other/', 'https://jake1164.github.io/awesome-Pimoroni-Presto-fork/',
    'https://jake1164.github.io/Awesome-Pimoroni-Presto/', 'https://someone-else.github.io/awesome-Pimoroni-Presto/', 'https://jake1164.github.io.example.org/awesome-Pimoroni-Presto/',
    'https://deploy-preview-1--site.netlify.app/awesome-Pimoroni-Presto/', 'file:///D:/site/index.html',
  ]) assert.equal(isProductionSite(new URL(href)), false, href);
});

test('the referrer is reduced to its origin; anything unusable becomes empty', () => {
  assert.equal(sanitizeReferrer('https://external.example/some/path?token=secret#frag'), 'https://external.example/');
  assert.equal(sanitizeReferrer('http://external.example:8080/a?b=c'), 'http://external.example:8080/');
  for (const value of ['', undefined, null, 'not a url', 'javascript:alert(1)', 'data:text/html,x', 'about:blank']) assert.equal(sanitizeReferrer(value), '', String(value));
});

test('before consent: banner shown, no script, no dataLayer, no address-bar change, and events are dropped, never replayed', () => {
  const page = browser({ href: `${LIVE}?q=secret` });
  assert.equal(page.elements.banner.hidden, false);
  assert.equal(page.elements.container.hidden, false);
  assert.equal(page.scripts.length, 0);
  assert.equal(page.window.dataLayer, undefined);
  assert.deepEqual(page.replaced, []);
  page.analytics.trackEvent('search_used');
  page.analytics.trackEvent('category_selected', { category: 'games' });
  assert.equal(page.window.dataLayer, undefined);
  page.elements.allow.click(); // consent given afterwards must not replay what was dropped
  assert.deepEqual(page.names(), ['page_view']);
});

test('allowing consent initialises gtag once with gtag-style arguments, denied defaults and one sanitized page view', () => {
  const page = browser({ href: `${LIVE}?q=review-sensitive-query&utm_source=x#frag`, referrer: 'https://external.example/some/path?token=secret-ref#h' });
  page.elements.allow.click();
  assert.equal(page.scripts.length, 1);
  assert.equal(page.scripts[0].src, `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`);
  assert.ok(page.window.dataLayer.every((entry) => Object.prototype.toString.call(entry) === '[object Arguments]'), 'gtag.js ignores plain arrays');
  assert.deepEqual(page.commands()[0], ['consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
  const canonical = { page_location: LIVE, page_referrer: 'https://external.example/' };
  assert.deepEqual(page.commands().find(([command]) => command === 'set')[1], canonical);
  const config = page.commands().find(([command]) => command === 'config');
  assert.equal(config[1], MEASUREMENT_ID);
  assert.deepEqual({ ...config[2] }, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, ...canonical });
  assert.deepEqual(page.commands().filter(([command]) => command === 'consent').map(([, kind, state]) => [kind, state.analytics_storage]), [['default', 'denied'], ['update', 'granted']]);
  assert.deepEqual(page.events(), [['page_view', canonical]]);
  // Nothing of the query string can reach Google through the library either: it is gone from the address bar first.
  assert.deepEqual(page.replaced, [`/awesome-Pimoroni-Presto/#frag`]);
  assert.equal(JSON.stringify(page.commands()).includes('review-sensitive-query'), false);
  assert.equal(JSON.stringify(page.commands()).includes('secret-ref'), false);
  assert.equal(page.local.get(CONSENT_KEY), 'granted');
  assert.equal(page.elements.banner.hidden, true);
  assert.equal(page.elements.status.textContent, MESSAGES.granted);
  assert.equal(disabledFlag(page), false);
});

test('a page without a query string is left alone; no referrer means an empty one', () => {
  const page = browser({ stored: 'granted' });
  assert.deepEqual(page.replaced, []);
  assert.equal(page.commands().find(([command]) => command === 'set')[1].page_referrer, '');
});

test('a remembered choice is applied at load: granted starts analytics once, denied loads nothing, anything else is no choice', () => {
  const granted = browser({ stored: 'granted' });
  assert.equal(granted.elements.banner.hidden, true);
  assert.equal(granted.scripts.length, 1);
  assert.deepEqual(granted.names(), ['page_view']);

  const denied = browser({ stored: 'denied' });
  assert.equal(denied.elements.banner.hidden, true);
  assert.equal(denied.scripts.length, 0);
  assert.equal(denied.window.dataLayer, undefined);
  assert.equal(denied.elements.status.textContent, MESSAGES.denied);
  denied.analytics.trackEvent('search_used');
  assert.equal(denied.window.dataLayer, undefined);

  for (const value of ['garbage', 'GRANTED', 'true', '1', '']) {
    const odd = browser({ stored: value || null });
    if (value) odd.local.set(CONSENT_KEY, value);
    assert.equal(browser({ local: odd.local }).scripts.length, 0, `"${value}" is not consent`);
    assert.equal(browser({ local: odd.local }).elements.banner.hidden, false);
  }
});

test('declining persists, loads nothing and says so', () => {
  const page = browser();
  page.elements.decline.click();
  assert.equal(page.local.get(CONSENT_KEY), 'denied');
  assert.equal(page.scripts.length, 0);
  assert.equal(page.window.dataLayer, undefined);
  assert.equal(disabledFlag(page), true);
  assert.equal(page.elements.banner.hidden, true);
  assert.equal(page.elements.status.textContent, MESSAGES.saved);
});

test('withdrawing stops everything at once: opt-out switch, consent update, cookies, own events', () => {
  const page = browser({ stored: 'granted', cookies: ['_ga=GA1.1.1.2', `${ID_COOKIE}=GS2.1.s1`, 'theme=dark'] });
  page.analytics.trackEvent('sort_changed', { sort_by: 'name' });
  const before = page.commands().length;
  page.elements.settings.click(); // the banner reopens with the opposite choice focused
  assert.equal(page.elements.banner.hidden, false);
  assert.equal(page.elements.decline.focused, true);
  page.elements.decline.click();
  assert.equal(disabledFlag(page), true, 'the loaded library is silenced');
  assert.deepEqual(page.commands().slice(before).map(([command, kind, state]) => [command, kind, state?.analytics_storage]), [['consent', 'update', 'denied']]);
  assert.equal(page.jar.has('_ga'), false);
  assert.equal(page.jar.has(ID_COOKIE), false, 'the per-property cookie is named without the "G-"');
  assert.equal(page.jar.get('theme'), 'dark', 'only Google Analytics cookies are removed');
  const after = page.commands().length;
  page.analytics.trackEvent('project_opened', { project_id: 'presto_x' });
  assert.equal(page.commands().length, after, 'no event after withdrawal');
  assert.equal(page.local.get(CONSENT_KEY), 'denied');
  assert.equal(page.analytics.isEnabled(), false);
});

test('re-enabling in the same page load resumes events with no second script or page view', () => {
  const page = browser({ stored: 'granted' });
  page.elements.settings.click();
  page.elements.decline.click();
  page.elements.settings.click();
  assert.equal(page.elements.allow.focused, true);
  page.elements.allow.click();
  assert.equal(page.scripts.length, 1, 'gtag.js is loaded once per page load');
  assert.equal(page.names().filter((name) => name === 'page_view').length, 1);
  assert.equal(disabledFlag(page), false);
  assert.deepEqual(page.commands().filter(([command]) => command === 'consent').map(([, kind, state]) => `${kind}:${state.analytics_storage}`), ['default:denied', 'update:granted', 'update:denied', 'update:granted']);
  page.analytics.trackEvent('support_click', { support_type: 'star', placement: 'footer' });
  assert.deepEqual(page.events().at(-1), ['support_click', { support_type: 'star', placement: 'footer' }]);
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 1: several tabs, one consent

test('withdrawing in tab A switches tab B off when it receives the storage event: flag, consent, cookies, UI, no more events', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const a = browser({ local });
  const b = browser({ local, cookies: ['_ga=GA1.1.1.2', `${ID_COOKIE}=GS2.1.s1`] });
  assert.equal(b.analytics.isEnabled(), true);
  a.elements.settings.click();
  a.elements.decline.click(); // writes localStorage; the browser then fires `storage` in B
  assert.equal(b.analytics.isEnabled(), true, 'asynchronous: B has not heard yet');
  b.storageEvent();
  assert.equal(b.analytics.isEnabled(), false);
  assert.equal(disabledFlag(b), true);
  assert.equal(b.commands().at(-1)[0], 'consent');
  assert.equal(b.commands().at(-1)[2].analytics_storage, 'denied');
  assert.equal(b.jar.has('_ga'), false);
  assert.equal(b.jar.has(ID_COOKIE), false);
  assert.equal(b.elements.status.textContent, MESSAGES.denied);
  assert.equal(b.elements.banner.hidden, true);
  const length = b.commands().length;
  b.analytics.trackEvent('category_selected', { category: 'games' });
  assert.equal(b.commands().length, length);
});

test('a custom event re-reads the authoritative consent, so a tab that has not yet received the storage event still sends nothing', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const a = browser({ local });
  const b = browser({ local });
  a.elements.settings.click();
  a.elements.decline.click();
  const length = b.commands().length;
  b.analytics.trackEvent('sort_changed', { sort_by: 'category' }); // no storage event delivered to B
  assert.equal(b.commands().length, b.commands().length);
  assert.equal(b.commands().slice(length).filter(([command]) => command === 'event').length, 0);
  assert.equal(b.analytics.isEnabled(), false);
  assert.equal(disabledFlag(b), true);
  assert.equal(b.elements.status.textContent, MESSAGES.denied, 'the UI follows');
});

test('a tab that becomes visible again re-checks consent', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const a = browser({ local });
  const b = browser({ local });
  a.elements.settings.click();
  a.elements.decline.click();
  b.becomeVisible();
  assert.equal(b.analytics.isEnabled(), false);
  assert.equal(disabledFlag(b), true);
});

test('granting in tab A turns a waiting tab B on, once, with one page view and no duplicate initialisation', () => {
  const local = new Map();
  const a = browser({ local });
  const b = browser({ local });
  assert.equal(b.elements.banner.hidden, false);
  a.elements.allow.click();
  assert.equal(b.scripts.length, 0, 'asynchronous: B has not heard yet');
  b.storageEvent();
  b.storageEvent(); // repeated notifications change nothing
  b.becomeVisible();
  assert.equal(b.scripts.length, 1);
  assert.deepEqual(b.names(), ['page_view']);
  assert.equal(b.analytics.isEnabled(), true);
  assert.equal(b.elements.banner.hidden, true);
  assert.equal(b.elements.status.textContent, MESSAGES.granted);
  assert.equal(disabledFlag(b), false);
  a.elements.settings.click();
  a.elements.decline.click();
  b.storageEvent();
  assert.equal(b.analytics.isEnabled(), false);
});

test('missing, malformed or unknown consent in another tab is denial: the tab turns off and asks again', () => {
  for (const change of [(map) => map.set(CONSENT_KEY, 'garbage'), (map) => map.delete(CONSENT_KEY), (map) => map.clear(), (map) => map.set(CONSENT_KEY, 'Granted ')]) {
    const local = new Map([[CONSENT_KEY, 'granted']]);
    const b = browser({ local });
    assert.equal(b.analytics.isEnabled(), true);
    change(local);
    b.storageEvent(change.toString().includes('clear') ? null : CONSENT_KEY); // `clear()` reports a null key
    assert.equal(b.analytics.isEnabled(), false, change.toString());
    assert.equal(disabledFlag(b), true);
    assert.equal(b.elements.banner.hidden, false, 'no valid choice: the banner asks');
    assert.equal(b.elements.status.textContent, '');
    const length = b.commands().length;
    b.analytics.trackEvent('search_used');
    assert.equal(b.commands().length, length);
    local.set(CONSENT_KEY, 'granted'); // a later valid grant turns it back on without a second script
    b.storageEvent();
    assert.equal(b.analytics.isEnabled(), true);
    assert.equal(b.scripts.length, 1);
    assert.equal(b.names().filter((name) => name === 'page_view').length, 1);
  }
});

test('unrelated storage keys are ignored', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const b = browser({ local });
  local.delete(CONSENT_KEY);
  b.storageEvent('something-else');
  assert.equal(b.analytics.isEnabled(), true, 'only the consent key matters (trackEvent still re-reads it)');
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 2: a withdrawal that cannot be written

test('writes blocked, reads allowed, sessionStorage works: this tab fails closed and a reload does not resume from the stale grant', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const session = new Map();
  const first = browser({ local, session, localFails: ['set', 'remove'] });
  assert.equal(first.analytics.isEnabled(), true);
  first.elements.settings.click();
  first.elements.decline.click();
  assert.equal(first.analytics.isEnabled(), false);
  assert.equal(disabledFlag(first), true);
  assert.equal(local.get(CONSENT_KEY), 'granted', 'the stale grant could not be replaced');
  assert.equal(session.get(OVERRIDE_KEY), 'denied');
  assert.equal(first.elements.status.textContent, MESSAGES.session);
  assert.match(MESSAGES.session, /for this browser session/);
  assert.doesNotMatch(MESSAGES.session, /saved|remembered|persist/i, 'it must not claim the choice was kept');

  const reload = browser({ local, session, localFails: ['set', 'remove'] }); // same tab: sessionStorage survives a reload
  assert.equal(reload.scripts.length, 0);
  assert.equal(reload.analytics.isEnabled(), false);
  assert.equal(reload.elements.status.textContent, MESSAGES.denied);

  // Other tabs and later sessions have no override, so the stale grant applies there. That limit is stated to the visitor.
  const fresh = browser({ local, localFails: ['set', 'remove'] });
  assert.equal(fresh.analytics.isEnabled(), true);
  assert.equal(fresh.elements.status.textContent, MESSAGES.granted, 'and the page does not pretend otherwise');
});

test('removal blocked as well as writes: same fail-closed result', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const session = new Map();
  const page = browser({ local, session, localFails: ['set', 'remove'] });
  page.elements.decline.click();
  assert.equal(page.analytics.isEnabled(), false);
  assert.equal(session.get(OVERRIDE_KEY), 'denied');
});

test('writes blocked but removal works: the grant is removed (no choice) and a reload asks again', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const page = browser({ local, localFails: ['set'] });
  page.elements.decline.click();
  assert.equal(local.has(CONSENT_KEY), false);
  assert.equal(page.analytics.isEnabled(), false);
  assert.equal(page.elements.status.textContent, MESSAGES.unsaved, 'a removal is not a recorded denial, and the page does not say it is');
  assert.equal(page.elements.banner.hidden, true);
  const reload = browser({ local, localFails: ['set'] });
  assert.equal(reload.scripts.length, 0);
  assert.equal(reload.elements.banner.hidden, false);
});

test('localStorage and sessionStorage both blocked: this document stays off, and the visitor is told it is this page only', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const page = browser({ local, localFails: ['set', 'remove'], sessionFails: ['get', 'set', 'remove'] });
  page.elements.decline.click();
  assert.equal(page.analytics.isEnabled(), false);
  assert.equal(disabledFlag(page), true);
  assert.equal(page.elements.status.textContent, MESSAGES.document);
  assert.match(MESSAGES.document, /this page only/);
  assert.equal(page.elements.banner.hidden, true);
  page.storageEvent(); // a stale "granted" cannot switch it back on while this document lives
  page.becomeVisible();
  assert.equal(page.analytics.isEnabled(), false);
  page.analytics.trackEvent('search_used');
  assert.equal(page.events().filter(([name]) => name === 'search_used').length, 0);
  // Unavoidable: with every write blocked a new page load reads the stale grant again.
  const reload = browser({ local, localFails: ['set', 'remove'], sessionFails: ['get', 'set', 'remove'] });
  assert.equal(reload.analytics.isEnabled(), true);
  assert.equal(reload.elements.status.textContent, MESSAGES.granted);
  // ... and the visitor can withdraw again from that page.
  reload.elements.settings.click();
  reload.elements.decline.click();
  assert.equal(reload.analytics.isEnabled(), false);
});

test('no stored grant and nothing writable: off, and honest that the choice is not kept', () => {
  const page = browser({ localFails: ['set', 'remove'], sessionFails: ['set'] });
  page.elements.decline.click();
  assert.equal(page.analytics.isEnabled(), false);
  assert.equal(page.elements.status.textContent, MESSAGES.unsaved);
  assert.match(MESSAGES.unsaved, /would not save this choice/);
  assert.equal(page.elements.banner.hidden, true, 'it does not pretend nothing happened by asking again at once');
});

test('allowing when nothing can be stored enables nothing; unreadable storage shows the banner', () => {
  const unwritable = browser({ localFails: ['set'] });
  unwritable.elements.allow.click();
  assert.equal(unwritable.scripts.length, 0);
  assert.equal(unwritable.window.dataLayer, undefined);
  assert.equal(unwritable.analytics.isEnabled(), false);
  assert.equal(unwritable.elements.status.textContent, MESSAGES.grantFailed);
  unwritable.analytics.trackEvent('search_used');
  assert.equal(unwritable.window.dataLayer, undefined);

  const unreadable = browser({ localFails: ['get'], sessionFails: ['get'] });
  assert.equal(unreadable.elements.banner.hidden, false);
  assert.equal(unreadable.scripts.length, 0);
});

test('a session denial stops a later stored grant until the visitor allows again here', () => {
  const local = new Map([[CONSENT_KEY, 'granted']]);
  const session = new Map([[OVERRIDE_KEY, 'denied']]);
  const page = browser({ local, session });
  assert.equal(page.analytics.isEnabled(), false);
  page.elements.settings.click();
  page.elements.allow.click(); // an explicit new choice clears the override
  assert.equal(page.analytics.isEnabled(), true);
  assert.equal(session.has(OVERRIDE_KEY), false);
});

test('anywhere but the live page analytics never loads, even with a stored "granted", and no banner is offered', () => {
  for (const href of [
    'http://localhost:8088/awesome-Pimoroni-Presto/', 'http://127.0.0.1:8765/awesome-Pimoroni-Presto/', 'https://other.github.io/awesome-Pimoroni-Presto/',
    'https://jake1164.github.io/preview/', 'https://jake1164.github.io/awesome-Pimoroni-Presto/preview/', 'https://jake1164.github.io/awesome-Pimoroni-Presto/index.html',
  ]) {
    const page = browser({ href, stored: 'granted' });
    assert.equal(page.scripts.length, 0, href);
    assert.equal(page.window.dataLayer, undefined, href);
    assert.equal(page.elements.banner.hidden, true, 'the banner ships hidden and is never revealed');
    assert.equal(page.elements.container.hidden, true, `${href}: the privacy control stays hidden`);
    assert.deepEqual(page.replaced, [], 'the address bar is untouched');
    page.analytics.trackEvent('search_used');
    assert.equal(page.window.dataLayer, undefined, href);
  }
});

test('an analytics failure never reaches the caller', () => {
  const page = browser();
  page.window.dataLayer = { push() { throw new Error('gtag exploded'); } };
  assert.doesNotThrow(() => page.elements.allow.click());
  assert.doesNotThrow(() => page.analytics.trackEvent('search_used'));
  assert.doesNotThrow(() => page.elements.decline.click());
});
