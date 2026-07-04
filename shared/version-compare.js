// shared/version-compare.js
// Tiny dependency-free semver-ish comparison used by the update checker.
//
// In the service worker (background.js) this is loaded via importScripts and
// exposes `self.VersionCompare`. In Node (tests) it exports via module.exports.
// Mirrors the UMD pattern in shared/host-keywords.js.
//
// We only need dotted numeric comparison ("1.6.1" vs "1.7.0"). Extension
// versions are numeric dot-separated (Chrome allows up to 4 parts, Firefox
// allows pre-release suffixes); we compare the leading numeric parts and ignore
// any non-numeric suffix, which is good enough to answer "is mine older?".

(function (root) {
  'use strict';

  // "1.6.1" -> [1, 6, 1]. Non-numeric leading chars per part are stripped so a
  // Firefox-style "1.7.0pre1" still parses its numeric core. Returns [] for
  // unusable input so callers can treat it as "unknown" (no false positives).
  function parseVersion(str) {
    if (typeof str !== 'string') return [];
    var trimmed = str.trim();
    if (!trimmed) return [];
    var parts = trimmed.split('.');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var m = /^\d+/.exec(parts[i]);
      if (!m) {
        // A part with no leading digits (e.g. a build tag) ends the numeric run.
        break;
      }
      out.push(parseInt(m[0], 10));
    }
    return out;
  }

  // Returns -1 if a < b, 0 if equal, 1 if a > b. Missing trailing parts are
  // treated as 0 so "1.6" === "1.6.0". Returns 0 when either side is unparseable
  // (we never want garbage input to claim a version is outdated).
  function compareVersions(a, b) {
    var pa = parseVersion(a);
    var pb = parseVersion(b);
    if (pa.length === 0 || pb.length === 0) return 0;
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var na = i < pa.length ? pa[i] : 0;
      var nb = i < pb.length ? pb[i] : 0;
      if (na < nb) return -1;
      if (na > nb) return 1;
    }
    return 0;
  }

  // True only when `current` is strictly older than `latest`. Unparseable or
  // equal versions are not "outdated".
  function isOutdated(current, latest) {
    return compareVersions(current, latest) < 0;
  }

  var exported = {
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    isOutdated: isOutdated
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.VersionCompare = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
