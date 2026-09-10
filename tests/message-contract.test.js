// The content script → background message contract (audit finding M2).
//
// content.js has always sent iframe_filtered, video_filtered and
// social_post_filtered. background.js had no handler for any of them, so those
// blocks reached nothing: not the toolbar badge, not the totals, not the audit
// log. The in-page pill counted video and iframe itself (COUNTED_BLOCK_TYPES),
// which is why the pill and the badge disagreed — and the whole thing was
// invisible, because a message with no handler is not an error anywhere.
//
// Three of six block types were dropped and nothing noticed for as long as the
// feature had existed. So this file does not test those three: it enumerates
// what the content script sends and asserts the background can answer all of
// it, which catches the next one too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

const ROOT = path.join(__dirname, '..');
const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// Every type content.js reports a block with.
function sentBlockTypes() {
  const types = new Set();
  const re = /notifyBackground\(\s*'([a-z_]+)'/g;
  let match;
  while ((match = re.exec(contentSource)) !== null) types.add(match[1]);
  return types;
}

// Every type the background listener branches on.
function handledTypes() {
  const types = new Set();
  const re = /message\.type === '([a-z_]+)'/g;
  let match;
  while ((match = re.exec(backgroundSource)) !== null) types.add(match[1]);
  return types;
}

test('M2: every block type the content script sends has a handler', () => {
  const sent = sentBlockTypes();
  const handled = handledTypes();
  assert.ok(sent.size >= 6, `expected the known block types, found ${[...sent]}`);

  const orphaned = [...sent].filter(type => !handled.has(type));
  assert.deepEqual(orphaned, [],
    'content.js reports these blocks and background.js ignores them, so they ' +
    'reach neither the badge nor the stats:\n  ' + orphaned.join('\n  '));
});

test('M2: every block type has a stats field and a daily field', () => {
  const context = loadBackgroundContext();
  const statField = JSON.parse(vm.runInContext('JSON.stringify(STAT_FIELD_BY_TYPE)', context));
  const dailyField = JSON.parse(vm.runInContext('JSON.stringify(DAILY_FIELD_BY_TYPE)', context));
  const defaults = JSON.parse(vm.runInContext('JSON.stringify(DEFAULT_STATS)', context));

  for (const type of sentBlockTypes()) {
    assert.ok(statField[type],
      `${type} has no STAT_FIELD_BY_TYPE entry, so it lands in the grand total with no line of its own`);
    assert.ok(dailyField[type], `${type} has no DAILY_FIELD_BY_TYPE entry`);
    assert.ok(statField[type] in defaults,
      `${statField[type]} is mapped but missing from DEFAULT_STATS, so it starts undefined`);
  }
});

test('M2: the three previously-dropped types now reach the batch', async () => {
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

  context.queueBlockEvent('video_filtered', { url: 'https://x.test/v', reason: 'v' });
  context.queueBlockEvent('iframe_filtered', { url: 'https://x.test/f', reason: 'f' });
  context.queueBlockEvent('social_post_filtered', { url: 'https://x.test/s', reason: 's', count: 7 });
  await context.flushBlockEvents();

  const stats = disk['pblocker_stats'];
  assert.equal(stats.videoBlockedCount, 1);
  assert.equal(stats.iframeBlockedCount, 1);
  assert.equal(stats.socialPostBlockedCount, 1);
  // Like the search pass, a sweep that hid 7 posts is one recorded event.
  assert.equal(stats.blockedCount, 3, 'each message counts once in the grand total');

  const daily = disk['pblocker_daily_stats'];
  assert.equal(daily.videoBlocked, 1);
  assert.equal(daily.iframeBlocked, 1);
  assert.equal(daily.socialPostBlocked, 1);
  assert.equal(daily.blockedToday, 3);
});

test('M2: an unhandled message does not hold the response port open', () => {
  const context = loadBackgroundContext();
  const listener = context.chrome.runtime.onMessage.listeners[0];
  assert.ok(listener, 'the background should have registered an onMessage listener');

  // Returning true promises a later sendResponse. For a message nothing
  // handles, that promise is never kept and the sender waits for the port to
  // close — surfacing as "The message port closed before a response was
  // received", once per blocked video or frame.
  assert.equal(listener({ type: 'no_such_message' }, {}, () => {}), false);
  assert.equal(listener({ target: 'offscreen-ai', op: 'ping' }, {}, () => {}), false);
});

test('M14: a malformed message is ignored instead of throwing', () => {
  const context = loadBackgroundContext();
  const listener = context.chrome.runtime.onMessage.listeners[0];
  assert.ok(listener);

  // message.type was read with no guard, so any of these threw inside the
  // listener — which Chrome surfaces only as a failed send on the far side.
  for (const bad of [null, undefined, 0, '', 'a string', 42, [], true]) {
    assert.doesNotThrow(() => listener(bad, {}, () => {}),
      `listener threw on ${JSON.stringify(bad)}`);
    assert.equal(listener(bad, {}, () => {}), false);
  }
});
