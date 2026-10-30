// Progress across computers (shared/progress.js) and the path's merge
// (shared/path.js). History stays per computer and is combined only when
// shown; a merge never makes the record look better than it was; what
// belongs to the person (path, check-ins, words) becomes one; and anything
// from outside (a backup, the browser's sync) is checked first.
const test = require('node:test');
const assert = require('node:assert/strict');
global.Moments = require('../shared/moments.js');
global.Gateways = require('../shared/gateways.js');
global.Ledger = require('../shared/ledger.js');
const Progress = require('../shared/progress.js');
const Path = require('../shared/path.js');
const { Moments, Ledger } = global;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 11, 15, 0).getTime();
const at = (daysAgo, hour = 12) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); };
const key = (daysAgo) => Ledger.dayKey(at(daysAgo));
const ID_A = 'd0123456789ab';
const ID_B = 'dabcdefabcdef';

function storeFor({ slips = [], kept = [], stops = [], off = [], ledger = {}, firstSeen = at(60) } = {}) {
  const audit = [];
  off.forEach(([from, to]) => { audit.push({ timestamp: from, enabled: false }); audit.push({ timestamp: to, enabled: true }); });
  return {
    [Ledger.KEY]: { days: ledger },
    [Moments.FIRST_SEEN_KEY]: firstSeen,
    [Moments.SLIPS_KEY]: slips,
    [Moments.KEPT_KEY]: { count: kept.length + 10, last: kept[kept.length - 1] || 0, times: kept },
    [Gateways.STOPS_KEY]: { total: stops.length + 4, byKey: {}, byHour: [], recent: stops.map((t) => ({ key: 'reddit', at: t })) },
    pblocker_audit_disabled: audit,
    pblocker_settings: { enabled: true },
    pblocker_daily_history: { [key(1)]: 3, [key(200)]: 9 }
  };
}

test('this computer gets an id once, and keeps it', async () => {
  const data = {};
  const storage = { get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => Object.assign(data, o) };
  const first = await Progress.deviceId(storage, NOW);
  assert.ok(Progress.validId(first));
  assert.equal(await Progress.deviceId(storage, NOW + 1), first);
  assert.notEqual(Progress.newId(), Progress.newId());
});

test('a snapshot carries the long record and only the last weeks of detail, and nothing about sites', () => {
  const s = Progress.snapshot(storeFor({
    stops: [at(2, 23), at(80, 23)], kept: [at(3, 22), at(90)], slips: [{ day: key(5), hour: 1, at: at(5, 1) }],
    off: [[at(4, 10), at(4, 11)], [at(70, 10), at(70, 11)]], ledger: { [key(100)]: { st: 'kept', g: 1, w: 0, x: 0, b: 2, h: [23] } }
  }), ID_A, NOW);
  assert.equal(s.id, ID_A);
  assert.deepEqual(s.stops, [at(2, 23)]);
  assert.deepEqual(s.kept, [at(3, 22)]);
  assert.equal(s.off.length, 1);
  assert.equal(s.slips.length, 1);
  assert.deepEqual(Object.keys(s.blocks), [key(1)], 'only the recent days held');
  assert.equal(s.ledger[key(100)].st, 'kept');
  assert.deepEqual(s.counts, { kept: 12, stops: 6 });
  assert.doesNotMatch(JSON.stringify(s), /reddit/, 'no site names travel');
});

test('anything from outside is checked: a bad id, odd numbers or junk are dropped', () => {
  assert.equal(Progress.normalizeSnapshot({ id: 'nope', at: NOW }), null);
  assert.equal(Progress.normalizeSnapshot({ id: ID_A }), null);
  const s = Progress.normalizeSnapshot({
    id: ID_A, at: NOW, label: '<b>x</b>'.repeat(30), off: [[5, 1], ['a', 2], [1, 9]], stops: [1, -2, 'x', 3],
    kept: 'nope', slips: [{ day: 'bad' }], blocks: { 'not-a-day': 4, [key(1)]: 2 }, ledger: { junk: 1, [key(2)]: { st: 'weird' } },
    counts: { kept: -4, stops: 2.7 }
  });
  assert.equal(s.label.length, 60);
  assert.deepEqual(s.off, [[1, 9]]);
  assert.deepEqual(s.stops, [1, 3]);
  assert.deepEqual(s.kept, []);
  assert.deepEqual(s.slips, []);
  assert.deepEqual(s.blocks, { [key(1)]: 2 });
  assert.deepEqual(s.ledger, {});
  assert.deepEqual(s.counts, { kept: 0, stops: 2 });
});

test('other computers: the newest of each kept, never this one, at most six', () => {
  const snap = (id, when) => ({ id, at: when });
  let r = Progress.mergeElsewhere({}, [snap(ID_B, 100), snap(ID_A, 200)], ID_A);
  assert.deepEqual(Object.keys(r.elsewhere), [ID_B], 'this computer is never kept beside itself');
  assert.equal(r.changed, true);
  r = Progress.mergeElsewhere(r.elsewhere, [snap(ID_B, 50)], ID_A);
  assert.equal(r.elsewhere[ID_B].at, 100, 'an older snapshot never replaces a newer one');
  assert.equal(r.changed, false);
  const many = Array.from({ length: 9 }, (_, i) => snap('d' + String(i).repeat(12), 1000 + i));
  r = Progress.mergeElsewhere({}, many, ID_A);
  assert.equal(Object.keys(r.elsewhere).length, Progress.MAX_ELSEWHERE);
  assert.ok(!r.elsewhere['d000000000000'], 'the oldest go first');
});

