// Supporter codes. The check has to accept every code the tool makes, and
// nothing else: not a made-up one, not one with a byte changed, not one signed
// by another key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, generateKeyPairSync, createHash, sign: nodeSign } = require('node:crypto');
const Supporter = require('../shared/supporter.js');

const subtle = webcrypto.subtle;

async function keyPair() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}

async function makeCode(privateKey, number, day = 283) {
  const payload = Supporter.payloadFor(number, day);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, payload));
  return Supporter.encode(payload, sig);
}

function memoryStorage() {
  const data = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (obj) => { Object.assign(data, obj); }
  };
}

test('the shipped public key is a real P-256 key', async () => {
  assert.equal(Supporter.PUBLIC_KEY.crv, 'P-256');
  await subtle.importKey('jwk', Supporter.PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
});

test('a code made with the key opens, and says its number and day', async () => {
  const { privateKey, publicKey } = await keyPair();
  const code = await makeCode(privateKey, 4242, 283);
  assert.match(code, /^BN1-[A-Za-z0-9_-]{95}$/);
  const r = await Supporter.verify(code, { subtle, publicKey });
  assert.equal(r.ok, true);
  assert.equal(r.number, 4242);
  assert.equal(new Date(r.issued).toISOString().slice(0, 10), '2026-10-11');
});

test('pasted with spaces, line breaks or a lower-case prefix, it still opens', async () => {
  const { privateKey, publicKey } = await keyPair();
  const code = await makeCode(privateKey, 7);
  const messy = '  bn1-' + code.slice(4, 40) + '\n  ' + code.slice(40) + ' ';
  assert.equal((await Supporter.verify(messy, { subtle, publicKey })).ok, true);
});

test('a changed byte, another key, or something code-shaped does not open', async () => {
  const { privateKey, publicKey } = await keyPair();
  const other = await keyPair();
  const code = await makeCode(privateKey, 9);

  const flipped = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
  assert.equal((await Supporter.verify(flipped, { subtle, publicKey })).ok, false);
  assert.equal((await Supporter.verify(code, { subtle, publicKey: other.publicKey })).ok, false);
  assert.equal((await Supporter.verify('BN1-' + 'A'.repeat(95), { subtle, publicKey })).ok, false);
  for (const junk of ['', 'hello', 'BN1-', 'BN1-%%%', null, undefined, code.slice(0, 50)]) {
    const r = await Supporter.verify(junk, { subtle, publicKey });
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
});

test('unlock keeps a good code and status reads it back; a bad one keeps nothing', async () => {
  const { privateKey, publicKey } = await keyPair();
  const storage = memoryStorage();
  const bad = await Supporter.unlock(storage, 'BN1-nope', 1000, { subtle, publicKey });
  assert.equal(bad.ok, false);
  assert.deepEqual(storage.data, {});
  assert.deepEqual(await Supporter.status(storage, { subtle, publicKey }), { supporter: false });

  const code = await makeCode(privateKey, 12);
  const good = await Supporter.unlock(storage, ' ' + code + ' ', 5000, { subtle, publicKey });
  assert.equal(good.ok, true);
  assert.equal(storage.data[Supporter.KEY].code, code);
  assert.deepEqual(await Supporter.status(storage, { subtle, publicKey }), { supporter: true, kind: 'signed', number: 12, since: 5000 });
});

// --- Store codes: monolab.dev asks Polar, and signs a receipt ------------------------

const RECEIPT_URL = 'https://receipt.test/api/blocknsfw/receipt';
const STORE = { mode: 'sandbox', organizationId: '3f2b8c1e-5d4a-4b7e-9c2f-1a6e8d0b4c3a', api: { sandbox: 'https://sandbox.test', live: 'https://live.test' }, receipt: RECEIPT_URL };
const CODE = 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB';
const DAY = 24 * 60 * 60 * 1000;
const day = (n) => 7000 + n * DAY;

// monolab.dev's key in these tests (the real one is only on the server).
const RECEIPT_KEYS = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const RECEIPT_PUBLIC = (() => {
  const j = RECEIPT_KEYS.publicKey.export({ format: 'jwk' });
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
})();

// A receipt as lib/blocknsfw-receipt.ts signs one.
function receiptFor(code, { mode = STORE.mode, limit = 0, issued = 7000, expires, privateKey = RECEIPT_KEYS.privateKey } = {}) {
  const h = createHash('sha256').update(code).digest().subarray(0, 16).toString('base64url');
  const i = Math.floor(issued / 1000);
  const e = Math.floor((expires === undefined ? issued + Supporter.OFFLINE_GRACE_MS : expires) / 1000);
  const payload = Buffer.from(JSON.stringify({ m: mode, h, l: limit, i, e }));
  const sig = nodeSign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `BNR1.${payload.toString('base64url')}.${sig.toString('base64url')}`;
}

// monolab.dev and Polar together: one code, its plan's limit, the places
// taken so far. The server signs at `fn.now`; `fn.down` takes both offline;
// `fn.answer` makes the server give that [status, body] instead.
function fakeStore({ code = CODE, limit = 0, taken = [], status = 'granted', reason = 'off', receiptOf } = {}) {
  const places = taken.slice();
  let next = 1;
  const calls = [];
  const fn = async (url, init) => {
    if (fn.down) throw new TypeError('Failed to fetch');
    const body = JSON.parse(init.body);
    const route = url === RECEIPT_URL ? 'receipt' : url.slice(url.lastIndexOf('/') + 1);
    calls.push({ url, route, body, init });
    const reply = (s, json) => ({ status: s, ok: s >= 200 && s < 300, json: async () => json });
    if (route === 'receipt') {
      if (fn.answer) return reply(...fn.answer);
      if (body.code !== code) return reply(403, { status: 'ended', reason: 'unknown' });
      if (status !== 'granted') return reply(403, { status: 'ended', reason });
      if (body.activation && !places.includes(body.activation)) return reply(403, { status: 'removed' });
      const receipt = receiptOf ? receiptOf(body) : receiptFor(body.code, { mode: body.mode, limit, issued: fn.now });
      return reply(200, { status: 'granted', limit, receipt });
    }
    if (body.key !== code || status !== 'granted') return reply(404, { error: 'ResourceNotFound' });
    if (route === 'activate') {
      if (!limit || places.length >= limit) return reply(403, { error: 'NotPermitted' });
      const id = `act_${next++}`;
      places.push(id);
      return reply(200, { id, label: body.label, license_key: { limit_activations: limit } });
    }
    if (route === 'deactivate') {
      const where = places.indexOf(body.activation_id);
      if (where < 0) return reply(404, { error: 'ResourceNotFound' });
      places.splice(where, 1);
      return { status: 204, ok: true, json: async () => { throw new SyntaxError('no body'); } };
    }
    return reply(404, {});
  };
  fn.now = 7000;
  fn.calls = calls;
  fn.places = places;
  return fn;
}

// What status and unlock are given: this store, the test key, the fake.
const S = (fetch, more = {}) => ({ store: STORE, receiptKey: RECEIPT_PUBLIC, fetch, ...more });
// The same at a moment, with the server's clock set to it.
const at = (fetch, now, more = {}) => {
  fetch.now = now;
  return S(fetch, { now, ...more });
};
const PAUSED = { supporter: false, kind: 'store', unchecked: true };

test('kindOf tells a signed code from a store code from junk', () => {
  assert.equal(Supporter.kindOf('BN1-abc'), 'signed');
  assert.equal(Supporter.kindOf(' bn1-abc '), 'signed');
  assert.equal(Supporter.kindOf('BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB'), 'store');
  assert.equal(Supporter.kindOf(''), null);
  assert.equal(Supporter.kindOf('short'), null);
  assert.equal(Supporter.kindOf('has spaces <script>'), null);
});

test('the shipped receipt key is a real P-256 key, not the gift-code one, and monolab.dev is asked', async () => {
  await subtle.importKey('jwk', Supporter.RECEIPT_PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.notEqual(Supporter.RECEIPT_PUBLIC_KEY.x, Supporter.PUBLIC_KEY.x);
  assert.equal(Supporter.STORE.receipt, 'https://monolab.dev/api/blocknsfw/receipt');
});

test('a store code is asked about at monolab.dev: only the code, the mode and the store go', async () => {
  const fetch = fakeStore();
  const storage = memoryStorage();
  const r = await Supporter.unlock(storage, ` ${CODE}\n`, 7000, at(fetch, 7000));
  assert.equal(r.ok, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, RECEIPT_URL);
  assert.deepEqual(fetch.calls[0].body, { code: CODE, mode: 'sandbox', org: STORE.organizationId });
  assert.equal(fetch.calls[0].init.credentials, 'omit');
  const { receipt, ...rest } = storage.data[Supporter.KEY];
  assert.deepEqual(rest, { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 });
  assert.match(receipt, /^BNR1\./);
  // Within the day, the receipt stands without asking.
  assert.deepEqual(await Supporter.status(storage, at(fetch, day(1) - 1)), { supporter: true, kind: 'store', since: 7000 });
  assert.equal(fetch.calls.length, 1);
});

test('after a day it asks again: still paid brings a new receipt; forced, it asks at once', async () => {
  assert.equal(Supporter.RECHECK_MS, DAY);
  const fetch = fakeStore();
  const storage = memoryStorage();
  await Supporter.unlock(storage, CODE, 7000, at(fetch, 7000));
  const first = storage.data[Supporter.KEY].receipt;
  assert.equal((await Supporter.status(storage, at(fetch, day(1)))).supporter, true);
  assert.equal(fetch.calls.length, 2);
  assert.notEqual(storage.data[Supporter.KEY].receipt, first);
  assert.equal(storage.data[Supporter.KEY].checkedAt, day(1));
  await Supporter.status(storage, at(fetch, day(1) + 1000, { force: true }));
  assert.equal(fetch.calls.length, 3);
});

test('a plan that has ended closes the extras, and says when; it stays ended without asking', async () => {
  for (const reason of ['off', 'expired', 'unknown']) {
    const storage = memoryStorage();
    await Supporter.unlock(storage, CODE, 7000, at(fakeStore(), 7000));
    const over = fakeStore({ status: 'revoked', reason });
    assert.deepEqual(await Supporter.status(storage, at(over, day(1))), { supporter: false, kind: 'store', ended: day(1) });
    const again = fakeStore();
    assert.equal((await Supporter.status(storage, at(again, day(2)))).supporter, false);
    assert.equal(again.calls.length, 0);
  }
});

test('a record typed into storage by hand opens nothing: online it’s turned down, offline it waits', async () => {
  // Written from the console, dated today: no receipt, a made-up one, or one
  // signed with some other key.
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  for (const receipt of [undefined, 'BNR1.made.up', receiptFor('MADEUPCODE123', { issued: 8000, privateKey: other })]) {
    const typed = () => ({ kind: 'store', code: 'MADEUPCODE123', since: 8000, checkedAt: 8000, limit: 3, receipt });
    const storage = memoryStorage();
    storage.data[Supporter.KEY] = typed();
    assert.deepEqual(await Supporter.status(storage, at(fakeStore(), 8001)), { supporter: false, kind: 'store', ended: 8001 });
    storage.data[Supporter.KEY] = typed();
    const offline = fakeStore();
    offline.down = true;
    assert.deepEqual(await Supporter.status(storage, at(offline, 8001)), PAUSED);
  }
});

test('a receipt stands only for its own code, its own mode, unchanged, and until it runs out', async () => {
  const storage = memoryStorage();
  const keep = (receipt, code = CODE) => { storage.data[Supporter.KEY] = { kind: 'store', code, since: 7000, receipt }; };
  const offline = fakeStore();
  offline.down = true;
  keep(receiptFor(CODE));
  assert.equal((await Supporter.status(storage, at(offline, 8000))).supporter, true, 'the real thing');
  keep(receiptFor(CODE), 'BLOCKNSFW-SOMEONE-ELSES-CODE-0000');
  assert.deepEqual(await Supporter.status(storage, at(offline, 8000)), PAUSED, 'another code’s receipt');
  keep(receiptFor(CODE, { mode: 'live' }));
  assert.deepEqual(await Supporter.status(storage, at(offline, 8000)), PAUSED, 'the live store’s receipt in a sandbox build');
  keep(receiptFor(CODE, { expires: 7000 + DAY }));
  assert.deepEqual(await Supporter.status(storage, at(offline, 7000 + DAY + 1)), PAUSED, 'run out');
  keep(receiptFor(CODE, { issued: day(5) }));
  assert.deepEqual(await Supporter.status(storage, at(offline, 8000)), PAUSED, 'issued days from now');
  keep(receiptFor(CODE, { expires: day(60) }));
  assert.deepEqual(await Supporter.status(storage, at(offline, day(15))), PAUSED, 'claims longer than the grace');
  const good = receiptFor(CODE);
  keep(good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
  assert.deepEqual(await Supporter.status(storage, at(offline, 8000)), PAUSED, 'a changed byte');
});

test('a yes whose receipt doesn’t check is no answer at all', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  for (const lying of [
    fakeStore({ receiptOf: (body) => receiptFor(body.code, { privateKey: other }) }),
    fakeStore({ receiptOf: () => 'BNR1.nope' }),
    fakeStore({ receiptOf: () => receiptFor('BLOCKNSFW-SOMEONE-ELSES-CODE-0000') })
  ]) {
    const storage = memoryStorage();
    const r = await Supporter.unlock(storage, CODE, 7000, at(lying, 7000));
    assert.deepEqual([r.ok, r.offline], [false, true]);
    assert.deepEqual(storage.data, {});
    storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000 };
    assert.deepEqual(await Supporter.status(storage, at(lying, 8000)), PAUSED);
  }
});

test('a fresh receipt answers without asking or writing, so a page listening for the record isn’t sent round again', async () => {
  const fetch = fakeStore();
  const storage = memoryStorage();
  await Supporter.unlock(storage, CODE, 7000, at(fetch, 7000));
  let writes = 0;
  const set = storage.set;
  storage.set = (v) => { writes++; return set(v); };
  for (const now of [7001, 9000, day(1) - 1]) assert.equal((await Supporter.status(storage, at(fetch, now))).supporter, true);
  assert.deepEqual([writes, fetch.calls.length], [0, 1]);
  // A day on: one ask, one write, then quiet again.
  await Supporter.status(storage, at(fetch, day(1)));
  await Supporter.status(storage, at(fetch, day(1) + 5000));
  assert.deepEqual([writes, fetch.calls.length], [1, 2]);
});

test('an answer that doesn’t come in time counts as no answer: the receipt stands', async () => {
  assert.equal(Supporter.ANSWER_MS, 6000);
  const storage = memoryStorage();
  await Supporter.unlock(storage, CODE, 7000, at(fakeStore(), 7000));
  const stuck = () => new Promise(() => {});
  const started = Date.now();
  assert.equal((await Supporter.status(storage, S(stuck, { now: day(2), answerMs: 20 }))).supporter, true);
  assert.ok(Date.now() - started < 1000);
  assert.equal(storage.data[Supporter.KEY].ended, undefined);
  // With no receipt, it waits for one.
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000 };
  assert.deepEqual(await Supporter.status(storage, S(stuck, { now: day(2), answerMs: 20 })), PAUSED);
});

test('offline, busy, or a code the server can’t read at the daily check: a supporter stays a supporter', async () => {
  const fetch = fakeStore();
  const storage = memoryStorage();
  await Supporter.unlock(storage, CODE, 7000, at(fetch, 7000));
  fetch.down = true;
  assert.equal((await Supporter.status(storage, at(fetch, day(3)))).supporter, true);
  fetch.down = false;
  for (const answer of [[503, { error: 'unavailable' }], [429, { error: 'too many' }], [400, { error: 'bad code' }], [200, { status: 'granted' }]]) {
    fetch.answer = answer;
    assert.equal((await Supporter.status(storage, at(fetch, day(3)))).supporter, true);
  }
  assert.equal(storage.data[Supporter.KEY].ended, undefined);
});

test('out of reach for two weeks, the receipt runs out and the extras pause until an answer; nothing is ended', async () => {
  assert.equal(Supporter.OFFLINE_GRACE_MS, 14 * DAY);
  const fetch = fakeStore();
  const storage = memoryStorage();
  await Supporter.unlock(storage, CODE, 7000, at(fetch, 7000));
  fetch.down = true;
  assert.equal((await Supporter.status(storage, at(fetch, day(13)))).supporter, true);
  assert.deepEqual(await Supporter.status(storage, at(fetch, day(15))), PAUSED);
  assert.equal(storage.data[Supporter.KEY].ended, undefined);
  // Back online: the store says it's paid, and the extras are back.
  fetch.down = false;
  assert.deepEqual(await Supporter.status(storage, at(fetch, day(16))), { supporter: true, kind: 'store', since: 7000 });
});

test('a record from before receipts gets one at the next answer, place and all', async () => {
  const fetch = fakeStore({ limit: 3, taken: ['act_old'] });
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000, activationId: 'act_old', limit: 3 };
  assert.deepEqual(await Supporter.status(storage, at(fetch, 8000)), { supporter: true, kind: 'store', since: 7000, limit: 3 });
  assert.deepEqual(fetch.calls.map((c) => c.body), [{ code: CODE, mode: 'sandbox', org: STORE.organizationId, activation: 'act_old' }]);
  assert.match(storage.data[Supporter.KEY].receipt, /^BNR1\./);
  assert.equal(storage.data[Supporter.KEY].activationId, 'act_old');
});

