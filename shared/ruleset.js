// shared/ruleset.js
// Parses a subscribed ruleset file.
//
// The format is uBlacklist's, deliberately: someone arriving from that tool
// should be able to paste the URLs they already follow and have them work, with
// no conversion step. A ruleset file is UTF-8 text, optionally opening with a
// YAML front-matter block, then one rule per line.
//
//     ---
//     name: Example spam list
//     homepage: https://example.com/list
//     ---
//     # comments use # or !
//     spam.example
//     *.spam.example
//     /example\.(net|org)/
//     title/Example Domain/
//
// The rule syntax is the same one the blocked-site box accepts, so
// shared/keyword-pattern.js validates and compiles these — there is no second
// dialect to keep in step.
//
// Two things this file will not do:
//
//   1. It is not a YAML parser. Only flat `key: value` scalars are read, which
//      is all the header ever carries. Anything else in the block is skipped
//      rather than guessed at.
//   2. It never produces an allow rule. A subscribed list may add blocks and
//      nothing else. A stranger's file that could say "never block this site"
//      would be a remote off switch for the extension, which is precisely what
//      this product cannot have.
(function (root) {
  'use strict';

  // A ruleset is user-chosen but not user-written, so the limits are about
  // keeping a hostile or broken file from wedging the browser rather than about
  // what is reasonable to publish.
  var MAX_FILE_BYTES = 5 * 1024 * 1024;
  var MAX_ENTRIES = 50000;
  var MAX_LINE_LENGTH = 2000;
  var MAX_NAME_LENGTH = 80;

  // Regex rules are capped far below MAX_ENTRIES, and separately from it.
  //
  // Validating a regex is the one line-level cost here that is not O(length):
  // each one is shape-checked and then timed against a dozen probe strings.
  // The shape check refuses the exponential family outright, so no single
  // entry can hang the parser any more — but a pattern that is merely slow
  // still costs up to the probe budget before it is rejected, and this runs on
  // the background thread on every startup. At 50,000 entries that multiplies
  // into an outage; at 200 it is bounded by construction.
  //
  // 200 is generous for the format's actual use: a published site list is
  // overwhelmingly bare domains, and the regex form exists for the handful of
  // cases a wildcard cannot express. Rules past the cap are counted as skipped
  // and reported to the user, not silently dropped.
  var MAX_REGEX_ENTRIES = 200;

  var KP = (typeof KeywordPattern !== 'undefined') ? KeywordPattern
    : (typeof require === 'function' ? require('./keyword-pattern.js') : null);

  function isCommentLine(line) {
    if (KP && KP.isCommentEntry) return KP.isCommentEntry(line);
    var value = String(line || '').trim();
    return !!value && (value.charAt(0) === '#' || value.charAt(0) === '!');
  }

  function stripEscape(line) {
    if (KP && KP.stripCommentEscape) return KP.stripCommentEscape(line);
    return String(line || '').trim();
  }

  /**
   * A last check on the plain (non regex) form. validateListEntry calls anything
   * that is not a regex a wildcard and passes it, which is right for a box the
   * user types into by hand but too generous for a downloaded file: the lines of
   * an HTML error page sail through and are counted as rules, so pasting the
   * GitHub page instead of the raw file looks like a subscription that worked.
   *
   * A site rule is a dotted host, optionally with a path. Nothing that carries
   * whitespace or markup can be one.
   */
  function looksLikeSiteRule(entry) {
    var value = String(entry || '');
    if (/[\s<>"'`]/.test(value)) return false;
    var hostPart = value.split('/')[0];
    if (!hostPart || hostPart.indexOf('.') === -1) return false;
    return /^[A-Za-z0-9*._-]+$/.test(hostPart);
  }

  function clampText(value, max) {
    var text = String(value == null ? '' : value).trim();
    return text.length > max ? text.slice(0, max) : text;
  }

  /**
   * Reads the optional front-matter block. Returns the metadata found and the
   * offset the rules start at, so a file without a header costs nothing.
   */
  function readFrontMatter(lines) {
    var meta = { name: '', homepage: '' };
    if (!lines.length || lines[0].trim() !== '---') return { meta: meta, start: 0 };

    for (var i = 1; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim() === '---') return { meta: meta, start: i + 1 };

      var separator = line.indexOf(':');
      if (separator === -1) continue;
      var key = line.slice(0, separator).trim().toLowerCase();
      var value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
      if (key === 'name') meta.name = clampText(value, MAX_NAME_LENGTH);
      else if (key === 'homepage') meta.homepage = clampText(value, 300);
    }

    // Unterminated block: treat the whole file as rules rather than silently
    // swallowing it, since a stray '---' should not cost the user their list.
    return { meta: { name: '', homepage: '' }, start: 0 };
  }

  /**
   * @param {string} text  raw file contents
   * @returns {{name: string, homepage: string, entries: Array<string>,
   *            skipped: number, truncated: boolean}}
   */
  function parseRuleset(text) {
    var source = String(text == null ? '' : text).replace(/^﻿/, '');
    var lines = source.split(/\r?\n/);
    var header = readFrontMatter(lines);

    var entries = [];
    var seen = {};
    var skipped = 0;
    var truncated = false;
    var regexCount = 0;

    for (var i = header.start; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;
      if (isCommentLine(raw)) continue;
      if (raw.length > MAX_LINE_LENGTH) { skipped++; continue; }

      var entry = stripEscape(raw);
      if (!entry) continue;

      // Count the regex forms before validating them, and stop validating once
      // the cap is reached. Checking the cap first is the point: validation is
      // the expensive step, so a file with 50,000 regex lines must not pay for
      // 50,000 validations to discover it is over the limit.
      var looksRegex = entry.charAt(0) === '/' || /^title\s*\//i.test(entry);
      if (looksRegex) {
        if (regexCount >= MAX_REGEX_ENTRIES) { skipped++; continue; }
        regexCount++;
      }

      // Validation is the same gate the options box applies, so a broken regex
      // in someone else's file is dropped here rather than reaching a page.
      if (KP && KP.validateListEntry) {
        var verdict = KP.validateListEntry(entry);
        if (!verdict.ok) { skipped++; continue; }
        if (verdict.kind === 'wildcard' && !looksLikeSiteRule(entry)) { skipped++; continue; }
      } else if (!looksLikeSiteRule(entry) && entry.charAt(0) !== '/') {
        skipped++;
        continue;
      }

      var key = entry.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      entries.push(entry);

      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    }

    return {
      name: header.meta.name,
      homepage: header.meta.homepage,
      entries: entries,
      skipped: skipped,
      truncated: truncated
    };
  }

  /**
   * Splits entries into a plain-host set and everything else.
   *
   * A published list is mostly bare domains, and a subscribed list can be tens
   * of thousands of lines where a hand-typed one is a dozen. Walking all of them
   * per image and per search result is the shape of problem that made pages
   * crawl in 1.7.0, so the common case becomes a hash lookup and only the
   * wildcard and regex entries keep the loop.
   *
   * @returns {{hosts: Array<string>, patterns: Array<string>}}
   */
  function splitEntries(entries) {
    var hosts = [];
    var patterns = [];
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      var entry = String(list[i] || '').trim().toLowerCase();
      if (!entry) continue;
      if (/^[a-z0-9.-]+$/.test(entry) && entry.indexOf('.') !== -1) hosts.push(entry);
      else patterns.push(list[i]);
    }
    return { hosts: hosts, patterns: patterns };
  }

  function isHttpUrl(value) {
    var text = String(value || '').trim();
    return /^https?:\/\//i.test(text);
  }

  var exported = {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_ENTRIES: MAX_ENTRIES,
    MAX_REGEX_ENTRIES: MAX_REGEX_ENTRIES,
    parseRuleset: parseRuleset,
    splitEntries: splitEntries,
    isHttpUrl: isHttpUrl
  };

  root.Ruleset = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof self !== 'undefined' ? self : this);
