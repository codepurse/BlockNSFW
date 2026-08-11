const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

test('packaged blocklist is fresh until its normal refresh TTL expires', async () => {
  const context = loadBackgroundContext();
  await new Promise(resolve => setImmediate(resolve));

  const writes = [];
  let remoteFetches = 0;
  context.chrome.storage.local.get = async () => ({});
  context.chrome.storage.local.set = async value => { writes.push(value); };
  context.fetch = async url => {
    if (url === 'blocklist.json') {
      return { json: async () => ['blocked.example'] };
    }
    remoteFetches++;
    throw new Error(`unexpected remote fetch: ${url}`);
  };
  vm.runInContext(
    'blocklistMeta = null; remoteBlocklistPromise = null; defaultBlocklist = []; defaultBlocklistSet = new Set()',
    context
  );

  await context.loadDefaultBlocklist();
  await new Promise(resolve => setImmediate(resolve));

  const metaWrite = writes.find(value => value.pblocker_blocklist_meta_v2);
  assert.equal(metaWrite.pblocker_blocklist_meta_v2.source, 'bundled');
  assert.equal(metaWrite.pblocker_blocklist_meta_v2.domainCount, 1);
  assert.equal(remoteFetches, 0);
});