test('combined, a day is kept only if it was kept everywhere, and counts add up', () => {
  const a = { [key(3)]: { st: 'kept', g: 1, w: 0, x: 0, b: 2, h: [23] }, [key(4)]: { st: 'kept', g: 0, w: 0, x: 0, b: 0, h: [] } };
  const b = { [key(3)]: { st: 'broken', g: 0, w: 1, x: 1, b: 1, h: [1] }, [key(9)]: { st: 'kept', g: 0, w: 0, x: 0, b: 5, h: [] } };
  const days = Progress.combineDays(a, b);
  assert.deepEqual(days[key(3)], { st: 'broken', g: 1, w: 1, x: 1, b: 3, h: [1, 23] });
  assert.equal(days[key(4)].st, 'kept');
  assert.equal(days[key(9)].b, 5);
});

test('days kept in the last 30 count a slip or time unprotected on another computer', () => {
  const other = Progress.snapshot(storeFor({ slips: [{ day: key(2), hour: 1, at: at(2, 1) }], off: [[at(5, 9), at(5, 10)]], firstSeen: at(200) }), ID_B, NOW);
  const others = Progress.others({ [ID_B]: other });
  const here = { now: NOW, firstSeen: at(10), slips: [], disabledLog: [], currentlyEnabled: true };
  const alone = Moments.daysKept(here);
  assert.equal(alone.kept, 11);
  assert.equal(alone.counted, 11);
  const both = Moments.daysKept({ ...here, others });
  assert.equal(both.counted, 30, 'the earliest first day counts');
  assert.equal(both.kept, 28, 'two days lost elsewhere are lost here too');
});

test('sources for showing add the others, and leave this computer\'s own untouched', () => {
  const own = { firstSeen: at(10), slips: [], off: [], stops: [{ key: 'x', at: at(1) }], kept: [], blocks: { [key(1)]: 2 } };
  const copy = JSON.stringify(own);
  const others = Progress.others({ [ID_B]: Progress.snapshot(storeFor({ stops: [at(2)], kept: [at(3)], firstSeen: at(50) }), ID_B, NOW) });
  const s = Progress.combineSources(own, others);
  assert.equal(s.firstSeen, at(50));
  assert.equal(s.stops.length, 2);
  assert.equal(s.kept.length, 1);
  assert.equal(s.blocks[key(1)], 5);
  assert.equal(JSON.stringify(own), copy);
  // Nothing else: the sources pass through as they were.
  assert.equal(Progress.combineSources(own, null), own);
});

test('check-ins from two computers: one a day, the one answered last, and hard stays hard', () => {
  const merged = Progress.mergeCheckins(
    [{ day: '2026-10-01', a: { sleep: 0, mood: 2 }, at: 10, hard: true }, { day: '2026-10-02', a: { sleep: 1 }, at: 5 }],
    [{ day: '2026-10-01', a: { sleep: 2 }, at: 20, hard: false }, { day: '2026-10-03', a: { moved: 2 }, at: 7 }, { day: 'x', a: { sleep: 1 } }, { day: '2026-10-04', a: {} }]
  );
  assert.deepEqual(merged.map((e) => e.day), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(merged[0].a.sleep, 2, 'the later answer');
  assert.equal(merged[0].hard, true, 'hard on either is hard');
  assert.equal(merged[1].a.stress, null);
});

test('your own words: the ones here, unless there are none here yet', () => {
  const there = { plan: 'Go for a walk.', note: '', person: { name: 'Sam', phone: '' } };
  assert.equal(Progress.mergeWords({}, there).plan, 'Go for a walk.');
  assert.equal(Progress.mergeWords({ plan: 'Mine.' }, there).plan, 'Mine.');
});

test('the path from two computers: earliest opened and done, the later round decides, the newest line wins', () => {
  const a = { opened: { 1: '2026-10-01', 2: '2026-10-03' }, done: { 1: 100 }, lines: { 1: 'old', 2: 'kept' }, edited: { 1: 10 }, rounds: 0 };
  const b = { opened: { 1: '2026-10-02', 2: '2026-10-02', 3: '2026-10-04' }, done: { 1: 50, 2: 70 }, lines: { 1: 'new' }, edited: { 1: 20 }, rounds: 0 };
  const m = Path.merge(a, b);
  assert.deepEqual(m.opened, { 1: '2026-10-01', 2: '2026-10-02', 3: '2026-10-04' });
  assert.deepEqual(m.done, { 1: 50, 2: 70 });
  assert.deepEqual(m.lines, { 1: 'new', 2: 'kept' });
  assert.deepEqual(Path.merge(a, b), Path.merge(b, a), 'both computers agree');
  // Starting again on one computer is kept.
  const again = Path.merge(a, { opened: { 1: '2026-10-09' }, done: {}, lines: {}, rounds: 1 });
  assert.deepEqual(again.opened, { 1: '2026-10-09' });
  assert.deepEqual(again.lines, { 1: 'old', 2: 'kept' }, 'the lines stay when starting again');
  // A line cleared last stays cleared.
  const cleared = Path.setLine({ opened: { 1: '2026-10-01' }, lines: { 1: 'x' }, edited: { 1: 5 } }, 1, '', 99);
  assert.deepEqual(Path.merge(cleared, { opened: { 1: '2026-10-01' }, lines: { 1: 'x' }, edited: { 1: 5 } }).lines, {});
});
