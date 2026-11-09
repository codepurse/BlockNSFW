// shared/site-access.js
// When BlockNSFW's site access is switched off.
//
// Chrome and Edge let anyone set an extension's site access to "When you click
// the extension" (or to a few sites) from the toolbar's extensions menu, with
// no visit to the extensions page. Without it the content script never runs,
// and the static rules, which need site access under
// declarativeNetRequestWithHostAccess, stop applying: nothing is blocked.
// Measured 2026-11-09 in Edge 157, where a page on a listed site opened and a
// listed image loaded.
//
// The background still sees every tab's address (the "tabs" permission), so
// while access is withheld it judges pages itself:
//   - 'hold' while protection is locked (a PIN, a Pact, the access code,
//     Storm Mode or Risk Hours): every page waits on access.html, which asks
//     the browser to give access back. Without site access nothing on a page
//     can be filtered, so this is the only way the switch stops being a way
//     round for someone who asked for locks.
//   - 'net' otherwise: listed sites go to the blocked page, as the content
//     script would have sent them. Images, search results and page words go
//     unfiltered, and the popup and Settings say so.
//
// Pure logic plus thin helpers. Loaded with importScripts in the service
// worker, as a classic <script> in pages, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var ORIGINS = ['<all_urls>'];
  // A held page's address travels in session storage under this prefix, never
  // in the URL, where it would reach history (see BLOCK_DETAIL_PREFIX in
  // content.js for why that matters here).
  var HOLD_PREFIX = 'pblocker_access_hold_';

  function isWebUrl(url) {
    return /^https?:\/\//i.test(String(url == null ? '' : url));
  }

  // `lock` is ExtensionsLock.lockState(store). The extensions-page switch is
  // about that page only; holding pages follows the locks themselves.
  function locked(lock) {
    return !!(lock && (lock.boost || lock.guarded));
  }

  // 'off' (access is there, or protection is off: nothing to do), 'hold' or
  // 'net'. `granted` is permissions.contains for ORIGINS.
  function mode(input) {
    var o = input || {};
    if (o.granted !== false || o.enabled === false) return 'off';
    return o.locked ? 'hold' : 'net';
  }

  // Resolves true when the API can't say: a browser without it has no switch.
  function contains(permissions) {
    try {
      if (!permissions || typeof permissions.contains !== 'function') return Promise.resolve(true);
      return Promise.resolve(permissions.contains({ origins: ORIGINS }))
        .then(function (ok) { return ok !== false; }, function () { return true; });
    } catch (_) {
      return Promise.resolve(true);
    }
  }

  function newHoldKey() {
    var c = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (c && typeof c.randomUUID === 'function') return HOLD_PREFIX + c.randomUUID();
    return HOLD_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function isHoldKey(key) {
    return typeof key === 'string' && key.indexOf(HOLD_PREFIX) === 0 && key.length > HOLD_PREFIX.length &&
      key.length < 120 && /^[A-Za-z0-9_-]+$/.test(key);
  }

  // Where a held tab goes. Without session storage the address has to ride
  // in the query string.
  function holdPath(key, url) {
    if (isHoldKey(key)) return 'access.html?k=' + encodeURIComponent(key);
    return 'access.html?to=' + encodeURIComponent(String(url || ''));
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  // What the popup (short) and Settings say while access is switched off.
  function describe(isLocked, long) {
    var lead = long ? 'Its site access was switched off in the toolbar’s extensions menu, so it can’t read pages or filter them. ' : '';
    if (isLocked) {
      return lead + (long
        ? 'Your protection is locked, so pages wait until it can see them again.'
        : 'Pages wait until it can see them again.');
    }
    return lead + 'Listed sites are still blocked, but images, search results and the words on pages aren’t filtered.';
  }

  // Asks the browser for access back. Call it straight from a click handler:
  // Firefox shows the prompt only inside the user's gesture.
  function request(permissions) {
    try {
      return Promise.resolve(permissions.request({ origins: ORIGINS })).then(function (ok) { return !!ok; }, function () { return false; });
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  var exported = {
    ORIGINS: ORIGINS,
    HOLD_PREFIX: HOLD_PREFIX,
    isWebUrl: isWebUrl,
    locked: locked,
    mode: mode,
    contains: contains,
    newHoldKey: newHoldKey,
    isHoldKey: isHoldKey,
    holdPath: holdPath,
    hostOf: hostOf,
    describe: describe,
    request: request
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.SiteAccess = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
