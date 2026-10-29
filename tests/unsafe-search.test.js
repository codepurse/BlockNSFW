// Search engines SafeSearch can't reach.
//
// SafeSearch is forced on about ten engines, and their results are filtered on
// the page. On any other, results aren't filtered, an image search shows
// thumbnails the engine serves itself, and some open the sites they list on
// their own servers (Startpage's "Visit in Anonymous View", the real address
// encrypted), so neither the blocklist nor DNS sees the site. "A search engine
// without a filter" is the first thing someone looks for when SafeSearch is in
// the way. Unless its own switch is off, the engines in
// shared/unsafe-search.js are blocked outright: by address before the page
// loads, and SearXNG, which runs on any host, from its pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UnsafeSearch = require('../shared/unsafe-search.js');
const { loadBackgroundContext } = require('./setup.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const contentSource = read('content.js');

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

const held = (url, rules) => {
  const rule = UnsafeSearch.matchAddress(url, rules);
  return rule ? rule.name : null;
};

// A page reduced to what matchPage reads: which selectors match, and the
// generator meta.
function page({ selectors = [], generator = null } = {}) {
  const present = new Set(selectors);
  return {
    querySelector(selector) {
      if (selector === 'meta[name="generator"]') return generator === null ? null : { content: generator };
      if (selector === 'not a selector [') throw new Error('SyntaxError');
      return present.has(selector) ? {} : null;
    }
  };
}

// --- By address -----------------------------------------------------------------

test('the whole engine is blocked by address, search, images and all', () => {
  for (const [url, name] of [
    ['https://www.startpage.com/', 'Startpage'],
    ['https://www.startpage.com/sp/search?query=cats', 'Startpage'],
    ['https://www.startpage.com/sp/search?query=cats&cat=images', 'Startpage'],
    // "Visit in Anonymous View" opens a listed site on Startpage's own server.
    ['https://us3-browse.startpage.com/av/proxy?ep=4358&ek=6645&ekdata=928b', 'Startpage'],
    ['https://www.ixquick.com/do/search?query=cats', 'Startpage'],
    ['https://www.mojeek.com/search?q=cats', 'Mojeek'],
    ['https://www.mojeek.com/images?q=cats', 'Mojeek'],
    ['https://kagi.com/search?q=cats', 'Kagi'],
    ['https://www.dogpile.com/serp?q=cats', 'Dogpile'],
    ['https://metager.org/meta/meta.ger3?eingabe=cats', 'MetaGer'],
    ['https://www.ask.com/web?q=cats', 'Ask'],
    ['https://search.lycos.com/web/?q=cats', 'Lycos Search']
  ]) {
    assert.equal(held(url), name, url);
  }
});

test('the engines SafeSearch covers, safe-by-design ones and look-alikes stay open', () => {
  for (const url of [
    'https://www.google.com/search?q=cats&tbm=isch',
    'https://mail.google.com/mail/u/0/',
    'https://www.bing.com/images/search?q=cats',
    'https://duckduckgo.com/?q=cats&ia=images',
    'https://search.brave.com/images?q=cats',
    'https://search.yahoo.com/search?p=cats',
    'https://www.ecosia.org/search?q=cats',
    'https://www.qwant.com/?q=cats',
    'https://yandex.com/images/search?text=cats',
    'https://www.kiddle.co/s.php?q=cats',
    'https://swisscows.com/en/web?query=cats',
    'https://www.lycos.com/',
    'https://notkagi.com/search',
    'https://kagi.com.evil.test/search',
    'https://searx.example/search?q=cats',
    'not an address',
    'chrome-extension://abc/search'
  ]) {
    assert.equal(held(url), null, url);
  }
});

test('no engine that ships is one SafeSearch covers', () => {
  for (const engine of UnsafeSearch.ENGINES) {
    for (const host of engine.hosts || []) {
      assert.equal(UnsafeSearch.isProtectedHost(host), false, host);
    }
  }
});

// --- From the page --------------------------------------------------------------

test('SearXNG is blocked on any host, every page of it', () => {
  const url = 'https://search.anyone.example/search?q=cats';
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'searxng/2026.10.28+c360868e5' }), url).name, 'SearXNG');
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'searxng/2026.10.28' }), 'https://search.anyone.example/').name, 'SearXNG',
    'its home page too');
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'searx/1.1.0' }), url).name, 'SearXNG', 'the older searx too');
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'WordPress 6.6' }), url), null);
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'Sphinx 7.2' }), 'https://docs.searxng.org/'), null, 'its own docs are not a search engine');
  assert.equal(UnsafeSearch.matchPage(page(), url), null, 'no generator at all');
});

