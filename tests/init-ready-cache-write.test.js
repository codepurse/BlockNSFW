const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

// Readiness must not depend on the blocklist cache write.
//
// Safari 17 never settles the chunked storage.local.set that stores the 4 MB
// bundled list, so the old init path awaited it forever: initReady never
// resolved, shouldBlock() never answered, and content scripts (which fail open)
// let every navigation through. The cache is a speed-up for the next wake, so
// a hung or rejected write must not hold up anything that waits on init.

const CHUNK_PREFIX = 'pblocker_blocklist_chunk_v2_';
const BUNDLED_LIST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'blocklist.json'), 'utf8'));
const PUBLIC_SUFFIX_TEXT = fs.readFileSync(path.join(__dirname, '..', 'data', 'public-suffixes.txt'), 'utf8');

function never() {
  return new Promise(() => {});
}

function settlesWithin(promise, ms) {
  return Promise.race([
    promise.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('pending'), ms))
  ]);
}

test('a never-settling blocklist cache write does not hold up readiness or verdicts', async () => {
  const context = loadBackgroundContext(undefined, sandbox => {
    sandbox.fetch = async url => {
      if (String(url).endsWith('public-suffixes.txt')) {
        return { ok: true, text: async () => PUBLIC_SUFFIX_TEXT };
      }
      if (url === 'blocklist.json') {
        return { json: async () => BUNDLED_LIST };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    sandbox.chrome.storage.local.set = items => (
      Object.keys(items).some(key => key.startsWith(CHUNK_PREFIX))
        ? never()
        : Promise.resolve()
    );
  });

  const ready = vm.runInContext('initReady', context);
  assert.equal(await settlesWithin(ready, 1000), 'settled',
    'initReady must resolve even though the chunk write never settles');

  const domain = BUNDLED_LIST[0];
  assert.equal(await context.shouldBlock(`https://${domain}/`), true,
    'a domain from the bundled list must be blocked once ready');
});
