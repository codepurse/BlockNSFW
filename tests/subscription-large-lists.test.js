// Subscribed lists at real-world size, driven through the background's own
// refresh code.
//
// The report that prompted this: subscribing to OISD's NSFW list
// (https://nsfw.oisd.nl/ublacklist) failed with "That file is too large to use
// as a ruleset", and pressing Update Now a few times got 503s back. Four things
// were wrong at once:
//
//   - the size caps (5 MB, 50,000 entries) turned away a 12.5 MB, 481,000-line
//     list, and would still have found no rules in it, since the parser did not
//     read uBlacklist match patterns (covered in ruleset-subscriptions.test.js);
//   - the file was downloaded in full before being measured and refused, on
//     every attempt;
//   - a failed list was retried on every background wake, and Update Now
//     downloaded again however recently it had just been pressed, which is how a
//     rate-limiting server ends up answering 503;
//   - even a list that fitted put every host in storage.local (10 MB in Chrome,
//     half of it already the bundled blocklist cache), in every frame's content
//     script, and into a regex each on the background's navigation path.
//
// These tests hold the background to the replacement: hosts in IndexedDB,
// answered by the background, downloaded at most once per window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

const RULESET_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ruleset.js'), 'utf8');
const PUBLIC_SUFFIX_TEXT = fs.readFileSync(path.join(__dirname, '..', 'data', 'public-suffixes.txt'), 'utf8');

const LIST_URL = 'https://lists.example/ublacklist';
const SUBSCRIPTIONS_KEY = 'pblocker_subscriptions';
const RULES_KEY = 'pblocker_subscription_rules';

// --- fakes -------------------------------------------------------------------

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const read = (keys) => {
    const out = {};
    const names = keys == null ? [...data.keys()]
      : typeof keys === 'string' ? [keys]
      : Array.isArray(keys) ? keys
      : Object.keys(keys);
    for (const name of names) {
      if (data.has(name)) out[name] = structuredClone(data.get(name));
      else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[name] = keys[name];
    }
    return out;
  };
  return {
    data,
    get: async (keys) => read(keys),
    set: async (items) => { for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value)); },
    remove: async (keys) => { for (const key of [].concat(keys)) data.delete(key); }
  };
}

// Enough IndexedDB for one object store with out-of-line keys: open, a
// transaction per call, get/put/delete, completion on a later tick.
function makeIndexedDB(records = new Map()) {
  return {
    records,
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            const tx = {
              objectStore: () => ({
                get: (key) => ({ result: records.get(key) }),
                put: (value, key) => { records.set(key, value); return { result: key }; },
                delete: (key) => { records.delete(key); return { result: undefined }; }
              })
            };
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
            return tx;
          }
        };
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    }
  };
}

/**
 * A worker booted against the given storage. Passing the same storage and
 * IndexedDB to a second call is a service-worker restart.
 */
async function bootWorker({ storage = makeStorage(), idb = makeIndexedDB(), respond } = {}) {
  const requests = [];
  const ctx = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.chrome.storage.local = storage;
    sandbox.chrome.storage.onChanged = { addListener() {} };
    sandbox.indexedDB = idb;
    sandbox.TextDecoder = TextDecoder;
    sandbox.fetch = async (url, init = {}) => {
      if (String(url).endsWith('public-suffixes.txt')) {
        return { ok: true, text: async () => PUBLIC_SUFFIX_TEXT };
      }
      if (!String(url).startsWith('https://lists.example/') || !respond) {
        throw new TypeError('Failed to fetch');
      }
      requests.push({ url, headers: { ...(init.headers || {}) } });
      return respond(url, init, requests.length);
    };
    vm.runInContext(RULESET_SOURCE, sandbox, { filename: 'shared/ruleset.js' });
  });
  const run = (code) => vm.runInContext(code, ctx);
  await run('initReady');
  return { ctx, run, storage, idb, requests };
}

function oisdShaped(count, { extra = [] } = {}) {
  const lines = ['# Title: test nsfw', '# Syntax: uBlacklist', `# Entries: ${count}`, ''];
  for (let i = 0; i < count; i++) lines.push(`*://*.site${i}.example/*`);
  lines.push('*://*.xxx/*', ...extra);
  return lines.join('\n');
}