test('host rules are left to the address check, and page rules need their selector', () => {
  // A whole-host rule never needs the page; the address check has it.
  assert.equal(UnsafeSearch.matchPage(page(), 'https://www.mojeek.com/search?q=x'), null);
  const rules = UnsafeSearch.rulesFrom({ rules: [{ name: 'Odd', hosts: ['odd.example'], page: ['not a selector [', 'div.images'] }] });
  assert.equal(held('https://odd.example/', rules), null, 'a host-and-page rule waits for the page');
  assert.equal(UnsafeSearch.matchPage(page({ selectors: ['div.images'] }), 'https://odd.example/', rules).name, 'Odd');
  assert.equal(UnsafeSearch.matchPage(page(), 'https://odd.example/', rules), null);
  assert.equal(UnsafeSearch.matchPage(null, 'https://odd.example/', rules), null);
  assert.equal(UnsafeSearch.matchPage(page(), 'not an address', rules), null);
});

// --- Downloaded rules -----------------------------------------------------------

test('downloaded rules add engines, and can\'t change or remove one that ships', () => {
  const rules = UnsafeSearch.rulesFrom({ rules: [
    { name: 'Example Search', hosts: ['search.example'] },
    { name: 'Images Only', hosts: ['pics.example'], paths: ['/images'] },
    { name: 'startpage', hosts: ['startpage.com'], paths: ['/never'] }
  ] });
  assert.equal(held('https://search.example/anything', rules), 'Example Search');
  assert.equal(held('https://pics.example/images?q=x', rules), 'Images Only');
  assert.equal(held('https://pics.example/about', rules), null, 'a path narrows a rule');
  assert.equal(held('https://www.startpage.com/sp/search?query=x', rules), 'Startpage', 'the shipped Startpage rule stands');
  assert.equal(UnsafeSearch.rulesFrom(null).length, UnsafeSearch.ENGINES.length);
  assert.equal(UnsafeSearch.rulesFrom({ rules: 'nope' }).length, UnsafeSearch.ENGINES.length);
});

test('a downloaded rule can never block an engine SafeSearch covers', () => {
  for (const hosts of [['google.com'], ['www.google.com'], ['google.co.uk'], ['images.google.com'], ['bing.com'],
    ['duckduckgo.com'], ['search.brave.com'], ['brave.com'], ['search.yahoo.com'], ['yandex.ru'], ['youtube.com'],
    ['co.uk'], ['com.au'], ['ok.example', 'bing.com']]) {
    assert.equal(UnsafeSearch.normalizeRule({ name: 'Slip', hosts }), null, hosts.join(','));
  }
  assert.ok(UnsafeSearch.normalizeRule({ name: 'Fine', hosts: ['searchgoogle-free.example'] }), 'a name merely containing one is fine');
});

test('a downloaded rule that could cover every site, or more than written, is no rule at all', () => {
  for (const raw of [
    null, 'text', {},
    { name: 'No host', paths: ['/images'] },
    { name: 'Any page', page: ['img'] },
    { name: 'Bad host', hosts: ['*.example'] },
    { name: 'TLD', hosts: ['com'] },
    { name: 'Odd generator', generator: 'searx.*' },
    { hosts: ['a.example'] },
    // Given but unreadable: dropping it would widen the rule to the whole host.
    { name: 'Regex path', hosts: ['a.example'], paths: ['images.*'] },
    { name: 'Query in path', hosts: ['a.example'], paths: ['/x?y=1'] },
    { name: 'Bad param', hosts: ['a.example'], params: { cat: ['images'], 'bad key!': ['x'] } },
    { name: 'Empty param', hosts: ['a.example'], params: { cat: [] } },
    { name: 'Bad selectors', hosts: ['a.example'], page: [7, ''] }
  ]) {
    assert.equal(UnsafeSearch.normalizeRule(raw), null, JSON.stringify(raw));
  }
  const rule = UnsafeSearch.normalizeRule({ name: ' Mixed ', hosts: ['WWW.Pics.Example', 'bad host'], params: { Tab: ['IMAGES', 7] }, extra: 'ignored' });
  assert.deepEqual(JSON.parse(JSON.stringify(rule)), { name: 'Mixed', hosts: ['pics.example'], params: { Tab: ['images'] } });
});

