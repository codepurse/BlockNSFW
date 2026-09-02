// shared/browser-key.js
// Single source of truth for "which browser are we running in?".
//
// Every surface that needs this — the announcement fetcher, the store links on
// the options page, and the `browser` field on a community report — used to
// answer it on its own, and the community report answered it with the literal
// string 'chrome'. So every report and story submitted from Firefox arrived at
// the backend labelled as a Chrome report.
//
// Loaded as a classic <script> on the extension pages, via importScripts() in
// the Chrome service worker, from the `background.scripts` list in Firefox, and
// as a CommonJS module in tests.

(function (root) {
  'use strict';

  // Bucket the running browser from the user agent. We do NOT use
  // `typeof browser` as a Firefox signal: recent Chrome/Chromium also expose a
  // `browser` global, so that test misfires and calls Chrome Firefox. The UA is
  // reliable in the MV3 service worker too (WorkerNavigator exposes userAgent).
  // Order matters — Edge's UA also contains "Chrome/", so it goes first.
  //
  // Chromium forks that ship no UA token of their own (Brave, and Opera/Vivaldi
  // for our purposes) bucket as 'chrome', which is what they are for anything
  // that reads this: same engine, same extension APIs, same store.
  function detectBrowserKey(userAgent) {
    var ua = typeof userAgent === 'string'
      ? userAgent
      : (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'edge';
    if (/\bFirefox\//.test(ua)) return 'firefox';
    if (/\bChrom(?:e|ium)\//.test(ua)) return 'chrome';
    // UA unavailable/unrecognized: fall back to the API-shim signal, treating a
    // `browser` global without Chrome's `chrome.runtime` as Firefox.
    if (typeof browser !== 'undefined' && !(typeof chrome !== 'undefined' && chrome.runtime)) {
      return 'firefox';
    }
    return 'chrome';
  }

  var exported = {
    detectBrowserKey: detectBrowserKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.BrowserKey = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
