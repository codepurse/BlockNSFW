// Supporter codes. The check has to accept every code the tool makes, and
// nothing else: not a made-up one, not one with a byte changed, not one signed
// by another key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
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

// --- Store codes (Polar) -----------------------------------------------------------

const STORE = { mode: 'sandbox', organizationId: '3f2b8c1e-5d4a-4b7e-9c2f-1a6e8d0b4c3a', api: { sandbox: 'https://sandbox.test', live: 'https://live.test' } };

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('kindOf tells a signed code from a store code from junk', () => {
  assert.equal(Supporter.kindOf('BN1-abc'), 'signed');
  assert.equal(Supporter.kindOf(' bn1-abc '), 'signed');
  assert.equal(Supporter.kindOf('BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB'), 'store');
  assert.equal(Supporter.kindOf(''), null);
  assert.equal(Supporter.kindOf('short'), null);
  assert.equal(Supporter.kindOf('has spaces <script>'), null);
});

test('a store code is checked with the store: only the code and organization go', async () => {
  const fetch = fakeFetch(200, { id: 'lk_1', status: 'granted', expires_at: null });
  const storage = memoryStorage();
  const code = 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB';
  const r = await Supporter.unlock(storage, ` ${code}\n`, 7000, { store: STORE, fetch });
  assert.equal(r.ok, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://sandbox.test/v1/customer-portal/license-keys/validate');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { key: code, organization_id: STORE.organizationId });
  assert.equal(fetch.calls[0].init.credentials, 'omit');
  assert.deepEqual(storage.data[Supporter.KEY], { kind: 'store', code, since: 7000, checkedAt: 7000 });
  // Within the month it doesn't ask again.
  const later = 7000 + Supporter.RECHECK_MS - 1;
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch, now: later }), { supporter: true, kind: 'store', since: 7000 });
  assert.equal(fetch.calls.length, 1);
});

const CODE = 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB';
const month = (n) => 7000 + n * Supporter.RECHECK_MS;

test('after a month it asks again; still paid keeps it and resets the month', async () => {
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  const fetch = fakeFetch(200, { id: 'lk_1', status: 'granted' });
  assert.equal((await Supporter.status(storage, { store: STORE, fetch, now: month(1) })).supporter, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(storage.data[Supporter.KEY].checkedAt, month(1));
});

test('a plan that has ended closes the extras, and says when', async () => {
  for (const [status, body] of [[200, { id: 'x', status: 'revoked' }], [404, { error: 'ResourceNotFound' }]]) {
    const storage = memoryStorage();
    storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
    const s = await Supporter.status(storage, { store: STORE, fetch: fakeFetch(status, body), now: month(1) });
    assert.deepEqual(s, { supporter: false, kind: 'store', ended: month(1) });
    // It stays ended without asking again.
    const again = fakeFetch(200, { status: 'granted' });
    assert.equal((await Supporter.status(storage, { store: STORE, fetch: again, now: month(2) })).supporter, false);
    assert.equal(again.calls.length, 0);
  }
});

test('the check runs about daily, and at once when forced', async () => {
  assert.equal(Supporter.RECHECK_MS, 24 * 60 * 60 * 1000);
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  const revoked = fakeFetch(200, { id: 'x', status: 'revoked' });
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: revoked, now: 8000 })).supporter, true);
  assert.equal(revoked.calls.length, 0);
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: revoked, now: 8000, force: true })).supporter, false);
  assert.equal(revoked.calls.length, 1);
});

test('offline at the monthly check, a supporter stays a supporter', async () => {
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  const down = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: down, now: month(3) })).supporter, true);
  const busy = fakeFetch(503, {});
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: busy, now: month(3) })).supporter, true);
  assert.equal(storage.data[Supporter.KEY].ended, undefined);
});

test('a check dated in the future counts for nothing: the store is asked now', async () => {
  // A record written by hand to dodge the daily check.
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: 'MADEUPCODE123', since: 7000, checkedAt: 9e15 };
  const store = fakeFetch(404, { error: 'ResourceNotFound' });
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch: store, now: 8000 }), { supporter: false, kind: 'store', ended: 8000 });
  assert.equal(store.calls.length, 1);
  // The same with no check at all and a start date in the future.
  storage.data[Supporter.KEY] = { kind: 'store', code: 'MADEUPCODE123', since: 9e15 };
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: fakeFetch(404, {}), now: 8000 })).supporter, false);
});

test('out of reach of the store for two weeks, the extras pause until it answers; nothing is ended', async () => {
  assert.equal(Supporter.OFFLINE_GRACE_MS, 14 * 24 * 60 * 60 * 1000);
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  const down = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: down, now: month(13) })).supporter, true);
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch: down, now: month(15) }), { supporter: false, kind: 'store', unchecked: true });
  assert.equal(storage.data[Supporter.KEY].ended, undefined);
  // Back online: the store says it's paid, and the extras are back.
  const ok = fakeFetch(200, { id: 'lk_1', status: 'granted' });
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch: ok, now: month(16) }), { supporter: true, kind: 'store', since: 7000 });
});

