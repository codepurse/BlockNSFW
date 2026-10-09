// The background side of the Pact, driven end to end: queue a change, move
// the clocks, and check that protection changes only when the wait is really
// over. The local clock (Date.now) and the server clock (the Date header the
// background reads) are controlled separately, so the tests can move one and
// not the other, the way someone changing their system clock would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('node:crypto');
const { loadBackgroundContext } = require('./setup');
const Totp = require('../shared/totp.js');

const TOTP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'totp.js'), 'utf8');
const PACT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'pact.js'), 'utf8');
const SERVER_TIME_URL = require('../shared/pact.js').SERVER_TIME_URL;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 8, 20, 0, 0);

function memoryStorage(initial) {
  const store = { ...initial };
  const pick = (keys) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in store) out[key] = store[key];
    return out;
  };
  return {
    store,
    get: async (keys) => pick(keys),
    set: async (items) => { Object.assign(store, JSON.parse(JSON.stringify(items))); },
    remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; },
  };
}

// `clock.local` is what Date.now() says; `clock.server` is what the server's
// Date header says, or null for offline.
function loadBackground(initial = {}) {
  const clock = { local: T0, server: T0 };
  const storage = memoryStorage({
    pblocker_settings: { enabled: true, safeSearchEnabled: true, customKeywordList: ['alpha'] },
    ...initial,
  });
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.local); }
    static now() { return clock.local; }
  }
  const ctx = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.Date = FakeDate;
    sandbox.TextEncoder = TextEncoder;
    sandbox.crypto = { getRandomValues: (a) => webcrypto.getRandomValues(a), subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-0000-0000-000000000000' };
    vm.runInContext(TOTP_SOURCE, sandbox, { filename: 'shared/totp.js' });
    vm.runInContext(PACT_SOURCE, sandbox, { filename: 'shared/pact.js' });
    sandbox.chrome.storage.local = storage;
    // Registered just above the Pact section; without it the rest of
    // background.js never runs in this harness.
    sandbox.chrome.storage.onChanged = { addListener() {} };
    sandbox.chrome.runtime.getURL = (p) => 'chrome-extension://blocknsfw/' + p;
    sandbox.chrome.alarms = {
      create() {}, get: async () => null, clear: async () => true, onAlarm: { addListener() {} },
    };
    const passThrough = sandbox.fetch;
    sandbox.fetch = (url, opts) => {
      if (url !== SERVER_TIME_URL) return passThrough(url, opts);
      if (clock.server === null) return Promise.reject(new Error('offline'));
      const header = new Date(clock.server).toUTCString();
      return Promise.resolve({ headers: { get: (name) => (String(name).toLowerCase() === 'date' ? header : null) } });
    };
  });
  return { ctx, storage, clock };
}

async function makePact(ctx, extra = {}) {
  await ctx.chrome.storage.local.set({ pblocker_pact: { active: true, delayMs: HOUR, createdAt: T0, ...extra } });
}

const settingsOf = (storage) => storage.store.pblocker_settings;
const queueOf = (storage) => storage.store.pblocker_pact_queue || [];

test('without a pact nothing is queued', async () => {
  const { ctx } = loadBackground();
  const reply = await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  assert.deepEqual({ ...reply }, { ok: false, error: 'no-pact' });
});

test('turning protection off waits out the pact, then happens', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  const reply = await ctx.pactEnqueue({ kind: 'disable', label: 'turn protection off', payload: {} });
  assert.equal(reply.ok, true);
  assert.equal(queueOf(storage).length, 1);

  clock.local = clock.server = T0 + 30 * MIN;
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, true, 'half way: still protected');

  clock.local = clock.server = T0 + 61 * MIN;
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, false);
  assert.equal(queueOf(storage).length, 0);
});

test('moving the system clock forward skips nothing', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  clock.local = T0 + 2 * 24 * HOUR; // the device says two days have passed
  clock.server = T0 + 5 * MIN;      // the server says five minutes
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, true);
  assert.equal(queueOf(storage).length, 1);
});

test('a night with the browser closed counts', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx, { delayMs: 24 * HOUR });
  await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  clock.local = clock.server = T0 + 25 * HOUR; // no ticks in between: the browser was closed
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, false);
});

test('offline, only time the browser was seen running counts', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  clock.server = null;
  await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  for (let minute = 1; minute <= 59; minute++) {
    clock.local = T0 + minute * MIN;
    await ctx.pactProcess();
  }
  assert.equal(settingsOf(storage).enabled, true, '59 minutes of running time');
  clock.local = T0 + 3 * HOUR; // a jump: earns nothing offline
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, true);
  clock.local += MIN;
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, false, 'the sixtieth minute');
});