function listResponse(text, { status = 200, etag = '"v1"', headers = {} } = {}) {
  return new Response(status === 304 ? null : text, {
    status,
    headers: { 'Content-Type': 'text/plain', ...(etag ? { ETag: etag } : {}), ...headers }
  });
}

function stored(storage) {
  return {
    subscription: (storage.data.get(SUBSCRIPTIONS_KEY) || [])[0],
    rules: storage.data.get(RULES_KEY) || {}
  };
}

// Moves a subscription's clock back, as if time had passed since its last
// check. Tests edit the timestamps rather than wait them out.
function age(storage, fields) {
  const list = storage.data.get(SUBSCRIPTIONS_KEY);
  Object.assign(list[0], fields);
  storage.data.set(SUBSCRIPTIONS_KEY, list);
}

function hostCheck(ctx, hosts) {
  const listener = ctx.chrome.runtime.onMessage.listeners[0];
  return new Promise((resolve) => {
    listener({ type: 'check_blocklist_hosts', hosts }, {}, resolve);
  }).then((response) => Array.from(response.blockedHosts));
}

async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- subscribing -------------------------------------------------------------

test('an OISD-shaped list subscribes, and its hosts block in the background', async () => {
  const worker = await bootWorker({ respond: () => listResponse(oisdShaped(5000)) });
  const { ctx, run, storage, idb } = worker;

  const result = await ctx.addSubscription(LIST_URL);
  assert.equal(result.ok, true);
  assert.equal(result.fetch.ok, true, result.fetch.error);
  assert.equal(result.fetch.entryCount, 5001);

  assert.equal(ctx.hostListedInSubscriptions('site42.example'), true);
  assert.equal(ctx.hostListedInSubscriptions('cdn.site42.example'), true, 'subdomains are covered');
  assert.equal(ctx.hostListedInSubscriptions('www.site42.example'), true);
  assert.equal(ctx.hostListedInSubscriptions('notsite42.example'), false, 'a sibling is not');
  assert.equal(ctx.hostListedInSubscriptions('unlisted.example'), false);

  // The content scripts' question gets the same answer.
  assert.deepEqual(await hostCheck(ctx, ['site7.example', 'img.site8.example', 'clean.example']),
    ['site7.example', 'img.site8.example']);

  // Where things were put: hosts in IndexedDB, only the one TLD rule in
  // storage.local, and only that rule compiled into a regex.
  const { subscription, rules } = stored(storage);
  assert.equal(subscription.hostCount, 5000);
  assert.deepEqual(rules[subscription.id], ['*.xxx']);
  assert.equal(typeof idb.records.get(subscription.id), 'string');
  assert.equal(run('compiledPatterns.length'), 1);
});

test('a restarted worker reads the hosts back without downloading again', async () => {
  const storage = makeStorage();
  const idb = makeIndexedDB();
  const first = await bootWorker({ storage, idb, respond: () => listResponse(oisdShaped(300)) });
  await first.ctx.addSubscription(LIST_URL);

  const second = await bootWorker({ storage, idb, respond: () => listResponse(oisdShaped(300)) });
  assert.equal(second.ctx.hostListedInSubscriptions('site299.example'), true);
  assert.equal(second.requests.length, 0, 'a list checked today is not fetched on wake');
});

// --- being gentle with the list's server --------------------------------------

test('an unchanged list is confirmed with a conditional request', async () => {
  const worker = await bootWorker({
    respond: (url, init) => (init.headers && init.headers['If-None-Match'] === '"v1"')
      ? listResponse(null, { status: 304 })
      : listResponse(oisdShaped(200))
  });
  const { ctx, storage, requests } = worker;
  await ctx.addSubscription(LIST_URL);
  const before = stored(storage).subscription;

  age(storage, { checkedAt: Date.now() - 60 * 60 * 1000 });
  const result = await ctx.refreshSubscription(before.id, { mode: 'manual' });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers['If-None-Match'], '"v1"');
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  const after = stored(storage).subscription;
  assert.equal(after.revision, before.revision, 'nothing was re-parsed or re-saved');
  assert.ok(after.updatedAt >= before.updatedAt);
  assert.equal(ctx.hostListedInSubscriptions('site5.example'), true);
});

