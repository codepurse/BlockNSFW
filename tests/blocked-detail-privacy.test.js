// The blocked address must not enter browser history (audit finding M3).
//
// content.js reaches the blocked page with location.replace(), so the adult
// URL itself is not left in history. Its replacement was
//
//   blocked.html?url=https%3A%2F%2F<adult site>&reason=…&matched=porn,xxx
//
// which IS a history entry, and carries the same URL. It shows in history
// search, in omnibox suggestions, and Chrome uploads it to the user's Google
// account when history sync is on. For a tool whose users are trying not to
// leave that trail, this was the worst place in the product to put it.
//
// The detail now goes to session storage — memory only, never on disk, gone
// when the browser closes — under a random key, and only the key travels in
// the URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const blockedSource = fs.readFileSync(path.join(ROOT, 'blocked.js'), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not parse ${name}`);
}

// Run getBlockedRedirectUrl() with a controllable session-storage stub.
function buildRedirect({ sessionAvailable = true, pageType = 'default', privacyMode = false } = {}) {
  const written = {};
  const sandbox = {
    console,
    privacyMode,
    URL,
    crypto: { randomUUID: () => '1111-2222' },
    Date,
    Math,
    blockedPageType: pageType,
    customBlockedPageUrl: pageType === 'custom' ? 'https://example.test/blocked' : '',
    plainBlockedPageHtml: pageType === 'plain_html' ? '<h1>{{url}}</h1>' : '',
    browserAPI: {
      runtime: { getURL: (p) => 'chrome-extension://abc/' + p },
      storage: sessionAvailable
        ? { session: { set: (obj) => { Object.assign(written, obj); return Promise.resolve(); } } }
        : {}
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'const BLOCK_DETAIL_PREFIX = "pblocker_block_detail_";\n' +
    functionSource(contentSource, 'newBlockDetailKey') + '\n' +
    functionSource(contentSource, 'stashBlockedDetail') + '\n' +
    functionSource(contentSource, 'getBlockedRedirectUrl'), sandbox);

  const url = sandbox.getBlockedRedirectUrl(
    'https://explicit.test/some/page?q=1', 'default_blocklist', null,
    { matched: ['porn', 'xxx'], score: 0.94 });
  return { url, written };
}

test('M3: the blocked address is not in the redirect URL', () => {
  const { url } = buildRedirect();
  assert.ok(!url.includes('explicit.test'),
    `the site's address is still in the history entry: ${url}`);
  assert.ok(!url.includes('porn'),
    'the matched terms are still in the history entry — those are as revealing as the URL');
  assert.match(url, /^chrome-extension:\/\/abc\/blocked\.html\?k=/);
});

test('M3: the detail is stashed where it can be read back', () => {
  const { url, written } = buildRedirect();
  const key = decodeURIComponent(url.split('?k=')[1]);
  const record = written[key];
  assert.ok(record, 'nothing was written to session storage');
  assert.equal(record.url, 'https://explicit.test/some/page?q=1');
  assert.equal(record.reason, 'default_blocklist');
  assert.deepEqual(Array.from(record.matched), ['porn', 'xxx']);
  assert.equal(record.score, 0.94);
  assert.equal(typeof record.ts, 'number');
});

test('M3: session storage is the only place it goes', () => {
  // Not storage.local — that is on disk, and the point is to leave no trace
  // after the browser closes.
  const stash = functionSource(contentSource, 'stashBlockedDetail');
  assert.match(stash, /storage\.session/);
  assert.ok(!/storage\.local/.test(stash),
    'the blocked address must not be written to disk');
});

test('M3: without session storage it falls back to the old query string', () => {
  // Losing the reason and the matched terms would be worse than the history
  // entry, and on a browser with no session storage there is nowhere better.
  const { url } = buildRedirect({ sessionAvailable: false });
  assert.ok(url.includes('url=https%3A%2F%2Fexplicit.test'),
    'the fallback must still carry the detail');
  assert.ok(url.includes('reason=default_blocklist'));
});

test('M3: a custom blocked page keeps the query string', () => {
  // It is someone else's document and cannot read our session storage.
  const { url } = buildRedirect({ pageType: 'custom' });
  assert.ok(url.startsWith('https://example.test/blocked'));
  assert.ok(url.includes('url=https%3A%2F%2Fexplicit.test'));
});

test('M3: blocked.js reads the key, and deletes the record after', () => {
  const loader = functionSource(blockedSource, 'loadStashedDetail');
  assert.match(loader, /storage\.session/);
  assert.match(loader, /area\.remove\(detailKey\)/,
    'the record exists to survive one navigation and should not outlive it');
  // content.js stashes fire-and-forget so the redirect is not delayed, which
  // leaves a race this page has to absorb.
  assert.match(loader, /for \(const waitMs of/, 'a missing record should be retried');
});

test('M3: the page still renders when nothing was stashed', () => {
  // A blocked page that fails to appear is far worse than one missing its
  // reason line.
  const driver = blockedSource.slice(blockedSource.indexOf('(async () => {'));
  assert.match(driver, /await loadStashedDetail\(\);/);
  assert.match(driver, /renderDetail\(\);/);
  assert.match(driver, /catch/, 'a failed lookup must not stop the render');
});

test('M3: both rendering paths see the stashed detail', () => {
  // renderPlainHtml() used to run in its own IIFE, which would have rendered
  // the query string's values while renderDetail() showed the stashed ones.
  const driver = blockedSource.slice(blockedSource.indexOf('// One driver'));
  const load = driver.indexOf('loadStashedDetail');
  const plain = driver.indexOf('renderPlainHtml');
  const normal = driver.indexOf('renderDetail');
  assert.ok(load !== -1 && plain !== -1 && normal !== -1);
  assert.ok(load < plain && load < normal,
    'the detail must be loaded before either path renders');
});

test('H3/M3: the background widens session-storage access for content scripts', () => {
  // Chrome defaults session storage to TRUSTED_CONTEXTS, so a content script
  // cannot write to it and the failure is silent. Without this call the stash
  // above never lands — and neither does the AI image verdict cache, which is
  // why that has never persisted across page loads on Chrome.
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(background, /setAccessLevel\(\{/);
  assert.match(background, /TRUSTED_AND_UNTRUSTED_CONTEXTS/);
});


test('privacy mode replaces an external blocked page with the built-in page', () => {
  const { url } = buildRedirect({ pageType: 'custom', privacyMode: true });
  assert.match(url, /^chrome-extension:\/\/abc\/blocked\.html\?k=/);
  assert.ok(!url.includes('explicit.test'));
});

test('privacy mode does not embed browsing data when session storage is unavailable', () => {
  const { url } = buildRedirect({ pageType: 'custom', privacyMode: true, sessionAvailable: false });
  assert.equal(url, 'chrome-extension://abc/blocked.html');
});
