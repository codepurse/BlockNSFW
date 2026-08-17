// shared/keyword-pattern.js
// Lets a custom blocked-word entry be a regular expression instead of a literal
// phrase, so one line can cover many spellings of the same word.
//
// Syntax follows uBlacklist's, which users of these tools already know:
//
//     /p[o0]rn/          a regex
//     porn               a literal phrase, exactly as before
//
// Everything that is not wrapped in slashes stays a literal, so existing lists
// keep working untouched.
//
// The reason this file exists rather than a call to `new RegExp` at the match
// site: these patterns run against the text of every page the user visits, and
// a regex is the one kind of user input that can hang the browser. Two
// safeguards, both here so the options page and the content script agree:
//
//   1. `g` and `y` are refused. They make a RegExp stateful — `lastIndex`
//      advances between calls — so a reused pattern would match on one page and
//      silently skip the next. That is far worse than an error.
//
//   2. Catastrophic backtracking is caught by measurement, not by inspection.
//      Patterns like /(a+)+$/ are perfectly valid and take exponential time on
//      the right input; you cannot reliably spot that by reading the source. So
//      a candidate is timed against a handful of adversarial strings before it
//      is ever allowed near a real page, and rejected if it is slow. This
//      catches the realistic cases at the moment the user can still fix them.

