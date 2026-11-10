const test = require('node:test');
const assert = require('node:assert/strict');
const PinHash = require('../shared/pin-hash.js');

test('hash stores no trace of the PIN itself', async () => {
  const stored = await PinHash.hash('2468');
  assert.equal(stored.v, 1);
  assert.equal(JSON.stringify(stored).includes('2468'), false);
  assert.equal(stored.salt.length, 32);
  assert.equal(stored.hash.length, 64);
});

test('the same PIN hashes differently each time (salted)', async () => {
  const a = await PinHash.hash('2468');
  const b = await PinHash.hash('2468');
  assert.notEqual(a.hash, b.hash);
});

test('verify accepts the right PIN and refuses a wrong one', async () => {
  const stored = await PinHash.hash('2468');
  assert.deepEqual(await PinHash.verify(stored, '2468'), { ok: true, upgrade: false });
  assert.equal((await PinHash.verify(stored, '2469')).ok, false);
  assert.equal((await PinHash.verify(stored, '')).ok, false);
});

test('a PIN saved as plain text by an older version still works, and asks to be upgraded', async () => {
  assert.deepEqual(await PinHash.verify('2468', '2468'), { ok: true, upgrade: true });
  assert.deepEqual(await PinHash.verify('2468', '1357'), { ok: false, upgrade: false });
});

test('isSet recognises both the old and the new form', async () => {
  assert.equal(PinHash.isSet('2468'), true);
  assert.equal(PinHash.isSet(await PinHash.hash('2468')), true);
  assert.equal(PinHash.isSet(null), false);
  assert.equal(PinHash.isSet(''), false);
  assert.equal(PinHash.isSet({ v: 2 }), false);
});

test('generatePin makes six digits', () => {
  for (let i = 0; i < 20; i++) assert.match(PinHash.generatePin(), /^\d{6}$/);
});

test('lockout: five free tries, then a wait that doubles and stops at an hour', () => {
  const now = 1_000_000;
  let raw = null;
  for (let i = 0; i < 4; i++) {
    raw = PinHash.afterFailure(raw, now);
    assert.equal(PinHash.lockState(raw, now).locked, false, `try ${i + 1}`);
  }
  raw = PinHash.afterFailure(raw, now);
  assert.equal(PinHash.lockState(raw, now).waitMs, 60_000);
  raw = PinHash.afterFailure(raw, now);
  assert.equal(PinHash.lockState(raw, now).waitMs, 120_000);
  for (let i = 0; i < 10; i++) raw = PinHash.afterFailure(raw, now);
  assert.equal(PinHash.lockState(raw, now).waitMs, 3_600_000);
  assert.equal(PinHash.lockState(raw, now + 3_600_001).locked, false);
});

function memoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (key) => (key in store ? { [key]: store[key] } : {}),
    set: async (payload) => { Object.assign(store, payload); },
    remove: async (key) => { delete store[key]; },
  };
}

test('check: a plain-text PIN is accepted once and re-saved as a hash', async () => {
  const storage = memoryStorage({ pblocker_pin: '2468' });
  assert.deepEqual(await PinHash.check(storage, '2468', 1000), { ok: true, waitMs: 0 });
  assert.equal(PinHash.isHashed(storage.store.pblocker_pin), true);
  assert.equal((await PinHash.check(storage, '2468', 2000)).ok, true, 'the hash still accepts it');
});

test('check: wrong tries lock it, and even the right PIN waits out the lock', async () => {
  const storage = memoryStorage({ pblocker_pin: await PinHash.hash('2468') });
  for (let i = 0; i < 4; i++) assert.equal((await PinHash.check(storage, '0000', 1000)).waitMs, 0);
  assert.equal((await PinHash.check(storage, '0000', 1000)).waitMs, 60_000);
  assert.deepEqual(await PinHash.check(storage, '2468', 1000 + 30_000), { ok: false, waitMs: 30_000 });
  assert.equal((await PinHash.check(storage, '2468', 1000 + 61_000)).ok, true);
  assert.equal(storage.store.pblocker_pin_lock, undefined, 'a right PIN clears the count');
});

// Up to 2.0.3, Settings' PIN boxes stopped taking characters at 20 and the
// popup's at 8, so a longer PIN was saved cut short. 2.0.4 lifted the limits
// and the whole PIN stopped matching (emailed report, 619 characters).
const LONG = ('I am more than my urges, and every clean day is a gift worth keeping. ').repeat(9).trim();
const settingsCut = (pin) => pin.slice(0, 20).trim();
const popupCut = (pin) => pin.slice(0, 8).trim();

test('a long PIN saved cut to 20 by the old Settings box is accepted typed in full', async () => {
  assert.ok(LONG.length > 600);
  const stored = await PinHash.hash(settingsCut(LONG));
  assert.equal((await PinHash.verify(stored, LONG)).ok, true, 'the whole text');
  assert.equal((await PinHash.verify(stored, settingsCut(LONG))).ok, true, 'the first 20, as before');
  assert.equal((await PinHash.verify(stored, LONG.slice(0, 35))).ok, true, 'any length past 20');
});

test('a PIN saved cut to 8 by the old popup box is accepted typed in full', async () => {
  const stored = await PinHash.hash(popupCut('correct horse battery'));
  assert.equal((await PinHash.verify(stored, 'correct horse battery')).ok, true);
  assert.equal((await PinHash.verify(stored, 'correct')).ok, true, 'the first 8, trimmed, as before');
});

test('the old cuts never let in a PIN that differs within them', async () => {
  const stored = await PinHash.hash(settingsCut(LONG));
  const typo = 'i' + LONG.slice(1);
  assert.equal((await PinHash.verify(stored, typo)).ok, false, 'a slip in the first 20');
  assert.equal((await PinHash.verify(stored, LONG.slice(0, 19))).ok, false, 'one short');
  assert.equal((await PinHash.verify(stored, settingsCut(LONG).slice(0, 8))).ok, false, 'the first 8 of a 20');
});

test('a long PIN saved whole still needs every character', async () => {
  const stored = await PinHash.hash(LONG);
  assert.equal((await PinHash.verify(stored, LONG)).ok, true);
  assert.equal((await PinHash.verify(stored, settingsCut(LONG))).ok, false, 'the first 20 alone');
  assert.equal((await PinHash.verify(stored, popupCut(LONG))).ok, false, 'the first 8 alone');
  assert.equal((await PinHash.verify(stored, LONG.slice(0, -1))).ok, false, 'one character short');
});

test('the cut is trimmed, as the old pages trimmed what the box kept', async () => {
  // Character 20 is a space here, so the old box saved 19 characters.
  const pin = 'abcd efgh ijkl mnop qrstuvwxyz';
  assert.equal(pin[19], ' ');
  const stored = await PinHash.hash(pin.slice(0, 20).trim());
  assert.equal((await PinHash.verify(stored, pin)).ok, true);
});

test('check: a cut-short plain-text PIN typed in full is re-saved as the PIN that was saved', async () => {
  const storage = memoryStorage({ pblocker_pin: settingsCut(LONG), pblocker_pin_lock: { fails: 6, until: 0 } });
  assert.deepEqual(await PinHash.check(storage, LONG, 1000), { ok: true, waitMs: 0 });
  assert.equal(PinHash.isHashed(storage.store.pblocker_pin), true);
  assert.equal(storage.store.pblocker_pin_lock, undefined, 'the wrong tries are forgotten');
  assert.equal((await PinHash.check(storage, settingsCut(LONG), 2000)).ok, true, 'the first 20 still works');
  assert.equal((await PinHash.check(storage, LONG, 3000)).ok, true, 'and so does the whole text');
});
