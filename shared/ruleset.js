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
//     *://*.spam.example/*
//     spam.example
//     *.spam.example
//     /example\.(net|org)/
//     title/Example Domain/
//
// The first form, a match pattern, is uBlacklist's own and the one real lists
// are written in (OISD's NSFW list is 480,000 lines of nothing else). Match
// patterns that name a whole host are read as that host, and everything else
// uses the rule syntax the blocked-site box accepts, so
// shared/keyword-pattern.js validates and compiles those — there is no second
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
  //
  // They were 5 MB and 50,000 entries, which turned away the list people
  // actually ask for: OISD's NSFW set is 12.5 MB and 481,000 entries. The
  // entry cap can be this high because hosts never reach a content script and
  // never become a regex; they are packed into one sorted string the
  // background searches in place (createHostIndex below).
  var MAX_FILE_BYTES = 32 * 1024 * 1024;
  var MAX_ENTRIES = 1000000;
  var MAX_LINE_LENGTH = 2000;
  var MAX_NAME_LENGTH = 80;

  // Rules that are not a plain host — wildcards inside a name, paths, regexes,
  // titles — are walked one by one for every navigation, image and search
  // result, in the background and in every frame. Hosts are a hash lookup no
  // matter how many there are; these are not, so they get a cap of their own.
  // Rules past it are counted as skipped and reported, not silently dropped.
  var MAX_PATTERN_ENTRIES = 1000;

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

  // A host as the matchers store it: lower case, ASCII (punycode for IDNs), at
  // least two labels. Underscores are allowed because real lists carry them and
  // browsers resolve them.
  var PLAIN_HOST_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
  var SINGLE_LABEL_RE = /^[a-z0-9-]+$/;
  // scheme://host/path, the shape of a uBlacklist match pattern.
  var MATCH_PATTERN_RE = /^([a-z*][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i;

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
   * The host a rule names, in the form the matchers look it up by, or '' if it
   * is not one. `www.` goes because every lookup strips it before asking, so an
   * entry that kept it could never be found.
   */
  function canonicalHost(value) {
    var host = String(value || '').trim().toLowerCase().replace(/\.+$/, '');
    if (!host) return '';
    // An internationalised name arrives in Unicode; the browser, and so every
    // lookup, uses its punycode form.
    if (/[^\x00-\x7f]/.test(host)) {
      try { host = new URL('http://' + host + '/').hostname; } catch (_) { return ''; }
    }
    if (host.length > 253) return '';
    if (host.indexOf('www.') === 0 && host.indexOf('.', 4) !== -1) host = host.slice(4);
    return host;
  }

  function isPlainHost(value) {
    return PLAIN_HOST_RE.test(value);
  }

  /**
   * Reads one rule. Returns {host} for anything that names a whole host and
   * its subdomains, {pattern} for anything the general rule syntax has to
   * handle, or null for a line that must be skipped.
   *
   * Everything that is really "this site" becomes a bare host, whichever way
   * the list spelled it: `*://*.example.com/*`, `*.example.com`,
   * `.example.com`, `example.com/*`. A bare host already covers its
   * subdomains everywhere in BlockNSFW, and a host is a lookup where a pattern
   * is a loop.
   *
   * One deliberate widening: uBlacklist reads `*://example.com/*` (no `*.`) as
   * that exact host, and this reads it as the host and its subdomains, as the
   * rest of the extension does. For a list that can only add blocks, that errs
   * toward blocking.
   */
  function classifyRule(entry) {
    // uBlacklist's `@` prefix marks allow and highlight rules. A subscribed
    // list may only add blocks, so these are not rules here at all.
    if (entry.charAt(0) === '@') return null;

    var match = MATCH_PATTERN_RE.exec(entry);
    if (match) {
      var scheme = match[1].toLowerCase();
      if (scheme !== '*' && scheme !== 'http' && scheme !== 'https') return null;
      var hostPart = match[2].toLowerCase();
      var path = match[3] || '';
      var wholeHost = path === '' || path === '/' || path === '/*';
      // `*://*/*` is every site on the web. No blocklist means that, and
      // honouring it would turn one bad line into a browser that opens nothing.
      if (!hostPart || hostPart === '*' || hostPart.indexOf(':') !== -1) return null;
      var bare = hostPart.indexOf('*.') === 0 ? hostPart.slice(2) : hostPart;
      if (bare.indexOf('*') !== -1) return null;
      var host = canonicalHost(bare);
      if (isPlainHost(host)) return wholeHost ? { host: host } : { pattern: host + path };
      // A whole top-level domain (`*://*.xxx/*`): the wildcard form is how the
      // blocked-site box spells that, and it stays on the pattern path.
      if (wholeHost && SINGLE_LABEL_RE.test(host)) return { pattern: '*.' + host };
      return null;
    }

    var plain = entry.replace(/\/\*?$/, '');
    if (plain.indexOf('/') === -1) {
      var candidate = plain;
      if (candidate.indexOf('*.') === 0) candidate = candidate.slice(2);
      else candidate = candidate.replace(/^\.+/, '');
      var canonical = canonicalHost(candidate);
      if (isPlainHost(canonical)) return { host: canonical };
    }
    return { pattern: entry };
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
   *            hosts: Array<string>, patterns: Array<string>,
   *            skipped: number, truncated: boolean}}
   *   `entries` is every rule in file order; `hosts` and `patterns` are the
   *   same rules already split the way splitEntries would split them.
   */
  function parseRuleset(text) {
    var source = String(text == null ? '' : text).replace(/^﻿/, '');
    var lines = source.split(/\r?\n/);
    var header = readFrontMatter(lines);

    var entries = [];
    var hosts = [];
    var patterns = [];
    var seen = new Set();
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

      var rule = classifyRule(entry);
      if (!rule) { skipped++; continue; }

      if (rule.host) {
        // The common case by far, and already fully checked by classifyRule:
        // a host needs no pattern validation.
        if (seen.has(rule.host)) continue;
        seen.add(rule.host);
        hosts.push(rule.host);
        entries.push(rule.host);
      } else {
        entry = rule.pattern;
        var key = entry.toLowerCase();
        if (seen.has(key)) continue;
        if (patterns.length >= MAX_PATTERN_ENTRIES) { skipped++; continue; }

        // Count the regex forms before validating them, and stop validating
        // once the cap is reached. Checking the cap first is the point:
        // validation is the expensive step, so a file with 50,000 regex lines
        // must not pay for 50,000 validations to discover it is over the limit.
        var looksRegex = entry.charAt(0) === '/' || /^title\s*\//i.test(entry);
        if (looksRegex) {
          if (regexCount >= MAX_REGEX_ENTRIES) { skipped++; continue; }
          regexCount++;
        }

        // Validation is the same gate the options box applies, so a broken
        // regex in someone else's file is dropped here rather than reaching a
        // page.
        if (KP && KP.validateListEntry) {
          var verdict = KP.validateListEntry(entry);
          if (!verdict.ok) { skipped++; continue; }
          if (verdict.kind === 'wildcard' && !looksLikeSiteRule(entry)) { skipped++; continue; }
        } else if (!looksLikeSiteRule(entry) && entry.charAt(0) !== '/') {
          skipped++;
          continue;
        }

        seen.add(key);
        patterns.push(entry);
        entries.push(entry);
      }

      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    }

    return {
      name: header.meta.name,
      homepage: header.meta.homepage,
      entries: entries,
      hosts: hosts,
      patterns: patterns,
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
   * parseRuleset already returns its rules split this way. This is for
   * entries stored before it did, which are still on disk for anyone who
   * subscribed to a list before hosts moved out of storage.local.
   *
   * @returns {{hosts: Array<string>, patterns: Array<string>}}
   */
  function splitEntries(entries) {
    var hosts = [];
    var patterns = [];
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      var entry = String(list[i] || '').trim();
      if (!entry) continue;
      var rule = classifyRule(entry);
      if (!rule) continue;
      if (rule.host) hosts.push(rule.host);
      else patterns.push(rule.pattern);
    }
    return { hosts: hosts, patterns: patterns };
  }

  // --- Packed host lists -------------------------------------------------------
  //
  // A list the size of OISD's is 481,000 hosts. Held as a Set that costs about
  // 30 MB and, more to the point, about 180 ms to rebuild — and the background
  // is a service worker that the browser stops and restarts all day, so it
  // would pay that on every wake. Held as one sorted string, it is a single
  // value to read back from storage, an index of line offsets built with
  // indexOf, and a binary search per lookup: roughly a third of the memory and
  // a few milliseconds to load.

  /** Sorted, deduplicated, newline-joined: the stored form of a host list. */
  function packHosts(hosts) {
    var unique = Array.from(new Set(hosts || []));
    // The default sort compares UTF-16 code units, which is the order
    // compareLineTo walks. The two must agree or lookups miss.
    unique.sort();
    return unique.join('\n');
  }

  function compareLineTo(text, start, end, host) {
    var length = end - start;
    var shorter = length < host.length ? length : host.length;
    for (var i = 0; i < shorter; i++) {
      var difference = text.charCodeAt(start + i) - host.charCodeAt(i);
      if (difference !== 0) return difference;
    }
    return length - host.length;
  }

  /**
   * @param {string} packed  output of packHosts
   * @returns {{size: number, has: function(string): boolean}}
   */
  function createHostIndex(packed) {
    var text = typeof packed === 'string' ? packed : '';
    var count = 0;
    var at;
    if (text) {
      count = 1;
      for (at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
    }
    // starts[i] is where line i begins; starts[count] is one past the end, so
    // line i always ends at starts[i + 1] - 1.
    var starts = new Uint32Array(count + 1);
    if (text) {
      var line = 1;
      for (at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts[line++] = at + 1;
    }
    starts[count] = text.length + 1;

    return {
      size: count,
      has: function (host) {
        if (!count || !host) return false;
        var low = 0;
        var high = count - 1;
        while (low <= high) {
          var middle = (low + high) >>> 1;
          var order = compareLineTo(text, starts[middle], starts[middle + 1] - 1, host);
          if (order === 0) return true;
          if (order < 0) low = middle + 1;
          else high = middle - 1;
        }
        return false;
      }
    };
  }

  function isHttpUrl(value) {
    var text = String(value || '').trim();
    return /^https?:\/\//i.test(text);
  }

  var exported = {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_ENTRIES: MAX_ENTRIES,
    MAX_PATTERN_ENTRIES: MAX_PATTERN_ENTRIES,
    MAX_REGEX_ENTRIES: MAX_REGEX_ENTRIES,
    parseRuleset: parseRuleset,
    splitEntries: splitEntries,
    packHosts: packHosts,
    createHostIndex: createHostIndex,
    isHttpUrl: isHttpUrl
  };

  root.Ruleset = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof self !== 'undefined' ? self : this);
