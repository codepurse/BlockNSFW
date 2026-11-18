// shared/access-code.js
// Single source of truth for the access code — the optional second layer over
// the PIN, modelled on LeechBlock's. The code is NOT a secret: it's displayed
// in full, right above the box you type it into. The protection is the
// deliberate effort of retyping 32-256 random characters, which is long enough
// for an impulse to pass. That design has consequences:
//
//   - Pasting must be impossible, or the whole thing is defeated in two
//     seconds. The input refuses paste/drop, and the displayed code can't be
//     selected or copied (see hardenEntry).
//   - A wrong answer must regenerate the code. Retrying against the same
//     string would let someone assemble it piecemeal instead of typing it in
//     one go. (That part lives in each page's modal.)
//
// This lived only in options.js until issue #29: the popup carried its own,
// PIN-only copy of the gate, so "unblock this site" — a whole-site whitelist,
// which overrides blocking entirely — never faced the code no matter how the
// user had configured it. The two pages now share this module, and each
// supplies its own modal chrome on top.
//
// Loaded as a classic <script> in popup.html / options.html before their main
// script, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var KEY = 'pblocker_access_code';

  // Ambiguous glyphs (O/0, I/l/1) are excluded: the point is deliberate
  // effort, not guessing which character you're looking at.
  //
  // So is "~". On US-International and many European layouts (Polish
  // Programmers, French, Nordic, Portuguese, German on a Mac) it's a dead key:
  // it waits for the next key and merges with it, so "~" then "n" types "ñ".
  // A careful typist got a wrong answer from a code they'd typed right, and
  // nearly every 256-character code had one (reported by email, 2026-11-16).
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+=?';
  var LENGTHS = [32, 64, 128, 256];

  // Scope: which changes have to face the code.
  //   'critical' (default) — only the master switches that would unlock
  //     everything at once: disabling blocking, whitelisting a whole site,
  //     clearing the PIN, and weakening the access code itself (with a longer
  //     code, see SELF_FACTOR and SELF_MAX).
  //   'all' — every change that weakens protection.
  // 'critical' is the default because a code on every small edit trains people
  // to resent the feature and switch it off, which protects nobody. The rare,
  // decisive moments are the ones worth guarding.
  var SCOPES = ['critical', 'all'];

  // Tier: how much a given change actually gives away. The caller picks one;
  // the scope above decides how many of them face the code.
  //   'critical' — a master switch that unlocks everything at once.
  //   'normal'   — a change that genuinely loosens protection: removing a
  //     blocked word, trusting an image domain.
  //   'tuning'   — a sensitivity dial: detection strictness and the image
  //     filter level. These never face the code, under either scope. At its
  //     loosest setting the layer is still on and still blocks clearly
  //     explicit content, so the dial is not a way out — it's how someone
  //     corrects a false positive of ours. Charging 64+ characters of typing
  //     to undo our own mistake is exactly the friction that makes people
  //     switch the whole feature off. Reported by users on the 'all' scope,
  //     who met the full code every time they nudged image strictness down.
  var TIERS = ['tuning', 'normal', 'critical'];

  // Callers written before the tiers existed pass a boolean `isCritical`.
  function normalizeTier(tier) {
    if (tier === true) return 'critical';
    if (typeof tier === 'string' && TIERS.indexOf(tier) >= 0) return tier;
    return 'normal';
  }

  function normalizeConfig(raw) {
    var config = raw && typeof raw === 'object' ? raw : {};
    var length = Number(config.length);
    return {
      enabled: config.enabled === true,
      length: LENGTHS.indexOf(length) >= 0 ? length : 64,
      scope: SCOPES.indexOf(config.scope) >= 0 ? config.scope : 'critical'
    };
  }

  // Pure decision, kept separate from the modal so it can be tested directly.
  // `tier` is one of TIERS (or the legacy `isCritical` boolean).
  function requiredFor(config, tier) {
    var normalized = normalizeConfig(config);
    if (!normalized.enabled) return false;
    var level = normalizeTier(tier);
    if (level === 'tuning') return false;
    if (normalized.scope === 'all') return true;
    return level === 'critical';
  }

  // A change to the code itself — turning it off, asking for it less often,
  // shortening it — faces a code this many times as long. At the same length
  // (issue #48), typing the code once to switch it off was cheaper than typing
  // it for two or three changes, so the code was its own quickest way round.
  var SELF_FACTOR = 2;

  // ...but never longer than the longest code there is. One wrong character
  // means a fresh code, and 512 random characters is a wall rather than a
  // pause, faced by the people who chose the longest code and are the likeliest
  // to need a way out of a mistake (a student who blocked google.com, with a
  // 256-character code, lost Gmail and Classroom). At 256 the code to weaken it
  // stays what it always was.
  var SELF_MAX = LENGTHS[LENGTHS.length - 1];

  // How long the code to type is. `aboutCode` is true for a change to the
  // code itself.
  function lengthFor(config, aboutCode) {
    var length = normalizeConfig(config).length;
    return aboutCode === true ? Math.max(length, Math.min(length * SELF_FACTOR, SELF_MAX)) : length;
  }

  // Rejection sampling so every character is equally likely — modulo would
  // bias toward the start of the charset.
  function generate(length) {
    var webcrypto = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    var size = CHARS.length;
    var limit = Math.floor(256 / size) * size;
    var code = '';
    while (code.length < length) {
      var bytes = new Uint8Array(length - code.length);
      webcrypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) {
        var byte = bytes[i];
        if (byte >= limit) continue; // discard, would skew the distribution
        code += CHARS[byte % size];
        if (code.length === length) break;
      }
    }
    return code;
  }

  // The line under the box while typing. A 256-character code is too long to
  // check by eye, so a missed or doubled character shows before Continue.
  // It counts only: it never says whether what's typed so far is right, or
  // the code could be fixed up as it goes instead of typed in one go.
  function countLine(typed, length) {
    var count = Array.from(String(typed == null ? '' : typed)).length;
    var line = count + ' of ' + length + ' typed';
    return count > length ? line + ', ' + (count - length) + ' too many' : line;
  }

  function shownChar(ch) {
    return ch === ' ' ? 'a space' : '“' + ch + '”';
  }

  // Where a wrong answer first went wrong. Said before the fresh code takes its
  // place, so it can't help with the next one: it's there so someone who keeps
  // missing can see why (a letter in the wrong case, a key their keyboard
  // turns into something else, a character left out). It used to be "That
  // didn't match" and nothing more, so one slip in 256 looked like a code that
  // could never be typed.
  function mismatchLine(typed, expected) {
    var t = Array.from(typed);
    var e = Array.from(expected);
    var i = 0;
    while (i < t.length && i < e.length && t[i] === e[i]) i++;
    if (i < t.length && i < e.length) {
      var where = 'character ' + (i + 1);
      if (t.slice(i).join('') === e.slice(i + 1).join('')) {
        return 'You left out ' + where + ', ' + shownChar(e[i]) + '.';
      }
      if (t.slice(i + 1).join('') === e.slice(i).join('')) {
        return 'There’s an extra ' + (t[i] === ' ' ? 'space' : shownChar(t[i])) + ' at ' + where + '.';
      }
      var line = 'Character ' + (i + 1) + ' didn’t match: you typed ' + shownChar(t[i]) +
        ', the code had ' + shownChar(e[i]) + '.';
      if (t[i].toLowerCase() === e[i].toLowerCase()) line += ' Capital and small letters count.';
      return line;
    }
    if (t.length < e.length) return 'You typed ' + t.length + ' of the ' + e.length + ' characters.';
    return 'You typed ' + t.length + ' characters, and the code has ' + e.length + '.';
  }

  // The answer to Continue. `fresh`: a wrong answer gets a new code, so an
  // attempt can't be assembled piecemeal. An empty box isn't an attempt, so it
  // keeps the code being read.
  function checkEntry(typed, expected) {
    var value = String(typed == null ? '' : typed);
    if (value === expected) return { ok: true, fresh: false, message: '' };
    if (!value) return { ok: false, fresh: false, message: 'Type the code above first.' };
    return { ok: false, fresh: true, message: mismatchLine(value, expected) + ' Type the new code above.' };
  }

  // `storage` is browserAPI.storage.local from the calling page.
  function readConfig(storage) {
    return Promise.resolve(storage.get(KEY)).then(function (stored) {
      return normalizeConfig(stored && stored[KEY]);
    });
  }

  function writeConfig(storage, config) {
    var payload = {};
    payload[KEY] = normalizeConfig(config);
    return Promise.resolve(storage.set(payload));
  }

  // Refuses every shortcut that would turn retyping the code back into a
  // two-second copy-paste. `display` is the element showing the code (CSS
  // already disables selection on it; this is the second line of defence),
  // `input` is the box the user types into.
  function hardenEntry(input, display) {
    if (input) {
      ['paste', 'drop', 'dragover'].forEach(function (evt) {
        input.addEventListener(evt, function (e) { e.preventDefault(); });
      });
      input.addEventListener('keydown', function (e) {
        var key = (e.key || '').toLowerCase();
        if ((e.ctrlKey || e.metaKey) && (key === 'v' || key === 'z')) e.preventDefault();
      });
    }
    if (display) {
      ['copy', 'cut', 'contextmenu'].forEach(function (evt) {
        display.addEventListener(evt, function (e) { e.preventDefault(); });
      });
    }
  }

  var exported = {
    KEY: KEY,
    CHARS: CHARS,
    LENGTHS: LENGTHS,
    SCOPES: SCOPES,
    TIERS: TIERS,
    SELF_FACTOR: SELF_FACTOR,
    SELF_MAX: SELF_MAX,
    normalizeTier: normalizeTier,
    normalizeConfig: normalizeConfig,
    requiredFor: requiredFor,
    lengthFor: lengthFor,
    generate: generate,
    countLine: countLine,
    checkEntry: checkEntry,
    readConfig: readConfig,
    writeConfig: writeConfig,
    hardenEntry: hardenEntry
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.AccessCode = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
