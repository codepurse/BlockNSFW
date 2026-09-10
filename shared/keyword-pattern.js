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

  // --- Comments -------------------------------------------------------------
  //
  // A line beginning with '#' or '!' is a note, not an entry. Both markers are
  // accepted because the tools people arrive from disagree: uBlacklist uses '#',
  // uBlock Origin and AdGuard use '!'. Lists get pasted between all of them.
  //
  //     # === Social ===        a comment
  //     ! also a comment
  //     \#nsfw                  the literal blocked word "#nsfw"
  //
  // The escape exists because '#nsfw' is a perfectly reasonable blocked word —
  // hashtags start with '#'. A single leading backslash means "this really is an
  // entry", and is stripped before matching.

  function isCommentEntry(entry) {
    var value = String(entry == null ? '' : entry).trim();
    if (!value) return false;
    var first = value.charAt(0);
    return first === '#' || first === '!';
  }

  // True when an entry would be mistaken for a comment if written bare, and so
  // needs the backslash. Used to migrate lists saved before comments existed.
  function needsCommentEscape(entry) {
    return isCommentEntry(entry);
  }

  function escapeCommentEntry(entry) {
    var value = String(entry == null ? '' : entry).trim();
    return needsCommentEscape(value) ? '\\' + value : value;
  }

  // Removes the one leading backslash that protects a '#' or '!' entry. Any
  // other backslash is left alone — it may be part of a regex.
  function stripCommentEscape(entry) {
    var value = String(entry == null ? '' : entry).trim();
    if (value.length >= 2 && value.charAt(0) === '\\') {
      var next = value.charAt(1);
      if (next === '#' || next === '!') return value.slice(1);
    }
    return value;
  }

  /**
   * The entries a matcher should actually run: comments dropped, escapes
   * removed, blanks skipped. Every consumer of a user list goes through this so
   * a comment can never become a live pattern.
   *
   * @param {Array<string>} list
   * @returns {Array<string>}
   */
  function effectiveEntries(list) {
    var out = [];
    if (!list || typeof list.length !== 'number') return out;
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] == null ? '' : list[i]).trim();
      if (!raw) continue;
      if (isCommentEntry(raw)) continue;
      out.push(stripCommentEscape(raw));
    }
    return out;
  }

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

  // --- Structural rejection ---------------------------------------------
  //
  // The timing probe below cannot be the only defence, because the thing it
  // measures is the thing that hangs. `compiled.test(probe)` is not
  // interruptible: the elapsed time is read only after it returns, so a probe
  // that takes a minute is billed a minute late, and the page — or the
  // background worker parsing a subscribed list — is frozen for that minute
  // either way. No budget can fix that from inside the same thread.
  //
  // So the catastrophic family is rejected by SHAPE, before anything is
  // executed. In practice that family is one construct: an unbounded repeat
  // nested inside another repeat — (a+)+, (a*)*, ([-.]+)+, ([^a]+)+,
  // (x+x+)+y, (\w+\s?)* — where the engine has exponentially many ways to
  // divide the same input between the two levels.
  //
  // This is deliberately conservative. A bounded inner repeat is fine
  // ((\d{3}-)+ stays legal), and so is a group with no inner repeat at all
  // ((foo|bar)+). Something like (ab+)+ is only polynomial, and is rejected
  // anyway: nested repeats are vanishingly rare in blocked-word patterns, and
  // the cost of a wrong "accept" here is a browser the user cannot unfreeze.

  // What quantifier, if any, sits at `pos`. `repeatable` means it can run the
  // atom more than once; `unbounded` means it has no upper limit.
  function quantifierAt(source, pos) {
    var none = { length: 0, repeatable: false, unbounded: false };
    var ch = source.charAt(pos);
    if (ch === '+' || ch === '*') {
      // A lazy quantifier (+?, *?) backtracks just as badly; it only changes
      // the order the engine tries things, not how many there are to try.
      var lazy = source.charAt(pos + 1) === '?' ? 1 : 0;
      return { length: 1 + lazy, repeatable: true, unbounded: true };
    }
    if (ch === '?') {
      return { length: source.charAt(pos + 1) === '?' ? 2 : 1, repeatable: false, unbounded: false };
    }
    if (ch !== '{') return none;
    var close = source.indexOf('}', pos);
    if (close === -1) return none;
    var spec = source.slice(pos + 1, close);
    var match = /^(\d+)(,(\d*))?$/.exec(spec);
    if (!match) return none;               // not a quantifier, a literal brace
    var lazyBrace = source.charAt(close + 1) === '?' ? 1 : 0;
    var min = parseInt(match[1], 10);
    var hasComma = !!match[2];
    var max = match[3] ? parseInt(match[3], 10) : (hasComma ? Infinity : min);
    return {
      length: (close - pos + 1) + lazyBrace,
      repeatable: max >= 2,
      unbounded: max === Infinity
    };
  }

  /**
   * The offending construct if the pattern nests an unbounded repeat inside a
   * repeated group, or '' when it does not.
   *
   * Walks the source tracking group nesting. Any unbounded quantifier marks
   * every group currently open, because it lies inside all of them. When a
   * group closes we look at the quantifier that follows: a repeatable one on a
   * group that contains an unbounded repeat is the exponential shape.
   *
   * Character classes are skipped wholesale — `+` inside `[...]` is a literal
   * plus sign — and an escaped character is never read as syntax.
   */
  function findNestedQuantifier(body) {
    var source = String(body == null ? '' : body);
    var open = [];          // one flag per currently-open group
    var inClass = false;
    var i = 0;
    while (i < source.length) {
      var ch = source.charAt(i);
      if (ch === '\\') { i += 2; continue; }
      if (inClass) {
        if (ch === ']') inClass = false;
        i++;
        continue;
      }
      if (ch === '[') { inClass = true; i++; continue; }
      if (ch === '(') { open.push({ start: i, nested: false }); i++; continue; }
      if (ch === ')') {
        var group = open.pop();
        var after = quantifierAt(source, i + 1);
        if (group && group.nested && after.repeatable) {
          return source.slice(group.start, i + 1 + after.length);
        }
        // The group's own quantifier belongs to whatever encloses it.
        if (after.unbounded && open.length) open[open.length - 1].nested = true;
        i += 1 + after.length;
        continue;
      }
      var here = quantifierAt(source, i);
      if (here.length > 0) {
        if (here.unbounded) {
          for (var g = 0; g < open.length; g++) open[g].nested = true;
        }
        i += here.length;
        continue;
      }
      i++;
    }
    return '';
  }

  // Inputs chosen to provoke backtracking: a run of one character, the same run
  // failing only at the final character (the worst case for a nested
  // quantifier), an alternating run, and ordinary prose as a sanity check.
  //
  // The alphabet is taken from the pattern itself, because a generic run of
  // "a" only blows up patterns written with "a" — /(x+x+)+y/ sails through an
  // all-"a" probe. Punctuation and character-class contents count too: the
  // original version collected only [A-Za-z0-9] literals and fell back to "a",
  // so /([-.]+)+$/ was probed with characters it never matches, passed in a
  // millisecond, and then took ~15 seconds against a run of 30 dots — text
  // that appears on ordinary pages as a separator or an ellipsis.
  function probeAlphabet(body) {
    var chars = [];
    var add = function (ch) {
      if (!ch || chars.length >= 5) return;
      if (chars.indexOf(ch) === -1) chars.push(ch);
    };
    var inClass = false;
    var negated = false;
    var seen = '';
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      if (ch === '\\') { i++; continue; }  // skip escapes: \d is not a literal d
      if (inClass) {
        if (ch === ']') {
          inClass = false;
          // A negated class is stressed by a character it does NOT contain,
          // so pick the first candidate the class leaves out.
          if (negated) {
            var candidates = 'az0-. !';
            for (var c = 0; c < candidates.length; c++) {
              if (seen.indexOf(candidates.charAt(c)) === -1) { add(candidates.charAt(c)); break; }
            }
          }
          seen = '';
          continue;
        }
        if (ch === '^' && seen === '') { negated = true; continue; }
        seen += ch;
        if (!negated) add(ch);
        continue;
      }
      if (ch === '[') { inClass = true; negated = false; seen = ''; continue; }
      if ('()|{}+*?.^$'.indexOf(ch) !== -1) continue; // syntax, not an input char
      add(ch);
    }
    if (chars.indexOf('a') === -1) chars.push('a'); // always try the classic
    return chars;
  }

  // Every probe is capped at PROBE_REPEAT characters, including the prose one.
  // That cap is the whole calibration: at ~22 characters an exponential
  // pattern costs a few million steps — tens of milliseconds, comfortably over
  // the budget and plainly detectable — while an honest one finishes in
  // microseconds. The prose probe used to be the full 43-character pangram,
  // which contains a 36-character run with no "a", so /([^a]+)+$/ backtracked
  // exponentially inside the validator and the measurement never ran at all.
  function cap(text) {
    return text.length > PROBE_REPEAT ? text.slice(0, PROBE_REPEAT) : text;
  }

  function probeStrings(body) {
    var strings = [];
    var alphabet = probeAlphabet(body || '');
    for (var i = 0; i < alphabet.length; i++) {
      var run = new Array(PROBE_REPEAT + 1).join(alphabet[i]);
      strings.push(cap(run));
      strings.push(cap(run.slice(0, PROBE_REPEAT - 1) + '!')); // fail at the end
    }
    strings.push(cap(new Array(Math.floor(PROBE_REPEAT / 2) + 1).join('a1') + ' '));
    strings.push(cap('the quick brown fox jumps over the lazy dog'));
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

    // Notes are valid and never compiled. Reported as not-a-regex so the
    // save-blocking checks, which only stop on a bad regex, ignore them.
    if (isCommentEntry(value)) return { ok: true, isRegex: false, isComment: true, error: '' };
    value = stripCommentEscape(value);

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

    // Shape check BEFORE compiling or running anything. The timing probe below
    // cannot interrupt a pattern that has already started, so the exponential
    // family has to be refused without being executed even once.
    var nested = findNestedQuantifier(parts.body);
    if (nested) {
      return {
        ok: false,
        isRegex: true,
        error: 'Pattern repeats a repeat (' + nested + '), which can take exponential ' +
          'time on some inputs and freeze pages. Rewrite it without the inner + or *'
      };
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

  // --- Blocked-site entries -------------------------------------------------
  //
  // The site list accepts three forms, following uBlacklist so users of that
  // tool can bring their syntax across:
  //
  //     example.com, *.example.com, example.com/path/*   wildcard (as before)
  //     /example\.(net|org)/                             regex over the URL
  //     title/Example Domain/                            regex over the title
  //
  // Wildcards stay the default so existing lists are untouched. Title patterns
  // are page-level by nature: the title is not known until the page loads, so
  // navigation blocking cannot use them and the content script applies them.

  function parseListEntry(entry) {
    var value = String(entry == null ? '' : entry).trim();
    if (!value) return { kind: 'empty', body: '', flags: '' };

    // A note carries no pattern. Recognised here so every caller that already
    // routes through parseListEntry inherits comment support rather than each
    // one having to remember.
    if (isCommentEntry(value)) return { kind: 'comment', body: '', flags: '', source: value };
    value = stripCommentEscape(value);

    // "title/.../flags" — only when it really carries a pattern, so a literal
    // domain that happens to start with "title" is left alone.
    var titleMatch = /^title\s*(\/.*)$/i.exec(value);
    if (titleMatch) {
      var titleParts = splitRegexEntry(titleMatch[1]);
      if (titleParts) {
        return { kind: 'title', body: titleParts.body, flags: titleParts.flags, source: titleMatch[1] };
      }
    }

    var parts = splitRegexEntry(value);
    if (parts) return { kind: 'url', body: parts.body, flags: parts.flags, source: value };

    return { kind: 'wildcard', body: value, flags: '', source: value };
  }

  /**
   * Validates one blocked-site entry. Wildcards always pass; the regex forms go
   * through the same syntax, flag and timing checks as blocked words.
   */
  function validateListEntry(entry) {
    var parsed = parseListEntry(entry);
    if (parsed.kind === 'empty') return { ok: false, kind: parsed.kind, error: 'Empty entry' };
    // A comment is always fine and never compiled, so it must not block a save.
    if (parsed.kind === 'comment') return { ok: true, kind: parsed.kind, error: '' };
    if (parsed.kind === 'wildcard') return { ok: true, kind: parsed.kind, error: '' };
    var result = validateEntry(parsed.source);
    return { ok: result.ok, kind: parsed.kind, error: result.error };
  }

  /**
   * Compiles a blocked-site entry for matching.
   * @returns {{kind: string, regex: RegExp|null}} kind is 'url', 'title' or
   *   'wildcard'; regex is null for wildcards (the caller keeps its glob path)
   *   and for anything that fails validation, so a bad entry is skipped rather
   *   than thrown.
   */
  function compileListEntry(entry) {
    var parsed = parseListEntry(entry);
    if (parsed.kind !== 'url' && parsed.kind !== 'title') {
      return { kind: parsed.kind, regex: null };
    }
    return { kind: parsed.kind, regex: compileEntry(parsed.source) };
  }

  var exported = {
    MAX_PATTERN_LENGTH: MAX_PATTERN_LENGTH,
    PROBE_BUDGET_MS: PROBE_BUDGET_MS,
    PROBE_REPEAT: PROBE_REPEAT,
    findNestedQuantifier: findNestedQuantifier,
    probeStrings: probeStrings,
    isCommentEntry: isCommentEntry,
    needsCommentEscape: needsCommentEscape,
    escapeCommentEntry: escapeCommentEntry,
    stripCommentEscape: stripCommentEscape,
    effectiveEntries: effectiveEntries,
    isRegexEntry: isRegexEntry,
    splitRegexEntry: splitRegexEntry,
    validateEntry: validateEntry,
    compileEntry: compileEntry,
    parseListEntry: parseListEntry,
    validateListEntry: validateListEntry,
    compileListEntry: compileListEntry
  };

  root.KeywordPattern = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof self !== 'undefined' ? self : this);
