const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

// C1 made the counters eventually-consistent. The unit tests cover one batch;
// what they do not cover is a long session — many pages, many flushes, a
// suspend in the middle — which is where a batching bug shows up as counts that
// quietly drift instead of failing loudly. This drives thousands of events
// across many flush cycles and asserts the totals are exact, not approximate.

const KEYS = {
  stats: 'pblocker_stats',
  daily: 'pblocker_daily_stats',
  audit: 'pblocker_audit_blocked',
  domains: 'pblocker_top_domains'
};

async function session() {
  const context = loadBackgroundContext();
  await context.backgroundInitializationPromise;
  await new Promise(done => setTimeout(done, 10));

  const disk = {};
  let writes = 0;
  context.chrome.storage.local.get = (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in disk) out[k] = disk[k];
    return Promise.resolve(out);
  };
  context.chrome.storage.local.set = (items) => {
    writes++;
    Object.assign(disk, items);
    return Promise.resolve();
  };
  return { context, disk, writes: () => writes };
}

test('counts stay exact across 40 pages and 40 flushes', async () => {
  const { context, disk } = await session();

  const perPage = 37;
  const pages = 40;
  for (let page = 0; page < pages; page++) {
    for (let i = 0; i < perPage; i++) {
      context.queueBlockEvent('image_filtered', {
        url: `https://cdn${page}.example.test/img-${i}.jpg`, tabId: page
      });
    }
    await context.flushBlockEvents();   // one page load, one flush
  }

  assert.equal(disk[KEYS.stats].imageBlockedCount, perPage * pages);
  assert.equal(disk[KEYS.stats].blockedCount, perPage * pages,
    'the running total must not drift over a long session');
});

test('a flush racing new events loses nothing over many rounds', async () => {
  const { context, disk } = await session();

  let queued = 0;
  for (let round = 0; round < 50; round++) {
    context.queueBlockEvent('image_filtered', { url: `https://a.test/${round}-1.jpg` });
    queued++;
    const inFlight = context.flushBlockEvents();
    // Arrives while the flush is awaiting storage — belongs to the next batch.
    context.queueBlockEvent('image_filtered', { url: `https://a.test/${round}-2.jpg` });
    queued++;
    await inFlight;
  }
  await context.flushBlockEvents();

  assert.equal(disk[KEYS.stats].imageBlockedCount, queued,
    'events queued mid-flush must survive the buffer reset');
});

test('mixed event types each land in their own counter', async () => {
  const { context, disk } = await session();

  const plan = {
    image_filtered: 120,
    website_blocked: 15,
    search_result_filtered: 30,
    image_ai_filtered: 7
  };
  for (const [type, n] of Object.entries(plan)) {
    for (let i = 0; i < n; i++) {
      context.queueBlockEvent(type, { url: `https://x.test/${type}-${i}`, reason: type });
      if (i % 13 === 0) await context.flushBlockEvents();   // interleave flushes
    }
  }
  await context.flushBlockEvents();

  const s = disk[KEYS.stats];
  assert.equal(s.imageBlockedCount, plan.image_filtered);
  assert.equal(s.websiteBlockedCount, plan.website_blocked);
  assert.equal(s.searchResultBlockedCount, plan.search_result_filtered);
  assert.equal(s.aiImageBlockedCount, plan.image_ai_filtered);
  assert.equal(s.blockedCount,
    Object.values(plan).reduce((a, b) => a + b, 0),
    'the grand total must equal the sum of the parts');
});

test('the audit log stays capped over a long session, keeping the newest', async () => {
  const { context, disk } = await session();

  for (let i = 0; i < 3000; i++) {
    context.queueBlockEvent('website_blocked', {
      url: `https://site.test/${i}`, reason: 'Pattern match'
    });
    if (i % 250 === 0) await context.flushBlockEvents();
  }
  await context.flushBlockEvents();

  const log = disk[KEYS.audit];
  assert.equal(log.length, 1000, 'AUDIT_MAX_ENTRIES must hold across flushes, not just within one');
  assert.equal(log[log.length - 1].url, 'https://site.test/2999');
});

test('top domains stay capped at 100 and keep the busiest', async () => {
  const { context, disk } = await session();

  // 300 distinct domains; the first 50 are hit far more often.
  for (let i = 0; i < 300; i++) {
    const hits = i < 50 ? 20 : 1;
    for (let h = 0; h < hits; h++) {
      context.queueBlockEvent('image_filtered', { url: `https://d${i}.test/a.jpg` });
    }
    if (i % 40 === 0) await context.flushBlockEvents();
  }
  await context.flushBlockEvents();

  const domains = disk[KEYS.domains];
  assert.equal(Object.keys(domains).length, 100, 'the map must not grow without bound');
  assert.equal(domains['d0.test'], 20, 'a busy domain keeps its full tally');
  assert.ok(!('d299.test' in domains), 'a one-hit domain loses to the busy ones');
});

test('storage writes scale with flushes, not with blocks', async () => {
  const { context, writes } = await session();

  const before = writes();
  for (let i = 0; i < 2000; i++) {
    context.queueBlockEvent('image_filtered', { url: `https://a.test/${i}.jpg` });
  }
  await context.flushBlockEvents();

  assert.equal(writes() - before, 1,
    '2000 blocked images must still commit in exactly one write');
});
