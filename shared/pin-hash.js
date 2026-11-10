// shared/pin-hash.js
// The PIN used to sit in storage as plain text and be compared with ===.
// Anyone who opened storage could read it. Now it is stored as a salted
// PBKDF2-SHA256 hash. A short PIN can still be guessed offline by someone
// with the hash, so the hash is hygiene, not a vault; what actually limits
// guessing in the browser is the lockout below, which slows every wrong try
// after the fifth.
//
// A PIN saved by an older version is still a plain string. It keeps working,
// and is re-saved as a hash the first time it is entered correctly
// (`verify` says when that is due).
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var KEY = 'pblocker_pin';
  var LOCK_KEY = 'pblocker_pin_lock';
  var ITERATIONS = 150000;
  var SALT_BYTES = 16;

  // Five free tries, then a wait that doubles from one minute to an hour.
  var FREE_TRIES = 5;
  var FIRST_WAIT = 60 * 1000;
  var LONGEST_WAIT = 60 * 60 * 1000;

  function webcrypto() {
    var c = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!c || !c.subtle) throw new Error('Web Crypto is not available');
    return c;
  }

  function toHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return hex;
  }

  function fromHex(hex) {
    var clean = String(hex || '');
    var bytes = new Uint8Array(clean.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    return bytes;
  }

  function encodeText(text) {
    var value = String(text);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
    // Pages and the service worker always have TextEncoder; this keeps a bare
    // test context working.
    var utf8 = unescape(encodeURIComponent(value));
    var bytes = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i);
    return bytes;
  }

  function isHashed(stored) {
    return !!(stored && typeof stored === 'object' && stored.v === 1 &&
      typeof stored.salt === 'string' && typeof stored.hash === 'string');
  }

  function isSet(stored) {
    return isHashed(stored) || (typeof stored === 'string' && stored.length > 0);
  }

  function derive(pin, saltBytes, iterations) {
    var subtle = webcrypto().subtle;
    return subtle.importKey('raw', encodeText(pin), { name: 'PBKDF2' }, false, ['deriveBits'])
      .then(function (key) {
        return subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iterations }, key, 256);
      })
      .then(function (bits) { return toHex(new Uint8Array(bits)); });
  }

  function hash(pin) {
    var salt = new Uint8Array(SALT_BYTES);
    webcrypto().getRandomValues(salt);
    return derive(pin, salt, ITERATIONS).then(function (digest) {
      return { v: 1, alg: 'PBKDF2-SHA256', iter: ITERATIONS, salt: toHex(salt), hash: digest };
    });
  }

  // Compares every character so the time taken says nothing about where two
  // strings first differ.
  function sameText(a, b) {
    var left = String(a);
    var right = String(b);
    var diff = left.length ^ right.length;
    var length = Math.max(left.length, right.length);
    for (var i = 0; i < length; i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
    return diff === 0;
  }

  // Up to 2.0.3 the PIN boxes stopped taking characters at a fixed length:
  // 20 in Settings, both where the PIN was set and where it was asked for,
  // and 8 in the toolbar popup (from 1.6.1). A longer PIN was saved cut to
  // that length, without a word, and kept matching because every entry was
  // cut the same way. 2.0.4 lifted the limits, so the whole PIN now arrives
  // and no longer matches what was saved. Reported by email 2026-11-10 with
  // a 619-character PIN. So a PIN that doesn't match is tried again as those
  // boxes would have cut it. That matches only when the cut-short text is
  // exactly what was saved, so it lets nobody in without the PIN.
  var OLD_BOX_LIMITS = [20, 8];

  // The PIN as typed, then as each old box would have kept it: cut, then
  // trimmed, as those boxes' pages trimmed what they read.
  function candidates(pin) {
    var list = [pin];
    for (var i = 0; i < OLD_BOX_LIMITS.length; i++) {
      if (pin.length <= OLD_BOX_LIMITS[i]) continue;
      var cut = pin.slice(0, OLD_BOX_LIMITS[i]).trim();
      if (cut && list.indexOf(cut) < 0) list.push(cut);
    }
    return list;
  }

  // Resolves { ok, upgrade }: `upgrade` is true when a correct PIN was found
  // stored as plain text and should be re-saved with `hash`.
  function verify(stored, pin) {
    if (typeof pin !== 'string' || !pin) return Promise.resolve({ ok: false, upgrade: false });
    var tries = candidates(pin);
    if (typeof stored === 'string') {
      var ok = false;
      for (var i = 0; i < tries.length; i++) {
        if (stored.length > 0 && sameText(stored, tries[i])) ok = true;
      }
      return Promise.resolve({ ok: ok, upgrade: ok });
    }
    if (!isHashed(stored)) return Promise.resolve({ ok: false, upgrade: false });
    var iterations = Number(stored.iter) || ITERATIONS;
    var salt = fromHex(stored.salt);
    var at = 0;
    function next() {
      if (at >= tries.length) return { ok: false, upgrade: false };
      return derive(tries[at++], salt, iterations).then(function (digest) {
        return sameText(digest, stored.hash) ? { ok: true, upgrade: false } : next();
      });
    }
    return Promise.resolve().then(next);
  }

  // A PIN the extension makes up, for when the witness is to hold it: six
  // digits, so it can be read out and typed easily.
  function generatePin() {
    var bytes = new Uint32Array(1);
    var pin = '';
    while (pin.length < 6) {
      webcrypto().getRandomValues(bytes);
      if (bytes[0] >= 4294967290) continue; // keeps % 10 uniform
      pin += String(bytes[0] % 10);
    }
    return pin;
  }

  // --- Lockout ---------------------------------------------------------------
  // `raw` is what is stored under LOCK_KEY: { fails, until }.

  function lockState(raw, now) {
    var fails = raw && Number(raw.fails) > 0 ? Number(raw.fails) : 0;
    var until = raw && Number(raw.until) > 0 ? Number(raw.until) : 0;
    return { fails: fails, until: until, locked: until > now, waitMs: Math.max(0, until - now) };
  }

  function afterFailure(raw, now) {
    var fails = lockState(raw, now).fails + 1;
    var until = 0;
    if (fails >= FREE_TRIES) {
      var steps = fails - FREE_TRIES;
      until = now + Math.min(LONGEST_WAIT, FIRST_WAIT * Math.pow(2, steps));
    }
    return { fails: fails, until: until };
  }

  function describeWait(ms) {
    var minutes = Math.max(1, Math.ceil(ms / 60000));
    return minutes === 1 ? '1 minute' : minutes + ' minutes';
  }

  // The whole check, shared by every page that asks for the PIN: honours the
  // lockout, records a wrong try, clears the count on a right one, and
  // re-saves a plain-text PIN as a hash. `storage` is storage.local.
  // Resolves { ok, waitMs }; waitMs > 0 means locked out for that long.
  function check(storage, entered, now) {
    var at = typeof now === 'number' ? now : Date.now();
    var stored;
    var lockRaw;
    return Promise.resolve(storage.get(KEY))
      .then(function (data) {
        stored = data && data[KEY];
        return storage.get(LOCK_KEY);
      })
      .then(function (data) {
        lockRaw = data && data[LOCK_KEY];
        var lock = lockState(lockRaw, at);
        if (lock.locked) return { ok: false, waitMs: lock.waitMs };
        return verify(stored, entered).then(function (result) {
          if (result.ok) {
            var done = Promise.resolve(storage.remove(LOCK_KEY));
            if (result.upgrade) {
              // The plain-text PIN itself, not what was typed: a long entry
              // may have matched as an old box cut it (see OLD_BOX_LIMITS).
              done = done.then(function () { return hash(stored); }).then(function (hashed) {
                var payload = {};
                payload[KEY] = hashed;
                return storage.set(payload);
              });
            }
            return done.then(function () { return { ok: true, waitMs: 0 }; });
          }
          var next = afterFailure(lockRaw, at);
          var record = {};
          record[LOCK_KEY] = next;
          return Promise.resolve(storage.set(record)).then(function () {
            return { ok: false, waitMs: lockState(next, at).waitMs };
          });
        });
      });
  }

  var exported = {
    KEY: KEY,
    LOCK_KEY: LOCK_KEY,
    ITERATIONS: ITERATIONS,
    isHashed: isHashed,
    isSet: isSet,
    hash: hash,
    verify: verify,
    generatePin: generatePin,
    lockState: lockState,
    afterFailure: afterFailure,
    describeWait: describeWait,
    check: check
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.PinHash = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
