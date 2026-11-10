// shared/extensions-lock.js
// The browser's extensions page, locked behind the PIN.
//
// The extensions page (chrome://extensions, edge://extensions, about:addons)
// is where BlockNSFW can be turned off, or switched off in private windows.
// The browser keeps both switches to itself: no extension can lock them, and
// once private windows are switched off the browser hides them from the
// extension altogether. What an extension can do is notice a tab arriving on
// that page and send it to Settings instead, where opening it asks for the
// PIN, or the Pact's wait, and never opens during Storm Mode or Risk Hours.
//
// It needs a PIN or a Pact. Without either it locks nothing, and an access
// code alone doesn't lock it. The code asks there, after the PIN, only when
// it's set to guard every change (scope 'all'). On its default scope it
// guards the master switches alone, and the user chose PIN-only for this page
// (2026-11-10): the code on every visit to manage any extension was more than
// the page is worth.
//
// It is a speed bump, like every lock in a browser extension: removing the
// extension from the toolbar menu, a guest window, another profile or another
// browser all get past it. Extension Guard (a separate Windows app) is what
// closes those.
//
// Off until the person turns it on (Settings › Security › Private windows),
// through a warning and an are-you-sure, because it can shut them out of their
// own extensions page. Once on, it is locked while there is a PIN or a Pact,
// and Storm Mode and Risk Hours shut it outright. With the switch off nothing here applies, hard hours
// included: nobody gets a lock they didn't choose.
//
// An opening is stored under ALLOW_KEY:
//   { until, reason }      open until `until` (OPEN_MS after the check passed)
//   { readyUntil, reason } a Pact's wait is over; the first visit before
//                          `readyUntil` opens it for OPEN_MS
// `reason` 'private' is the free opening for turning private windows on:
// that makes protection stronger, so it never asks for anything, but it is
// short and ends as soon as private windows are on.
//
// Pure logic plus key names. Loaded with importScripts in the service worker,
// as a classic <script> in Settings, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var ALLOW_KEY = 'pblocker_extensions_page_open';
  // Read to decide whether the page is locked. Kept in step with their own
  // modules (tests/extensions-lock.test.js checks them).
  var SETTINGS_KEY = 'pblocker_settings';
  var PIN_KEY = 'pblocker_pin';
  var ACCESS_CODE_KEY = 'pblocker_access_code';
  var PACT_KEY = 'pblocker_pact';
  var BOOST_STATE_KEY = 'pblocker_boost_state';
  var SETTING = 'lockExtensionsPage';

  var MINUTE = 60 * 1000;
  var OPEN_MS = 10 * MINUTE;
  var PRIVATE_MS = 3 * MINUTE;
  // After a Pact's wait the opening keeps a day for its first use: the wait
  // rarely ends while someone is sitting there.
  var READY_MS = 24 * 60 * MINUTE;

  var REASONS = ['unlock', 'pact', 'private'];

  // Chromium's own schemes for the page (Brave, Opera and Vivaldi may report
  // either theirs or chrome://), and Firefox's. Never http(s): a website
  // called extensions.example is just a website.
  var PAGE_PATTERNS = [
    /^(?:chrome|edge|brave|opera|vivaldi):\/\/extensions(?:[/?#]|$)/i,
    /^about:addons(?:[/?#]|$)/i
  ];

  function isExtensionsPage(url) {
    var value = String(url == null ? '' : url).trim();
    for (var i = 0; i < PAGE_PATTERNS.length; i++) {
      if (PAGE_PATTERNS[i].test(value)) return true;
    }
    return false;
  }

  // Mirrors PinHash.isSet (shared/pin-hash.js): a salted hash, or a plain PIN
  // an older version saved.
  function pinIsSet(stored) {
    if (typeof stored === 'string') return stored.length > 0;
    return !!(stored && typeof stored === 'object' && stored.v === 1 &&
      typeof stored.salt === 'string' && typeof stored.hash === 'string');
  }

  function boostOn(rawState) {
    return !!(rawState && typeof rawState === 'object' &&
      (rawState.active === 'storm' || rawState.active === 'risk'));
  }

  // Off unless turned on.
  function switchOn(settings) {
    return !!(settings && typeof settings === 'object' && settings[SETTING] === true);
  }

  // `store` holds the raw values under the keys above.
  function lockState(store) {
    var data = store || {};
    var code = data[ACCESS_CODE_KEY];
    var guarded = {
      pin: pinIsSet(data[PIN_KEY]),
      pact: !!(data[PACT_KEY] && data[PACT_KEY].active === true),
      code: !!(code && code.enabled === true)
    };
    // Mirrors AccessCode.requiredFor(config, 'normal'), the tier Settings
    // opens this page with: the code asks here, after the PIN, only on the
    // 'all' scope.
    var codeAsksHere = guarded.code && code.scope === 'all';
    var boost = boostOn(data[BOOST_STATE_KEY]);
    var on = switchOn(data[SETTINGS_KEY]);
    // `guarded` (any of the three) is what holds pages while site access is
    // off (shared/site-access.js). The page itself needs a PIN or a Pact: an
    // access code alone never locks it.
    var hasGuard = guarded.pin || guarded.pact || guarded.code;
    var pageGuard = guarded.pin || guarded.pact;
    return {
      locked: on && (boost || pageGuard),
      boost: boost,
      switchOn: on,
      guarded: hasGuard,
      pin: guarded.pin,
      pact: guarded.pact,
      code: guarded.code,
      codeHere: codeAsksHere
    };
  }

  function keys() {
    return [ALLOW_KEY, SETTINGS_KEY, PIN_KEY, ACCESS_CODE_KEY, PACT_KEY, BOOST_STATE_KEY];
  }

  function normalizeAllowance(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var reason = REASONS.indexOf(raw.reason) >= 0 ? raw.reason : 'unlock';
    var until = Number(raw.until) > 0 ? Number(raw.until) : 0;
    var readyUntil = Number(raw.readyUntil) > 0 ? Number(raw.readyUntil) : 0;
    if (!until && !readyUntil) return null;
    var out = { reason: reason };
    if (until) out.until = until;
    else out.readyUntil = readyUntil;
    return out;
  }

  // The opening the check (or a witness) just let through.
  function grant(reason, now) {
    var why = REASONS.indexOf(reason) >= 0 ? reason : 'unlock';
    return { until: now + (why === 'private' ? PRIVATE_MS : OPEN_MS), reason: why };
  }

  // What a Pact leaves once its wait is over.
  function grantAfterWait(now) {
    return { readyUntil: now + READY_MS, reason: 'pact' };
  }

  // Whether a tab may stay on the page now. Resolves { allow, allowance }:
  // `allowance` is what to store when it changed (a ready opening starting),
  // `null` when it has run out, or undefined when nothing changed.
  // Storm Mode and Risk Hours shut every opening except the free one for
  // turning private windows on, which only makes protection stronger.
  function visit(rawAllowance, now, boost) {
    var allowance = normalizeAllowance(rawAllowance);
    if (!allowance) return { allow: false };
    if (allowance.until) {
      if (allowance.until <= now) return { allow: false, allowance: null };
      if (boost && allowance.reason !== 'private') return { allow: false };
      return { allow: true };
    }
    if (allowance.readyUntil <= now) return { allow: false, allowance: null };
    if (boost) return { allow: false };
    var started = { until: now + OPEN_MS, reason: allowance.reason };
    return { allow: true, allowance: started };
  }

  // When an open page has to be shut again: the end of an opening that has
  // started, or of a ready one nobody used. null when nothing is open.
  function nextEdge(rawAllowance, now) {
    var allowance = normalizeAllowance(rawAllowance);
    if (!allowance) return null;
    var edge = allowance.until || allowance.readyUntil;
    return edge > now ? edge : null;
  }

  // Where a tab that arrived on the page is sent: the Private windows group in
  // Settings, carrying the address it was going to.
  function lockPagePath(target, extra) {
    var query = 'extensions-page=' + encodeURIComponent(String(target || ''));
    if (extra) query += '&' + extra;
    return 'options.html?' + query + '#private-windows-group';
  }

  // The address carried back, only if it really is the extensions page.
  function targetFrom(search) {
    try {
      var value = new URLSearchParams(String(search || '')).get('extensions-page');
      return value && isExtensionsPage(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  var exported = {
    ALLOW_KEY: ALLOW_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    PIN_KEY: PIN_KEY,
    ACCESS_CODE_KEY: ACCESS_CODE_KEY,
    PACT_KEY: PACT_KEY,
    BOOST_STATE_KEY: BOOST_STATE_KEY,
    SETTING: SETTING,
    OPEN_MS: OPEN_MS,
    PRIVATE_MS: PRIVATE_MS,
    READY_MS: READY_MS,
    isExtensionsPage: isExtensionsPage,
    pinIsSet: pinIsSet,
    lockState: lockState,
    keys: keys,
    normalizeAllowance: normalizeAllowance,
    grant: grant,
    grantAfterWait: grantAfterWait,
    visit: visit,
    nextEdge: nextEdge,
    lockPagePath: lockPagePath,
    targetFrom: targetFrom
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.ExtensionsLock = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