test('the shared vector: the receipt the site signed checks here, and only as itself', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'supporter-receipt.vectors.json'), 'utf8'));
  const live = { store: { ...STORE, mode: 'live' }, receiptKey: v.publicKey };
  const when = v.payload.i * 1000 + 1000;
  assert.deepEqual(await Supporter.verifyReceipt(v.receipt, v.code, live, when), { ok: true, limit: 3, issued: v.payload.i * 1000, expires: v.payload.e * 1000 });
  assert.equal((await Supporter.verifyReceipt(v.receipt, v.code + 'X', live, when)).ok, false);
  assert.equal((await Supporter.verifyReceipt(v.receipt, v.code, { ...live, store: STORE }, when)).ok, false);
  assert.equal((await Supporter.verifyReceipt(v.receipt, v.code, live, v.payload.e * 1000)).ok, false);
  assert.equal((await Supporter.verifyReceipt(v.receipt, v.code, { ...live, receiptKey: RECEIPT_PUBLIC }, when)).ok, false);
});

// --- What a page's Console can't do ------------------------------------------------

test('what Supporter hands out is frozen through: status() and the keys stay as shipped', () => {
  assert.ok(Object.isFrozen(Supporter));
  for (const part of [Supporter.STORE, Supporter.STORE.api, Supporter.PUBLIC_KEY, Supporter.RECEIPT_PUBLIC_KEY, Supporter.PLANS, Supporter.PLANS[0], Supporter.REVOKED]) {
    assert.ok(Object.isFrozen(part));
  }
  assert.throws(() => { 'use strict'; Supporter.status = async () => ({ supporter: true }); }, TypeError);
  assert.throws(() => { 'use strict'; Supporter.STORE.mode = 'sandbox'; }, TypeError);
});

