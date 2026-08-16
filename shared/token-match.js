// shared/token-match.js
// Finds a site/brand name inside free text without matching words that merely
// contain it.
//
// The adult-site names in content.js (`ADULT_CONTENT_KEYWORDS`) were matched
// with plain indexOf, and one hit blocks a page on its own. "erome" is a real
// adult site, so every page that said "Jerome" was blocked — the name, the city
// in Arizona, Jerome Powell, St. Jerome.
//
// A site name counts only when it is not glued to another ASCII letter, so
// "erome.com", "erome/1", "erome_2" and "EROME" still match while "Jerome",
// "Jeromes" and the Greek "eromenos" do not. Digits and punctuation stay inside
// the boundary because site names legitimately sit next to them ("tube8",
// "pornhub2"), and letters on either side are the only reliable signal that
// what we found is part of a different word.

(function (root) {
  'use strict';

  function isAsciiLetter(ch) {
    if (!ch) return false;
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }

  /**
   * Index of the first standalone occurrence of `token` in `text` at or after
   * `fromIndex`, or -1. Both are expected to be lower-cased by the caller when
   * the match should be case-insensitive.
   *
   * @param {string} text
   * @param {string} token
   * @param {number} [fromIndex=0]
   * @returns {number}
   */
  function indexOfStandaloneToken(text, token, fromIndex) {
    if (!text || !token) return -1;
    var from = fromIndex > 0 ? fromIndex : 0;
    var idx = text.indexOf(token, from);
    while (idx !== -1) {
      var before = idx > 0 ? text.charAt(idx - 1) : '';
      var after = text.charAt(idx + token.length); // '' past the end
      if (!isAsciiLetter(before) && !isAsciiLetter(after)) return idx;
      // Step by 1, not by token.length: occurrences can overlap.
      idx = text.indexOf(token, idx + 1);
    }
    return -1;
  }

  function containsStandaloneToken(text, token) {
    return indexOfStandaloneToken(text, token, 0) !== -1;
  }

  var exported = {
    isAsciiLetter: isAsciiLetter,
    indexOfStandaloneToken: indexOfStandaloneToken,
    containsStandaloneToken: containsStandaloneToken
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.TokenMatch = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
