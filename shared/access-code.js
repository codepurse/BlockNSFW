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
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+=?~';
  var LENGTHS = [32, 64, 128, 256];

  // Scope: which changes have to face the code.
  //   'critical' (default) — only the master switches that would unlock
  //     everything at once: disabling blocking, whitelisting a whole site,
  //     clearing the PIN, and weakening the access code itself.
  //   'all' — every change that weakens protection.
  // 'critical' is the default because a code on every small edit trains people
  // to resent the feature and switch it off, which protects nobody. The rare,
  // decisive moments are the ones worth guarding.
  var SCOPES = ['critical', 'all'];

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
  function requiredFor(config, isCritical) {
    var normalized = normalizeConfig(config);
    if (!normalized.enabled) return false;
    if (normalized.scope === 'all') return true;
    return isCritical === true;
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
    normalizeConfig: normalizeConfig,
    requiredFor: requiredFor,
    generate: generate,
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
