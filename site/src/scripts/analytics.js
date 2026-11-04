// Consent-gated Google Analytics 4 for the live gallery. Nothing here runs a network request, sets a cookie or loads a script
// until the visitor has pressed "Allow analytics" (or allowed it on an earlier visit), and only on the live site.
//
//   - Production only. `isProductionSite` requires the exact live origin and the exact page path; localhost, `astro preview`,
//     nested preview paths, forks, other hosts and the automated tests never load Google, whatever is stored in the browser.
//     (Constants below are checked against site-config.mjs by tests/analytics.test.mjs.)
//   - No queue. Events requested without consent are dropped, never stored and never replayed after consent.
//   - One initialisation and one page view per page load, however often consent is withdrawn and given again.
//   - Withdrawal is a hard stop, not just a consent signal. Consent Mode alone ("analytics_storage: denied") still lets gtag.js
//     send cookieless pings, so withdrawal also sets Google's documented opt-out switch `window['ga-disable-<ID>']`, which makes
//     the already-loaded library send nothing new for this ID, stops our own events, and deletes the first-party `_ga*` cookies.
//   - One authoritative consent state (`storedConsent`), read from storage whenever it matters: before every custom event, when
//     another tab changes it (`storage` event), and when the tab becomes visible again. Withdrawing in one tab therefore switches
//     the others off as soon as they receive the browser's (asynchronous) storage event; granting in another tab switches this one
//     on without a second initialisation.
//   - Withdrawal fails closed. This document stops at once; the denial is then written to localStorage, and if that cannot be
//     done while an earlier "granted" is still readable, to sessionStorage (a per-tab override), and the visitor is told which of
//     these held, never more than that.
//   - The page URL and referrer sent to Google are pinned to the canonical page and the referrer's origin, so a query string or
//     fragment typed into the address bar never leaves the browser through our configuration.
//   - Failures (storage blocked, script blocked, any exception) leave analytics off and never reach the gallery code.
//
// Limits: withdrawal cannot recall data Google already received; Google's library holds events for a few seconds, and ones
// generated just before a withdrawal can still be sent; a script that has loaded stays in memory until the page is reloaded (it is
// silenced, not unloaded); if the browser blocks every write, an earlier "granted" cannot be revoked for later visits.
// Automatic events of the GA4 data stream (scroll, outbound click, site search, ...) are controlled in the Google Analytics
// console, not here (see site/README.md, "Required GA4 Console Configuration").

export const MEASUREMENT_ID = 'G-K5XSTX64R3';
export const PRODUCTION_ORIGIN = 'https://jake1164.github.io';
export const PRODUCTION_PATH = '/awesome-Pimoroni-Presto/';
export const CONSENT_KEY = 'presto-analytics-consent';
export const OVERRIDE_KEY = 'presto-analytics-consent-override'; // sessionStorage: "denied" when the stored grant could not be replaced
export const GRANTED = 'granted';
export const DENIED = 'denied';

/** True only on the live page: the exact origin and the exact path (GitHub Pages redirects the bare path to this one). */
export function isProductionSite(location) {
  return location.origin === PRODUCTION_ORIGIN && location.pathname === PRODUCTION_PATH;
}