test('parseRemote reads data/UNSAFE_SEARCH.json and refuses anything else', () => {
  const shipped = UnsafeSearch.parseRemote(read('data/UNSAFE_SEARCH.json'));
  assert.ok(Array.isArray(shipped), 'the file in the repository parses');
  assert.equal(UnsafeSearch.parseRemote('<html>404</html>'), null);
  assert.equal(UnsafeSearch.parseRemote('{"rules": {}}'), null);
  assert.deepEqual(Array.from(UnsafeSearch.parseRemote('{"rules": [{"name": "A", "hosts": ["a.example"]}, {"name": "B"}, {"name": "G", "hosts": ["google.com"]}]}'))
    .map((r) => r.name), ['A']);
});

// --- Wiring ---------------------------------------------------------------------

test('the address is checked early, after the whitelist and only with its switch on', () => {
  const early = contentSource.slice(contentSource.indexOf('(function instantBlockEarly()'));
  const allowAt = early.indexOf('if (isAllowed(normalizedHost, pathname)) return;');
  const checkAt = early.indexOf('UnsafeSearch.matchAddress(urlStr, UnsafeSearch.rulesFrom(result[UNSAFE_SEARCH_KEY]))');
  assert.ok(allowAt > 0 && checkAt > allowAt, 'a whitelisted engine stays open');
  assert.match(early.slice(allowAt, checkAt), /settings\.unsafeSearchEnabled !== false/);
  assert.match(early.slice(checkAt, checkAt + 200), /redirectNow\('unsafe_search', getBlockedReasonLabel\('unsafe_search'\)\)/);
  assert.match(early.slice(0, allowAt), /UNSAFE_SEARCH_KEY\s*\]\);/, 'the downloaded rules are read with the settings');
  assert.equal(/const UNSAFE_SEARCH_KEY = '([^']+)'/.exec(contentSource)[1], UnsafeSearch.STORAGE_KEY);
  assert.ok(contentSource.indexOf('const UNSAFE_SEARCH_KEY') < contentSource.indexOf('(function instantBlockEarly()'),
    'declared before the early check runs');
});

