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