test('pressing Update Now repeatedly costs the server one request', async () => {
  const worker = await bootWorker({ respond: () => listResponse(oisdShaped(200), { etag: '' }) });
  const { ctx, storage, requests } = worker;
  await ctx.addSubscription(LIST_URL);
  const { id } = stored(storage).subscription;
  age(storage, { checkedAt: Date.now() - 60 * 60 * 1000 });

  // Five presses while the first download is still running join it.
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    ctx.refreshSubscription(id, { mode: 'manual' })));
  assert.equal(requests.length, 2, 'one for subscribing, one for all five presses');
  for (const result of results) assert.equal(result.ok, true);

  // And one more straight afterwards is answered from disk.
  const again = await ctx.refreshSubscription(id, { mode: 'manual' });
  assert.equal(again.checked, false);
  assert.equal(again.reason, 'recent');
  assert.equal(requests.length, 2);
});

test('a 503 keeps the old rules, and nothing retries it on every wake', async () => {
  let status = 200;
  const worker = await bootWorker({
    respond: () => status === 200 ? listResponse(oisdShaped(200)) : listResponse('busy', { status, etag: '' })
  });
  const { ctx, storage, requests } = worker;
  await ctx.addSubscription(LIST_URL);
  const { id } = stored(storage).subscription;

  status = 503;
  age(storage, { checkedAt: Date.now() - 60 * 60 * 1000 });
  const failed = await ctx.refreshSubscription(id, { mode: 'manual' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /busy or limiting downloads \(503\)/);
  assert.equal(ctx.hostListedInSubscriptions('site9.example'), true, 'the last good download still blocks');

  const afterFailure = stored(storage).subscription;
  assert.ok(afterFailure.retryAfterAt > Date.now() + 5 * 60 * 1000,
    'with no Retry-After, the server is left alone for a while');

  // Neither a wake nor another press goes back while it asked to be left alone.
  const requestsSoFar = requests.length;
  assert.equal((await ctx.refreshSubscription(id)).reason, 'rate-limited');
  assert.equal((await ctx.refreshSubscription(id, { mode: 'manual' })).reason, 'rate-limited');
  assert.equal(requests.length, requestsSoFar);

  // Past that window, a wake still waits out the hour-long backoff...
  age(storage, { retryAfterAt: 0, lastErrorAt: Date.now() - 10 * 60 * 1000, updatedAt: 1 });
  assert.equal((await ctx.refreshSubscription(id)).reason, 'backoff');
  assert.equal(requests.length, requestsSoFar);

  // ...and after it, tries again.
  status = 200;
  age(storage, { lastErrorAt: Date.now() - 2 * 60 * 60 * 1000 });
  const recovered = await ctx.refreshSubscription(id);
  assert.equal(recovered.ok, true);
  assert.equal(requests.length, requestsSoFar + 1);
  assert.equal(stored(storage).subscription.error, '');
});

test('a Retry-After header decides how long to wait', async () => {
  const worker = await bootWorker({
    respond: () => listResponse('slow down', { status: 429, etag: '', headers: { 'Retry-After': '120' } })
  });
  const { ctx, storage } = worker;
  const started = Date.now();
  const result = await ctx.addSubscription(LIST_URL);
  assert.equal(result.fetch.ok, false);
  const { retryAfterAt } = stored(storage).subscription;
  assert.ok(retryAfterAt >= started + 119 * 1000 && retryAfterAt <= Date.now() + 121 * 1000,
    `retryAfterAt ${retryAfterAt - started} ms after the request`);
});

// --- the size limit ------------------------------------------------------------

test('a list over the size limit is refused from its Content-Length, unread', async () => {
  let pulled = 0;
  const worker = await bootWorker({
    respond: (_url, _init) => {
      const max = worker.ctx.self.Ruleset.MAX_FILE_BYTES;
      const body = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); } });
      return new Response(body, { status: 200, headers: { 'Content-Length': String(max + 1) } });
    }
  });
  const result = await worker.ctx.addSubscription(LIST_URL);
  assert.equal(result.fetch.ok, false);
  assert.match(result.fetch.error, /larger than 32 MB/);
  assert.ok(pulled <= 1, `the body was read (${pulled} chunks)`);
});

