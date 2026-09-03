// Tests for shared/browser-key.js and the surfaces that report which browser
// the user is on.
//
// The bug this pins down: the community report and story payloads sent
// `browser: 'chrome'` as a literal, so every report submitted from Firefox
// arrived at the backend labelled Chrome. Three separate copies of the UA
// sniffing existed at the time (background.js, options.js, and the literal in
// appwrite-client.js), which is how one of them drifted into being wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { detectBrowserKey } = require('../shared/browser-key.js');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const UA = {
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
  firefoxEsr: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  brave: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0',
};

test('every Firefox user agent buckets as firefox', () => {
  assert.equal(detectBrowserKey(UA.firefox), 'firefox');
  assert.equal(detectBrowserKey(UA.firefoxAndroid), 'firefox');
  assert.equal(detectBrowserKey(UA.firefoxEsr), 'firefox');
});

test('Edge is checked before Chrome, whose token it also carries', () => {
  assert.equal(detectBrowserKey(UA.edge), 'edge');
  assert.equal(detectBrowserKey(UA.chrome), 'chrome');
});

test('Chromium forks with no token of their own bucket as chrome', () => {
  // Same engine, same extension APIs, same store — nothing that reads this key
  // needs to tell them apart.
  assert.equal(detectBrowserKey(UA.brave), 'chrome');
  assert.equal(detectBrowserKey(UA.opera), 'chrome');
});

test('an unrecognized user agent never claims to be Firefox', () => {
  // The last resort in a page context (no `browser` shim signal available) is
  // chrome; what matters is that it does not mislabel a browser as Firefox.
  assert.equal(detectBrowserKey(''), 'chrome');
  assert.equal(detectBrowserKey('SomeFutureBrowser/1.0'), 'chrome');
});

test('report and story payloads no longer hardcode a browser name', () => {
  const source = read('appwrite-client.js');
  assert.doesNotMatch(source, /browser:\s*['"]chrome['"]/,
    "appwrite-client.js must detect the browser, not send the literal 'chrome'");
  assert.equal((source.match(/browser: reportBrowserKey\(\)/g) || []).length, 2,
    'both the report and the story payload must report the real browser');
});

test('both submitting pages load browser-key.js before appwrite-client.js', () => {
  // reportBrowserKey() falls back to 'unknown' rather than throwing, so a
  // missing <script> would be silent — hence this check.
  for (const page of ['options.html', 'community.html']) {
    const html = read(page);
    const shared = html.indexOf('shared/browser-key.js');
    const client = html.indexOf('appwrite-client.js');
    assert.ok(shared !== -1, `${page} must load shared/browser-key.js`);
    assert.ok(client !== -1, `${page} must load appwrite-client.js`);
    assert.ok(shared < client, `${page} must load shared/browser-key.js first`);
  }
});