test('on a page, the Supporter global can be neither replaced nor removed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, URL, btoa, atob, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'supporter.js'), 'utf8'), ctx);
  const real = ctx.Supporter;
  assert.equal(typeof real.status, 'function');
  vm.runInContext('Supporter = { status: async () => ({ supporter: true }) }; delete globalThis.Supporter;', ctx);
  assert.equal(ctx.Supporter, real);
  assert.throws(() => vm.runInContext("'use strict'; Supporter = {};", ctx));
});

test('a Console that makes crypto say yes after the page loaded changes nothing', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, receipt: receiptFor(CODE, { issued: day(0), privateKey: other.privateKey }) };
  const down = fakeStore();
  down.down = true;
  // Told outright to use a crypto that says yes, it would open: the test means something.
  const yes = { importKey: subtle.importKey.bind(subtle), digest: subtle.digest.bind(subtle), verify: async () => true };
  assert.equal((await Supporter.status(storage, at(down, day(0), { subtle: yes }))).supporter, true);
  // The page's own crypto, changed after supporter.js loaded: it isn't fooled.
  const proto = Object.getPrototypeOf(webcrypto.subtle);
  const real = proto.verify;
  proto.verify = async () => true;
  try {
    assert.deepEqual(await Supporter.status(storage, at(down, day(0))), PAUSED);
    assert.equal(await Supporter.proof(storage, S(down, { now: day(0) })), '');
  } finally {
    proto.verify = real;
  }
});