test('a list with no Content-Length is cut off once it passes the limit', async () => {
  let sent = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  const worker = await bootWorker({
    respond: () => new Response(new ReadableStream({
      pull(controller) { sent += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { cancelled = true; }
    }), { status: 200 })
  });
  const result = await worker.ctx.addSubscription(LIST_URL);
  const max = worker.ctx.self.Ruleset.MAX_FILE_BYTES;
  assert.equal(result.fetch.ok, false);
  assert.match(result.fetch.error, /larger than/);
  assert.equal(cancelled, true, 'the download is abandoned, not finished');
  assert.ok(sent <= max + 4 * chunk.byteLength, `read ${sent} bytes for a ${max} byte limit`);
});

// --- storage -------------------------------------------------------------------

test('a list removed while it downloads leaves nothing behind', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = await bootWorker({
    respond: async () => { await gate; return listResponse(oisdShaped(100)); }
  });
  const { ctx, storage, idb, requests } = worker;

  const adding = ctx.addSubscription(LIST_URL);
  await until(() => requests.length === 1, 'the download to start');
  const { id } = stored(storage).subscription;
  await ctx.removeSubscription(id);
  release();
  await adding;

  assert.deepEqual(Array.from(storage.data.get(SUBSCRIPTIONS_KEY)), []);
  assert.equal(id in stored(storage).rules, false);
  assert.equal(idb.records.has(id), false);
  assert.equal(ctx.hostListedInSubscriptions('site1.example'), false);
});

test('hosts saved by an older version move to IndexedDB on start', async () => {
  const id = 'sub_legacy';
  const storage = makeStorage({
    [SUBSCRIPTIONS_KEY]: [{ id, url: LIST_URL, name: 'Legacy', enabled: true, updatedAt: Date.now(), entryCount: 4, error: '' }],
    [RULES_KEY]: { [id]: ['old.example', '*.wild.example', 'www.dotted.example', '/old\\.regex/'] }
  });
  const idb = makeIndexedDB();
  const { ctx, run } = await bootWorker({ storage, idb });

  const { subscription, rules } = stored(storage);
  assert.equal(subscription.hostCount, 3);
  assert.deepEqual(rules[id], ['/old\\.regex/'], 'only the pattern stays in storage.local');
  assert.equal(idb.records.get(id), 'dotted.example\nold.example\nwild.example');
  assert.equal(ctx.hostListedInSubscriptions('a.wild.example'), true);
  assert.equal(ctx.hostListedInSubscriptions('dotted.example'), true);
  assert.equal(run('compiledPatterns.length'), 1, 'hosts are no longer compiled into regexes');
});

test('saved hosts that went missing are downloaded again', async () => {
  const storage = makeStorage();
  const idb = makeIndexedDB();
  const first = await bootWorker({ storage, idb, respond: () => listResponse(oisdShaped(50)) });
  await first.ctx.addSubscription(LIST_URL);

  idb.records.clear(); // evicted by the browser between two runs
  const second = await bootWorker({ storage, idb, respond: () => listResponse(oisdShaped(50)) });
  await until(() => second.ctx.hostListedInSubscriptions('site3.example'), 'the list to be restored');
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].headers['If-None-Match'], undefined,
    'a 304 would restore nothing, so the request is unconditional');
});

test('public-suffix entries in a list are dropped, as in the bundled list', async () => {
  const text = ['*://*.github.io/*', '*://*.blogspot.com/*', '*://*.real.example/*'].join('\n');
  const { ctx, storage } = await bootWorker({ respond: () => listResponse(text) });
  await ctx.addSubscription(LIST_URL);

  assert.equal(ctx.hostListedInSubscriptions('someone.github.io'), false);
  assert.equal(ctx.hostListedInSubscriptions('someone.blogspot.com'), false);
  assert.equal(ctx.hostListedInSubscriptions('real.example'), true);
  assert.equal(stored(storage).subscription.skipped, 2, 'and reported as skipped');
});

test('switching a list off stops it at once; back on needs no download', async () => {
  const { ctx, storage, requests } = await bootWorker({ respond: () => listResponse(oisdShaped(50)) });
  await ctx.addSubscription(LIST_URL);
  const { id } = stored(storage).subscription;

  await ctx.setSubscriptionEnabled(id, false);
  assert.equal(ctx.hostListedInSubscriptions('site1.example'), false);
  await ctx.setSubscriptionEnabled(id, true);
  assert.equal(ctx.hostListedInSubscriptions('site1.example'), true);
  assert.equal(requests.length, 1);
});
