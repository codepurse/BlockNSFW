const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function fn(name) {
  const marker = new RegExp('(?:^|\\n)(?:async )?function ' + name + '\\s*\\(', 'm');
  const m = marker.exec(CONTENT);
  assert.ok(m, `function ${name} not found in content.js`);
  const start = m.index + (CONTENT[m.index] === '\n' ? 1 : 0);
  let i = CONTENT.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; i < CONTENT.length; i++) {
    if (CONTENT[i] === '{') depth++;
    else if (CONTENT[i] === '}') { depth--; if (depth === 0) break; }
  }
  return CONTENT.slice(start, i + 1);
}

// isCurrentPageWhitelisted decides whether this page is filtered at all, and it
// is now cached instead of re-read from storage on every processContent(). A
// wrong cache here does not merely cost performance: holding a stale "allowed"
// verdict means adult content is not filtered on a page that should be. These
// pin the invalidation rules.

function harness({ now = 1_000_000 } = {}) {
  const sandbox = {
    computeCalls: 0,
    verdict: false,
    nextExpiry: 0,
    fakeNow: now,
    window: { location: { href: 'https://example.test/a' } },
    Promise, Date: { now: () => sandbox.fakeNow }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let _whitelistCache = null;
    let _whitelistNearestExpiry = 0;
    ${fn('resetWhitelistCache')}
    ${fn('isCurrentPageWhitelisted')}
    async function computeCurrentPageWhitelisted() {
      computeCalls++;
      _whitelistNearestExpiry = nextExpiry;
      return verdict;
    }
    globalThis.ask = isCurrentPageWhitelisted;
    globalThis.reset = resetWhitelistCache;
  `, sandbox);
  return sandbox;
}

test('a permanent verdict is computed once per URL', async () => {
  const s = harness();
  s.verdict = true;

  for (let i = 0; i < 20; i++) assert.equal(await s.ask(), true);

  assert.equal(s.computeCalls, 1,
    'processContent runs from many triggers; each must not re-read storage');
});

test('a different URL is not served the previous page\'s verdict', async () => {
  const s = harness();
  s.verdict = true;
  assert.equal(await s.ask(), true);

  s.window.location.href = 'https://other.test/b';
  s.verdict = false;
  assert.equal(await s.ask(), false, 'an SPA navigation must not inherit the allowance');
  assert.equal(s.computeCalls, 2);
});

test('a temporary allowance is not cached past its expiry', async () => {
  const s = harness({ now: 1_000_000 });
  s.verdict = true;
  s.nextExpiry = 1_000_500;               // expires 500ms from now

  assert.equal(await s.ask(), true);
  assert.equal(s.computeCalls, 1);

  s.fakeNow = 1_000_400;                  // still inside the window
  assert.equal(await s.ask(), true);
  assert.equal(s.computeCalls, 1, 'still valid, still cached');

  s.fakeNow = 1_000_600;                  // lapsed
  s.verdict = false;
  s.nextExpiry = 0;
  assert.equal(await s.ask(), false,
    'a lapsed temporary allowance must stop suppressing filtering');
  assert.equal(s.computeCalls, 2);
});

test('a permanent allowance is cached indefinitely', async () => {
  const s = harness({ now: 1_000_000 });
  s.verdict = true;
  s.nextExpiry = 0;                       // permanent entries report no expiry

  assert.equal(await s.ask(), true);
  s.fakeNow = 9_999_999_999;
  assert.equal(await s.ask(), true);
  assert.equal(s.computeCalls, 1);
});

test('resetWhitelistCache forces a recompute', async () => {
  const s = harness();
  s.verdict = false;
  assert.equal(await s.ask(), false);

  // What the storage.onChanged listener does when the user allows this site.
  s.reset();
  s.verdict = true;
  assert.equal(await s.ask(), true, 'allowing a site must take effect without a reload');
  assert.equal(s.computeCalls, 2);
});

test('a not-whitelisted verdict is cached too', async () => {
  const s = harness();
  s.verdict = false;

  for (let i = 0; i < 10; i++) await s.ask();

  // The common case is "not whitelisted", and it is the one that used to pay a
  // two-key storage read on every processContent().
  assert.equal(s.computeCalls, 1);
});

test('the content script listens for the keys that invalidate the cache', () => {
  // The cache is only safe because these three changes reset it. Before this
  // work the content script did not watch the whitelist at all.
  for (const key of ['pblocker_whitelist', 'pblocker_remote_whitelist_v1',
                     'pblocker_temp_disable_until']) {
    assert.ok(CONTENT.includes(`changes.${key}`),
      `storage.onChanged must react to ${key}, or the cache goes stale`);
  }
});