test('the page is checked first among the page-level checks, top frame only', () => {
  const check = functionSource(contentSource, 'checkUnsafeSearchPage');
  assert.match(check, /if \(!unsafeSearchOn \|\| !unsafeSearchRules/);
  assert.match(check, /redirectToBlockedPage\('unsafe_search'\)/);
  const process = functionSource(contentSource, 'processContent');
  assert.match(process, /if \(IS_TOP_FRAME\) \{\s*if \(checkUnsafeSearchPage\(\)\) return;/);
  assert.ok(process.indexOf('isCurrentPageWhitelisted()') < process.indexOf('checkUnsafeSearchPage()'), 'after the whitelist');
  const load = functionSource(contentSource, 'loadSettings');
  assert.match(load, /unsafeSearchOn = settings\.unsafeSearchEnabled !== false;/);
  assert.match(load, /unsafeSearchRules = UnsafeSearch\.rulesFrom\(result\[UNSAFE_SEARCH_KEY\]\)/);
});

test('the reason is named on the blocked page, in the history and in the label', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(functionSource(contentSource, 'getBlockedReasonLabel') + '\nglobalThis.label = getBlockedReasonLabel;', sandbox);
  const label = sandbox.label('unsafe_search');
  assert.equal(label, 'Blocked search engine without SafeSearch');
  const audit = read('audit.js');
  assert.match(audit, new RegExp(`'${label.toLowerCase()}': 'Other search engines'`));
  assert.match(audit, /unsafe_search: 'Other search engines'/);
  const meta = functionSource(read('blocked.js'), 'getReasonMeta');
  assert.match(meta, /case 'unsafe_search':[\s\S]{0,80}sourceLabel: 'Other search engines'/);
  assert.match(meta, /Search with Google, Bing or DuckDuckGo instead/, 'it says where to search instead');
});

test('it has its own switch: on by default, forced on by Storm Mode, guarded going off', () => {
  assert.match(read('background.js'), /\n  unsafeSearchEnabled: true,/);
  assert.match(read('options.js'), /\n  unsafeSearchEnabled: true,/);
  const Boost = require('../shared/boost.js');
  assert.equal(Boost.STORM_SETTINGS.unsafeSearchEnabled, true);
  assert.equal(Boost.RISK_SETTINGS.unsafeSearchEnabled, true, 'Risk Hours too');

  const html = read('options.html');
  const row = html.slice(html.indexOf('for="unsafe-search-enabled"') - 200, html.indexOf('id="unsafe-search-enabled"') + 200);
  assert.match(row, /Block other search engines/);
  assert.match(row, /data-lock="normal" data-lock-when="Turning it off"/, 'it says what turning it off asks for');
  assert.ok(html.indexOf('id="unsafe-search-enabled"') > html.indexOf('id="safe-search-enabled"'), 'next to Safe Search');

  const options = read('options.js');
  const handler = options.slice(options.indexOf("const unsafeSearchToggleEl = $('unsafe-search-enabled');"));
  assert.match(handler.slice(0, 900),
    /settings\.unsafeSearchEnabled !== false && !e\.target\.checked[\s\S]{0,80}guardWeakening\('allow search engines Safe Search can’t reach', \{\}, settingsChange\(\{ unsafeSearchEnabled: false \}\)\)/);
  assert.match(handler.slice(0, 900), /if \(!ok\) \{\s*e\.target\.checked = true;\s*return;/, 'a refused or waiting change leaves it on');
  assert.match(options, /unsafeSearchToggle\.checked = settings\.unsafeSearchEnabled !== false;/);
});

test('every content script and the background load the rules first', () => {
  for (const file of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(read(file));
    for (const script of manifest.content_scripts || []) {
      const at = script.js.indexOf('content.js');
      if (at === -1) continue;
      const shared = script.js.indexOf('shared/unsafe-search.js');
      assert.ok(shared !== -1 && shared < at, `${file}: shared/unsafe-search.js must load before content.js`);
    }
  }
  const firefox = JSON.parse(read('manifest.firefox.json')).background.scripts;
  assert.ok(firefox.indexOf('shared/unsafe-search.js') !== -1 && firefox.indexOf('shared/unsafe-search.js') < firefox.indexOf('background.js'));
  assert.match(read('background.js'), /self\.importScripts\('shared\/unsafe-search\.js'\);/);
});

// --- The download ---------------------------------------------------------------

async function runDownload({ stored, response, forceRefresh = false }) {
  // The worker starts with no UnsafeSearch, so its own start-up download does
  // nothing; the module arrives once start-up is over, with the stubs.
  const context = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', context);
  context.UnsafeSearch = UnsafeSearch;
  const writes = [];
  const fetched = [];
  context.chrome.storage.local.get = () => Promise.resolve(stored ? { [UnsafeSearch.STORAGE_KEY]: stored } : {});
  context.chrome.storage.local.set = (items) => { writes.push(JSON.parse(JSON.stringify(items))); return Promise.resolve(); };
  context.fetch = (url) => {
    fetched.push(String(url));
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve({ ok: response.ok !== false, text: async () => response.text });
  };
  const result = await context.ensureUnsafeSearchUpToDate({ forceRefresh });
  return { result: JSON.parse(JSON.stringify(result)), writes, fetched };
}

test('the list is downloaded from the repository and kept for the content script', async () => {
  const { writes, fetched } = await runDownload({
    response: { text: JSON.stringify({ rules: [{ name: 'Example Search', hosts: ['search.example'] }] }) }
  });
  assert.deepEqual(fetched, ['https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/UNSAFE_SEARCH.json']);
  const kept = writes[0][UnsafeSearch.STORAGE_KEY];
  assert.equal(kept.rules[0].name, 'Example Search');
  assert.ok(kept.checkedAt > 0 && kept.updatedAt === kept.checkedAt);
});

test('a fresh list is not downloaded again; a failed download keeps the old one and waits', async () => {
  const recent = { rules: [{ name: 'Old', hosts: ['old.example'] }], checkedAt: Date.now() - 1000, updatedAt: 5 };
  const fresh = await runDownload({ stored: recent, response: { text: '{"rules": []}' } });
  assert.equal(fresh.fetched.length, 0);
  assert.equal(fresh.writes.length, 0);

  const stale = { ...recent, checkedAt: Date.now() - 13 * 60 * 60 * 1000 };
  for (const response of [new Error('offline'), { ok: false, text: 'Not Found' }, { text: '<html>' }]) {
    const { writes } = await runDownload({ stored: stale, response });
    const kept = writes[0][UnsafeSearch.STORAGE_KEY];
    assert.deepEqual(kept.rules.map((r) => r.name), ['Old'], 'the old rules stay');
    assert.equal(kept.updatedAt, 5);
    assert.ok(Date.now() - kept.checkedAt < 5000, 'and the next try waits a full interval');
  }

  const forced = await runDownload({ stored: recent, response: { text: '{"rules": []}' }, forceRefresh: true });
  assert.equal(forced.fetched.length, 1, 'Refresh in Settings fetches anyway');
});
