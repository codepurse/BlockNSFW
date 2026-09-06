const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { loadBackgroundContext } = require('./setup.js');

const ROOT = path.join(__dirname, '..');

// C1 replaced five read-modify-write pairs with one batched write. The batch is
// only correct if it still produces every field the UI reads, in the format the
// UI expects — and it is written in background.js while it is consumed in four
// separate pages that nothing links to it. Two bugs already slipped through
// that gap during this work: the daily key was written as an ISO date while
// popup.js compares toDateString(), and blockedToday was dropped entirely.
// Both showed as "the popup reads zero", not as a crash.
//
// This pins the contract from the consumer's side.

const STATS_KEY = 'pblocker_stats';
const DAILY_KEY = 'pblocker_daily_stats';

async function flushOneOfEach() {
  const context = loadBackgroundContext();
  await context.backgroundInitializationPromise;
  await new Promise(done => setTimeout(done, 10));

  const disk = {};
  context.chrome.storage.local.get = (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in disk) out[k] = disk[k];
    return Promise.resolve(out);
  };
  context.chrome.storage.local.set = (items) => { Object.assign(disk, items); return Promise.resolve(); };

  for (const type of ['image_filtered', 'website_blocked',
                      'search_result_filtered', 'image_ai_filtered']) {
    context.queueBlockEvent(type, { url: `https://x.test/${type}`, reason: type });
  }
  await context.flushBlockEvents();
  return disk;
}

test('every stats field the UI reads is written by the batch', async () => {
  const disk = await flushOneOfEach();
  const stats = disk[STATS_KEY];

  // Read off what popup.js / options.js / stats.js actually consume.
  for (const field of ['blockedCount', 'websiteBlockedCount', 'imageBlockedCount',
                       'aiImageBlockedCount', 'searchResultBlockedCount']) {
    assert.equal(typeof stats[field], 'number',
      `${field} is read by the UI and must be a number after a flush`);
  }
  assert.equal(stats.imageBlockedCount, 1);
  assert.equal(stats.websiteBlockedCount, 1);
  assert.equal(stats.searchResultBlockedCount, 1);
  assert.equal(stats.aiImageBlockedCount, 1);
  assert.equal(stats.blockedCount, 4, 'the grand total counts every event once');
  assert.equal(typeof stats.lastBlocked, 'string');
  assert.ok(stats.lastWebsiteBlocked && typeof stats.lastWebsiteBlocked.url === 'string');
});

test('every daily field the UI reads is written by the batch', async () => {
  const disk = await flushOneOfEach();
  const daily = disk[DAILY_KEY];

  for (const field of ['blockedToday', 'websiteBlocked', 'imageBlocked',
                       'imageAiBlocked', 'searchResultBlocked']) {
    assert.equal(typeof daily[field], 'number', `${field} must survive the batch`);
  }
  assert.equal(daily.blockedToday, 4);
  assert.equal(daily.imageBlocked, 1);
});

test('the daily date matches the format the popup compares against', async () => {
  const disk = await flushOneOfEach();

  // popup.js: `if (!dailyStats || dailyStats.date !== new Date().toDateString())`
  // — any other format reads as a new day, every day, so the popup shows zero.
  assert.equal(disk[DAILY_KEY].date, new Date().toDateString());
});

test('the batch fills the whole DEFAULT_STATS shape, not just what it touched', async () => {
  const context = loadBackgroundContext();
  await context.backgroundInitializationPromise;
  const defaults = JSON.parse(vm.runInContext('JSON.stringify(DEFAULT_STATS)', context));

  const disk = await flushOneOfEach();
  for (const key of Object.keys(defaults)) {
    assert.ok(key in disk[STATS_KEY],
      `${key} is in DEFAULT_STATS, so something reads it; the batch dropped it`);
  }
});

test('the UI files still read only fields the batch writes', async () => {
  // A guard against the reverse drift: a new field added to a UI page that the
  // background never writes would silently render as undefined.
  const disk = await flushOneOfEach();
  const written = new Set([
    ...Object.keys(disk[STATS_KEY]),
    ...Object.keys(disk[DAILY_KEY])
  ]);

  const known = new Set(['blockedCount', 'websiteBlockedCount', 'imageBlockedCount',
    'aiImageBlockedCount', 'searchResultBlockedCount', 'lastBlocked', 'lastWebsiteBlocked',
    'blockedToday', 'websiteBlocked', 'imageBlocked', 'imageAiBlocked',
    'searchResultBlocked', 'date']);

  for (const file of ['popup.js', 'options.js', 'stats.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const field of known) {
      if (!src.includes(field)) continue;
      assert.ok(written.has(field),
        `${file} reads ${field} but the batched write never produces it`);
    }
  }
});
