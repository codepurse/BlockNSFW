const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const BASE = 'chrome-extension://privacy-test/';
const DOWNLOAD =
  'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/HOSTS.txt';
const PRIVATE_URL = 'https://private.example/path?search=PRIVATE_SEARCH_MARKER';
// Independent, reviewable contract; never load the production allowlist here.
const contract = JSON.parse(read('tests/fixtures/privacy-contract.json'));

function functionSource(file, name) {
  const source = read(file);
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed function ' + name);
}

function context(settings = { privacyMode: true }) {
  const requests = [];
  const disk = { pblocker_settings: settings };
  const listeners = [];
  const reads = { count: 0 };
  const ctx = {
    URL,
    URLSearchParams,
    Date,
    Math,
    Promise,
    Map,
    Set,
    AbortController,
    btoa,
    atob,
    TextEncoder,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => 'test-device-id' },
    chrome: {
      runtime: { getURL: (p) => BASE + p, getManifest: () => ({ version: 'test' }) },
      storage: {
        local: {
          get: async (key) => {
            reads.count++;
            return typeof key === 'string' ? { [key]: disk[key] } : disk;
          },
          set: async (values) => {
            const changes = {};
            for (const [key, newValue] of Object.entries(values)) {
              changes[key] = { oldValue: disk[key], newValue };
            }
            Object.assign(disk, values);
            for (const listener of listeners) listener(changes, 'local');
          },
        },
        onChanged: { addListener: (listener) => listeners.push(listener) },
      },
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ ok: true, Status: 0, data: { over18: false }, stories: [] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('shared/privacy-guard.js'), ctx);
  return { ctx, requests, disk, reads };
}

function assertClean(request, options) {
  for (const [key, value] of Object.entries(options)) {
    assert.equal(request.init[key], value, key);
  }
  assert.ok(!JSON.stringify(request).includes('PRIVATE_'), JSON.stringify(request));
}

