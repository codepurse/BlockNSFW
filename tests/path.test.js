// The path: one page a day, a missed day waits, the first week is free.
const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('../shared/path.js');

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('a new path starts at day 1, free for everyone', () => {
  assert.equal(Path.available(undefined, at(2026, 10, 10)), 1);
  assert.equal(Path.canOpen(undefined, 1, at(2026, 10, 10), false), true);
  assert.equal(Path.canOpen(undefined, 2, at(2026, 10, 10), false), false);
});

test('one new page a day, and a missed day waits', () => {
  let s = Path.open(undefined, 1, at(2026, 10, 10, 9), false);
  assert.equal(Path.available(s, at(2026, 10, 10, 23)), 1, 'not twice in one day');
  assert.equal(Path.available(s, at(2026, 10, 11, 9)), 2);
  // Three days away: still day 2, not day 4.
  assert.equal(Path.available(s, at(2026, 10, 14, 9)), 2);
  s = Path.open(s, 2, at(2026, 10, 14, 9), false);
  assert.equal(Path.available(s, at(2026, 10, 14, 22)), 2);
  assert.equal(Path.available(s, at(2026, 10, 15, 9)), 3);
});

test('mornings start at 4 am: past midnight is still the night before', () => {
  const s = Path.open(undefined, 1, at(2026, 10, 10, 23), false);
  assert.equal(Path.available(s, at(2026, 10, 11, 1, 30)), 1);
  assert.equal(Path.available(s, at(2026, 10, 11, 4, 0)), 2);
  assert.equal(Path.dayOf(at(2026, 10, 11, 3, 59)), '2026-10-10');
});

test('days 8 to 30 need Supporter; day 7 and before never do', () => {
  let s;
  for (let n = 1; n <= 7; n++) s = Path.open(s, n, at(2026, 10, n, 9), false);
  assert.equal(Object.keys(s.opened).length, 7);
  const now = at(2026, 10, 8, 9);
  assert.equal(Path.available(s, now), 8);
  assert.equal(Path.locked(8, false), true);
  assert.equal(Path.canOpen(s, 8, now, false), false);
  assert.equal(Path.open(s, 8, now, false).opened[8], undefined);
  assert.equal(Path.canOpen(s, 8, now, true), true);
  assert.equal(Path.open(s, 8, now, true).opened[8], '2026-10-08');
  assert.equal(Path.locked(7, false), false);
});

test('a day can be read again, but its first day is kept', () => {
  let s = Path.open(undefined, 1, at(2026, 10, 10, 9), false);
  s = Path.open(s, 1, at(2026, 10, 12, 9), false);
  assert.equal(s.opened[1], '2026-10-10');
  assert.equal(Path.canOpen(s, 1, at(2026, 10, 12, 9), false), true);
});

test('done and lines only for days that were opened; a line marks it done', () => {
  let s = Path.open(undefined, 1, at(2026, 10, 10, 9), false);
  s = Path.markDone(s, 2, at(2026, 10, 10, 10));
  assert.equal(s.done[2], undefined);
  s = Path.setLine(s, 1, '  I want my   evenings back.  ', at(2026, 10, 10, 10));
  assert.equal(s.lines[1], 'I want my evenings back.');
  assert.equal(s.done[1], at(2026, 10, 10, 10));
  s = Path.setLine(s, 1, 'x'.repeat(500), at(2026, 10, 10, 11));
  assert.equal(s.lines[1].length, Path.LINE_MAX);
  s = Path.setLine(s, 1, '   ', at(2026, 10, 10, 12));
  assert.equal(s.lines[1], undefined);
});

test('the book is the lines in day order; starting again keeps them', () => {
  let s = { opened: { 1: '2026-10-01', 5: '2026-10-05', 3: '2026-10-03' }, done: {}, lines: { 5: 'five', 1: 'one', 3: 'three' } };
  assert.deepEqual(Path.book(s).map((b) => b.n), [1, 3, 5]);
  s = Path.restart(s);
  assert.deepEqual(s.opened, {});
  assert.equal(s.rounds, 1);
  assert.equal(Path.book(s).length, 3);
  assert.equal(Path.available(s, at(2026, 11, 1)), 1);
});

test('summary says which day, its title, and whether it is locked or finished', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ title: 'Day ' + (i + 1) }));
  let s;
  for (let n = 1; n <= 7; n++) s = Path.open(s, n, at(2026, 10, n, 9), false);
  const sum = Path.summary(s, at(2026, 10, 8, 9), false, days);
  assert.deepEqual([sum.day, sum.title, sum.locked, sum.opened], [8, 'Day 8', true, false]);
  const opened = {};
  const done = {};
  for (let n = 1; n <= 30; n++) { opened[n] = '2026-10-01'; done[n] = 1; }
  assert.equal(Path.summary({ opened, done }, at(2026, 11, 1), true, days).finished, true);
});

test('normalize drops anything that is not a day from 1 to 30', () => {
  const s = Path.normalize({ opened: { 0: '2026-10-01', 31: '2026-10-01', 2: 'soon', 3: '2026-10-03' }, done: { 3: 'x', 4: 5 }, lines: { 3: 42, 4: ' ok ' } });
  assert.deepEqual(s.opened, { 3: '2026-10-03' });
  assert.deepEqual(s.done, { 4: 5 });
  assert.deepEqual(s.lines, { 4: 'ok' });
});