// A copy of supporter.js of its own, so what other tests told it doesn't count.
function freshSupporter() {
  const file = require.resolve('../shared/supporter.js');
  delete require.cache[file];
  try {
    return require(file);
  } finally {
    delete require.cache[file];
  }
}

test('the extras hear the plan only from status(): once per change, and a late one at once', async () => {
  const S2 = freshSupporter();
  const { privateKey, publicKey } = await keyPair();
  const storage = memoryStorage();
  const heard = [];
  S2.onStatus((s) => heard.push(s));
  await S2.status(storage);
  await S2.status(storage);
  assert.equal(heard.length, 1, 'the same answer again isn’t told again');
  assert.deepEqual({ ...heard[0] }, { supporter: false });
  assert.ok(Object.isFrozen(heard[0]), 'what they hear can’t be changed on its way to the next one');

  S2.onStatus(() => { throw new Error('one extra failing'); });
  await S2.unlock(storage, await makeCode(privateKey, 31), 1000, { subtle, publicKey });
  await S2.status(storage, { subtle, publicKey });
  assert.deepEqual(heard.map((s) => s.supporter), [false, true], 'the rest still hear it');

  const late = [];
  S2.onStatus((s) => late.push(s.supporter));
  assert.deepEqual(late, [], 'not from inside onStatus itself');
  await Promise.resolve();
  assert.deepEqual(late, [true], 'the latest, straight after');
});

test('proof: the receipt while it stands, or the signed code, else nothing; it asks no one', async () => {
  const never = () => { throw new Error('proof never asks'); };
  const storage = memoryStorage();
  const receipt = receiptFor(CODE, { issued: day(0) });
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, receipt };
  assert.equal(await Supporter.proof(storage, S(never, { now: day(3) })), receipt);
  assert.equal(await Supporter.proof(storage, S(never, { now: day(15) })), '', 'run out');
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, receipt, ended: day(1) };
  assert.equal(await Supporter.proof(storage, S(never, { now: day(3) })), '', 'ended');
  storage.data[Supporter.KEY] = { kind: 'store', code: 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-OTHERCODE001', since: 7000, receipt };
  assert.equal(await Supporter.proof(storage, S(never, { now: day(3) })), '', 'another code’s receipt');
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: day(3) };
  assert.equal(await Supporter.proof(storage, S(never, { now: day(3) })), '', 'typed in by hand');

  const { privateKey, publicKey } = await keyPair();
  const code = await makeCode(privateKey, 77);
  storage.data[Supporter.KEY] = { kind: 'signed', code, since: 7000 };
  assert.equal(await Supporter.proof(storage, { subtle, publicKey }), code);
  assert.equal(await Supporter.proof(memoryStorage(), { subtle, publicKey }), '');
});

test('a keepsake’s proof stands after the plan ends, but only a real one, for this store', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.equal(await Supporter.proves(receiptFor(CODE, { issued: day(0) }), S(null)), true, 'run out long ago, still a proof');
  assert.equal(await Supporter.proves(receiptFor(CODE, { mode: 'live' }), S(null)), false, 'another store mode');
  assert.equal(await Supporter.proves(receiptFor(CODE, { privateKey: other.privateKey }), S(null)), false, 'another key');
  for (const junk of ['', 'BNR1.x.y', 'hello', null, 123, {}]) assert.equal(await Supporter.proves(junk, S(null)), false);

  const { privateKey, publicKey } = await keyPair();
  const code = await makeCode(privateKey, 88);
  assert.equal(await Supporter.proves(code, { subtle, publicKey }), true);
  assert.equal(await Supporter.proves(code, { subtle, publicKey, revoked: [88] }), false, 'a code turned off');
});