/** The referrer reduced to its origin ("https://example.org/"), or "" when there is none or it is not an http(s) URL. */
export function sanitizeReferrer(referrer) {
  try {
    const url = new URL(referrer);
    return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.origin}/` : '';
  } catch {
    return '';
  }
}

// What the visitor is told after withdrawing, by how far the denial could be stored. Never more than what held.
export const MESSAGES = {
  granted: 'Analytics allowed',
  denied: 'Analytics declined',
  saved: 'Analytics declined',
  unsaved: 'Analytics is off. Your browser would not save this choice, so you may be asked again.',
  session: 'Analytics is off for this browser session. Your browser would not save your choice for later, so an earlier “allow” may apply again in a new session.',
  document: 'Analytics is off on this page only. Your browser would not save your choice, so an earlier “allow” may apply again when you reload or return. Clearing this site’s data in your browser settings removes it.',
  grantFailed: 'Analytics stays off: your browser would not save the choice.',
};

/**
 * `env` is injectable for tests: `{ window, document }`. Everything touching the browser goes through it, so the consent logic
 * can be tested without one.
 */
export function createAnalytics(env = {}) {
  const win = env.window ?? globalThis.window;
  const doc = env.document ?? globalThis.document;
  const disableKey = `ga-disable-${MEASUREMENT_ID}`;
  const canonicalLocation = `${PRODUCTION_ORIGIN}${PRODUCTION_PATH}`;
  let enabled = false; // our own switch: events are only forwarded while true
  let initialised = false; // gtag.js was set up (once per page load)
  let pageViewSent = false; // at most one per page load
  let forcedDenied = false; // this document withdrew and no storage could record it: it stays off whatever storage says
  let refresh = null; // set by initAnalyticsConsent: redraws the banner and status from the authoritative state

  const safely = (action) => {
    try {
      return action();
    } catch {
      return undefined; // analytics must never break the gallery
    }
  };
  const read = (area, key) => safely(() => win[area].getItem(key)) ?? null;
  const write = (area, key, value) => safely(() => { win[area].setItem(key, value); return true; }) === true;
  const remove = (area, key) => safely(() => { win[area].removeItem(key); return true; }) === true;

  /**
   * The one authoritative consent: GRANTED only for a stored grant that nothing overrides; DENIED for a stored denial, a
   * session override or this document's own failed withdrawal; null (no choice) for anything missing, malformed or unreadable.
   * Anything that is not GRANTED means analytics is off.
   */
  function storedConsent() {
    if (forcedDenied || read('sessionStorage', OVERRIDE_KEY) === DENIED) return DENIED;
    const value = read('localStorage', CONSENT_KEY);
    return value === GRANTED || value === DENIED ? value : null;
  }

  // gtag.js only understands the `arguments` object of a gtag() call; a plain array pushed to dataLayer is ignored.
  function gtag() {
    win.dataLayer.push(arguments); // eslint-disable-line prefer-rest-params
  }

  /** Deletes the first-party Google Analytics cookies (`_ga`, `_ga_<ID without "G-">`, `_gid`, `_gat*`) from this host. */
  function removeAnalyticsCookies() {
    const names = String(doc.cookie).split(';').map((part) => part.split('=')[0].trim()).filter((name) => /^(_ga|_gid|_gat)/.test(name));
    const hostname = win.location?.hostname;
    for (const name of new Set(names)) {
      doc.cookie = `${name}=; Max-Age=0; Path=/`;
      if (hostname) doc.cookie = `${name}=; Max-Age=0; Path=/; Domain=${hostname}`;
    }
  }

  /**
   * Google's library has its own automatic "site search" measurement that reads the address bar's query string directly (it
   * ignores the page location we set) and would send e.g. `?q=anything` as a search term. The gallery uses no query
   * parameters, so once analytics is about to load the query string is removed from the address bar (the fragment is kept).
   * Campaign tags such as `utm_source` are therefore not seen by Google either; that is deliberate.
   */
  function removeQueryString() {
    const { search, pathname, hash } = win.location;
    if (search) win.history.replaceState(win.history.state, '', `${pathname}${hash}`);
  }

  function initialise() {
    removeQueryString();
    initialised = true;
    win.dataLayer = win.dataLayer || [];
    // Everything but analytics storage stays denied; there is no advertising or personalisation here.
    gtag('consent', 'default', { analytics_storage: DENIED, ad_storage: DENIED, ad_user_data: DENIED, ad_personalization: DENIED });
    gtag('js', new Date());
    // Pin what Google records about the page: the canonical URL (no query string or fragment, which can hold anything the
    // visitor or a link put there) and the referrer's origin only. `set` covers every later event, automatic ones included.
    const page = { page_location: canonicalLocation, page_referrer: sanitizeReferrer(doc.referrer) };
    gtag('set', page);
    gtag('config', MEASUREMENT_ID, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, ...page });
    gtag('consent', 'update', { analytics_storage: GRANTED });
    const script = doc.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
    script.onerror = () => {}; // blocked or offline: the gallery carries on
    doc.head.append(script);
  }

  function enable() {
    if (enabled || !isProductionSite(win.location)) return;
    safely(() => {
      win[disableKey] = false;
      if (initialised) gtag('consent', 'update', { analytics_storage: GRANTED });
      else initialise();
      enabled = true;
      if (!pageViewSent) { // the first enabling of this page load is its page view; re-enabling later adds none
        pageViewSent = true;
        gtag('event', 'page_view', { page_location: canonicalLocation, page_referrer: sanitizeReferrer(doc.referrer) });
      }
    });
  }

  function disable() {
    enabled = false;
    safely(() => {
      win[disableKey] = true; // Google's documented opt-out: the loaded library sends nothing new from here on
      if (initialised) gtag('consent', 'update', { analytics_storage: DENIED });
      removeAnalyticsCookies();
    });
  }

  /**
   * Sends one custom event, only while analytics is on and consent still stands in storage (another tab may have withdrawn it).
   * Never queues, never throws. Parameters must never hold free text.
   */
  function trackEvent(name, parameters = {}) {
    if (!enabled) return;
    if (storedConsent() !== GRANTED) {
      disable();
      refresh?.();
      return;
    }
    safely(() => gtag('event', name, parameters));
  }

  /** Records a withdrawal as far as the browser allows and reports how far that went (a key of MESSAGES). */
  function persistDenial() {
    const written = write('localStorage', CONSENT_KEY, DENIED);
    if (written) return 'saved';
    if (read('localStorage', CONSENT_KEY) !== GRANTED || remove('localStorage', CONSENT_KEY)) {
      // No grant is left to revive, but no denial is recorded either: "no choice" is all that storage says. This document stays
      // off (and does not show the banner as if nothing had happened); a later visit asks again.
      forcedDenied = true;
      return 'unsaved';
    }
    // An earlier grant is still readable and cannot be replaced: a per-tab override keeps it from coming back on reload.
    if (write('sessionStorage', OVERRIDE_KEY, DENIED) && read('sessionStorage', OVERRIDE_KEY) === DENIED) return 'session';
    forcedDenied = true; // nothing could record it: this document at least stays off
    return 'document';
  }

  /** Records a grant; false when it could not be stored (then analytics must stay off). */
  function persistGrant() {
    if (read('sessionStorage', OVERRIDE_KEY) === DENIED && !remove('sessionStorage', OVERRIDE_KEY) && !write('sessionStorage', OVERRIDE_KEY, GRANTED)) return false;
    if (read('sessionStorage', OVERRIDE_KEY) === DENIED) return false;
    if (!write('localStorage', CONSENT_KEY, GRANTED) || read('localStorage', CONSENT_KEY) !== GRANTED) return false;
    forcedDenied = false;
    return true;
  }

  /**
   * Wires the consent banner and the privacy-settings control. On any other page than the live one analytics is unavailable,
   * so the banner and the control stay hidden and nothing is loaded.
   */
  function initAnalyticsConsent({ banner, allow, decline, settings, status, container = null }) {
    if (!isProductionSite(win.location)) return;
    if (container) container.hidden = false;
    let note = null; // the outcome of this document's own last withdrawal, shown instead of the plain "declined"

    // Redraws banner and status from the authoritative state (also after another tab changed it).
    refresh = () => {
      const value = storedConsent();
      status.textContent = value === GRANTED ? MESSAGES.granted : value === DENIED ? MESSAGES[note ?? 'denied'] : '';
      banner.hidden = value !== null;
    };
    // Applies the authoritative state to analytics itself.
    const sync = () => {
      const value = storedConsent();
      if (value === GRANTED) enable();
      else if (enabled) disable();
      refresh();
    };
    const choose = (value) => {
      note = null;
      if (value === GRANTED) {
        if (!persistGrant()) {
          disable();
          banner.hidden = true;
          status.textContent = MESSAGES.grantFailed;
          safely(() => settings.focus({ preventScroll: true }));
          return;
        }
      } else {
        disable(); // first, so this document is silent whatever storage does next
        note = persistDenial();
      }
      sync();
      safely(() => settings.focus({ preventScroll: true })); // the banner is gone; keep keyboard users in place
    };

    sync();
    allow.addEventListener('click', () => choose(GRANTED));
    decline.addEventListener('click', () => choose(DENIED));
    settings.addEventListener('click', () => {
      banner.hidden = false;
      safely(() => (storedConsent() === GRANTED ? decline : allow).focus());
    });
    // Another tab changed the choice. Storage events arrive asynchronously, so until this one runs a tab can still act on its
    // old state; trackEvent re-reads storage for that reason.
    win.addEventListener?.('storage', (event) => {
      if (event.key === null || event.key === CONSENT_KEY) { note = null; sync(); }
    });
    doc.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'visible') sync(); });
  }

  return { trackEvent, initAnalyticsConsent, isEnabled: () => enabled };
}

let shared = null;
const instance = () => shared ?? (shared = createAnalytics());
export const trackEvent = (name, parameters) => { try { instance().trackEvent(name, parameters); } catch { /* never breaks the page */ } };
export const initAnalyticsConsent = (elements) => { try { instance().initAnalyticsConsent(elements); } catch { /* never breaks the page */ } };
