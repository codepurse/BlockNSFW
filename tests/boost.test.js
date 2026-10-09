// Storm Mode and Risk Hours. The parts that matter: a boost really does raise
// every setting it names, it can't be shortened by moving the clock, Risk
// Hours wrap midnight correctly, and ending a boost gives the user back their
// own settings (but never switches protection off).
const test = require('node:test');
const assert = require('node:assert/strict');
const Boost = require('../shared/boost.js');

const HOUR = 60 * 60 * 1000;
const T0 = new Date(2026, 9, 9, 21, 0, 0).getTime(); // 21:00 local

test('startStorm: only the offered lengths, and pressing again can only extend', () => {
  const four = Boost.startStorm(null, 4, T0, T0);
  assert.equal(four.durationMs, 4 * HOUR);
  assert.equal(Boost.startStorm(null, 7, T0, T0).durationMs, HOUR, 'an unknown length falls back to an hour');
  const shorter = Boost.startStorm(four, 1, T0 + HOUR, T0 + HOUR);
  assert.deepEqual(shorter, four, 'one hour from now ends before the four-hour storm does');
  const longer = Boost.startStorm(four, 12, T0 + HOUR, T0 + HOUR);
  assert.equal(longer.durationMs, 12 * HOUR);
});

test('stormOver: the server clock decides, so moving the computer clock ends nothing', () => {
  const storm = Boost.startStorm(null, 1, T0, T0);
  assert.equal(Boost.stormOver(storm, T0 + 24 * HOUR, T0 + 10 * 60 * 1000), false);
  assert.equal(Boost.stormOver(storm, T0 + HOUR, T0 + HOUR), true);
});

test('stormOver: offline, a storm that began online runs into its grace period', () => {
  const storm = Boost.startStorm(null, 1, T0, T0);
  assert.equal(Boost.stormOver(storm, T0 + 2 * HOUR, null), false);
  assert.equal(Boost.stormOver(storm, T0 + HOUR + Boost.OFFLINE_GRACE, null), true, 'and it still ends');
});

test('Risk Hours wrap midnight', () => {
  const risk = { enabled: true, start: 23 * 60, end: 2 * 60 };
  const at = (h, m = 0) => new Date(2026, 9, 9, h, m);
  assert.equal(Boost.inRiskHours(risk, at(22, 59)), false);
  assert.equal(Boost.inRiskHours(risk, at(23, 0)), true);
  assert.equal(Boost.inRiskHours(risk, at(1, 30)), true);
  assert.equal(Boost.inRiskHours(risk, at(2, 0)), false);
  assert.equal(Boost.riskEndsAt(risk, at(23, 30)), new Date(2026, 9, 10, 2, 0).getTime());
  assert.equal(Boost.nextRiskChange(risk, at(12, 0)), new Date(2026, 9, 9, 23, 0).getTime());
  assert.equal(Boost.nextRiskChange(risk, at(23, 30)), new Date(2026, 9, 10, 2, 0).getTime());
});

test('Risk Hours: off, or an empty window, never applies', () => {
  assert.equal(Boost.inRiskHours({ enabled: false, start: 0, end: 600 }, new Date(2026, 9, 9, 5)), false);
  assert.equal(Boost.normalizeRisk({ enabled: true, start: 60, end: 60 }).enabled, false);
  assert.equal(Boost.nextRiskChange({ enabled: false }, new Date(T0)), null);
});

test('desired: a storm wins over Risk Hours', () => {
  const risk = { enabled: true, start: 20 * 60, end: 23 * 60 };
  assert.equal(Boost.desired(null, risk, T0, T0).kind, 'risk');
  const storm = Boost.startStorm(null, 1, T0, T0);
  assert.equal(Boost.desired(storm, risk, T0, T0).kind, 'storm');
  assert.equal(Boost.desired(null, { enabled: false }, T0, T0), null);
});

test('overlay raises every setting a storm names, and remembers what they were', () => {
  const mine = { enabled: false, aiStrictness: 'relaxed', safeSearchEnabled: true, dnsFilterEnabled: true };
  const { settings, snapshot } = Boost.overlay(mine, 'storm');
  for (const [key, value] of Object.entries(Boost.STORM_SETTINGS)) assert.equal(settings[key], value, key);
  assert.equal(settings.dnsFilterEnabled, true, 'keys a storm does not name are left alone');
  assert.equal(snapshot.aiStrictness, 'relaxed');
  assert.equal('safeSearchEnabled' in snapshot, false, 'unchanged keys are not recorded');
});

test('restore gives the user their settings back, but never turns protection off', () => {
  const mine = { enabled: false, aiStrictness: 'relaxed', aiImageBlocker: false };
  const boosted = Boost.overlay(mine, 'storm');
  const back = Boost.restore(boosted.settings, boosted.snapshot, 'storm');
  assert.equal(back.aiStrictness, 'relaxed');
  assert.equal(back.aiImageBlocker, false);
  assert.equal(back.enabled, true);
});

test('restore leaves a value the user changed during the boost', () => {
  const boosted = Boost.overlay({ imageFilterLevel: 'lenient' }, 'risk');
  const changed = { ...boosted.settings, imageFilterLevel: 'moderate' };
  assert.equal(Boost.restore(changed, boosted.snapshot, 'risk').imageFilterLevel, 'moderate');
});

test('refusal names the boost and when it ends', () => {
  const storm = Boost.refusal({ active: 'storm', until: T0 + HOUR }, T0);
  assert.match(storm, /^Storm Mode is on until .+\. Nothing that loosens protection can be changed until then\.$/);
  assert.match(Boost.refusal({ active: 'risk', until: T0 + HOUR }, T0), /^Your risk hours run until /);
  assert.equal(Boost.normalizeState({ active: 'nope' }), null);
});
