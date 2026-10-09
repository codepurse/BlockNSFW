// The QR encoder is checked against published worked examples where they
// exist (the Reed-Solomon codewords), against the code's own algebra where
// they don't (BCH format and version words), and against the layout rules a
// scanner relies on (finder patterns, timing, module counts).
const test = require('node:test');
const assert = require('node:assert/strict');
const QrCode = require('../shared/qr.js');

const Q = QrCode._internal;

test('Reed-Solomon: the "HELLO WORLD" 1-Q worked example', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
  const ecc = Q.rsRemainder(data, Q.rsDivisor(13));
  assert.deepEqual(ecc, [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
});

test('Reed-Solomon: the "01234567" 1-M example from the standard', () => {
  const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
  const ecc = Q.rsRemainder(data, Q.rsDivisor(10));
  assert.deepEqual(ecc, [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
});

test('data capacity at level M matches the standard tables', () => {
  // Data codewords for versions 1, 2, 5, 7 and 10 at level M.
  assert.equal(Q.dataCodewords(1), 16);
  assert.equal(Q.dataCodewords(2), 28);
  assert.equal(Q.dataCodewords(5), 86);
  assert.equal(Q.dataCodewords(7), 124);
  assert.equal(Q.dataCodewords(10), 216);
});

test('alignment pattern centres match the standard table', () => {
  assert.deepEqual(Q.alignmentPositions(1), []);
  assert.deepEqual(Q.alignmentPositions(2), [6, 18]);
  assert.deepEqual(Q.alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(Q.alignmentPositions(10), [6, 28, 50]);
});

function readFormatWord(matrix) {
  let bits = 0;
  for (let i = 0; i <= 5; i++) if (matrix.modules[i][8]) bits |= 1 << i;
  if (matrix.modules[7][8]) bits |= 1 << 6;
  if (matrix.modules[8][8]) bits |= 1 << 7;
  if (matrix.modules[8][7]) bits |= 1 << 8;
  for (let i = 9; i < 15; i++) if (matrix.modules[8][14 - i]) bits |= 1 << i;
  return bits;
}

function polyMod(value, generator, generatorDegree) {
  let v = value;
  for (let bit = 31; bit >= generatorDegree; bit--) {
    if ((v >>> bit) & 1) v ^= generator << (bit - generatorDegree);
  }
  return v;
}

test('format words are valid BCH(15,5) codewords for level M and every mask', () => {
  for (let mask = 0; mask < 8; mask++) {
    const matrix = new Q.Matrix(1);
    matrix.drawFormatBits(mask);
    const word = readFormatWord(matrix) ^ 0x5412;
    assert.equal(polyMod(word, 0x537, 10), 0, `mask ${mask}`);
    assert.equal(word >>> 10, mask, 'level M is 00, so the data bits are the mask');
  }
});

test('both copies of the format word agree, and the dark module is set', () => {
  const matrix = new Q.Matrix(3);
  matrix.drawFormatBits(5);
  const size = matrix.size;
  let second = 0;
  for (let i = 0; i < 8; i++) if (matrix.modules[8][size - 1 - i]) second |= 1 << i;
  for (let i = 8; i < 15; i++) if (matrix.modules[size - 15 + i][8]) second |= 1 << i;
  assert.equal(second, readFormatWord(matrix));
  assert.equal(matrix.modules[size - 8][8], true);
});

test('version 7 carries the version word from the standard (0x07C94)', () => {
  const matrix = new Q.Matrix(7);
  matrix.drawVersion();
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    if (matrix.modules[Math.floor(i / 3)][matrix.size - 11 + (i % 3)]) bits |= 1 << i;
  }
  assert.equal(bits, 0x07c94);
});

test('every non-function module holds a data bit, for versions 1 to 10', () => {
  for (let version = 1; version <= 10; version++) {
    const matrix = new Q.Matrix(version);
    matrix.drawFunctionPatterns();
    let free = 0;
    for (const row of matrix.isFunction) for (const used of row) if (!used) free++;
    assert.equal(free, Q.rawDataModules(version), `version ${version}`);
  }
});

test('finder patterns and timing patterns are where scanners look', () => {
  const qr = QrCode.encode('otpauth://totp/BlockNSFW:Laptop?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BlockNSFW');
  const m = qr.modules;
  const s = qr.size;
  for (const [ox, oy] of [[0, 0], [s - 7, 0], [0, s - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(m[oy][ox + i], true);
      assert.equal(m[oy + 6][ox + i], true);
      assert.equal(m[oy + i][ox], true);
      assert.equal(m[oy + i][ox + 6], true);
    }
    assert.equal(m[oy + 1][ox + 1], false);
    assert.equal(m[oy + 3][ox + 3], true);
  }
  for (let i = 8; i < s - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
});

test('an otpauth key with a 160-bit secret fits version 6 (41 x 41)', () => {
  const qr = QrCode.encode('otpauth://totp/BlockNSFW:Witness?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BlockNSFW');
  assert.equal(qr.version, 6);
  assert.equal(qr.size, qr.version * 4 + 17);
});

// Undo the mask named in the format word and walk the zigzag, the way a
// scanner does, and return the raw codeword bytes.
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function readCodewords(qr) {
  const blank = new Q.Matrix(qr.version);
  blank.drawFunctionPatterns();
  const mask = (readFormatWord({ modules: qr.modules }) ^ 0x5412) >>> 10;
  const bits = [];
  const size = qr.size;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!blank.isFunction[y][x]) bits.push(qr.modules[y][x] !== MASKS[mask](x, y) ? 1 : 0);
      }
    }
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return bytes;
}

test('reading a one-block code back gives its data and error correction', () => {
  const text = 'otpauth://totp/BlockNSFW?secret=ABCDEFGH';
  const qr = QrCode.encode(text);
  assert.equal(qr.version, 3, 'versions 1-3 at level M are a single block');
  const bytes = readCodewords(qr);
  const data = Q.encodeData([...new TextEncoder().encode(text)], qr.version);
  assert.deepEqual(bytes.slice(0, data.length), data);
  assert.deepEqual(bytes.slice(data.length), Q.rsRemainder(data, Q.rsDivisor(bytes.length - data.length)));
});

test('reading a four-block code back de-interleaves into four valid blocks', () => {
  // Version 6-M: four blocks of 27 data and 16 error-correction codewords,
  // interleaved column by column. Undo that here independently of the encoder.
  const text = 'otpauth://totp/BlockNSFW:Witness?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BlockNSFW';
  const qr = QrCode.encode(text);
  assert.equal(qr.version, 6);
  const bytes = readCodewords(qr);
  const data = Q.encodeData([...new TextEncoder().encode(text)], qr.version);
  for (let block = 0; block < 4; block++) {
    const blockData = [];
    for (let i = 0; i < 27; i++) blockData.push(bytes[i * 4 + block]);
    const blockEcc = [];
    for (let i = 0; i < 16; i++) blockEcc.push(bytes[108 + i * 4 + block]);
    assert.deepEqual(blockData, data.slice(block * 27, block * 27 + 27), `block ${block} data`);
    assert.deepEqual(blockEcc, Q.rsRemainder(blockData, Q.rsDivisor(16)), `block ${block} ecc`);
  }
});

test('toPath draws one square per dark module, inside a 4-module quiet zone', () => {
  const qr = QrCode.encode('hi');
  const path = QrCode.toPath(qr);
  let dark = 0;
  for (const row of qr.modules) for (const cell of row) if (cell) dark++;
  assert.equal((path.match(/M/g) || []).length, dark);
  assert.ok(path.startsWith('M4 4'), 'the top-left finder starts after the quiet zone');
});
