// shared/totp.js
// Witness codes for the Pact. A trusted person adds a secret to the
// authenticator app they already use (Google Authenticator, Aegis,
// 1Password); from then on the app and the extension each work out the same
// six digits from the secret and the clock, every 30 seconds. Nothing is sent
// anywhere, so there is no server to run and nothing for one to learn: the
// witness holds a key, never a history.
//
// This is standard TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1, 6 digits,
// 30 s), because standard is what every authenticator app accepts.
//
// Also here: the one-time recovery codes the witness keeps in case they lose
// their phone. Only their SHA-256 hashes are stored.
//
// Loaded with importScripts in the service worker, as a classic <script> in
// pages, and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var PERIOD = 30;
  var DIGITS = 6;
  var SECRET_BYTES = 20; // 160 bits, the size RFC 4226 recommends
  var RECOVERY_COUNT = 8;
  // Recovery codes avoid look-alikes, since someone may read one out over the
  // phone: no 0/O, 1/I/L, 2/Z, 5/S, 8/B.
  var RECOVERY_CHARS = 'ACDEFGHJKMNPQRTUVWXY34679';

  function webcrypto() {
    var c = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!c || !c.subtle) throw new Error('Web Crypto is not available');
    return c;
  }

  function base32Encode(bytes) {
    var out = '';
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      buffer = (buffer << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(buffer >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
    return out;
  }

  // Lenient on the way in: people type keys with spaces, in lower case, with
  // padding. Returns null for anything that is not base32.
  function base32Decode(text) {
    var clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
    if (!clean) return null;
    var bytes = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var value = ALPHABET.indexOf(clean[i]);
      if (value < 0) return null;
      buffer = (buffer << 5) | value;
      bits += 5;
      if (bits >= 8) {
        bytes.push((buffer >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return new Uint8Array(bytes);
  }

  function generateSecret() {
    var bytes = new Uint8Array(SECRET_BYTES);
    webcrypto().getRandomValues(bytes);
    return base32Encode(bytes);
  }

  // Groups of four, the way authenticator apps show a key for typing.
  function formatSecret(secret) {
    return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
  }

  function counterAt(ms) {
    return Math.floor(ms / 1000 / PERIOD);
  }

  // RFC 4226 HOTP. `counter` fits a double, so it is split into two 32-bit
  // halves for the 8-byte big-endian message.
  function hotp(secretBytes, counter, digits) {
    var size = digits || DIGITS;
    var message = new Uint8Array(8);
    var high = Math.floor(counter / 4294967296);
    var low = counter >>> 0;
    for (var i = 3; i >= 0; i--) {
      message[i] = high & 255;
      high = high >>> 8;
      message[4 + i] = low & 255;
      low = low >>> 8;
    }
    var subtle = webcrypto().subtle;
    return subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
      .then(function (key) { return subtle.sign('HMAC', key, message); })
      .then(function (signature) {
        var mac = new Uint8Array(signature);
        var offset = mac[mac.length - 1] & 15;
        var binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) |
          (mac[offset + 2] << 8) | mac[offset + 3];
        var code = String(binary % Math.pow(10, size));
        while (code.length < size) code = '0' + code;
        return code;
      });
  }

  function totp(secret, ms) {
    var bytes = base32Decode(secret);
    if (!bytes) return Promise.reject(new Error('Not a valid key'));
    return hotp(bytes, counterAt(ms));
  }

  function normalizeCode(code) {
    return String(code == null ? '' : code).replace(/\D/g, '');
  }

  // Checks a six-digit code against one window either side of each reference
  // time. `opts.times` are the clocks to trust: the device clock and, when the
  // background has one, the server clock (so a computer whose clock is wrong
  // still accepts the witness's code). A counter at or below
  // `opts.lastCounter` was already used and is refused, so one code cannot
  // skip two waits. Resolves { ok, counter }.
  function verify(secret, code, opts) {
    var options = opts || {};
    var digits = normalizeCode(code);
    var bytes = base32Decode(secret);
    if (!bytes || digits.length !== DIGITS) return Promise.resolve({ ok: false });
    var lastCounter = typeof options.lastCounter === 'number' ? options.lastCounter : -1;
    var skew = typeof options.window === 'number' ? options.window : 1;
    var times = Array.isArray(options.times) && options.times.length ? options.times : [Date.now()];

    var counters = [];
    times.forEach(function (time) {
      if (typeof time !== 'number' || !isFinite(time)) return;
      var center = counterAt(time);
      for (var d = -skew; d <= skew; d++) {
        var counter = center + d;
        if (counter > lastCounter && counter >= 0 && counters.indexOf(counter) < 0) counters.push(counter);
      }
    });
    counters.sort(function (a, b) { return a - b; });

    var index = 0;
    function next() {
      if (index >= counters.length) return Promise.resolve({ ok: false });
      var counter = counters[index++];
      return hotp(bytes, counter).then(function (expected) {
        if (expected === digits) return { ok: true, counter: counter };
        return next();
      });
    }
    return next();
  }

  // The QR payload authenticator apps read. The label says whose key it is,
  // so the witness can tell it apart from their own accounts.
  function otpauthUri(secret, accountName) {
    var account = encodeURIComponent(String(accountName || 'Witness').slice(0, 40));
    return 'otpauth://totp/BlockNSFW:' + account + '?secret=' + secret + '&issuer=BlockNSFW';
  }

  function generateRecoveryCodes(count) {
    var total = count || RECOVERY_COUNT;
    var crypto = webcrypto();
    var size = RECOVERY_CHARS.length;
    var limit = Math.floor(256 / size) * size;
    var codes = [];
    while (codes.length < total) {
      var code = '';
      while (code.length < 8) {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        for (var i = 0; i < bytes.length && code.length < 8; i++) {
          if (bytes[i] >= limit) continue; // rejection sampling keeps it uniform
          code += RECOVERY_CHARS[bytes[i] % size];
        }
      }
      codes.push(code.slice(0, 4) + '-' + code.slice(4));
    }
    return codes;
  }

  function normalizeRecoveryCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function looksLikeRecoveryCode(code) {
    var clean = normalizeRecoveryCode(code);
    if (clean.length !== 8) return false;
    for (var i = 0; i < clean.length; i++) {
      if (RECOVERY_CHARS.indexOf(clean[i]) < 0) return false;
    }
    return true;
  }

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return hex;
  }

  function hashRecoveryCode(code) {
    var clean = normalizeRecoveryCode(code);
    var data = new Uint8Array(clean.length);
    for (var i = 0; i < clean.length; i++) data[i] = clean.charCodeAt(i);
    return webcrypto().subtle.digest('SHA-256', data).then(toHex);
  }

  var exported = {
    PERIOD: PERIOD,
    DIGITS: DIGITS,
    base32Encode: base32Encode,
    base32Decode: base32Decode,
    generateSecret: generateSecret,
    formatSecret: formatSecret,
    counterAt: counterAt,
    hotp: hotp,
    totp: totp,
    normalizeCode: normalizeCode,
    verify: verify,
    otpauthUri: otpauthUri,
    generateRecoveryCodes: generateRecoveryCodes,
    looksLikeRecoveryCode: looksLikeRecoveryCode,
    hashRecoveryCode: hashRecoveryCode
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Totp = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
