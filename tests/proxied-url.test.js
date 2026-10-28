// Tests for shared/proxied-url.js — the real address behind a page shown
// through Google Translate or the Wayback Machine.
//
// Both serve someone else's site from their own host, which let a listed site
// with a plain name through: the blocklist had only ever heard of the site's
// own host. The background and the content script check the unwrapped address
// as the site itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unwrap, decodeTranslateHost } = require('../shared/proxied-url.js');

test('Translate proxy: the host comes back with its dots and hyphens', () => {
  assert.equal(decodeTranslateHost('www-example-com'), 'www.example.com');
  assert.equal(decodeTranslateHost('my--site-example-com'), 'my-site.example.com');
  assert.equal(decodeTranslateHost('xn----p1ai-com'), 'xn--p1ai.com');
  assert.equal(decodeTranslateHost('localhost'), null);
  assert.equal(decodeTranslateHost('bad_host-com'), null);
});

test('Translate proxy: the page keeps its path and query, without Translate\'s own', () => {
  assert.equal(
    unwrap('https://www-example-com.translate.goog/videos/1?page=2&_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en&_x_tr_pto=wapp'),
    'https://www.example.com/videos/1?page=2'
  );
  assert.equal(
    unwrap('https://yardsale--xxx-com.translate.goog/?_x_tr_sl=auto&_x_tr_tl=en'),
    'https://yardsale-xxx.com/'
  );
});

test('Translate page: the address in u= is the site', () => {
  assert.equal(
    unwrap('https://translate.google.com/translate?sl=auto&tl=en&u=https://www.example.com/page'),
    'https://www.example.com/page'
  );
  assert.equal(
    unwrap('https://translate.google.co.uk/website?sl=auto&tl=en&u=example.com'),
    'http://example.com/'
  );
  assert.equal(
    unwrap('https://translate.googleusercontent.com/translate_c?depth=1&u=https%3A%2F%2Fexample.com%2Fa'),
    'https://example.com/a'
  );
  assert.equal(unwrap('https://translate.google.com/?sl=auto&tl=en&text=hello'), null);
});

test('Wayback Machine: a snapshot is the site it archived', () => {
  assert.equal(unwrap('https://web.archive.org/web/20240101000000/https://example.com/'), 'https://example.com/');
  assert.equal(unwrap('https://web.archive.org/web/20240101000000im_/https://example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.equal(unwrap('https://web.archive.org/web/20240101000000/http://example.com/watch?v=1'), 'http://example.com/watch?v=1');
  assert.equal(unwrap('https://web.archive.org/web/2024/example.com/page'), 'http://example.com/page');
  assert.equal(unwrap('https://web.archive.org/web/https://example.com/'), 'https://example.com/');
  assert.equal(unwrap('https://wayback.archive.org/web/20240101000000/https://example.com/'), 'https://example.com/');
});

test('Wayback Machine: calendar and search pages name the site too', () => {
  assert.equal(unwrap('https://web.archive.org/web/*/example.com*'), 'http://example.com/');
  assert.equal(unwrap('https://web.archive.org/web/2024*/https://example.com/*'), 'https://example.com/');
});

test('Wayback Machine: its own pages are not a site', () => {
  assert.equal(unwrap('https://web.archive.org/'), null);
  assert.equal(unwrap('https://web.archive.org/details/texts'), null);
  assert.equal(unwrap('https://archive.org/web/'), null);
});

test('layers are peeled to the site underneath', () => {
  assert.equal(
    unwrap('https://web-archive-org.translate.goog/web/20240101000000/https://example.com/?_x_tr_sl=auto&_x_tr_tl=en'),
    'https://example.com/'
  );
});

test('ordinary addresses are left alone', () => {
  assert.equal(unwrap('https://www.example.com/'), null);
  assert.equal(unwrap('https://www.google.com/search?q=translate'), null);
  assert.equal(unwrap('https://goog.translate.example/'), null);
  assert.equal(unwrap('not a url'), null);
  assert.equal(unwrap(''), null);
  assert.equal(unwrap(null), null);
});

test('the content script and the background both load it', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const scripts = manifest.content_scripts[0].js;
    assert.ok(scripts.indexOf('shared/proxied-url.js') !== -1, `${file} content script`);
    assert.ok(scripts.indexOf('shared/proxied-url.js') < scripts.indexOf('content.js'), `${file} order`);
  }
  const firefox = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
  const bg = firefox.background.scripts;
  assert.ok(bg.indexOf('shared/proxied-url.js') !== -1 && bg.indexOf('shared/proxied-url.js') < bg.indexOf('background.js'));
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /importScripts\('shared\/proxied-url\.js'\)/);
  assert.match(background, /ProxiedUrl\.unwrap\(urlStr\)/);
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(content, /ProxiedUrl\.unwrap\(urlStr\)/);
});