test('a queued temporary whitelist starts its allowance when it applies', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  await ctx.pactEnqueue({ kind: 'whitelist-add', payload: { domain: 'example.com', path: null, type: 'temporary', durationMs: 15 * MIN } });
  clock.local = clock.server = T0 + 61 * MIN;
  await ctx.pactProcess();
  const [entry] = storage.store.pblocker_whitelist;
  assert.equal(entry.domain, 'example.com');
  assert.equal(entry.expiresAt, T0 + 61 * MIN + 15 * MIN);
});

test('asking for the same change twice does not start a second wait', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  clock.local = clock.server = T0 + 10 * MIN;
  const again = await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  assert.equal(again.existing, true);
  assert.equal(queueOf(storage).length, 1);
});

test('cancelling removes the change and nothing happens', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  const { entry } = await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  await ctx.pactCancel(entry.id);
  clock.local = clock.server = T0 + 2 * HOUR;
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).enabled, true);
});

test('settings changes apply by value, keeping words added while it waited', async () => {
  const { ctx, storage, clock } = loadBackground();
  await makePact(ctx);
  await ctx.pactEnqueue({ kind: 'settings', payload: { set: { safeSearchEnabled: false }, removeFrom: { customKeywordList: ['alpha'] } } });
  const settings = settingsOf(storage);
  await ctx.chrome.storage.local.set({ pblocker_settings: { ...settings, customKeywordList: ['alpha', 'beta'] } });
  clock.local = clock.server = T0 + 61 * MIN;
  await ctx.pactProcess();
  assert.equal(settingsOf(storage).safeSearchEnabled, false);
  assert.deepEqual(settingsOf(storage).customKeywordList, ['beta']);
});

test('a witness code lets a waiting change through at once, and only once', async () => {
  const secret = Totp.generateSecret();
  const { ctx, storage } = loadBackground();
  await makePact(ctx, { witness: { secret, pairedAt: T0, lastCounter: -1, recovery: [] } });
  const { entry } = await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  const code = await Totp.totp(secret, T0);
  const first = await ctx.pactApplyNow(entry.id, code);
  assert.equal(first.ok, true);
  assert.equal(settingsOf(storage).enabled, false);

  await ctx.chrome.storage.local.set({ pblocker_settings: { ...settingsOf(storage), enabled: true } });
  const second = await ctx.pactEnqueue({ kind: 'disable', payload: {} });
  const replay = await ctx.pactApplyNow(second.entry.id, code);
  assert.equal(replay.ok, false, 'the same code cannot skip a second wait');
  assert.equal(settingsOf(storage).enabled, true);
});

test('wrong witness codes lock out after five tries', async () => {
  const { ctx } = loadBackground();
  await makePact(ctx, { witness: { secret: Totp.generateSecret(), pairedAt: T0 } });
  let reply;
  for (let i = 0; i < 5; i++) reply = await ctx.pactCheckCode('000000');
  assert.equal(reply.locked, true);
  assert.equal(reply.waitMs, 5 * MIN);
});

test('ending a pact whose witness held the PIN clears the PIN too', async () => {
  const { ctx, storage, clock } = loadBackground({ pblocker_pin: { v: 1, salt: 'aa', hash: 'bb' } });
  await makePact(ctx, { pinSealed: true, witness: { secret: Totp.generateSecret(), pairedAt: T0 } });
  await ctx.pactEnqueue({ kind: 'pact', payload: { action: 'end' } });
  clock.local = clock.server = T0 + 61 * MIN;
  await ctx.pactProcess();
  assert.equal(storage.store.pblocker_pact, undefined);
  assert.equal(storage.store.pblocker_pin, undefined);
});

test('only the extension’s own pages may touch the queue', async () => {
  const { ctx } = loadBackground();
  await makePact(ctx);
  const [listener] = ctx.chrome.runtime.onMessage.listeners;
  const fromPage = await new Promise((resolve) => {
    listener({ type: 'pact_cancel', id: 'x' }, { url: 'https://example.com/' }, resolve);
  });
  assert.deepEqual({ ...fromPage }, { ok: false, error: 'not-allowed' });
  const fromSettings = await new Promise((resolve) => {
    listener({ type: 'pact_cancel', id: 'x' }, { url: 'chrome-extension://blocknsfw/options.html' }, resolve);
  });
  assert.equal(fromSettings.ok, true);
});
