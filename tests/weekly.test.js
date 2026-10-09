// Your week: which week, what happened in it, and how it's said.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../shared/weekly.js');
const Moments = require('../shared/moments.js');

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const MON = 1;
// The week of Monday 5 to Sunday 11 October 2026.
const START = at(2026, 10, 5, 0);

function sampleWeek(extra = {}) {
  return {
    now: at(2026, 10, 11, 19),
    firstSeen: at(2026, 9, 1),
    stops: [
      { key: 'reddit', at: at(2026, 10, 5, 23, 20) },
      { key: 'reddit', at: at(2026, 10, 8, 23, 42) },
      { key: 'instagram-explore', at: at(2026, 10, 9, 22, 58) },
      { key: 'reddit', at: at(2026, 10, 10, 23, 5) },
      { key: 'reddit', at: at(2026, 10, 4, 23, 0) } // the Sunday before
    ],
    kept: [at(2026, 10, 6, 23, 50), at(2026, 10, 10, 0, 10)],
    slips: Moments.normalizeSlips([{ day: '2026-10-07', hour: 23, tags: ['tired'], start: 'x-search', at: at(2026, 10, 7, 23, 40) }]),
    off: [],
    ...extra
  };
}

test('a week starts on the locale’s first day, and is ready on its last evening', () => {
  assert.equal(W.weekStart(at(2026, 10, 9, 15), MON), START);
  assert.equal(W.weekStart(at(2026, 10, 9, 15), 0), at(2026, 10, 4, 0), 'a Sunday-first locale');
  assert.equal(W.readyAt(START), at(2026, 10, 11, 18));
  assert.equal(W.latestReady(at(2026, 10, 11, 17, 59), MON), at(2026, 9, 28, 0), 'before Sunday 6 pm, last week');
  assert.equal(W.latestReady(at(2026, 10, 11, 18), MON), START);
  assert.equal(W.dayKey(START), '2026-10-05');
  assert.equal(W.parseKey('2026-10-05'), START);
  assert.equal(W.parseKey('2026-02-31'), null);
});

test('the popup marks a ready week new until it is opened', () => {
  const now = at(2026, 10, 11, 20);
  assert.equal(W.hasNew(now, MON, undefined, at(2026, 9, 1)), true);
  assert.equal(W.hasNew(now, MON, '2026-10-05', at(2026, 9, 1)), false);
  assert.equal(W.hasNew(now, MON, '2026-09-28', at(2026, 9, 1)), true);
  assert.equal(W.hasNew(now, MON, undefined, at(2026, 10, 11, 9)), false, 'installed this morning: nothing to tell yet');
});

test('the weeks on offer run from the first one seen, at most four back, to this one', () => {
  const now = at(2026, 10, 9, 15);
  assert.deepEqual(W.range(now, MON, at(2026, 1, 1)), { oldest: at(2026, 9, 7, 0), newest: START });
  assert.deepEqual(W.range(now, MON, at(2026, 10, 1)), { oldest: at(2026, 9, 28, 0), newest: START });
});

test('a week gathers its own stops, waits and slips, day by day', () => {
  const week = W.collect(sampleWeek(), START);
  assert.equal(week.stops, 4);
  assert.equal(week.kept, 2);
  assert.equal(week.slips, 1);
  assert.deepEqual(week.days.map((d) => d.status), ['kept', 'kept', 'broken', 'kept', 'kept', 'kept', 'kept']);
  assert.deepEqual(week.days.map((d) => d.events.length), [1, 1, 1, 1, 1, 2, 0]);
  assert.equal(week.daysKept, 6);
  assert.equal(week.daysCounted, 7);
});

test('days not yet here, and days before the extension, are not counted', () => {
  const week = W.collect(sampleWeek({ now: at(2026, 10, 8, 9), firstSeen: at(2026, 10, 6, 15) }), START);
  assert.deepEqual(week.days.map((d) => d.status), ['before', 'kept', 'broken', 'kept', 'ahead', 'ahead', 'ahead']);
  assert.equal(week.daysCounted, 3);
});

