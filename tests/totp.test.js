// Witness codes are only useful if they match what an ordinary authenticator
// app shows, so these pin the implementation to the published test vectors
// rather than to itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const Totp = require('../shared/totp.js');

// RFC 4226 and RFC 6238 both use the ASCII secret "12345678901234567890".
const RFC_SECRET = Totp.base32Encode(new TextEncoder().encode('12345678901234567890'));

test('base32 round-trips bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 17]);
  assert.deepEqual([...Totp.base32Decode(Totp.base32Encode(bytes))], [...bytes]);
});

test('base32Decode accepts spaces, lower case and padding, and refuses junk', () => {
  const secret = Totp.base32Encode(new Uint8Array([104, 105, 33]));
  const typed = secret.toLowerCase().replace(/(.{2})/g, '$1 ') + '===';
  assert.deepEqual([...Totp.base32Decode(typed)], [104, 105, 33]);
  assert.equal(Totp.base32Decode('not base32 !'), null);
  assert.equal(Totp.base32Decode(''), null);
});

test('hotp matches the RFC 4226 test vectors', async () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  const bytes = Totp.base32Decode(RFC_SECRET);
  for (let counter = 0; counter < expected.length; counter++) {
    assert.equal(await Totp.hotp(bytes, counter), expected[counter], `counter ${counter}`);
  }
});

test('8-digit TOTP matches the RFC 6238 SHA-1 test vectors', async () => {
  const bytes = Totp.base32Decode(RFC_SECRET);
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(await Totp.hotp(bytes, Totp.counterAt(seconds * 1000), 8), code, `T=${seconds}`);
  }
});

test('verify accepts the current code and one step either side', async () => {
  const now = 1234567890 * 1000;
  for (const offset of [-30000, 0, 30000]) {
    const code = await Totp.totp(RFC_SECRET, now + offset);
    const result = await Totp.verify(RFC_SECRET, code, { times: [now] });
    assert.equal(result.ok, true, `offset ${offset}`);
  }
});

test('verify refuses a code from two minutes ago', async () => {
  const now = 1234567890 * 1000;
  const old = await Totp.totp(RFC_SECRET, now - 120000);
  assert.equal((await Totp.verify(RFC_SECRET, old, { times: [now] })).ok, false);
});

test('verify refuses a code that was already used', async () => {
  const now = 1234567890 * 1000;
  const code = await Totp.totp(RFC_SECRET, now);
  const first = await Totp.verify(RFC_SECRET, code, { times: [now] });
  assert.equal(first.ok, true);
  const again = await Totp.verify(RFC_SECRET, code, { times: [now], lastCounter: first.counter });
  assert.equal(again.ok, false);
});

test('verify trusts a second clock when the device clock is wrong', async () => {
  const server = 1234567890 * 1000;
  const wrongDevice = server + 6 * 3600 * 1000;
  const code = await Totp.totp(RFC_SECRET, server);
  assert.equal((await Totp.verify(RFC_SECRET, code, { times: [wrongDevice] })).ok, false);
  assert.equal((await Totp.verify(RFC_SECRET, code, { times: [wrongDevice, server] })).ok, true);
});

test('verify ignores spaces in a typed code and refuses the wrong length', async () => {
  const now = 1234567890 * 1000;
  const code = await Totp.totp(RFC_SECRET, now);
  assert.equal((await Totp.verify(RFC_SECRET, code.slice(0, 3) + ' ' + code.slice(3), { times: [now] })).ok, true);
  assert.equal((await Totp.verify(RFC_SECRET, code.slice(0, 5), { times: [now] })).ok, false);
});

test('generateSecret makes 160-bit keys that differ', () => {
  const a = Totp.generateSecret();
  const b = Totp.generateSecret();
  assert.equal(Totp.base32Decode(a).length, 20);
  assert.notEqual(a, b);
});

test('otpauthUri is the format authenticator apps read', () => {
  const uri = Totp.otpauthUri('JBSWY3DPEHPK3PXP', 'Laptop');
  assert.equal(uri, 'otpauth://totp/BlockNSFW:Laptop?secret=JBSWY3DPEHPK3PXP&issuer=BlockNSFW');
});

test('recovery codes are unambiguous, and their hashes ignore case and dashes', async () => {
  const codes = Totp.generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes) {
    assert.match(code, /^[ACDEFGHJKMNPQRTUVWXY34679]{4}-[ACDEFGHJKMNPQRTUVWXY34679]{4}$/);
    assert.equal(Totp.looksLikeRecoveryCode(code), true);
  }
  const [first] = codes;
  assert.equal(await Totp.hashRecoveryCode(first), await Totp.hashRecoveryCode(first.toLowerCase().replace('-', ' ')));
  assert.equal(Totp.looksLikeRecoveryCode('123456'), false);
});
