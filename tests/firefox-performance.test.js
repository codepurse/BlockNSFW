const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

test('set-based default blocklist keeps exact, subdomain, and shared-CDN semantics', () => {
  const context = loadBackgroundContext();
  vm.runInContext(
    "defaultBlocklistSet = new Set(['blocked.example', 'tenant.cloudfront.net', 'cloudfront.net'])",
    context
  );
  assert.equal(context.isUrlInDefaultBlocklist('https://blocked.example/path'), true);
  assert.equal(context.isUrlInDefaultBlocklist('https://sub.blocked.example/path'), true);
  assert.equal(context.isUrlInDefaultBlocklist('https://tenant.cloudfront.net/image.jpg'), true);
  assert.equal(context.isUrlInDefaultBlocklist('https://safe.cloudfront.net/image.jpg'), false);
  assert.equal(context.isUrlInDefaultBlocklist('https://safe.example/path'), false);
});

test('a cold-start URL verdict waits for the blocklist before replying', async () => {
  const context = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', context);
  vm.runInContext(`
    defaultBlocklistSet = new Set(['blocked.example']);
    isReady = false;
    initReady = new Promise(resolve => { resolveReady = resolve; });
  `, context);

  let settled = false;
  const listener = context.chrome.runtime.onMessage.listeners[0];
  const verdictPromise = new Promise(resolve => {
    const keepOpen = listener(
      { type: 'should_block_url', url: 'https://blocked.example/path' },
      {},
      response => { settled = true; resolve(response); }
    );
    assert.equal(keepOpen, true);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  context.markReady();
  assert.deepEqual({ ...await verdictPromise }, { success: true, blocked: true });
});

test('interrupted chunk writes leave the previous generation readable', async () => {
  const context = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', context);

  const metaKey = 'pblocker_blocklist_meta_v2';
  const prefix = 'pblocker_blocklist_chunk_v2_';
  const oldMeta = {
    updatedAt: 1,
    chunkCount: 1,
    version: 7,
    source: 'remote',
    domainCount: 1
  };
  const storage = {
    [metaKey]: oldMeta,
    [`${prefix}0`]: ['old.example']
  };
  let failMetadataCommit = true;
  context.chrome.storage.local.get = async keys => {
    if (typeof keys === 'string') return { [keys]: storage[keys] };
    return Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]]));
  };
  context.chrome.storage.local.set = async values => {
    if (failMetadataCommit && Object.hasOwn(values, metaKey)) {
      throw new Error('simulated interruption before metadata commit');
    }
    Object.assign(storage, values);
  };
  context.chrome.storage.local.remove = async keys => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
  };
  context.crypto.randomUUID = () => 'new-generation';
  vm.runInContext(`blocklistMeta = ${JSON.stringify(oldMeta)}`, context);

  await assert.rejects(
    context.storeBlocklistInCache(['new.example']),
    /simulated interruption/
  );
  assert.deepEqual([...await context.loadBlocklistFromCache()], ['old.example']);
  assert.deepEqual(storage[metaKey], oldMeta);
  assert.deepEqual(storage[`${prefix}0`], ['old.example']);

  failMetadataCommit = false;
  await context.storeBlocklistInCache(['new.example']);
  assert.equal(storage[metaKey].generation, 'new-generation');
  assert.deepEqual([...await context.loadBlocklistFromCache()], ['new.example']);
  assert.equal(`${prefix}0` in storage, false);
});