test('a photo shows on its proof, or while the plan is held, which then keeps the proof; one put in by hand never', async () => {
  const PHOTO = 'pblocker_moment_photo';
  const photo = { src: 'data:image/png;base64,AAAA', at: 5 };
  const never = () => { throw new Error('a keepsake never asks'); };
  const held = { kind: 'store', code: CODE, since: 7000, receipt: receiptFor(CODE, { issued: day(0) }) };
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const storage = memoryStorage();
  storage.data[PHOTO] = { ...photo };
  assert.equal(await Supporter.keepsake(storage, PHOTO, S(never, { now: day(1) })), false, 'by hand, with no plan');
  storage.data[PHOTO] = { ...photo, paid: receiptFor(CODE, { privateKey: other.privateKey }) };
  assert.equal(await Supporter.keepsake(storage, PHOTO, S(never, { now: day(1) })), false, 'with a made-up proof');

  storage.data[Supporter.KEY] = held;
  storage.data[PHOTO] = { ...photo };
  assert.equal(await Supporter.keepsake(storage, PHOTO, S(never, { now: day(1) })), true, 'while the plan is held');
  assert.equal(storage.data[PHOTO].paid, held.receipt, 'and it keeps the proof');

  storage.data[Supporter.KEY] = { ...held, ended: day(2) };
  assert.equal(await Supporter.keepsake(storage, PHOTO, S(never, { now: day(90) })), true, 'after the plan ends, on its proof');
  assert.equal(await Supporter.keepsake(memoryStorage(), PHOTO, S(never, { now: day(1) })), false, 'none stored');
});

test('a look survives a pause for want of an answer, but not a plan that ended', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), /if \(!s\.supporter && !s\.unchecked\) \{\s*endLook\(\);\s*endDesign\(\);/);
  assert.match(fs.readFileSync(path.join(root, 'options-supporter.js'), 'utf8'), /answered && !s\.supporter && !s\.unchecked && scheme/);
  assert.match(fs.readFileSync(path.join(root, 'options-supporter.js'), 'utf8'), /if \(answered && !s\.supporter && !s\.unchecked\) endDesign\(\);/);
});

// --- Blocked-page designs: Classic free, the others with Supporter -----------------

test('the design picker locks every design but Classic, only where the extras are sold', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  const start = src.indexOf('let designSupporter = null;');
  const end = src.indexOf('// shared/supporter.js loads after this file', start);
  assert.ok(start > 0 && end > start, 'options.js keeps designLocked beside designSupporter');
  const run = (extras, supporter) => {
    const ctx = { globalThis: {}, BlockedThemes: undefined };
    ctx.globalThis = ctx;
    ctx.SupporterExtras = extras;
    ctx.BlockedThemes = { DEFAULT_ID: 'classic' };
    vm.runInNewContext(src.slice(start, end) + `\ndesignSupporter = ${JSON.stringify(supporter)};\nthis.locked = ['classic','calm','verse','motivation','play'].filter(designLocked);`, ctx);
    return [...ctx.locked];
  };
  const store = { path: true };
  assert.deepEqual(run(store, null), ['calm', 'verse', 'motivation', 'play'], 'locked until Supporter answers');
  assert.deepEqual(run(store, false), ['calm', 'verse', 'motivation', 'play']);
  assert.deepEqual(run(store, true), [], 'a supporter has all five');
  assert.deepEqual(run(null, false), [], 'the open-source build sells nothing, so all five are open');
});

test('a plan that ends sets the blocked page back to Classic, only where the designs are sold', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['popup.js', 'options-supporter.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const body = src.slice(src.indexOf('async function endDesign()'), src.indexOf('async function endDesign()') + 600);
    assert.match(body, /if \(!self\.SupporterExtras\) return;/, `${file}: open-source build leaves the design alone`);
    assert.match(body, /blockedPageTheme === 'classic'\) return;/, `${file}: Classic stays`);
    assert.match(body, /blockedPageTheme: 'classic'/, `${file}: anything else goes back to Classic`);
  }
});

test('entering a code again after a plan ended opens it again', async () => {
  const fetch = fakeStore();
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000, ended: day(1) };
  const r = await Supporter.unlock(storage, CODE, day(2), at(fetch, day(2)));
  assert.equal(r.ok, true);
  assert.equal((await Supporter.status(storage, at(fetch, day(2)))).supporter, true);
});

test('plans: three, yearly chosen first', () => {
  assert.deepEqual(Supporter.PLANS.map((p) => p.id), ['monthly', 'yearly', 'lifetime']);
  assert.deepEqual(Supporter.PLANS.filter((p) => p.best).map((p) => p.id), ['yearly']);
  assert.equal(typeof Supporter.buyable(), 'boolean');
});

// --- Offers ---------------------------------------------------------------------

const OFFER = {
  name: 'Founding offer',
  title: '30% off Yearly and Lifetime',
  text: 'For our first supporters.',
  until: '2026-11-13',
  prices: { yearly: '$12.00', lifetime: '$10.00' }
};
const plan = (id) => Supporter.PLANS.find((p) => p.id === id);

