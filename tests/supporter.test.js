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
  // Within the day, a cached read doesn't ask again; a plain one does.
  const later = 7000 + Supporter.RECHECK_MS - 1;
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch, now: later, cached: true }), { supporter: true, kind: 'store', since: 7000 });
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch, now: later }), { supporter: true, kind: 'store', since: 7000 });
  assert.equal(fetch.calls.length, 2);
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

test('the store is asked every time; only a cached read takes an answer from the last day', async () => {
  assert.equal(Supporter.RECHECK_MS, 24 * 60 * 60 * 1000);
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  const revoked = fakeFetch(200, { id: 'x', status: 'revoked' });
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: revoked, now: 8000, cached: true })).supporter, true);
  assert.equal(revoked.calls.length, 0);
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: revoked, now: 8000, cached: true, force: true })).supporter, false);
  assert.equal(revoked.calls.length, 1);
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: revoked, now: 8000 })).supporter, false);
  assert.equal(revoked.calls.length, 2);
});

test('a record typed into storage by hand lasts no longer than the next ask', async () => {
  // Written from the console with today's date, to look checked.
  const typed = () => ({ kind: 'store', code: 'MADEUPCODE123', since: 8000, checkedAt: 8000 });
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = typed();
  const store = fakeFetch(404, { error: 'ResourceNotFound' });
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch: store, now: 8001 }), { supporter: false, kind: 'store', ended: 8001 });
  assert.equal(store.calls.length, 1);
  // Typed in again, it's turned down again.
  storage.data[Supporter.KEY] = typed();
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: store, now: 8002 })).supporter, false);
  assert.equal(store.calls.length, 2);
});

test('still paid within the hour writes nothing, so a page listening for the record isn’t sent round again', async () => {
  assert.equal(Supporter.KEEP_MS, 60 * 60 * 1000);
  const storage = memoryStorage();
  let writes = 0;
  const set = storage.set.bind(storage);
  storage.set = (v) => { writes++; return set(v); };
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000, limit: 3, activationId: 'act_1' };
  const ok = fakeFetch(200, { id: 'lk_1', status: 'granted', limit_activations: 3 });
  for (const now of [7001, 7000 + Supporter.KEEP_MS - 1]) {
    assert.equal((await Supporter.status(storage, { store: STORE, fetch: ok, now })).supporter, true);
  }
  assert.equal(writes, 0);
  assert.equal(ok.calls.length, 2);
  // Past the hour, the answer is written down once.
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: ok, now: 7000 + Supporter.KEEP_MS })).supporter, true);
  assert.equal(writes, 1);
  assert.equal(storage.data[Supporter.KEY].checkedAt, 7000 + Supporter.KEEP_MS);
  // A new limit is written down at once.
  const more = fakeFetch(200, { id: 'lk_1', status: 'granted', limit_activations: 5 });
  await Supporter.status(storage, { store: STORE, fetch: more, now: 7000 + Supporter.KEEP_MS + 1 });
  assert.equal(writes, 2);
  assert.equal(storage.data[Supporter.KEY].limit, 5);
});

test('a store that doesn’t answer in time counts as no answer: the last one stands', async () => {
  assert.equal(Supporter.ANSWER_MS, 6000);
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000 };
  const stuck = () => new Promise(() => {});
  const started = Date.now();
  assert.equal((await Supporter.status(storage, { store: STORE, fetch: stuck, now: month(1), answerMs: 20 })).supporter, true);
  assert.ok(Date.now() - started < 1000);
  assert.equal(storage.data[Supporter.KEY].ended, undefined);
  // Past the grace, it pauses as any unanswered check does.
  assert.deepEqual(await Supporter.status(storage, { store: STORE, fetch: stuck, now: month(15), answerMs: 20 }), { supporter: false, kind: 'store', unchecked: true });
});

test('only the popup’s first draw takes a cached answer, and it asks the store straight after', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  assert.match(popup, /isSupporter = await readSupporter\(fresh \? undefined : \{ cached: true \}\);/);
  assert.match(popup, /if \(isSupporter && !fresh\) recheckSupporter\(\);/);
  assert.match(popup, /if \(s\.supporter !== true\) location\.replace\(`\$\{location\.pathname\}\?fresh`\);/);
  // Everywhere else asks the store (Settings' recheck reads the answer it just got).
  const seen = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'tests', '.verify', '.git', 'store-assets', 'trailer'].includes(name.name)) continue;
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith('.js') && /cached: true/.test(fs.readFileSync(full, 'utf8'))) seen.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  assert.deepEqual(seen.filter((f) => f !== 'background.js').sort(), ['options-supporter.js', 'popup.js']);
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
  const end = src.indexOf("document.addEventListener('supporter-status'", start);
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
  const storage = memoryStorage();
  storage.data[Supporter.KEY] = { kind: 'store', code: CODE, since: 7000, checkedAt: 7000, ended: month(1) };
  const r = await Supporter.unlock(storage, CODE, month(2), { store: STORE, fetch: fakeFetch(200, { status: 'granted' }) });
  assert.equal(r.ok, true);
  assert.equal((await Supporter.status(storage, { store: STORE, now: month(2) })).supporter, true);
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
  // Nor does the blocked page load it: every design there is free. Its one
  // extra, Proof it passes, follows a switch the plan sets elsewhere, and
  // never reads the plan itself.
  const page = fs.readFileSync(path.join(root, 'blocked.html'), 'utf8');
  assert.doesNotMatch(page, /supporter\.js/, 'blocked.html must not load Supporter');
  assert.deepEqual([...page.matchAll(/"(extras\/[^"]+)"/g)].map((m) => m[1]), ['extras/proof.js'], 'blocked.html loads no other extra');
  const stub = fs.readFileSync(path.join(root, 'extras', 'proof.js'), 'utf8');
  assert.doesNotMatch(stub, /pblocker_supporter|Supporter\./);
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
