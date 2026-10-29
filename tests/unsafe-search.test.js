// Image and video search on search engines SafeSearch can't reach.
//
// SafeSearch is forced on about ten engines. On any other, an image search
// shows thumbnails the engine serves itself, so the blocklist never sees the
// adult site behind them, and "a search engine without a filter" is the first
// thing someone looks for when SafeSearch is in the way. While SafeSearch is
// on, image and video search on the engines in shared/unsafe-search.js are
// held: by address where the address says so, and from the page where it
// doesn't (Startpage posts its search; SearXNG runs on any host). Web search on
// them still works.

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

test('image and video search held by address', () => {
  assert.equal(held('https://www.startpage.com/sp/search?query=cats&cat=images'), 'Startpage');
  assert.equal(held('https://www.startpage.com/do/dsearch?query=cats&cat=pics'), 'Startpage');
  assert.equal(held('https://eu.startpage.com/sp/search?query=cats&cat=video'), 'Startpage');
  assert.equal(held('https://www.mojeek.com/images?q=cats'), 'Mojeek');
  assert.equal(held('https://kagi.com/images?q=cats'), 'Kagi');
  assert.equal(held('https://kagi.com/videos?q=cats'), 'Kagi');
});

test('web search on the same engines is left open', () => {
  for (const url of [
    'https://www.startpage.com/sp/search?query=cats',
    'https://www.startpage.com/sp/search?query=cats&cat=web',
    'https://www.startpage.com/sp/search?query=cats&cat=news',
    'https://www.startpage.com/',
    'https://www.mojeek.com/search?q=images',
    'https://www.mojeek.com/imagesearch-about',
    'https://kagi.com/search?q=images',
    'https://kagi.com/'
  ]) {
    assert.equal(held(url), null, url);
  }
});

test('other sites, look-alikes and engines SafeSearch covers are left open', () => {
  for (const url of [
    'https://www.google.com/search?q=cats&tbm=isch',
    'https://www.bing.com/images/search?q=cats',
    'https://duckduckgo.com/?q=cats&ia=images',
    'https://example.com/images?cat=images',
    'https://notkagi.com/images',
    'https://kagi.com.evil.test/images',
    'https://searx.example/search?q=cats&categories=images',
    'not an address',
    'chrome-extension://abc/images'
  ]) {
    assert.equal(held(url), null, url);
  }
});

// --- From the page --------------------------------------------------------------

test('Startpage\'s posted image and video search is known from its search form', () => {
  const url = 'https://www.startpage.com/sp/search';
  assert.equal(UnsafeSearch.matchPage(page({ selectors: ['form#search input[name="cat"][value="images"]'] }), url).name, 'Startpage');
  assert.equal(UnsafeSearch.matchPage(page({ selectors: ['form#search input[name="cat"][value="video"]'] }), url).name, 'Startpage');
  assert.equal(UnsafeSearch.matchPage(page({ selectors: [] }), url), null, 'web results');
  // The same form on another site means nothing.
  assert.equal(UnsafeSearch.matchPage(page({ selectors: ['form#search input[name="cat"][value="images"]'] }), 'https://example.com/sp/search'), null);
});

test('SearXNG is known on any host by its generator, and only for images or videos', () => {
  const searx = (selectors) => page({ generator: 'searxng/2026.10.28+c360868e5', selectors });
  const url = 'https://search.anyone.example/search';
  assert.equal(UnsafeSearch.matchPage(searx(['article.category-images']), url).name, 'SearXNG');
  assert.equal(UnsafeSearch.matchPage(searx(['article.category-videos']), url).name, 'SearXNG');
  assert.equal(UnsafeSearch.matchPage(searx(['input[type="hidden"][name="category_images"]']), url).name, 'SearXNG',
    'the chosen category holds the page before its results arrive');
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'searx/1.1.0', selectors: ['article.category-images'] }), url).name, 'SearXNG',
    'the older searx too');
  assert.equal(UnsafeSearch.matchPage(searx(['article.category-general']), url), null, 'a web search');
  assert.equal(UnsafeSearch.matchPage(page({ generator: 'WordPress 6.6', selectors: ['article.category-images'] }), url), null,
    'a blog with an "images" category is not SearXNG');
  assert.equal(UnsafeSearch.matchPage(page({ selectors: ['article.category-images'] }), url), null, 'no generator at all');
});

test('a page check survives a bad selector and a missing document', () => {
  const rules = UnsafeSearch.rulesFrom({ rules: [{ name: 'Odd', hosts: ['odd.example'], page: ['not a selector [', 'div.images'] }] });
  assert.equal(UnsafeSearch.matchPage(page({ selectors: ['div.images'] }), 'https://odd.example/', rules).name, 'Odd');
  assert.equal(UnsafeSearch.matchPage(null, 'https://odd.example/', rules), null);
  assert.equal(UnsafeSearch.matchPage(page(), 'not an address', rules), null);
});

// --- Downloaded rules -----------------------------------------------------------

test('downloaded rules add engines, and can\'t change or remove one that ships', () => {
  const rules = UnsafeSearch.rulesFrom({ rules: [
    { name: 'Example Images', hosts: ['images.example'], paths: ['/search'] },
    { name: 'startpage', hosts: ['startpage.com'], paths: ['/'] }
  ] });
  assert.equal(held('https://images.example/search?q=x', rules), 'Example Images');
  assert.equal(held('https://www.startpage.com/sp/search?query=x', rules), null, 'the shipped Startpage rule stands');
  assert.equal(UnsafeSearch.rulesFrom(null).length, UnsafeSearch.ENGINES.length);
  assert.equal(UnsafeSearch.rulesFrom({ rules: 'nope' }).length, UnsafeSearch.ENGINES.length);
});

