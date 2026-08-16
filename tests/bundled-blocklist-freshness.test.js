const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

const META_KEY = 'pblocker_blocklist_meta_v2';

async function settleBackgroundStartup(context) {
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(
    'blocklistMeta = null; remoteBlocklistPromise = null; defaultBlocklist = []; defaultBlocklistSet = new Set()',
    context
  );
}

test('packaged blocklist is fresh until its normal refresh TTL expires', async () => {
  const context = loadBackgroundContext();
  await settleBackgroundStartup(context);

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
  await context.loadDefaultBlocklist();
  await new Promise(resolve => setImmediate(resolve));

  const metaWrite = writes.find(value => value[META_KEY]);
  assert.equal(metaWrite[META_KEY].source, 'bundled');
  assert.equal(metaWrite[META_KEY].domainCount, 1);
  assert.equal(remoteFetches, 0);
});

test('packaged blocklist preserves its original freshness timestamp across restarts', async () => {
  const context = loadBackgroundContext();
  await settleBackgroundStartup(context);

  const originalTimestamp = Date.now() - 1000;
  const storedMeta = {
    updatedAt: originalTimestamp,
    chunkCount: 0,
    version: 1,
    source: 'bundled',
    domainCount: 1
  };
  const writes = [];
  let remoteFetches = 0;
  context.chrome.storage.local.get = async () => ({ [META_KEY]: storedMeta });
  context.chrome.storage.local.set = async value => { writes.push(value); };
  context.fetch = async url => {
    if (url === 'blocklist.json') {
      return { json: async () => ['blocked.example'] };
    }
    remoteFetches++;
    throw new Error(`unexpected remote fetch: ${url}`);
  };

  await context.loadDefaultBlocklist();
  await new Promise(resolve => setImmediate(resolve));

  const currentMeta = vm.runInContext('blocklistMeta', context);
  assert.equal(currentMeta.updatedAt, originalTimestamp);
  assert.equal(writes.some(value => value[META_KEY]), false);
  assert.equal(remoteFetches, 0);
});

test('an expired bundled timestamp triggers the normal remote refresh', async () => {
  const context = loadBackgroundContext();
  await settleBackgroundStartup(context);

  const staleTimestamp = Date.now() - (13 * 60 * 60 * 1000);
  const storedMeta = {
    updatedAt: staleTimestamp,
    chunkCount: 0,
    version: 1,
    source: 'bundled',
    domainCount: 1
  };
  let resolveRemoteFetch;
  const remoteFetchStarted = new Promise(resolve => { resolveRemoteFetch = resolve; });
  let remoteFetches = 0;
  context.chrome.storage.local.get = async () => ({ [META_KEY]: storedMeta });
  context.chrome.storage.local.set = async () => {};
  context.chrome.storage.local.remove = async () => {};
  context.fetch = async url => {
    if (url === 'blocklist.json') {
      return { json: async () => ['blocked.example'] };
    }
    remoteFetches++;
    resolveRemoteFetch();
    return { ok: true, text: async () => '0.0.0.0 refreshed.example' };
  };

  await context.loadDefaultBlocklist();
  await remoteFetchStarted;

  assert.equal(remoteFetches, 1);
});