(function (root) {
  'use strict';

  // Long enough for real patterns, short enough to bound the damage.
  var MAX_PATTERN_LENGTH = 400;

  // Flags a user may set. 'i' is added regardless: literal matching here has
  // always been case-insensitive, and a regex behaving differently would be a
  // trap ("apricot" matching but "Apricot" not).
  var ALLOWED_FLAGS = ['i', 'm', 's', 'u'];

  // Per-probe budget. A healthy pattern finishes the probes below in well under
  // a millisecond; a catastrophic one takes tens of milliseconds on them.
  var PROBE_BUDGET_MS = 10;

  // Deliberately SHORT. The measurement happens after `test()` returns, so the
  // probe input has to be small enough that even an exponential pattern comes
  // back — feed /(a+)+$/ a 2000-character string and it never returns at all,
  // and the timer that was supposed to catch it never runs.
  //
  // Backtracking on these patterns costs roughly 2^n, so 22 characters is about
  // four million steps: tens of milliseconds, far above the budget and plainly
  // detectable, while an honest pattern finishes in microseconds. Long enough
  // to expose the blow-up, short enough to survive it.
  var PROBE_REPEAT = 22;

  function isRegexEntry(entry) {
    var value = String(entry == null ? '' : entry).trim();
    return value.length >= 2 && value.charAt(0) === '/' && value.lastIndexOf('/') > 0;
  }

  // Splits "/body/flags" into its parts. Returns null when the entry is not in
  // regex form (i.e. it is a literal).
  function splitRegexEntry(entry) {
    var value = String(entry == null ? '' : entry).trim();
    if (!isRegexEntry(value)) return null;
    var close = value.lastIndexOf('/');
    if (close <= 0) return null;
    return { body: value.slice(1, close), flags: value.slice(close + 1) };
  }

  // Inputs chosen to provoke backtracking: a run of one character, the same run
  // failing only at the final character (the worst case for a nested
  // quantifier), an alternating run, and ordinary prose as a sanity check.
  // A generic run of "a" only blows up patterns written with "a". /(x+x+)+y/ is
  // just as catastrophic but sails through an all-"a" probe, so the probe
  // alphabet is taken from the pattern itself: the literal characters it
  // mentions are the ones capable of driving its own backtracking.
  function probeAlphabet(body) {
    var chars = [];
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      if (ch === '\\') { i++; continue; } // skip escapes: \d is not a literal d
      if (!/[A-Za-z0-9]/.test(ch)) continue;
      if (chars.indexOf(ch) === -1) chars.push(ch);
      if (chars.length >= 3) break;       // keep the probe set small
    }
    if (chars.indexOf('a') === -1) chars.push('a'); // always try the classic
    return chars;
  }

  function probeStrings(body) {
    var strings = [];
    var alphabet = probeAlphabet(body || '');
    for (var i = 0; i < alphabet.length; i++) {
      var run = new Array(PROBE_REPEAT + 1).join(alphabet[i]);
      strings.push(run);
      strings.push(run + '!'); // failing at the very end is the worst case
    }
    strings.push(new Array(Math.floor(PROBE_REPEAT / 2) + 1).join('a1') + ' ');
    strings.push('the quick brown fox jumps over the lazy dog');
    return strings;
  }

  /**
   * Validates one entry. Literals are always valid. Regexes must compile, may
   * not use stateful flags, and must survive the timing probe.
   *
   * @param {string} entry
   * @returns {{ok: boolean, isRegex: boolean, error: string}}
   */
  function validateEntry(entry) {
    var value = String(entry == null ? '' : entry).trim();
    if (!value) return { ok: false, isRegex: false, error: 'Empty entry' };

    var parts = splitRegexEntry(value);
    if (!parts) return { ok: true, isRegex: false, error: '' };

    if (value.length > MAX_PATTERN_LENGTH) {
      return { ok: false, isRegex: true, error: 'Pattern is too long (max ' + MAX_PATTERN_LENGTH + ' characters)' };
    }
    if (!parts.body) {
      return { ok: false, isRegex: true, error: 'Empty pattern between the slashes' };
    }

    var flags = parts.flags || '';
    for (var i = 0; i < flags.length; i++) {
      var flag = flags.charAt(i);
      if (flag === 'g' || flag === 'y') {
        return { ok: false, isRegex: true, error: 'The "' + flag + '" flag is not supported — it would make the pattern match only every other time' };
      }
      if (ALLOWED_FLAGS.indexOf(flag) === -1) {
        return { ok: false, isRegex: true, error: 'Unknown flag "' + flag + '"' };
      }
    }

    var compiled;
    try {
      compiled = new RegExp(parts.body, flags.indexOf('i') === -1 ? flags + 'i' : flags);
    } catch (err) {
      // The engine's own message names the mistake far better than we could.
      return { ok: false, isRegex: true, error: (err && err.message) ? String(err.message) : 'Invalid pattern' };
    }

    var probes = probeStrings(parts.body);
    for (var p = 0; p < probes.length; p++) {
      var started = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      try {
        compiled.test(probes[p]);
      } catch (_) {
        return { ok: false, isRegex: true, error: 'Pattern failed while being tested' };
      }
      var elapsed = ((root.performance && root.performance.now) ? root.performance.now() : Date.now()) - started;
      if (elapsed > PROBE_BUDGET_MS) {
        return {
          ok: false,
          isRegex: true,
          error: 'Pattern is too slow and would freeze pages. Nested repeats like (a+)+ are the usual cause'
        };
      }
    }

    return { ok: true, isRegex: true, error: '' };
  }

  /**
   * Compiles an entry for matching. Returns null for literals (the caller keeps
   * its existing literal path) and null for anything that fails validation, so
   * a bad pattern that somehow reached storage is skipped rather than thrown.
   *
   * @param {string} entry
   * @returns {RegExp|null}
   */
  function compileEntry(entry) {
    var result = validateEntry(entry);
    if (!result.ok || !result.isRegex) return null;
    var parts = splitRegexEntry(entry);
    if (!parts) return null;
    var flags = parts.flags || '';
    try {
      return new RegExp(parts.body, flags.indexOf('i') === -1 ? flags + 'i' : flags);
    } catch (_) {
      return null;
    }
  }

  var exported = {
    MAX_PATTERN_LENGTH: MAX_PATTERN_LENGTH,
    PROBE_BUDGET_MS: PROBE_BUDGET_MS,
    isRegexEntry: isRegexEntry,
    splitRegexEntry: splitRegexEntry,
    validateEntry: validateEntry,
    compileEntry: compileEntry
  };

  root.KeywordPattern = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof self !== 'undefined' ? self : this);