test('a downloaded rule that could cover every site is no rule at all', () => {
  for (const raw of [
    null, 'text', {},
    { name: 'No host', paths: ['/images'] },
    { name: 'Bare host only', hosts: ['images.example'] },
    { name: 'Any page', page: ['img'] },
    { name: 'Bad host', hosts: ['*.example'], paths: ['/x'] },
    { name: 'TLD', hosts: ['com'], paths: ['/images'] },
    { name: 'Regex path', hosts: ['a.example'], paths: ['images.*'] },
    { name: 'Query in path', hosts: ['a.example'], paths: ['/x?y=1'] },
    { name: 'Odd generator', generator: 'searx.*', page: ['img'] },
    { hosts: ['a.example'], paths: ['/images'] }
  ]) {
    assert.equal(UnsafeSearch.normalizeRule(raw), null, JSON.stringify(raw));
  }
  const rule = UnsafeSearch.normalizeRule({ name: ' Mixed ', hosts: ['WWW.Pics.Example', 'bad host'], params: { Tab: ['IMAGES', 7], 'bad key!': ['x'] }, extra: 'ignored' });
  assert.deepEqual(JSON.parse(JSON.stringify(rule)), { name: 'Mixed', hosts: ['pics.example'], params: { Tab: ['images'] } });
});

test('parseRemote reads data/UNSAFE_SEARCH.json and refuses anything else', () => {
  const shipped = UnsafeSearch.parseRemote(read('data/UNSAFE_SEARCH.json'));
  assert.ok(Array.isArray(shipped), 'the file in the repository parses');
  assert.equal(UnsafeSearch.parseRemote('<html>404</html>'), null);
  assert.equal(UnsafeSearch.parseRemote('{"rules": {}}'), null);
  assert.deepEqual(Array.from(UnsafeSearch.parseRemote('{"rules": [{"name": "A", "hosts": ["a.example"], "paths": ["/img"]}, {"name": "B"}]}'))
    .map((r) => r.name), ['A']);
});

// --- Wiring ---------------------------------------------------------------------

test('the address is checked early, after the whitelist and only with SafeSearch on', () => {
  const early = contentSource.slice(contentSource.indexOf('(function instantBlockEarly()'));
  const allowAt = early.indexOf('if (isAllowed(normalizedHost, pathname)) return;');
  const checkAt = early.indexOf('UnsafeSearch.matchAddress(urlStr, UnsafeSearch.rulesFrom(result[UNSAFE_SEARCH_KEY]))');
  assert.ok(allowAt > 0 && checkAt > allowAt, 'a whitelisted engine stays open');
  assert.match(early.slice(allowAt, checkAt), /settings\.safeSearchEnabled !== false/);
  assert.match(early.slice(checkAt, checkAt + 200), /redirectNow\('unsafe_search', getBlockedReasonLabel\('unsafe_search'\)\)/);
  assert.match(early.slice(0, allowAt), /UNSAFE_SEARCH_KEY\s*\]\);/, 'the downloaded rules are read with the settings');
  assert.equal(/const UNSAFE_SEARCH_KEY = '([^']+)'/.exec(contentSource)[1], UnsafeSearch.STORAGE_KEY);
  assert.ok(contentSource.indexOf('const UNSAFE_SEARCH_KEY') < contentSource.indexOf('(function instantBlockEarly()'),
    'declared before the early check runs');
});

test('the page is checked first among the page-level checks, top frame only', () => {
  const check = functionSource(contentSource, 'checkUnsafeSearchPage');
  assert.match(check, /if \(!safeSearchOn \|\| !unsafeSearchRules/);
  assert.match(check, /redirectToBlockedPage\('unsafe_search'\)/);
  const process = functionSource(contentSource, 'processContent');
  assert.match(process, /if \(IS_TOP_FRAME\) \{\s*if \(checkUnsafeSearchPage\(\)\) return;/);
  assert.ok(process.indexOf('isCurrentPageWhitelisted()') < process.indexOf('checkUnsafeSearchPage()'), 'after the whitelist');
  const load = functionSource(contentSource, 'loadSettings');
  assert.match(load, /safeSearchOn = settings\.safeSearchEnabled !== false;/);
  assert.match(load, /unsafeSearchRules = UnsafeSearch\.rulesFrom\(result\[UNSAFE_SEARCH_KEY\]\)/);
});

test('the reason is named on the blocked page, in the history and in the label', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(functionSource(contentSource, 'getBlockedReasonLabel') + '\nglobalThis.label = getBlockedReasonLabel;', sandbox);
  const label = sandbox.label('unsafe_search');
  assert.equal(label, 'Blocked image search without SafeSearch');
  const audit = read('audit.js');
  assert.match(audit, new RegExp(`'${label.toLowerCase()}': 'SafeSearch'`));
  assert.match(audit, /unsafe_search: 'SafeSearch'/);
  const blocked = read('blocked.js');
  assert.match(functionSource(blocked, 'getReasonMeta'), /case 'unsafe_search':[\s\S]{0,80}sourceLabel: 'SafeSearch'/);
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
    response: { text: JSON.stringify({ rules: [{ name: 'Example Images', hosts: ['images.example'], paths: ['/search'] }] }) }
  });
  assert.deepEqual(fetched, ['https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/UNSAFE_SEARCH.json']);
  const kept = writes[0][UnsafeSearch.STORAGE_KEY];
  assert.equal(kept.rules[0].name, 'Example Images');
  assert.ok(kept.checkedAt > 0 && kept.updatedAt === kept.checkedAt);
});

test('a fresh list is not downloaded again; a failed download keeps the old one and waits', async () => {
  const recent = { rules: [{ name: 'Old', hosts: ['old.example'], paths: ['/i'] }], checkedAt: Date.now() - 1000, updatedAt: 5 };
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