test('public downloads strip headers, credentials and referrer before following a redirect', async () => {
  const { ctx, requests } = context();
  await ctx.fetch(DOWNLOAD, {
    headers: { Authorization: 'PRIVATE_SECRET', 'X-Page': PRIVATE_URL },
    credentials: 'include',
    referrer: PRIVATE_URL,
    redirect: 'follow',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.referrerPolicy, 'no-referrer');
  // A redirect only ever sees the fixed public URL, so following one is safe
  // and keeps list updates working if GitHub moves raw content.
  assert.equal(requests[0].init.redirect, 'follow');
  assert.equal(requests[0].init.headers, undefined);
  assert.ok(!JSON.stringify(requests).includes('PRIVATE_'));
});

test('Request-like objects cannot smuggle browsing data into approved downloads', async () => {
  const { ctx, requests } = context();
  await ctx.fetch({ url: DOWNLOAD, method: 'GET', headers: { 'X-Page': PRIVATE_URL } });
  assert.equal(requests[0].url, DOWNLOAD);
  assert.ok(!JSON.stringify(requests).includes('PRIVATE_'));
});

for (const url of contract.allowedDownloads) {
  test(`privacy contract allows only a sanitized public GET: ${url}`, async () => {
    const { ctx, requests } = context();
    await ctx.fetch(url, {
      headers: { Authorization: 'PRIVATE_SECRET', 'X-Page': PRIVATE_URL },
      credentials: 'include',
      referrer: PRIVATE_URL,
      redirect: 'follow',
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, url);
    assertClean(requests[0], contract.requiredRequestOptions);
  });
}

for (const url of contract.allowedDnsQueries) {
  test(`privacy contract allows a bare DNS query to a chosen resolver: ${new URL(url).host}`, async () => {
    const { ctx, requests } = context();
    vm.runInContext(read('shared/dns-providers.js'), ctx);
    await ctx.fetch(url, {
      headers: { Accept: 'application/dns-message', 'X-Page': PRIVATE_URL },
      credentials: 'include',
      referrer: PRIVATE_URL,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, url);
    assert.deepEqual({ ...requests[0].init.headers }, { Accept: 'application/dns-message' });
    assertClean(requests[0], contract.requiredDnsRequestOptions);
  });
}

for (const { name, url, method = 'GET', body } of contract.deniedRequests) {
  test(`privacy contract rejects ${name}`, async () => {
    const { ctx, requests } = context();
    vm.runInContext(read('shared/dns-providers.js'), ctx);
    await assert.rejects(ctx.fetch(url, { method, ...(body ? { body } : {}) }));
    assert.equal(requests.length, 0);
  });
}

test('permission expansion requires explicit privacy contract review', () => {
  for (const file of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(read(file));
    const permissions = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
    for (const permission of contract.forbiddenPermissions) {
      assert.ok(
        !permissions.includes(permission),
        `${file}: review ${permission} before adding it`,
      );
    }
    assert.equal(manifest.externally_connectable, undefined, 'review external message access');
  }
});

test('POST to a public download URL is rejected', async () => {
  const { ctx, requests } = context();
  await assert.rejects(ctx.fetch(DOWNLOAD, { method: 'POST', body: PRIVATE_URL }), /Privacy mode/);
  assert.equal(requests.length, 0);
});

test('local packaged assets remain readable', async () => {
  const { ctx, requests } = context();
  await ctx.fetch(BASE + 'text-model.json');
  assert.equal(requests.length, 1);
});

test('relative content-script URLs cannot bypass the extension-origin check', async () => {
  const { ctx, requests } = context();
  for (const url of ['/PRIVATE_MARKER', '//third-party.example/PRIVATE_MARKER']) {
    await assert.rejects(ctx.fetch(url));
  }
  assert.equal(requests.length, 0);
});

test('a settings read failure fails closed', async () => {
  const { ctx, requests } = context();
  ctx.chrome.storage.local.get = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(ctx.fetch(PRIVATE_URL), /storage unavailable/);
  assert.equal(requests.length, 0);
});

test('a failed settings read is retried rather than cached', async () => {
  const { ctx, requests } = context({ privacyMode: false });
  const get = ctx.chrome.storage.local.get;
  ctx.chrome.storage.local.get = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(ctx.fetch(PRIVATE_URL), /storage unavailable/);
  ctx.chrome.storage.local.get = get;
  await ctx.fetch(PRIVATE_URL);
  assert.equal(requests.length, 1);
});

test('settings are read once, not on every fetch', async () => {
  const { ctx, reads } = context({ privacyMode: false });
  for (let i = 0; i < 5; i++) await ctx.fetch(PRIVATE_URL);
  assert.equal(reads.count, 1);
});

test('changes in privacy setting apply to the next fetch in the same context', async () => {
  const { ctx, requests } = context({ privacyMode: false });
  await ctx.fetch(PRIVATE_URL);
  await ctx.chrome.storage.local.set({ pblocker_settings: { privacyMode: true } });
  await assert.rejects(ctx.fetch(PRIVATE_URL), /Privacy mode/);
  await ctx.chrome.storage.local.set({ pblocker_settings: { privacyMode: false } });
  await ctx.fetch(PRIVATE_URL);
  assert.equal(requests.length, 2);
});

test('real report and community clients cannot transmit content or identifiers', async () => {
  const { ctx, requests } = context();
  vm.runInContext(
    read('appwrite-client.js') +
      '\nglobalThis.reports = PBlockerReports; globalThis.stories = PBlockerStories;',
    ctx,
  );
  await assert.rejects(
    ctx.reports.submitReport({
      url: PRIVATE_URL,
      domain: 'private.example',
      reportType: 'should_block',
      category: 'adult',
      notes: 'PRIVATE_NOTE',
    }),
    /Privacy mode/,
  );
  await assert.rejects(ctx.stories.fetchStories(), /Privacy mode/);
  await assert.rejects(ctx.stories.likeStory('story', true), /Privacy mode/);
  await assert.rejects(
    ctx.stories.submitStory({
      title: 'PRIVATE_TITLE',
      content: 'PRIVATE_CONTENT long enough for validation',
    }),
    /Privacy mode/,
  );
  assert.equal(requests.length, 0);
});

test('real DNS client sends only the hostname, to the chosen resolver', async () => {
  const { ctx, requests } = context();
  vm.runInContext(read('shared/dns-providers.js'), ctx);
  for (const id of ['cloudflare', 'adguard']) {
    await ctx.DnsProviders.queryProvider(
      ctx.DnsProviders.getProviderOrDefault(id),
      'checked.example.com',
      100,
    );
  }
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).host, 'family.cloudflare-dns.com');
  assert.equal(new URL(requests[1].url).host, 'dns-family.adguard.com');
  for (const request of requests) assertClean(request, contract.requiredDnsRequestOptions);
});

test('a custom resolver is reachable only once the user has set it', async () => {
  const custom = 'https://dns.resolver.example/abc123';
  const query = custom + '?dns=AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE';
  const unset = context();
  vm.runInContext(read('shared/dns-providers.js'), unset.ctx);
  await assert.rejects(unset.ctx.fetch(query), /Privacy mode/);
  assert.equal(unset.requests.length, 0);

  const chosen = context({ privacyMode: true, dnsProvider: 'custom', dnsCustomUrl: custom });
  vm.runInContext(read('shared/dns-providers.js'), chosen.ctx);
  await chosen.ctx.DnsProviders.queryProvider(
    chosen.ctx.DnsProviders.makeCustomProvider(custom),
    'checked.example.com',
    100,
  );
  assert.equal(chosen.requests.length, 1);
  assert.ok(chosen.requests[0].url.startsWith(custom + '?dns='));
  assertClean(chosen.requests[0], contract.requiredDnsRequestOptions);
});

test('Reddit lookup is skipped in privacy mode even with smart blocking on', async () => {
  const { ctx, requests } = context();
  Object.assign(ctx, { privacyMode: true, useSmartBlocking: true });
  vm.runInContext(functionSource('content.js', 'checkRedditSubredditNSFW'), ctx);
  assert.equal(await ctx.checkRedditSubredditNSFW('PRIVATE_SUBREDDIT'), false);
  assert.equal(requests.length, 0);
});

test('guard also stops a Reddit lookup from a stale content-script setting', async () => {
  const { ctx, requests } = context();
  Object.assign(ctx, {
    privacyMode: false,
    useSmartBlocking: true,
    debugMode: false,
    redditNSFWCache: new Map(),
    REDDIT_CACHE_DURATION: 1000,
    log() {},
  });
  vm.runInContext(functionSource('content.js', 'checkRedditSubredditNSFW'), ctx);
  assert.equal(await ctx.checkRedditSubredditNSFW('PRIVATE_SUBREDDIT'), false);
  assert.equal(requests.length, 0);
});

test('AI image re-fetch repeats the image request bare, from cache', async () => {
  const { ctx, requests } = context();
  Object.assign(ctx, {
    Models: { resolveModel: () => ({ inputSize: 224 }) },
    loadModel: async () => ({}),
  });
  vm.runInContext(functionSource('offscreen.js', 'classify'), ctx);
  const image = 'https://images.example/photo.jpg';
  // The stub response has no pixels; only the request matters here.
  await assert.rejects(ctx.classify(image, 'nsfwjs'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, image);
  assertClean(requests[0], {
    method: 'GET',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'force-cache',
  });
  assert.equal(requests[0].init.headers, undefined);
});

test('AI image re-fetch refuses non-web addresses and plain fetch refuses images', async () => {
  const { ctx, requests } = context();
  await assert.rejects(ctx.PrivacyGuard.fetchImage('ftp://images.example/photo.jpg'), /Privacy mode/);
  await assert.rejects(ctx.fetch('https://images.example/photo.jpg'), /Privacy mode/);
  assert.equal(requests.length, 0);
});

test('only the AI classifiers use the image re-fetch path', () => {
  const runtime = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => read(f).includes('fetchImage('));
  assert.deepEqual(runtime.sort(), ['background.js', 'offscreen.js']);
});

test('subscribed list downloads are refused', async () => {
  const { ctx, requests } = context();
  await assert.rejects(
    ctx.fetch('https://lists.example/nsfw.txt', { cache: 'no-store', redirect: 'follow' }),
    /Privacy mode/,
  );
  assert.equal(requests.length, 0);
});

test('guard precedes feature and vendor scripts in both manifests and all runtime HTML', () => {
  for (const name of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(read(name));
    assert.equal(manifest.content_scripts[0].js[0], 'shared/privacy-guard.js');
    if (manifest.background.scripts)
      assert.equal(manifest.background.scripts[0], 'shared/privacy-guard.js');
  }
  assert.ok(
    read('background.js').indexOf("importScripts('shared/privacy-guard.js')") <
      read('background.js').indexOf('const browserAPI'),
  );
  for (const file of fs.readdirSync(ROOT).filter((file) => file.endsWith('.html'))) {
    const first = read(file).match(/<script\s+src="([^"]+)"/);
    if (first) assert.equal(first[1], 'shared/privacy-guard.js', file);
  }
});

test('runtime sources do not introduce an unguarded non-fetch transport', () => {
  const files = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith('.js'))
    .concat(
      fs
        .readdirSync(path.join(ROOT, 'shared'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => 'shared/' + f),
    );
  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /new\s+(?:XMLHttpRequest|WebSocket|EventSource)|\.sendBeacon\s*\(|\.setUninstallURL\s*\(/,
      file,
    );
  }
});