test('an offer is words and a last day; anything else is no offer', () => {
  assert.deepEqual(Supporter.cleanOffer(OFFER), OFFER);
  for (const bad of [
    null, 'offer', 42, [],
    { ...OFFER, text: '' },
    { ...OFFER, text: '   ' },
    { ...OFFER, text: 7 },
    { ...OFFER, text: 'x'.repeat(201) },
    { ...OFFER, name: 'x'.repeat(41) },
    { ...OFFER, title: 'x'.repeat(81) },
    { ...OFFER, until: undefined },
    { ...OFFER, until: '13 November' },
    { ...OFFER, until: 20261113 }
  ]) {
    assert.equal(Supporter.cleanOffer(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(Supporter.cleanOffer({ text: 'Words only.', until: '2026-11-13' }),
    { name: '', title: '', text: 'Words only.', until: '2026-11-13', prices: {} });
});

test('an offer says when it ends, and says so on its last day', () => {
  assert.match(Supporter.offerEnds(OFFER, new Date(2026, 9, 14, 9).getTime()), /^until .*13/);
  assert.equal(Supporter.offerEnds(OFFER, new Date(2026, 10, 13, 0, 1).getTime()), 'last day');
  assert.equal(Supporter.offerEnds(OFFER, new Date(2026, 10, 13, 23, 59).getTime()), 'last day');
});

test('an offer keeps only prices that lower a plan that exists', () => {
  const kept = Supporter.cleanOffer({
    ...OFFER,
    prices: {
      monthly: plan('monthly').price,   // the same price is no offer
      yearly: '$999.99',                // higher than the plan's own
      lifetime: '62.99',                // no dollar sign
      weekly: '$1.00'                   // no such plan
    }
  });
  assert.deepEqual(kept.prices, {});
  assert.deepEqual(Supporter.cleanOffer({ ...OFFER, prices: { yearly: '$12' } }).prices, { yearly: '$12' });
});

test('an offer shows until the end of its last day, then ends by itself', () => {
  const lastDay = new Date(2026, 10, 13, 23, 59).getTime();
  const dayAfter = new Date(2026, 10, 14, 0, 0).getTime();
  assert.equal(Supporter.activeOffer(new Date(2026, 9, 14).getTime(), OFFER).text, OFFER.text);
  assert.equal(Supporter.activeOffer(lastDay, OFFER).text, OFFER.text);
  assert.equal(Supporter.activeOffer(dayAfter, OFFER), null);
  assert.equal(Supporter.activeOffer(new Date(2030, 0, 1).getTime(), null), null, 'long after any offer, there is none');
  assert.equal(Supporter.activeOffer(new Date(2030, 0, 1).getTime(), { text: 'Broken' }), null);
  const broken = Supporter.activeOffer(lastDay, { text: 'Broken' });
  assert.notEqual(broken && broken.text, 'Broken', 'a broken offer is never shown');
});

test('the founding offer is built in, and ends after November 13', () => {
  const offer = Supporter.activeOffer(new Date(2026, 9, 14, 12).getTime(), null);
  assert.equal(offer.name, 'Founding offer');
  assert.deepEqual(offer.prices, { yearly: '$20.99', lifetime: '$62.99' });
  assert.equal(Supporter.activeOffer(new Date(2026, 10, 14, 0, 0).getTime(), null), null);
});

test('during an offer, a plan it lowers shows both prices, and yearly its new month', () => {
  const shown = Supporter.offered(Supporter.cleanOffer(OFFER));
  const yearly = shown.find((p) => p.id === 'yearly');
  assert.equal(yearly.price, '$12.00');
  assert.equal(yearly.was, plan('yearly').price);
  assert.equal(yearly.note, '$1.00 a month');
  const lifetime = shown.find((p) => p.id === 'lifetime');
  assert.equal(lifetime.price, '$10.00');
  assert.equal(lifetime.was, plan('lifetime').price);
  assert.equal(lifetime.note, plan('lifetime').note, 'only a yearly plan has a month to work out');
  const monthly = shown.find((p) => p.id === 'monthly');
  assert.equal(monthly.price, plan('monthly').price);
  assert.equal(monthly.was, undefined);
  // The plans themselves never change.
  assert.equal(plan('yearly').price, Supporter.offered().find((p) => p.id === 'yearly').price);
  assert.ok(Supporter.offered().every((p) => p.was === undefined));
});

test('the offer in data/version.json is one Settings shows whole', () => {
  // A typo there doesn't fail anywhere else: Settings just quietly drops the
  // offer, or one of its prices.
  const remote = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'data', 'version.json'), 'utf8')).offer;
  if (!remote) return;
  const clean = Supporter.cleanOffer(remote);
  assert.ok(clean, 'version.json has an offer Settings would drop');
  assert.deepEqual(clean.prices, remote.prices || {}, 'version.json has a price Settings would drop');
});

// --- Where a buyer came from ----------------------------------------------------

test('the checkout link names the door, and only a known one', () => {
  const yearly = plan('yearly');
  const url = new URL(Supporter.checkoutUrl({ url: 'https://api.polar.sh/v1/checkout-links/polar_cl_x/redirect' }, 'release'));
  assert.equal(url.origin + url.pathname, 'https://api.polar.sh/v1/checkout-links/polar_cl_x/redirect');
  assert.equal(url.searchParams.get('utm_source'), 'release');
  assert.equal(url.searchParams.get('utm_medium'), 'extension');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['utm_medium', 'utm_source']);
  for (const odd of [undefined, null, '', 'https://example.com/', 'morning', 'constructor', '__proto__']) {
    assert.equal(new URL(Supporter.checkoutUrl({ url: 'https://api.polar.sh/x' }, odd)).searchParams.get('utm_source'), 'settings', String(odd));
  }
  assert.equal(Supporter.checkoutUrl({ url: '' }, 'release'), '');
  assert.equal(Supporter.checkoutUrl(null, 'release'), '');
  if (yearly.url) assert.ok(Supporter.checkoutUrl(yearly, 'popup').startsWith(yearly.url + '?'));
});

test('every door a page names is one Supporter knows', () => {
  // A misspelt door isn't an error anywhere: the sale just counts as Settings.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const named = [];
  for (const file of fs.readdirSync(root).filter((f) => /\.(html|js)$/.test(f))) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/options\.html\?from=([a-z]*)/g)) named.push([file, m[1]]);
    for (const m of text.matchAll(/data-door="([a-z]*)"/g)) named.push([file, m[1]]);
  }
  assert.ok(named.length >= 10, `found only ${named.length} doors`);
  for (const [file, name] of named) assert.ok(Supporter.DOORS.includes(name), `${file}: unknown door "${name}"`);
});

test('only plans with a checkout link are offered, and exactly one is chosen', () => {
  const shown = Supporter.offered();
  assert.ok(shown.length >= 1);
  assert.equal(shown.filter((p) => p.chosen).length, 1);
  if (Supporter.buyable()) {
    for (const p of shown) assert.match(p.url, /^https:\/\/(sandbox-)?api\.polar\.sh\/v1\/checkout-links\/polar_cl_[A-Za-z0-9]+\/redirect$/);
  } else {
    assert.equal(shown.length, Supporter.PLANS.length);
  }
});