test('a look survives a pause for want of an answer, but not a plan that ended', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), /if \(!s\.supporter && !s\.unchecked\) endLook\(\);/);
  assert.match(fs.readFileSync(path.join(root, 'options-supporter.js'), 'utf8'), /answered && !s\.supporter && !s\.unchecked && scheme/);
});

test('entering a code again after a plan ended opens it again', async () => {
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000, ended: month(1) };
  const r = await Supporter.unlock(storage, CODE, month(2), { store: STORE, fetch: fakeFetch(200, { status: 'granted' }) });
  assert.equal(r.ok, true);
  assert.equal((await Supporter.status(storage, { store: STORE, now: month(2) })).supporter, true);
});

test('plans: three, yearly chosen first; the offer line ends by itself', () => {
  assert.deepEqual(Supporter.PLANS.map((p) => p.id), ['monthly', 'yearly', 'lifetime']);
  assert.deepEqual(Supporter.PLANS.filter((p) => p.best).map((p) => p.id), ['yearly']);
  assert.equal(typeof Supporter.buyable(), 'boolean');
  assert.equal(Supporter.offerFor(Date.now()), Supporter.offerFor(Date.now()));
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

test('a store code that is unknown, turned off, or run out keeps nothing', async () => {
  const code = 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB';
  for (const [status, body] of [
    [404, { error: 'ResourceNotFound' }],
    [200, { id: 'x', status: 'revoked' }],
    [200, { id: 'x', status: 'granted', expires_at: '2020-01-01T00:00:00Z' }]
  ]) {
    const storage = memoryStorage();
    const r = await Supporter.unlock(storage, code, Date.parse('2026-10-10'), { store: STORE, fetch: fakeFetch(status, body) });
    assert.equal(r.ok, false);
    assert.deepEqual(storage.data, {});
  }
});

test('offline or before the store is switched on, it says so and keeps nothing', async () => {
  const code = 'BLOCKNSFW-6F2D1A90-0A4B-4E5C-9D7E-1234567890AB';
  const storage = memoryStorage();
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const r = await Supporter.unlock(storage, code, 1, { store: STORE, fetch: down });
  assert.deepEqual([r.ok, r.offline], [false, true]);
  const off = await Supporter.unlock(storage, code, 1, { store: { ...STORE, organizationId: '' }, fetch: fakeFetch(200, { status: 'granted' }) });
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

// A store with one key, a limit of `limit` places, and the places taken so far.
function fakeStore({ limit = 3, taken = [], status = 'granted' } = {}) {
  const places = taken.slice();
  let next = 1;
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const route = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ route, body });
    const reply = (code, json) => ({ status: code, ok: code >= 200 && code < 300, json: async () => json });
    if (body.key !== LIMITED || status !== 'granted') return reply(404, { error: 'ResourceNotFound' });
    if (route === 'validate') {
      if (body.activation_id && !places.includes(body.activation_id)) return reply(404, { error: 'ResourceNotFound' });
      return reply(200, { id: 'lk_1', status: 'granted', limit_activations: limit, expires_at: null });
    }
    if (route === 'activate') {
      if (!limit) return reply(403, { error: 'NotPermitted' });
      if (places.length >= limit) return reply(403, { error: 'NotPermitted' });
      const id = `act_${next++}`;
      places.push(id);
      return reply(200, { id, label: body.label, license_key: { limit_activations: limit } });
    }
    if (route === 'deactivate') {
      const at = places.indexOf(body.activation_id);
      if (at < 0) return reply(404, { error: 'ResourceNotFound' });
      places.splice(at, 1);
      return { status: 204, ok: true, json: async () => { throw new SyntaxError('no body'); } };
    }
    return reply(404, {});
  };
  fn.calls = calls;
  fn.places = places;
  return fn;
}

test('with a limit, entering the code takes a place named for the browser', async () => {
  const fetch = fakeStore({ limit: 3 });
  const storage = memoryStorage();
  const r = await Supporter.unlock(storage, LIMITED, 7000, { store: STORE, fetch, label: 'BlockNSFW · Chrome on Windows' });
  assert.equal(r.ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.route), ['validate', 'activate']);
  assert.deepEqual(fetch.calls[1].body, { key: LIMITED, organization_id: STORE.organizationId, label: 'BlockNSFW · Chrome on Windows' });
  assert.deepEqual(storage.data[Supporter.KEY], { kind: 'store', code: LIMITED, since: 7000, checkedAt: 7000, activationId: 'act_1', limit: 3 });
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch, now: 8000 }), { supporter: true, kind: 'store', since: 7000, limit: 3 });

  // The daily check asks about this browser's place, not just the code.
  await Supporter.status(storage, { store: STORE, fetch, now: 7000 + Supporter.RECHECK_MS + 1 });
  const last = fetch.calls[fetch.calls.length - 1];
  assert.deepEqual([last.route, last.body.activation_id], ['validate', 'act_1']);
});

