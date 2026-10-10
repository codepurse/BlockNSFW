// The long record (shared/ledger.js): one line per day, written while the
// detail behind it is still all there, kept for 400 days.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ledger = require('../shared/ledger.js');
const Moments = require('../shared/moments.js');
const Gateways = require('../shared/gateways.js');

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 20, 9);

function sources(extra = {}) {
  return {
    firstSeen: at(2026, 9, 1, 8),
    slips: [],
    off: [],
    stops: [],
    kept: [],
    blocks: {},
    ...extra
  };
}

test('a day: its counts, the hours of its hard moments, and whether it was kept', () => {
  const s = sources({
    stops: [{ at: at(2026, 10, 15, 23, 10) }, { at: at(2026, 10, 15, 23, 40) }, { at: at(2026, 10, 16, 0, 5) }],
    kept: [at(2026, 10, 15, 22)],
    blocks: { '2026-10-15': 7 }
  });
  assert.deepEqual(Ledger.summarize(s, at(2026, 10, 15, 0)), { st: 'kept', g: 2, w: 1, x: 0, b: 7, h: [22, 23, 23] });
  assert.deepEqual(Ledger.summarize(s, at(2026, 10, 16, 0)).h, [0], 'midnight belongs to the next day');
});

test('a slip, or protection off for part of a day, breaks it', () => {
  const slips = Moments.normalizeSlips([{ day: '2026-10-12', hour: 1, at: at(2026, 10, 12, 1) }]);
  assert.deepEqual(Ledger.summarize(sources({ slips }), at(2026, 10, 12, 0)), { st: 'broken', g: 0, w: 0, x: 1, b: 0, h: [1] });
  const off = [[at(2026, 10, 13, 20), at(2026, 10, 13, 21)]];
  assert.equal(Ledger.summarize(sources({ off }), at(2026, 10, 13, 0)).st, 'broken');
  assert.equal(Ledger.summarize(sources({ off }), at(2026, 10, 14, 0)).st, 'kept');
});

test('no line for a day before the extension was here', () => {
  assert.equal(Ledger.summarize(sources(), at(2026, 8, 31, 0)), null);
  assert.ok(Ledger.summarize(sources(), at(2026, 9, 1, 0)), 'the first day counts');
});

test('rollup writes the settled days, never today, and changes nothing the second time', () => {
  const s = sources({ stops: [{ at: at(2026, 10, 19, 23) }, { at: at(2026, 10, 20, 1) }] });
  const first = Ledger.rollup(null, s, NOW);
  assert.ok(first.changed);
  const keys = Object.keys(first.ledger.days);
  assert.equal(keys.length, Ledger.SETTLE_DAYS);
  assert.equal(keys[keys.length - 1], '2026-10-19', 'yesterday is the newest');
  assert.ok(!first.ledger.days['2026-10-20'], 'today is not over');
  assert.equal(first.ledger.days['2026-10-19'].g, 1);
  const again = Ledger.rollup(first.ledger, s, NOW);
  assert.equal(again.changed, false);
});

test('rollup leaves older days as written, and lets go after 400 days', () => {
  const old = {
    days: {
      '2026-08-01': { st: 'broken', g: 0, w: 0, x: 1, b: 3, h: [23] },
      '2025-09-01': { st: 'kept', g: 0, w: 0, x: 0, b: 0, h: [] },
      'junk': { st: 'kept' },
      '2026-08-02': { st: 'maybe' }
    }
  };
  const { ledger } = Ledger.rollup(old, sources({ firstSeen: at(2025, 1, 1) }), NOW);
  assert.deepEqual(ledger.days['2026-08-01'], old.days['2026-08-01'], 'out of the detail\'s reach: kept as written');
  assert.ok(!ledger.days['2025-09-01'], 'more than 400 days ago');
  assert.ok(!ledger.days.junk && !ledger.days['2026-08-02'], 'nothing malformed survives');
});

test('days: today and the settled days from the detail, older ones from the record', () => {
  const s = sources({ stops: [{ at: at(2026, 10, 20, 8) }], firstSeen: at(2026, 6, 1) });
  const record = { days: { '2026-08-10': { st: 'broken', g: 0, w: 0, x: 1, b: 0, h: [2] } } };
  const list = Ledger.days(record, s, NOW, at(2026, 8, 9, 0), at(2026, 10, 21, 0));
  const by = Object.fromEntries(list.map((d) => [d.key, d]));
  assert.equal(by['2026-08-09'].status, 'unknown', 'before the long record began');
  assert.equal(by['2026-08-10'].status, 'broken');
  assert.equal(by['2026-10-20'].status, 'kept');
  assert.equal(by['2026-10-20'].entry.g, 1, 'today, live');
  assert.equal(by['2026-10-21'].status, 'ahead');
  const early = Ledger.days(null, sources(), NOW, at(2026, 8, 30, 0), at(2026, 9, 1, 0));
  assert.deepEqual(early.map((d) => d.status), ['before', 'before', 'unknown'], 'past the detail, with no record: unknown');
});

test('readSources reads each store in the shape a day is made from', async () => {
  const store = {
    pblocker_slips: [{ day: '2026-10-12', hour: 1 }],
    pblocker_kept_moments: { count: 3, times: [at(2026, 10, 18, 22)] },
    pblocker_first_seen: at(2026, 9, 1),
    pblocker_gateway_stops: { total: 1, recent: [{ key: 'reddit', at: at(2026, 10, 19, 23) }] },
    pblocker_audit_disabled: [{ enabled: false, timestamp: at(2026, 10, 3, 20) }, { enabled: true, timestamp: at(2026, 10, 3, 21) }],
    pblocker_settings: { enabled: true },
    pblocker_daily_history: { '2026-10-19': 4 }
  };
  const s = await Ledger.readSources(async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]])), Moments, Gateways, NOW);
  assert.equal(s.firstSeen, at(2026, 9, 1));
  assert.equal(s.slips.length, 1);
  assert.deepEqual(s.kept, [at(2026, 10, 18, 22)]);
  assert.equal(s.stops.length, 1);
  assert.equal(s.off.length, 1);
  assert.equal(s.blocks['2026-10-19'], 4);
});

test('the record holds counts and hours only, never a site', () => {
  const s = sources({ stops: [{ key: 'reddit.com/r/something', at: at(2026, 10, 19, 23) }] });
  const { ledger } = Ledger.rollup(null, s, NOW);
  assert.doesNotMatch(JSON.stringify(ledger), /reddit|something/);
});

test('the background rolls it up once a day, and loads what it needs in both browsers', () => {
  const root = path.join(__dirname, '..');
  const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  for (const f of ['shared/moments.js', 'shared/gateways.js', 'shared/ledger.js']) {
    assert.ok(bg.includes(`self.importScripts('${f}')`), `Chrome loads ${f}`);
  }
  const ff = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8')).background.scripts;
  for (const f of ['shared/moments.js', 'shared/gateways.js', 'shared/ledger.js']) assert.ok(ff.includes(f), `Firefox loads ${f}`);
  assert.ok(ff.indexOf('shared/ledger.js') < ff.indexOf('background.js'));
  assert.match(bg, /alarms\.create\(LEDGER_ALARM, \{ delayInMinutes: 1, periodInMinutes: 12 \* 60 \}\)/);
});
