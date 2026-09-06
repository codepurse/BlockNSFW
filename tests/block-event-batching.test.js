const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

// One blocked image used to cost ~11 storage/IPC round-trips, none of which
// awaited each other: five unserialised read-modify-write pairs on shared keys.
// That was both a write storm and a correctness bug — concurrent RMW loses
// counts. These tests pin the batched replacement: one read, one write, and
// totals that survive a burst.

const KEYS = {
  stats: 'pblocker_stats',
  daily: 'pblocker_daily_stats',
  audit: 'pblocker_audit_blocked',
  domains: 'pblocker_top_domains',
  history: 'pblocker_daily_history'
};

async function harness() {
  const context = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', context);

  const disk = {};
  const writes = [];
  const reads = [];

  context.chrome.storage.local.get = (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    reads.push(list);
    const out = {};
    for (const key of list) if (key in disk) out[key] = disk[key];
    return Promise.resolve(out);
  };
  context.chrome.storage.local.set = (items) => {
    writes.push(items);
    Object.assign(disk, items);
    return Promise.resolve();
  };

  const statWrites = () => writes.filter(item => KEYS.stats in item);
  return { context, disk, writes, reads, statWrites };
}

test('a burst of blocks commits in a single storage write', async () => {
  const { context, statWrites, reads } = await harness();

  for (let i = 0; i < 40; i++) {
    context.queueBlockEvent('image_filtered', {
      url: `https://example.test/photo-${i}.jpg`,
      reason: 'Image filtered'
    });
  }

  assert.deepEqual(statWrites(), [], 'queueing must not touch storage at all');

  const readsBefore = reads.length;
  await context.flushBlockEvents();

  assert.equal(statWrites().length, 1, '40 blocks must produce one write, not 40');
  assert.equal(reads.length - readsBefore, 1, 'and one read, not five per block');
});

test('no count is lost across a burst', async () => {
  const { context, disk } = await harness();

  for (let i = 0; i < 25; i++) {
    context.queueBlockEvent('image_filtered', { url: `https://a.test/${i}.jpg` });
  }
  for (let i = 0; i < 7; i++) {
    context.queueBlockEvent('website_blocked', { url: `https://b.test/${i}`, reason: 'Pattern match' });
  }
  await context.flushBlockEvents();

  const stats = disk[KEYS.stats];
  assert.equal(stats.imageBlockedCount, 25);
  assert.equal(stats.websiteBlockedCount, 7);
  assert.equal(stats.blockedCount, 32, 'the total counts every event exactly once');
});

test('totals accumulate across separate flushes', async () => {
  const { context, disk } = await harness();

  context.queueBlockEvent('image_filtered', { url: 'https://a.test/1.jpg' });
  await context.flushBlockEvents();
  context.queueBlockEvent('image_filtered', { url: 'https://a.test/2.jpg' });
  await context.flushBlockEvents();

  assert.equal(disk[KEYS.stats].imageBlockedCount, 2, 'a flush must not reset the running total');
});

test('events recorded during a flush are not dropped', async () => {
  const { context, disk } = await harness();

  context.queueBlockEvent('image_filtered', { url: 'https://a.test/1.jpg' });
  const inFlight = context.flushBlockEvents();
  // Arrives while the flush is awaiting storage: belongs to the next batch,
  // and must not be discarded by the buffer reset.
  context.queueBlockEvent('image_filtered', { url: 'https://a.test/2.jpg' });
  await inFlight;
  await context.flushBlockEvents();

  assert.equal(disk[KEYS.stats].imageBlockedCount, 2);
});

test('a filtering pass is one stat event however many results it hid', async () => {
  const { context, disk } = await harness();

  context.queueBlockEvent('search_result_filtered', {
    url: 'https://search.test/?q=x', count: 12
  });
  await context.flushBlockEvents();

  assert.equal(disk[KEYS.stats].searchResultBlockedCount, 1,
    'stats record the pass, matching the previous behaviour');
});

test('daily stats keep the date format the popup compares against', async () => {
  const { context, disk } = await harness();

  context.queueBlockEvent('image_filtered', { url: 'https://a.test/1.jpg' });
  await context.flushBlockEvents();

  const daily = disk[KEYS.daily];
  assert.equal(daily.date, new Date().toDateString(),
    'popup.js treats any other format as a new day and shows zero');
  assert.equal(daily.blockedToday, 1);
  assert.equal(daily.imageBlocked, 1);
});

test('the audit log stays bounded and records the blocked urls', async () => {
  const { context, disk } = await harness();

  for (let i = 0; i < 1200; i++) {
    context.queueBlockEvent('website_blocked', { url: `https://a.test/${i}`, reason: 'Pattern match' });
  }
  await context.flushBlockEvents();

  const log = disk[KEYS.audit];
  assert.equal(log.length, 1000, 'AUDIT_MAX_ENTRIES still caps the log');
  assert.equal(log[log.length - 1].url, 'https://a.test/1199', 'the tail is what is kept');
});

test('top domains are tallied and capped', async () => {
  const { context, disk } = await harness();

  for (let i = 0; i < 5; i++) context.queueBlockEvent('image_filtered', { url: 'https://www.one.test/a.jpg' });
  for (let i = 0; i < 2; i++) context.queueBlockEvent('image_filtered', { url: 'https://two.test/a.jpg' });
  await context.flushBlockEvents();

  const domains = disk[KEYS.domains];
  assert.equal(domains['one.test'], 5, 'the www. prefix is stripped, as before');
  assert.equal(domains['two.test'], 2);
});

test('a block with no url updates counters without touching the audit log', async () => {
  const { context, disk } = await harness();

  context.queueBlockEvent('image_filtered', {});
  await context.flushBlockEvents();

  assert.equal(disk[KEYS.stats].imageBlockedCount, 1);
  // Length, not deepEqual: the array is created inside the vm context, so its
  // prototype is that realm's Array.prototype and strict deepEqual rejects it.
  assert.equal(disk[KEYS.audit].length, 0, 'no url means nothing to log');
});

test('flushing with nothing pending writes nothing', async () => {
  const { context, statWrites } = await harness();

  await context.flushBlockEvents();

  assert.deepEqual(statWrites(), [], 'an idle flush must not fire storage.onChanged');
});
