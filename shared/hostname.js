// shared/hostname.js
// Browser-safe hostname normalization helpers for IDN / punycode.
//
// The decoder is a minimal, browser-safe port of the algorithm used in the
// widely-deployed `punycode.js` reference (Mathias Bynens, MIT). It does
// not depend on any Node-only API (no `require('punycode')`, no Buffer)
// and runs unchanged in MV3 service workers and content scripts.
//
// Exposes:
//   - decodePunycodeLabel(label)  decode a single "xn--"-stripped label
//   - decodePunycodeHostname(h)  decode every "xn--"-prefixed label in h
//   - getHostnameVariants(h)     return { ascii, unicode } normalized forms
//
// Callers should keep the ASCII / punycode form as the primary lookup key
// (matches what URLs expose, the blocklist stores, and what DNR sees) and
// use the decoded Unicode form only for smart keyword matching.

(function (root) {
  'use strict';

  // RFC 3492 Punycode parameters
  var BASE = 36;
  var TMIN = 1;
  var TMAX = 26;
  var SKEW = 38;
  var DAMP = 700;
  var INITIAL_BIAS = 72;
  var INITIAL_N = 128;
  var DELIMITER = 0x2D; // '-'
  var MAX_INT = 2147483647; // 2^31 - 1

  function adaptBias(delta, numPoints, firstTime) {
    var k = 0;
    delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    var baseMinusTMin = BASE - TMIN;
    while (delta > (baseMinusTMin * TMAX) >> 1) {
      delta = Math.floor(delta / baseMinusTMin);
      k += BASE;
    }
    return k + Math.floor((baseMinusTMin + 1) * delta / (delta + SKEW));
  }

  function digitToCodePoint(digit) {
    // 0..25 -> 'a'..'z' ; 26..35 -> '0'..'9' (lowercase form)
    if (digit < 26) return 97 + digit;
    return 22 + digit;
  }

  function codePointToDigit(cp) {
    if (cp >= 97 && cp <= 122) return cp - 97;
    if (cp >= 65 && cp <= 90) return cp - 65;
    if (cp >= 48 && cp <= 57) return cp - 22;
    return BASE;
  }

  // Decode a single punycode-encoded label (the part AFTER the "xn--" prefix).
  // Returns the decoded string, or null on malformed input.
  //
  // Per RFC 3492, a label is "<basic>-<encoded>"; the basic part holds all
  // ASCII code points and the encoded part holds the punycode-encoded
  // non-basic code points. A label with no basic code points has no '-' at
  // all (the entire input is the encoded part).
  function decodePunycodeLabel(input) {
    if (typeof input !== 'string') return null;

    var output = [];
    var inputLength = input.length;
    var i = 0;
    var n = INITIAL_N;
    var bias = INITIAL_BIAS;

    // Number of input code points before the last delimiter. If there is
    // no delimiter, basic = 0 (the entire input is the encoded part).
    var basic = input.lastIndexOf('-');
    if (basic < 0) basic = 0;
    for (var j = 0; j < basic; j++) {
      if (input.charCodeAt(j) >= 128) return null; // basic must be ASCII
      output.push(input.charCodeAt(j));
    }

    // Main decoding loop: start just after the last delimiter if any basic
    // code points were copied; start at the beginning otherwise.
    for (var index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
      var oldi = i;
      for (var w = 1, k = BASE; ; k += BASE) {
        if (index >= inputLength) return null;
        var digit = codePointToDigit(input.charCodeAt(index++));
        if (digit >= BASE) return null;
        if (digit > Math.floor((MAX_INT - i) / w)) return null; // overflow
        i += digit * w;
        // t = k <= bias ? TMIN : (k >= bias + TMAX ? TMAX : k - bias)
        var t;
        if (k <= bias) t = TMIN;
        else if (k >= bias + TMAX) t = TMAX;
        else t = k - bias;
        if (digit < t) break;
        var baseMinusT = BASE - t;
        if (w > Math.floor(MAX_INT / baseMinusT)) return null; // overflow
        w *= baseMinusT;
      }
      var out = output.length + 1;
      bias = adaptBias(i - oldi, out, oldi === 0);
      if (Math.floor(i / out) > MAX_INT - n) return null; // overflow
      n += Math.floor(i / out);
      i %= out;
      output.splice(i++, 0, n);
    }

    try {
      return String.fromCodePoint.apply(null, output);
    } catch (_) {
      return null;
    }
  }

  // Decode every "xn--"-prefixed label in a hostname. Returns the original
  // string if no label was decoded (so callers can short-circuit).
  function decodePunycodeHostname(hostname) {
    if (typeof hostname !== 'string' || hostname.length === 0) return hostname;
    var labels = hostname.split('.');
    var out = [];
    var changed = false;
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (typeof label !== 'string' || label.length === 0) {
        out.push(label);
        continue;
      }
      var lower = label.toLowerCase();
      if (lower.indexOf('xn--') === 0) {
        var decoded = decodePunycodeLabel(lower.slice(4));
        if (decoded != null) {
          out.push(decoded);
          changed = true;
          continue;
        }
      }
      out.push(label);
    }
    return changed ? out.join('.') : hostname;
  }

  // Produce both normalized forms of a hostname for smart keyword matching.
  //   ascii   -> lowercase, leading "www." stripped (what URLs expose, what
  //              the blocklist stores, what DNR sees).
  //   unicode -> same, with each "xn--..." label decoded. Falls back to
  //              ascii on decode failure so the caller can still scan it.
  function getHostnameVariants(hostname) {
    if (!hostname) return { ascii: '', unicode: '' };
    var ascii = String(hostname).toLowerCase().replace(/^www\./, '');
    var unicode = ascii;
    try {
      var decoded = decodePunycodeHostname(ascii);
      if (decoded) unicode = decoded;
    } catch (_) {
      // decode failure: unicode stays as ascii
    }
    return { ascii: ascii, unicode: unicode };
  }

  var exported = {
    decodePunycodeLabel: decodePunycodeLabel,
    decodePunycodeHostname: decodePunycodeHostname,
    getHostnameVariants: getHostnameVariants,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.HostnameNormalize = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
