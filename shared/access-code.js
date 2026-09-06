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
    TIERS: TIERS,
    normalizeTier: normalizeTier,
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
