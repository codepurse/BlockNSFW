// shared/qr.js
// A small QR Code encoder, so the witness can scan the Pact's key into their
// authenticator app. The extension runs offline and loads nothing from a CDN,
// so this is written here instead of vendored.
//
// Scope is deliberately narrow: byte mode, error correction level M,
// versions 1 to 10 (up to 213 bytes; an otpauth:// key is about 90). The
// structure follows ISO/IEC 18004 and the layout of Project Nayuki's QR Code
// generator (MIT), re-implemented for this one use. It returns a matrix of
// booleans (true = dark); the page draws it.
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var MIN_VERSION = 1;
  var MAX_VERSION = 10;
  // Level M, versions 1-10: error-correction codewords per block, and blocks.
  var ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var BLOCK_COUNT = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var FORMAT_LEVEL_M = 0; // the two format bits for level M are 00

  // --- Galois field GF(2^8) over x^8 + x^4 + x^3 + x^2 + 1 -------------------

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var rootValue = 1;
    for (var n = 0; n < degree; n++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], rootValue);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      rootValue = gfMultiply(rootValue, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }

  // --- Sizes -------------------------------------------------------------------

  function sizeOf(version) {
    return version * 4 + 17;
  }

  function rawDataModules(version) {
    var result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      var numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(version) {
    return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version - 1] * BLOCK_COUNT[version - 1];
  }

  function alignmentPositions(version) {
    if (version === 1) return [];
    var numAlign = Math.floor(version / 7) + 2;
    var step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = sizeOf(version) - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // --- Bits ----------------------------------------------------------------------

  function utf8Bytes(text) {
    var value = String(text);
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(value));
    var utf8 = unescape(encodeURIComponent(value));
    var bytes = [];
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
    return bytes;
  }

  function appendBits(bits, value, length) {
    for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  function encodeData(bytes, version) {
    var capacityBits = dataCodewords(version) * 8;
    var bits = [];
    appendBits(bits, 0x4, 4); // byte mode
    appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach(function (b) { appendBits(bits, b, 8); });
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
    appendBits(bits, 0, (8 - bits.length % 8) % 8);
    for (var pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      codewords.push(b);
    }
    return codewords;
  }

  function addEccAndInterleave(data, version) {
    var numBlocks = BLOCK_COUNT[version - 1];
    var eccLength = ECC_PER_BLOCK[version - 1];
    var rawCodewords = Math.floor(rawDataModules(version) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLength = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(eccLength);

    var blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLength - eccLength + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0); // placeholder, skipped below
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var row = 0; row < blocks.length; row++) {
        if (col !== shortBlockLength - eccLength || row >= numShortBlocks) result.push(blocks[row][col]);
      }
    }
    return result;
  }

  // --- The matrix ------------------------------------------------------------------

  function Matrix(version) {
    this.version = version;
    this.size = sizeOf(version);
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
  }

  Matrix.prototype.setFunction = function (x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  };

  Matrix.prototype.drawFinder = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx;
        var yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };

  Matrix.prototype.drawAlignment = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  Matrix.prototype.drawFormatBits = function (mask) {
    var data = (FORMAT_LEVEL_M << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var size = this.size;

    for (var a = 0; a <= 5; a++) this.setFunction(8, a, getBit(bits, a));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (var b = 9; b < 15; b++) this.setFunction(14 - b, 8, getBit(bits, b));

    for (var c = 0; c < 8; c++) this.setFunction(size - 1 - c, 8, getBit(bits, c));
    for (var d = 8; d < 15; d++) this.setFunction(8, size - 15 + d, getBit(bits, d));
    this.setFunction(8, size - 8, true); // the dark module, always dark
  };

  Matrix.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (this.version << 12) | rem;
    for (var j = 0; j < 18; j++) {
      var bit = getBit(bits, j);
      var a = this.size - 11 + j % 3;
      var b = Math.floor(j / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  };

  Matrix.prototype.drawFunctionPatterns = function () {
    var size = this.size;
    for (var i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    var positions = alignmentPositions(this.version);
    var count = positions.length;
    for (var a = 0; a < count; a++) {
      for (var b = 0; b < count; b++) {
        var corner = (a === 0 && b === 0) || (a === 0 && b === count - 1) || (a === count - 1 && b === 0);
        if (!corner) this.drawAlignment(positions[a], positions[b]);
      }
    }
    this.drawFormatBits(0); // reserves the area; redrawn once the mask is chosen
    this.drawVersion();
  };

  // The zigzag: two columns at a time from the right, alternating up and
  // down, skipping the vertical timing column.
  Matrix.prototype.drawCodewords = function (codewords) {
    var size = this.size;
    var i = 0;
    var total = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < total) {
            this.modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  Matrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  // The four standard penalty rules. Any mask makes a valid code; the lowest
  // score just reads most reliably.
  Matrix.prototype.penalty = function () {
    var size = this.size;
    var m = this.modules;
    var score = 0;
    var line;

    function runs(get) {
      var total = 0;
      for (var a = 0; a < size; a++) {
        var count = 1;
        for (var b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) {
            count++;
          } else {
            if (count >= 5) total += 3 + (count - 5);
            count = 1;
          }
        }
        if (count >= 5) total += 3 + (count - 5);
      }
      return total;
    }
    score += runs(function (a, b) { return m[a][b]; });
    score += runs(function (a, b) { return m[b][a]; });

    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }

    var finderA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var finderB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, a, start, pattern) {
      for (var k = 0; k < pattern.length; k++) {
        if ((get(a, start + k) ? 1 : 0) !== pattern[k]) return false;
      }
      return true;
    }
    for (var dir = 0; dir < 2; dir++) {
      line = dir === 0 ? function (a, b) { return m[a][b]; } : function (a, b) { return m[b][a]; };
      for (var a = 0; a < size; a++) {
        for (var start = 0; start + 11 <= size; start++) {
          if (matches(line, a, start, finderA) || matches(line, a, start, finderB)) score += 40;
        }
      }
    }

    var dark = 0;
    for (var r = 0; r < size; r++) for (var s = 0; s < size; s++) if (m[r][s]) dark++;
    var total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  };

  function smallestVersion(byteLength) {
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      var header = 4 + (v <= 9 ? 8 : 16);
      if (header + byteLength * 8 <= dataCodewords(v) * 8) return v;
    }
    return 0;
  }

  // Returns { size, version, modules } where modules[y][x] is true for dark.
  function encode(text) {
    var bytes = utf8Bytes(text);
    var version = smallestVersion(bytes.length);
    if (!version) throw new Error('Too long for a QR code here');
    var codewords = addEccAndInterleave(encodeData(bytes, version), version);

    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var matrix = new Matrix(version);
      matrix.drawFunctionPatterns();
      matrix.drawCodewords(codewords);
      matrix.applyMask(mask);
      matrix.drawFormatBits(mask);
      var score = matrix.penalty();
      if (score < bestScore) {
        best = matrix;
        bestScore = score;
      }
    }
    return { size: best.size, version: version, modules: best.modules };
  }

  // One SVG path for every dark module, with the four-module quiet zone the
  // standard requires. `cell` is the size of one module in viewBox units.
  function toPath(qr) {
    var d = '';
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) d += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z';
      }
    }
    return d;
  }

  var exported = {
    encode: encode,
    toPath: toPath,
    // Exposed for tests.
    _internal: {
      gfMultiply: gfMultiply,
      rsDivisor: rsDivisor,
      rsRemainder: rsRemainder,
      rawDataModules: rawDataModules,
      dataCodewords: dataCodewords,
      alignmentPositions: alignmentPositions,
      encodeData: encodeData,
      Matrix: Matrix,
      smallestVersion: smallestVersion
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.QrCode = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