test('every place taken: the code is refused, says why, and keeps nothing', async () => {
  const fetch = fakeStore({ limit: 3, taken: ['a', 'b', 'c'] });
  const storage = memoryStorage();
  const r = await Supporter.unlock(storage, LIMITED, 7000, { store: STORE, fetch });
  assert.deepEqual([r.ok, r.full], [false, true]);
  assert.match(r.reason, /already on 3 browsers/);
  assert.match(r.reason, /Remove it from one of them/);
  assert.deepEqual(storage.data, {});
});

test('the same code entered again here keeps its place instead of taking another', async () => {
  const fetch = fakeStore({ limit: 2 });
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, { store: STORE, fetch });
  await Supporter.unlock(storage, LIMITED, 9000, { store: STORE, fetch });
  assert.deepEqual(fetch.places, ['act_1']);
  assert.equal(storage.data[Supporter.KEY].activationId, 'act_1');
});

test('removing it here gives the place back, so it can move to another browser', async () => {
  const fetch = fakeStore({ limit: 1 });
  const here = memoryStorage();
  const there = memoryStorage();
  assert.equal((await Supporter.unlock(here, LIMITED, 7000, { store: STORE, fetch })).ok, true);
  assert.equal((await Supporter.unlock(there, LIMITED, 7100, { store: STORE, fetch })).full, true);

  assert.deepEqual(await Supporter.release(here, { store: STORE, fetch }), { ok: true });
  assert.deepEqual(fetch.places, []);
  assert.deepEqual(await Supporter.status(here, { store: STORE, fetch }), { supporter: false });
  assert.equal((await Supporter.unlock(there, LIMITED, 7200, { store: STORE, fetch })).ok, true);
});

test('offline, removing it changes nothing: the place would stay taken', async () => {
  const fetch = fakeStore({ limit: 3 });
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, { store: STORE, fetch });
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const r = await Supporter.release(storage, { store: STORE, fetch: down });
  assert.equal(r.ok, false);
  assert.match(r.reason, /still holds its place/);
  assert.equal(storage.data[Supporter.KEY].activationId, 'act_1');
});

test('a place taken back on the purchases page closes the extras here, and says so', async () => {
  const fetch = fakeStore({ limit: 3 });
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, { store: STORE, fetch });
  fetch.places.length = 0;   // the buyer removed this browser in Polar
  const later = 7000 + Supporter.RECHECK_MS + 1;
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch, now: later }), { supporter: false, kind: 'store', removed: later });
  // Entering the code again takes a free place back.
  assert.equal((await Supporter.unlock(storage, LIMITED, later + 1, { store: STORE, fetch })).ok, true);
  assert.equal((await Supporter.status(storage, { store: STORE, fetch, now: later + 2 })).supporter, true);
});

test('a plan that ends with a place held still reads as ended, not removed', async () => {
  const storage = memoryStorage();
  await Supporter.unlock(storage, LIMITED, 7000, { store: STORE, fetch: fakeStore({ limit: 3 }) });
  const later = 7000 + Supporter.RECHECK_MS + 1;
  const s = await Supporter.status(storage, { store: STORE, fetch: fakeStore({ status: 'revoked' }), now: later });
  assert.deepEqual(s, { supporter: false, kind: 'store', ended: later });
});

test('a limit set in Polar after the code was entered: a free place is taken, a full plan closes here', async () => {
  const later = 7000 + Supporter.RECHECK_MS + 1;
  const old = () => {
    const storage = memoryStorage();
    storage.data[Supporter.KEY] = { kind: 'store', code: LIMITED, since: 7000, checkedAt: 7000 };
    return storage;
  };
  const roomy = fakeStore({ limit: 3 });
  const a = old();
  assert.deepEqual(await Supporter.status(a, { store: STORE, fetch: roomy, now: later }), { supporter: true, kind: 'store', since: 7000, limit: 3 });
  assert.equal(a.data[Supporter.KEY].activationId, 'act_1');

  const b = old();
  const full = fakeStore({ limit: 3, taken: ['x', 'y', 'z'] });
  assert.deepEqual(await Supporter.status(b, { store: STORE, fetch: full, now: later }), { supporter: false, kind: 'store', removed: later });
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

test('nothing that blocks reads the supporter state', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  for (const file of ['background.js', 'content.js', 'blocked.js', 'blocked-themes.js', 'gateway.js', 'offscreen.js', 'ai-image-blocker.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /pblocker_supporter|Supporter\./, `${file} must not depend on Supporter`);
  }
  // Nor does the blocked page load it: every design there is free.
  const page = fs.readFileSync(path.join(root, 'blocked.html'), 'utf8');
  assert.doesNotMatch(page, /supporter\.js|extras\//, 'blocked.html must not load Supporter or an extra');
});