test('protection off for part of a day breaks that day', () => {
  const week = W.collect(sampleWeek({ slips: [], off: [[at(2026, 10, 9, 10), at(2026, 10, 9, 11)]] }), START);
  assert.equal(week.days[4].status, 'broken');
  assert.equal(week.daysKept, 6);
});

test('the week is told in plain words, the slip included', () => {
  const week = W.collect(sampleWeek(), START);
  const told = W.tell(week, { risk: { enabled: true, start: 23 * 60, end: 2 * 60 }, gatewaysOn: ['reddit'], names: { 'x-search': 'X search and Explore' }, format: (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` });
  assert.equal(told.headline, 'Four times at the door. Four times you turned back.');
  assert.equal(told.lede, 'Wednesday was hard. You came back, and on Thursday you stopped at the door again.');
  assert.equal(told.closing, 'A good week. Thank you for showing up for it.');
  assert.equal(told.suggestion.kind, 'risk');
  assert.deepEqual(told.suggestion.risk, { enabled: true, start: 22 * 60 + 30, end: 2 * 60 });
  assert.equal(told.suggestion.text, 'Six of your seven hard moments came between 23:00 and 1:00. Start your risk hours at 22:30, before it begins.');
});

test('risk hours are only ever widened, never moved or shortened', () => {
  const week = W.collect(sampleWeek(), START);
  const names = { 'x-search': 'X search and Explore' };
  const covered = W.tell(week, { risk: { enabled: true, start: 21 * 60, end: 3 * 60 }, names });
  assert.equal(covered.suggestion.kind, 'gateway', 'already covered: the next suggestion instead');
  assert.equal(covered.suggestion.id, 'x-search');
  const morning = W.tell(week, { risk: { enabled: true, start: 6 * 60, end: 9 * 60 }, names, gatewaysOn: ['x-search'] });
  assert.equal(morning.suggestion, null, 'stretching a morning window to night would be far too long');
  const off = W.tell(week, { risk: { enabled: false, start: 0, end: 0 } });
  assert.deepEqual(off.suggestion.risk, { enabled: true, start: 22 * 60 + 30, end: 2 * 60 });
  assert.equal(off.suggestion.label, 'Set risk hours');
  assert.equal(W.covers({ enabled: true, start: 1350, end: 120 }, { enabled: true, start: 1380, end: 120 }), true);
  assert.equal(W.covers({ enabled: true, start: 1380, end: 60 }, { enabled: true, start: 1380, end: 120 }), false);
});

test('quiet weeks, hard weeks and weeks in progress', () => {
  const quiet = W.collect(sampleWeek({ stops: [], kept: [], slips: [] }), START);
  assert.deepEqual(W.tell(quiet, {}), {
    headline: 'A quiet week.',
    lede: 'Protection was on every day, and nothing pulled hard enough to count.',
    closing: 'A quiet week. Thank you for keeping it that way.',
    suggestion: null
  });
  const hard = W.collect(sampleWeek({
    stops: [], kept: [],
    slips: Moments.normalizeSlips([{ day: '2026-10-06', hour: 1 }, { day: '2026-10-08', hour: 2 }, { day: '2026-10-09', hour: 1 }])
  }), START);
  const told = W.tell(hard, {});
  assert.equal(told.headline, 'A hard week.');
  assert.equal(told.lede, 'Three hard days. A slip costs a day, not the count, and you’re still here.');
  assert.equal(told.closing, 'Not an easy week. Thank you for still being here.');
  const one = W.collect(sampleWeek({ stops: [{ key: 'reddit', at: at(2026, 10, 6, 23) }], kept: [], slips: [] }), START);
  assert.equal(W.tell(one, { partial: true }).headline, 'Once at the door, and you turned back.');
  assert.equal(W.tell(one, { partial: true }).closing, 'So far, so good. Thank you for showing up.');
  const sameDay = W.collect(sampleWeek({ slips: Moments.normalizeSlips([{ day: '2026-10-08', hour: 1, at: at(2026, 10, 8, 1, 5) }]) }), START);
  assert.equal(W.tell(sameDay, {}).lede, 'Thursday was hard. Later that day you stopped at the door again.');
  const waits = W.collect(sampleWeek({ stops: [], slips: [] }), START);
  assert.equal(W.tell(waits, {}).headline, 'Two hard moments, and you waited out every one.');
});