test('the store mode and its links agree: no sandbox link in live, no live link in sandbox', () => {
  const sandbox = Supporter.STORE.mode === 'sandbox';
  for (const p of Supporter.PLANS.filter((x) => x.url)) {
    assert.equal(p.url.startsWith('https://sandbox-api.polar.sh/'), sandbox, `${p.id} link doesn't match ${Supporter.STORE.mode} mode`);
  }
});

test('a store code that is unknown, turned off, or run out keeps nothing, and says which', async () => {
  for (const [store, words] of [
    [fakeStore({ code: 'BLOCKNSFW-SOMETHING-ELSE-0000' }), /doesn’t match/],
    [fakeStore({ status: 'revoked', reason: 'off' }), /turned off/],
    [fakeStore({ status: 'revoked', reason: 'expired' }), /run out/]
  ]) {
    const storage = memoryStorage();
    const r = await Supporter.unlock(storage, CODE, 7000, at(store, 7000));
    assert.equal(r.ok, false);
    assert.match(r.reason, words);
    assert.deepEqual(storage.data, {});
  }
});

test('offline or before the store is switched on, it says so and keeps nothing', async () => {
  const storage = memoryStorage();
  const down = fakeStore();
  down.down = true;
  const r = await Supporter.unlock(storage, CODE, 1, at(down, 1));
  assert.deepEqual([r.ok, r.offline], [false, true]);
  const off = await Supporter.unlock(storage, CODE, 1, { ...at(fakeStore(), 1), store: { ...STORE, organizationId: '' } });
  assert.equal(off.ok, false);
  assert.match(off.reason, /switched on/);
  assert.deepEqual(storage.data, {});
});

test('a stored record that no longer checks is not a supporter', async () => {
  const { publicKey } = await keyPair();
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { code: 'BN1-' + 'A'.repeat(95), number: 1, since: 1 };
  assert.deepEqual(await Supporter.status(storage, { subtle, publicKey }), { supporter: false });
  storage.data[Supporter.KEY] = { supporter: true };
  assert.deepEqual(await Supporter.status(storage, { subtle, publicKey }), { supporter: false });
});

// --- A gift code that turned up shared ------------------------------------------------

test('a gift code whose number is revoked opens nothing, and closes where it was kept', async () => {
  const { privateKey, publicKey } = await keyPair();
  const storage = memoryStorage();
  const code = await makeCode(privateKey, 1042);
  assert.equal((await Supporter.unlock(storage, code, 5000, { subtle, publicKey })).ok, true);

  const revoked = [1042];
  const r = await Supporter.unlock(memoryStorage(), code, 6000, { subtle, publicKey, revoked });
  assert.deepEqual([r.ok, r.revoked], [false, true]);
  assert.match(r.reason, /turned off/);
  assert.deepEqual(await Supporter.status(storage, { subtle, publicKey, revoked }), { supporter: false });
  // Another number from the same key still opens.
  assert.equal((await Supporter.verify(await makeCode(privateKey, 1043), { subtle, publicKey, revoked })).ok, true);
  assert.deepEqual(Supporter.REVOKED.filter((n) => !Number.isInteger(n)), [], 'REVOKED holds code numbers only');
});

// --- Polar's limit: a plan works on a few browsers at once ---------------------------

const LIMITED = 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-LIMITED00003';
const limited = (more = {}) => fakeStore({ code: LIMITED, limit: 3, ...more });

test('with a limit, entering the code takes a place named for the browser', async () => {
  const fetch = limited();
  const storage = memoryStorage();
  const r = await Supporter.unlock(storage, LIMITED, 7000, at(fetch, 7000, { label: 'BlockNSFW · Chrome on Windows' }));
  assert.equal(r.ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.route), ['receipt', 'activate']);
  assert.equal(fetch.calls[1].url, 'https://sandbox.test/v1/customer-portal/license-keys/activate');
  assert.deepEqual(fetch.calls[1].body, { key: LIMITED, organization_id: STORE.organizationId, label: 'BlockNSFW · Chrome on Windows' });
  const { receipt, ...rest } = storage.data[Supporter.KEY];
  assert.deepEqual(rest, { kind: 'store', code: LIMITED, since: 7000, checkedAt: 7000, activationId: 'act_1', limit: 3 });
  assert.match(receipt, /^BNR1\./);
  assert.deepEqual(await Supporter.status(storage, at(fetch, 8000)), { supporter: true, kind: 'store', since: 7000, limit: 3 });

  // The daily check asks about this browser's place, not just the code.
  await Supporter.status(storage, at(fetch, day(1) + 1000));
  const last = fetch.calls[fetch.calls.length - 1];
  assert.deepEqual([last.route, last.body.activation], ['receipt', 'act_1']);
});

test('every place taken: the code is refused, says why, and keeps nothing', async () => {
  const fetch = limited({ taken: ['a', 'b', 'c'] });
  const storage = memoryStorage();
  const r = await Supporter.unlock(storage, LIMITED, 7000, at(fetch, 7000));
  assert.deepEqual([r.ok, r.full], [false, true]);
  assert.match(r.reason, /already on 3 browsers/);
  assert.match(r.reason, /Remove it from one of them/);
  assert.deepEqual(storage.data, {});
});

test('the same code entered again here keeps its place instead of taking another', async () => {
  const fetch = limited({ limit: 2 });
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, at(fetch, 7000));
  await Supporter.unlock(storage, LIMITED, 9000, at(fetch, 9000));
  assert.deepEqual(fetch.places, ['act_1']);
  assert.equal(storage.data[Supporter.KEY].activationId, 'act_1');
});

test('removing it here gives the place back, so it can move to another browser', async () => {
  const fetch = limited({ limit: 1 });
  const here = memoryStorage();
  const there = memoryStorage();
  assert.equal((await Supporter.unlock(here, LIMITED, 7000, at(fetch, 7000))).ok, true);
  assert.equal((await Supporter.unlock(there, LIMITED, 7100, at(fetch, 7100))).full, true);

  assert.deepEqual(await Supporter.release(here, S(fetch)), { ok: true });
  assert.equal(fetch.calls[fetch.calls.length - 1].url, 'https://sandbox.test/v1/customer-portal/license-keys/deactivate');
  assert.deepEqual(fetch.places, []);
  assert.deepEqual(await Supporter.status(here, S(fetch)), { supporter: false });
  assert.equal((await Supporter.unlock(there, LIMITED, 7200, at(fetch, 7200))).ok, true);
});

