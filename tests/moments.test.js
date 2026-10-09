// Own Words, slips and Days Kept. Days Kept is the number people will look at
// the morning after a slip, so its counting is pinned down carefully.
const test = require('node:test');
const assert = require('node:assert/strict');
const Moments = require('../shared/moments.js');

const DAY = 24 * 60 * 60 * 1000;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 10, 9, 21);

test('normalizeWords trims, caps lengths and tells empty from set', () => {
  const words = Moments.normalizeWords({ plan: '  Walk to the kitchen.  ', note: 'x'.repeat(2000), person: { name: ' Sam ', phone: '+1 555 0100' } });
  assert.equal(words.plan, 'Walk to the kitchen.');
  assert.equal(words.note.length, Moments.LIMITS.note);
  assert.equal(words.person.name, 'Sam');
  assert.equal(Moments.hasWords(words), true);
  assert.equal(Moments.hasWords(undefined), false);
  assert.equal(Moments.hasWords({ plan: '   ' }), false);
});

test('telHref only for something that is plainly a phone number', () => {
  assert.equal(Moments.telHref('+1 (555) 010-0100'), 'tel:+15550100100');
  assert.equal(Moments.telHref('0917 123 4567'), 'tel:09171234567');
  assert.equal(Moments.telHref('call me'), '');
  assert.equal(Moments.telHref('javascript:alert(1)'), '');
  assert.equal(Moments.telHref('123'), '');
});

test('kept moments count up', () => {
  const once = Moments.addKept(undefined, NOW);
  assert.deepEqual(Moments.addKept(once, NOW + 1), { count: 2, last: NOW + 1, times: [NOW, NOW + 1] });
});

test('kept moments remember the last five weeks of times, and the whole count', () => {
  let kept = { count: 40, last: NOW - 60 * DAY };
  kept = Moments.addKept(kept, NOW - 40 * DAY);
  kept = Moments.addKept(kept, NOW - 2 * DAY);
  kept = Moments.addKept(kept, NOW);
  assert.equal(kept.count, 43);
  assert.deepEqual(kept.times, [NOW - 2 * DAY, NOW], 'older than five weeks drops');
  assert.deepEqual(Moments.normalizeKept({ count: 1, times: ['x', -1, 5, 3] }).times, [3, 5]);
});

test('a slip is recorded as one day, with only known tags', () => {
  const slips = Moments.addSlip([], { tags: ['tired', 'tired', 'nonsense'], helped: ['wait'] }, NOW);
  assert.deepEqual(slips, [{ day: '2026-10-09', hour: 21, tags: ['tired'], helped: ['wait'], start: null, at: NOW }]);
});

test('suggestedRiskHours: an hour before the slip to two after, across midnight', () => {
  assert.deepEqual(Moments.suggestedRiskHours(23), { enabled: true, start: 22 * 60, end: 1 * 60 });
  assert.deepEqual(Moments.suggestedRiskHours(0), { enabled: true, start: 23 * 60, end: 2 * 60 });
});

test('days kept: a new install counts only its own days', () => {
  assert.deepEqual(Moments.daysKept({ now: NOW, firstSeen: at(2026, 10, 7), slips: [], disabledLog: [], currentlyEnabled: true }), { kept: 3, counted: 3 });
});

test('days kept: one slip costs one day, not the month', () => {
  const slips = Moments.addSlip([], { tags: ['late'] }, at(2026, 10, 5, 23));
  const result = Moments.daysKept({ now: NOW, firstSeen: at(2026, 8, 1), slips, disabledLog: [], currentlyEnabled: true });
  assert.deepEqual(result, { kept: 29, counted: 30 });
});

test('days kept: protection off overnight breaks both days it touched', () => {
  const log = [
    { enabled: false, timestamp: at(2026, 10, 3, 23) },
    { enabled: true, timestamp: at(2026, 10, 4, 1) },
  ];
  assert.equal(Moments.daysKept({ now: NOW, firstSeen: at(2026, 8, 1), slips: [], disabledLog: log, currentlyEnabled: true }).kept, 28);
});

test('days kept: protection off right now breaks today', () => {
  const log = [{ enabled: false, timestamp: at(2026, 10, 9, 8) }];
  assert.equal(Moments.daysKept({ now: NOW, firstSeen: at(2026, 8, 1), slips: [], disabledLog: log, currentlyEnabled: false }).kept, 29);
});

test('days kept: a log that opens with "turned on" only costs that day', () => {
  const log = [{ enabled: true, timestamp: at(2026, 10, 2, 9) }];
  assert.equal(Moments.daysKept({ now: NOW, firstSeen: at(2026, 8, 1), slips: [], disabledLog: log, currentlyEnabled: true }).kept, 29);
});

test('a slip can say where it started, one place or none', () => {
  const slips = Moments.addSlip([], { tags: [], helped: [], hour: 23, at: NOW, start: 'instagram-explore' }, NOW);
  assert.equal(slips[0].start, 'instagram-explore');
  assert.equal(Moments.addSlip([], { start: 'not-a-place', at: NOW }, NOW)[0].start, null);
  assert.ok(Moments.SLIP_STARTS.some((s) => s.id === 'other'));
});
