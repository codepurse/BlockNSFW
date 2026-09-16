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
  const ctx = {
    URL,
    URLSearchParams,
    Date,
    Math,
    Promise,
    Map,
    Set,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => 'test-device-id' },
    chrome: {
      runtime: { getURL: (p) => BASE + p, getManifest: () => ({ version: 'test' }) },
      storage: {
        local: {
          get: async (key) => (typeof key === 'string' ? { [key]: disk[key] } : disk),
          set: async (values) => Object.assign(disk, values),
        },
      },
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ ok: true, Status: 0, data: { over18: false }, stories: [] }),
      };
    },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('shared/privacy-guard.js'), ctx);
  return { ctx, requests, disk };
}

test('public downloads strip headers, credentials and referrer; redirects cannot forward them', async () => {
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
  assert.equal(requests[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(requests).includes('PRIVATE_'));
});

test('Request-like objects cannot smuggle browsing data into approved downloads', async () => {
  const { ctx, requests } = context();
  await ctx.fetch({ url: DOWNLOAD, method: 'GET', headers: { 'X-Page': PRIVATE_URL } });
  assert.equal(requests[0].url, DOWNLOAD);
  assert.ok(!JSON.stringify(requests).includes('PRIVATE_'));
});

for (const url of [
  PRIVATE_URL,
  DOWNLOAD + '?page=PRIVATE_SEARCH_MARKER',
  DOWNLOAD + '#PRIVATE_SEARCH_MARKER',
  DOWNLOAD.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.example'),
  'https://example.test/report',
  'https://www.reddit.com/r/PRIVATE_SEARCH_MARKER/about.json',
]) {
  test(`privacy mode rejects non-public-download destination ${url}`, async () => {
    const { ctx, requests } = context();
    await assert.rejects(ctx.fetch(url), /Privacy mode/);
    assert.equal(requests.length, 0);
  });
}

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

test('changes in privacy setting apply to the next fetch in the same context', async () => {
  const { ctx, requests, disk } = context({ privacyMode: false });
  await ctx.fetch(PRIVATE_URL);
  disk.pblocker_settings.privacyMode = true;
  await assert.rejects(ctx.fetch(PRIVATE_URL), /Privacy mode/);
  assert.equal(requests.length, 1);
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

test('real DNS provider client cannot disclose the checked hostname', async () => {
  const { ctx, requests } = context();
  vm.runInContext(read('shared/dns-providers.js'), ctx);
  const result = await ctx.DnsProviders.queryProvider(
    ctx.DnsProviders.getProviderOrDefault('cloudflare'),
    'private.example.com',
    100,
  );
  assert.equal(result, null);
  assert.equal(requests.length, 0);
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

test('offscreen image classifier cannot re-request a private image address', async () => {
  const { ctx, requests } = context();
  Object.assign(ctx, {
    Models: { resolveModel: () => ({ inputSize: 224 }) },
    loadModel: async () => ({}),
  });
  vm.runInContext(functionSource('offscreen.js', 'classify'), ctx);
  await assert.rejects(ctx.classify(PRIVATE_URL, 'nsfwjs'), /Privacy mode/);
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
