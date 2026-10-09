// The Pact only means something if its wait can't be skipped. Most of these
// tests are about time: moving the system clock, closing the laptop, going
// offline. The rest pin down how queued changes are applied.
const test = require('node:test');
const assert = require('node:assert/strict');
const Pact = require('../shared/pact.js');
const Totp = require('../shared/totp.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 8, 20, 0, 0);

// A one-hour "turn protection off" request made at T0. `serverStart` is the
// server time it was asked at (null when offline).
function entry({ serverStart = T0, fields = {} } = {}) {
  const change = { kind: 'disable', label: 'turn protection off', payload: {} };
  return Object.assign(Pact.makeEntry(change, HOUR, T0, serverStart), fields);
}

test('normalizePact: nothing stored means no pact', () => {
  assert.equal(Pact.normalizePact(undefined), null);
  assert.equal(Pact.normalizePact({ active: false }), null);
  assert.equal(Pact.isActive(Pact.normalizePact(undefined)), false);
});

test('normalizePact: an unknown delay falls back to an hour, and a sealed PIN needs a witness', () => {
  const pact = Pact.normalizePact({ active: true, delayMs: 5, pinSealed: true });
  assert.equal(pact.delayMs, HOUR);
  assert.equal(pact.pinSealed, false);
  const withWitness = Pact.normalizePact({ active: true, delayMs: 24 * HOUR, pinSealed: true, witness: { secret: 'ABC' } });
  assert.equal(withWitness.pinSealed, true);
  assert.equal(withWitness.witness.lastCounter, -1);
});

test('makeEntry keeps the delay in force when the change was asked for', () => {
  const e = Pact.makeEntry({ kind: 'whitelist-add', label: 'whitelist example.com', payload: { domain: 'example.com' } }, 24 * HOUR, T0, null);
  assert.equal(e.delayMs, 24 * HOUR);
  assert.equal(e.requestedAtServer, null);
  assert.equal(e.runMs, 0);
  assert.equal(Pact.makeEntry({ kind: 'not-a-kind' }, HOUR, T0, T0), null);
});

test('tick credits running time in small steps', () => {
  let state = { clock: { lastTick: T0 }, queue: [entry()] };
  for (let i = 1; i <= 60; i++) state = Pact.tick(state.clock, state.queue, T0 + i * MIN);
  assert.equal(state.queue[0].runMs, 60 * MIN);
});

test('tick credits nothing for a jump forward in the system clock', () => {
  const first = Pact.tick({ lastTick: T0 }, [entry()], T0 + 24 * HOUR);
  assert.equal(first.credit, 0);
  assert.equal(first.queue[0].runMs, 0);
  assert.equal(Pact.isReady(first.queue[0], null), false, 'offline, the jump earned nothing');
});

test('tick credits nothing when the clock goes backwards', () => {
  const back = Pact.tick({ lastTick: T0 }, [entry()], T0 - HOUR);
  assert.equal(back.credit, 0);
});

test('with the server clock, the wait is wall time: a night with the laptop shut counts', () => {
  const e = entry({ serverStart: T0 });
  assert.equal(Pact.isReady(e, T0 + 59 * MIN), false);
  assert.equal(Pact.isReady(e, T0 + 60 * MIN), true);
});

test('with the server clock, moving the system clock changes nothing', () => {
  // The device says a day has passed; the server says five minutes.
  const ticked = Pact.tick({ lastTick: T0 }, [entry({ serverStart: T0 })], T0 + 24 * HOUR);
  assert.equal(Pact.isReady(ticked.queue[0], T0 + 5 * MIN), false);
});

test('offline, only running time counts', () => {
  const e = entry({ serverStart: null, fields: { requestedAtServer: null, runMs: 59 * MIN } });
  assert.equal(Pact.isReady(e, null), false);
  assert.equal(Pact.isReady({ ...e, runMs: 60 * MIN }, null), true);
});

test('backfill gives an offline request a server start that never overstates the wait', () => {
  const e = { ...entry(), requestedAtServer: null, runMs: 20 * MIN };
  const [filled] = Pact.backfill([e], T0 + 5 * HOUR);
  assert.equal(filled.requestedAtServer, T0 + 5 * HOUR - 20 * MIN);
  assert.equal(Pact.isReady(filled, T0 + 5 * HOUR), false, 'only the 20 minutes it was seen to run count');
  assert.equal(Pact.isReady(filled, T0 + 5 * HOUR + 40 * MIN), true);
});

test('remainingMs counts down from the estimated server time', () => {
  const e = entry({ serverStart: T0 });
  const clock = { offset: 0, offsetAt: T0 };
  assert.equal(Pact.remainingMs(e, clock, T0 + 15 * MIN), 45 * MIN);
  assert.equal(Pact.remainingMs(e, clock, T0 + 2 * HOUR), 0);
});

test('needsServerCheck: only while something is waiting', () => {
  assert.equal(Pact.needsServerCheck([], { offset: 0, offsetAt: T0 }, T0), false);
  assert.equal(Pact.needsServerCheck([entry()], { offset: null }, T0), true);
  assert.equal(Pact.needsServerCheck([entry({ serverStart: T0 })], { offset: 0, offsetAt: T0 }, T0 + MIN), false);
  assert.equal(Pact.needsServerCheck([entry({ serverStart: T0 })], { offset: 0, offsetAt: T0 }, T0 + 58 * MIN), true, 'nearly due');
});

test('applySettingsOps: set, remove and add, keeping what was added while it waited', () => {
  const settings = { dnsFilterEnabled: true, customKeywordList: ['alpha', 'Beta', 'gamma'], trustedImageDomains: ['a.com'] };
  const next = Pact.applySettingsOps(settings, {
    set: { dnsFilterEnabled: false },
    removeFrom: { customKeywordList: ['beta'] },
    addTo: { trustedImageDomains: ['b.com', 'A.com'] },
  });
  assert.equal(next.dnsFilterEnabled, false);
  assert.deepEqual(next.customKeywordList, ['alpha', 'gamma']);
  assert.deepEqual(next.trustedImageDomains, ['a.com', 'b.com']);
  assert.deepEqual(settings.customKeywordList, ['alpha', 'Beta', 'gamma'], 'the input is not mutated');
});

test('addWhitelistEntry: a temporary allowance starts when it is applied, not when asked', () => {
  const applyAt = T0 + 24 * HOUR;
  const list = Pact.addWhitelistEntry([], { domain: 'example.com', type: 'temporary', durationMs: 15 * MIN }, applyAt);
  assert.deepEqual(list, [{ domain: 'example.com', path: null, type: 'temporary', addedAt: applyAt, expiresAt: applyAt + 15 * MIN }]);
  const again = Pact.addWhitelistEntry(list, { domain: 'example.com', type: 'permanent' }, applyAt + MIN);
  assert.equal(again.length, 1);
  assert.equal(again[0].type, 'permanent');
});

test('checkWitnessCode: a current code passes once, then is spent', async () => {
  const secret = Totp.generateSecret();
  const pact = Pact.normalizePact({ active: true, witness: { secret } });
  const code = await Totp.totp(secret, T0);
  const first = await Pact.checkWitnessCode(pact, code, [T0], Totp);
  assert.equal(first.ok, true);
  assert.equal(first.via, 'code');
  const spent = { ...pact, witness: first.witness };
  assert.equal((await Pact.checkWitnessCode(spent, code, [T0], Totp)).ok, false);
});

test('checkWitnessCode: a recovery code passes once', async () => {
  const [code] = Totp.generateRecoveryCodes(1);
  const pact = Pact.normalizePact({ active: true, witness: { secret: Totp.generateSecret(), recovery: [{ hash: await Totp.hashRecoveryCode(code) }] } });
  assert.equal(Pact.recoveryLeft(pact), 1);
  const first = await Pact.checkWitnessCode(pact, code.toLowerCase(), [T0], Totp);
  assert.equal(first.ok, true);
  assert.equal(first.via, 'recovery');
  const spent = { ...pact, witness: first.witness };
  assert.equal(Pact.recoveryLeft(spent), 0);
  assert.equal((await Pact.checkWitnessCode(spent, code, [T0], Totp)).ok, false);
});

test('checkWitnessCode: no witness, no way through', async () => {
  const pact = Pact.normalizePact({ active: true });
  assert.equal((await Pact.checkWitnessCode(pact, '123456', [T0], Totp)).ok, false);
});

test('code lockout: five tries, then five minutes, doubling to an hour', () => {
  let raw = null;
  for (let i = 0; i < 4; i++) raw = Pact.afterCodeFailure(raw, T0);
  assert.equal(Pact.codeLockState(raw, T0).locked, false);
  raw = Pact.afterCodeFailure(raw, T0);
  assert.equal(Pact.codeLockState(raw, T0).waitMs, 5 * MIN);
  for (let i = 0; i < 10; i++) raw = Pact.afterCodeFailure(raw, T0);
  assert.equal(Pact.codeLockState(raw, T0).waitMs, HOUR);
});

test('formatRemaining and formatDelay say it plainly', () => {
  assert.equal(Pact.formatRemaining(30 * 1000), 'under a minute');
  assert.equal(Pact.formatRemaining(52 * MIN), '52 min');
  assert.equal(Pact.formatRemaining(3 * HOUR + 5 * MIN), '3 h 5 min');
  assert.equal(Pact.formatRemaining(50 * HOUR), '2 d 2 h');
  assert.deepEqual(Pact.DELAYS.map(Pact.formatDelay), ['15 minutes', '1 hour', '24 hours', '3 days']);
  assert.equal(Pact.sentenceCase('turn protection off'), 'Turn protection off');
});

test('looksLikeWitnessCode: six digits or a recovery code, not a PIN-shaped guess', () => {
  assert.equal(Pact.looksLikeWitnessCode('287082'), true);
  assert.equal(Pact.looksLikeWitnessCode('287 082'), true);
  assert.equal(Pact.looksLikeWitnessCode('ACDE-FG34'), true);
  assert.equal(Pact.looksLikeWitnessCode('acdefg34'), true);
  assert.equal(Pact.looksLikeWitnessCode('2468'), false);
  assert.equal(Pact.looksLikeWitnessCode('12345678'), true, 'eight digits fits the recovery shape; the background decides');
  assert.equal(Pact.looksLikeWitnessCode('my pin!'), false);
  assert.equal(Pact.looksLikeWitnessCode(''), false);
});
