// shared/url-scan.js
// Builds the text that URL adult-keyword scans run against.
//
// Scanning a raw query string is what makes filter-friendly sites look adult.
// A site that ships its own adult filter puts the switch in the query, so the
// keyword lands in the parameter NAME while the value says the filter is ON:
//
//   https://4get.ca/web?s=cats&nsfw=no       -> filtered, must NOT be blocked
//   https://example.com/search?show_nsfw=0   -> filtered, must NOT be blocked
//   https://4get.ca/web?s=cats&nsfw=yes      -> filter off, keep blocking
//
// Parameter names are controls, not content, so a keyword in a name only counts
// when the value says the switch is turned on. Parameter values are always
// scanned, so ?q=porn still reads as an adult signal.
//
// In a content script this file is loaded before content.js via
// manifest.json; in Node it exports the same helpers for tests.

(function (root) {
  'use strict';

  // Values meaning "the adult filter is engaged" on a positively named
  // parameter (nsfw=no), and "disengaged" on a negatively named one
  // (hide_nsfw=no).
  var FILTER_OFF_VALUES = /^(no|off|0|false|none|never|hide|hidden|exclude|excluded|deny|disable|disabled|strict|safe)$/;
  var FILTER_ON_VALUES = /^(yes|on|1|true|only|all|allow|allowed|include|included|show|shown|enable|enabled)$/;

  // Parameter names that already carry the negation, which flips their
  // polarity: `hide_nsfw=true` says the same thing as `nsfw=false`.
  var NEGATED_PARAM_NAME = /(^|[^a-z])(no|not|non|hide|block|exclude|filter|without|safe|deny|disable|disallow|strict|skip|remove)([^a-z]|$)/;

  /**
   * True when this parameter is a filter switch in the "adult content is being
   * filtered out" position, which makes any keyword in its name a control label
   * rather than a description of the page.
   */
  function isFilterSwitchEngaged(key, value) {
    var name = String(key == null ? '' : key).toLowerCase();
    var val = String(value == null ? '' : value).trim().toLowerCase();
    // A bare flag (?nsfw) states no polarity, so it keeps its old meaning.
    if (!val) return false;

    var negatedName = NEGATED_PARAM_NAME.test(name);
    if (FILTER_OFF_VALUES.test(val)) return !negatedName;
    if (FILTER_ON_VALUES.test(val)) return negatedName;
    return false;
  }

  function decodeSafely(value) {
    if (!value) return '';
    try {
      return decodeURIComponent(String(value));
    } catch (_) {
      // Stray "%" or an invalid escape: the raw text still scans fine.
      return String(value);
    }
  }

  function toUrl(urlLike) {
    if (!urlLike) return null;
    if (typeof urlLike === 'object' && typeof urlLike.pathname === 'string') return urlLike;
    try {
      return new URL(String(urlLike));
    } catch (_) {
      return null;
    }
  }

  // Query text with every engaged filter switch dropped. Both halves of a
  // dropped pair go: an engaged switch always has a boolean-ish value, so no
  // adult keyword can hide in the value we discard.
  function buildQueryScanText(u) {
    var search = u.search || '';
    if (!search || search === '?') return '';

    var parts = [];
    try {
      var params = u.searchParams || new URLSearchParams(search);
      params.forEach(function (value, key) {
        if (isFilterSwitchEngaged(key, value)) return;
        parts.push(decodeSafely(key));
        parts.push(decodeSafely(value));
      });
    } catch (_) {
      // No usable URLSearchParams: scan the raw query rather than nothing.
      return decodeSafely(search.replace(/\+/g, ' '));
    }
    return parts.join(' ');
  }

  /**
   * Text safe to run adult-keyword regexes over: the decoded path plus the
   * query with filter switches removed. Word-boundary patterns keep working
   * because the pieces are space-joined.
   *
   * @param {string|URL|Location} urlLike
   * @param {{includeQuery?: boolean}} [opts]
   * @returns {string}
   */
  function buildUrlScanText(urlLike, opts) {
    var includeQuery = !opts || opts.includeQuery !== false;
    var u = toUrl(urlLike);
    if (!u) return decodeSafely(String(urlLike || '').replace(/\+/g, ' '));

    var text = decodeSafely(u.pathname || '');
    if (includeQuery) {
      var query = buildQueryScanText(u);
      if (query) text += ' ' + query;
    }
    return text;
  }

  var exported = {
    FILTER_OFF_VALUES: FILTER_OFF_VALUES,
    FILTER_ON_VALUES: FILTER_ON_VALUES,
    NEGATED_PARAM_NAME: NEGATED_PARAM_NAME,
    isFilterSwitchEngaged: isFilterSwitchEngaged,
    buildUrlScanText: buildUrlScanText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.UrlScan = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
