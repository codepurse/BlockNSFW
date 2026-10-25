// The page the browser opens after BlockNSFW is removed (background.js,
// setGoodbyePage). Its address is the whole of what leaves the extension, so
// it is pinned here: the version, the browser and a rounded install age, and
// nothing else. Privacy policy, section 14.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

const DAY = 86400000;

function load(firstSeen) {
  const set = [];
  const ctx = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.chrome.runtime.setUninstallURL = (url) => {
      set.push(url);
      return Promise.resolve();
    };
    sandbox.chrome.runtime.getManifest = () => ({ version: '2.0.3' });
    sandbox.chrome.storage.local.get = () =>
      Promise.resolve(firstSeen === undefined ? {} : { pblocker_first_seen: firstSeen });
    // Without these two, the rest of background.js never runs in this
    // harness, and the goodbye page is near the end (as in pact-background).
    sandbox.chrome.storage.onChanged = { addListener() {} };
    sandbox.chrome.alarms = {
      create() {}, get: async () => null, clear: async () => true, onAlarm: { addListener() {} },
    };
  });
  return { ctx, set };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('every wake sets the goodbye address without being asked', async () => {
  const { set } = load(Date.now() - 3 * DAY);
  await settle();
  assert.deepEqual(set, ['https://monolab.dev/blocknsfw/goodbye?v=2.0.3&b=chrome&a=week']);
});

test('the address carries the version, the browser and the install age, nothing else', async () => {
  const { ctx, set } = load(Date.now() - 40 * DAY);
  await settle();
  set.length = 0;
  await ctx.setGoodbyePage();
  assert.equal(set.length, 1);
  const url = new URL(set[0]);
  assert.equal(url.origin + url.pathname, 'https://monolab.dev/blocknsfw/goodbye');
  assert.deepEqual([...url.searchParams.keys()], ['v', 'b', 'a']);
  assert.equal(url.searchParams.get('a'), 'older');
  assert.ok(set[0].length < 1023, 'Chrome refuses an uninstall URL over 1023 characters');
});

test('the install age is rounded to a day, a week, a month or longer', () => {
  const { ctx } = load();
  const now = Date.UTC(2026, 9, 25);
  assert.equal(ctx.goodbyeAge(now - 2 * 3600000, now), 'day');
  assert.equal(ctx.goodbyeAge(now - 2 * DAY, now), 'week');
  assert.equal(ctx.goodbyeAge(now - 10 * DAY, now), 'month');
  assert.equal(ctx.goodbyeAge(now - 31 * DAY, now), 'older');
  assert.equal(ctx.goodbyeAge(undefined, now), 'unknown');
  assert.equal(ctx.goodbyeAge('2026-10-01', now), 'unknown');
});

test('a browser without setUninstallURL is left alone', async () => {
  const { ctx } = load(Date.now());
  delete ctx.chrome.runtime.setUninstallURL;
  await assert.doesNotReject(ctx.setGoodbyePage());
});