test('offline, removing it changes nothing: the place would stay taken', async () => {
  const fetch = limited();
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, at(fetch, 7000));
  fetch.down = true;
  const r = await Supporter.release(storage, S(fetch));
  assert.equal(r.ok, false);
  assert.match(r.reason, /still holds its place/);
  assert.equal(storage.data[Supporter.KEY].activationId, 'act_1');
});

test('a place taken back on the purchases page closes the extras here, and says so', async () => {
  const fetch = limited();
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, at(fetch, 7000));
  fetch.places.length = 0;   // the buyer removed this browser in Polar
  const later = day(1) + 1000;
  assert.deepEqual(await Supporter.status(storage, at(fetch, later)), { supporter: false, kind: 'store', removed: later });
  // Entering the code again takes a free place back.
  assert.equal((await Supporter.unlock(storage, LIMITED, later + 1000, at(fetch, later + 1000))).ok, true);
  assert.equal((await Supporter.status(storage, at(fetch, later + 2000))).supporter, true);
});

test('a plan that ends with a place held still reads as ended, not removed', async () => {
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, at(limited(), 7000));
  const later = day(1) + 1000;
  const s = await Supporter.status(storage, at(limited({ status: 'revoked' }), later));
  assert.deepEqual(s, { supporter: false, kind: 'store', ended: later });
});

test('a limit set in Polar after the code was entered: a free place is taken, a full plan closes here', async () => {
  const later = day(1) + 1000;
  const old = () => {
    const storage = memoryStorage();
    storage.data[Supporter.KEY] = { kind: 'store', code: LIMITED, since: 7000, checkedAt: 7000, receipt: receiptFor(LIMITED) };
    return storage;
  };
  const a = old();
  assert.deepEqual(await Supporter.status(a, at(limited(), later)), { supporter: true, kind: 'store', since: 7000, limit: 3 });
  assert.equal(a.data[Supporter.KEY].activationId, 'act_1');

  const b = old();
  assert.deepEqual(await Supporter.status(b, at(limited({ taken: ['x', 'y', 'z'] }), later)), { supporter: false, kind: 'store', removed: later });
});

test('the browser name says the browser and the system, and nothing else', () => {
  const ua = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
    firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:157.0) Gecko/20100101 Firefox/157.0',
    android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'
  };
  const label = (s) => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: s }, configurable: true });
    try { return Supporter.deviceLabel(); } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
    }
  };
  assert.equal(label(ua.chrome), 'BlockNSFW · Chrome on Windows');
  assert.equal(label(ua.edge), 'BlockNSFW · Edge on Windows');
  assert.equal(label(ua.firefox), 'BlockNSFW · Firefox on Mac');
  assert.equal(label(ua.android), 'BlockNSFW · Chrome on Android');
});

test('nothing that blocks reads the supporter state; the blocked page and the pause check it only on the device', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  for (const file of ['background.js', 'content.js', 'blocked-themes.js', 'offscreen.js', 'ai-image-blocker.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /pblocker_supporter|Supporter\./, `${file} must not depend on Supporter`);
  }
  // The blocked page and the gateway pause show what comes with Supporter
  // (a design, the dial, the photo, the voice) only while it's held, checked
  // on the device by proof and keepsake. Never status(), which may ask
  // monolab.dev, so nothing there waits on the network.
  for (const file of ['blocked.js', 'gateway.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /pblocker_supporter|Supporter\.status/, `${file} asks nobody`);
    const asks = [...src.matchAll(/Supporter\.([A-Za-z]+)/g)].map((m) => m[1]);
    assert.ok(asks.length && asks.every((name) => name === 'proof' || name === 'keepsake'), `${file}: only proof and keepsake, got ${asks}`);
  }
  // Its extras: the list of what this build carries, and the dial.
  const page = fs.readFileSync(path.join(root, 'blocked.html'), 'utf8');
  assert.deepEqual([...page.matchAll(/"(extras\/[^"]+)"/g)].map((m) => m[1]), ['extras/extras.js', 'extras/proof.js'], 'blocked.html loads no other extra');
  const stub = fs.readFileSync(path.join(root, 'extras', 'proof.js'), 'utf8');
  assert.doesNotMatch(stub, /pblocker_supporter|Supporter\./);
});

test('nothing listens for the old supporter-status event, which any Console could send', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = ['options.js', 'options-supporter.js', 'popup.js'];
  for (const dir of ['extras', path.join('extras-private', 'extras')]) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /supporter-status/, file);
  }
});

test('Storm warning shows only for a supporter, only where it ships, and starts Storm Mode the usual way', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const body = src.slice(src.indexOf('async function renderStormWarning('), src.indexOf('async function renderStormWarning(') + 700);
  assert.match(body, /if \(!extra \|\| !isSupporter \|\| !self\.SupporterExtras \|\| !self\.SupporterExtras\.storm\) return;/);
  assert.match(body, /Pact\.ask\(\{ type: 'boost_storm_start', until \}\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.match(html, /<section class="storm-warn" id="storm-warn"[^>]*hidden>/, 'hidden until the extra shows it');
});

test('Proof it passes comes and goes with the plan, only where it ships, only on a clear answer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['popup.js', 'options-supporter.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const body = src.slice(src.indexOf('async function followProof('), src.indexOf('async function followProof(') + 600);
    assert.match(body, /if \(!self\.SupporterExtras \|\| !self\.SupporterExtras\.proof \|\| !Moments\) return;/, `${file}: only in builds that carry it`);
    assert.match(body, /Moments\.proofForPlan\(raw, supporter, Date\.now\(\)\)/, `${file}: the plan decides by Moments.proofForPlan`);
    assert.match(src, /\(s\.supporter \|\| !s\.unchecked\)\)? followProof\(s\.supporter === true\)/, `${file}: never on a pause for want of an answer`);
  }
});
