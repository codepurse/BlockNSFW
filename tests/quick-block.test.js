// The "Block" button beside each search result, as uBlacklist has it: a user
// asked for a quick way to add a result's site to the blocklist.
//
// Covered here: reading the result's real site through each engine's redirect
// link, the background adding it (and refusing what it should), and the
// guard rails on the page side: never inside a link, only on a real press,
// confirm first, a switch in Settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function functionSource(name) {
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

function objectSource(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} should exist`);
  return source.slice(start, source.indexOf('\n};', start) + 3);
}

function loadPageHelpers(pageUrl) {
  const sandbox = { URL, URLSearchParams, atob, decodeURIComponent, window: { location: { href: pageUrl } } };
  vm.createContext(sandbox);
  vm.runInContext([
    'const SEARCH_SELECTORS = { google: { urlLine: "cite" }, bing: { urlLine: "cite" } };',
    objectSource('SEARCH_ENGINE_OWN_HOSTS'),
    functionSource('unwrapSearchRedirect'),
    functionSource('hostFromAddressText'),
    functionSource('searchResultHost'),
    'globalThis.unwrap = unwrapSearchRedirect; globalThis.hostOf = searchResultHost; globalThis.fromText = hostFromAddressText;'
  ].join('\n'), sandbox);
  return sandbox;
}

const bingLink = (url) => 'https://www.bing.com/ck/a?!&&p=abc&u=a1' +
  Buffer.from(url).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '&ntb=1';

test('a result\'s real address is read through each engine\'s redirect', () => {
  const ctx = loadPageHelpers('https://www.bing.com/search?q=cats');
  assert.equal(ctx.unwrap(bingLink('https://www.example.com/page?x=1')), 'https://www.example.com/page?x=1');
  assert.equal(ctx.unwrap('https://r.search.yahoo.com/_ylt=A/RV=2/RE=1/RO=10/RU=https%3a%2f%2fexample.org%2fa%2f/RK=2/RS=x-'), 'https://example.org/a/');
  assert.equal(ctx.unwrap('https://www.google.com/url?q=https://example.net/&sa=U'), 'https://example.net/');
  assert.equal(ctx.unwrap('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.edu%2F&rut=x'), 'https://example.edu/');
  assert.equal(ctx.unwrap('https://example.com/direct'), 'https://example.com/direct');
  assert.equal(ctx.unwrap('javascript:alert(1)'), '');
  assert.equal(ctx.unwrap('https://www.bing.com/ck/a?u=notbase'), '', 'an unknown wrapping gives nothing, not Bing');
});

test('the result\'s site skips the engine\'s own links and drops "www."', () => {
  const ctx = loadPageHelpers('https://www.bing.com/search?q=cats');
  const container = (hrefs) => ({
    querySelectorAll: () => hrefs.map((href) => ({ href, getAttribute: () => null }))
  });
  assert.equal(ctx.hostOf(container(['https://www.bing.com/search?q=more', bingLink('https://www.cats.example/')]), 'bing'), 'cats.example');
  assert.equal(ctx.hostOf(container(['https://cc.bingj.com/cache.aspx?d=1', 'https://m.example.org/']), 'bing'), 'cc.bingj.com', 'only the engine\'s own hosts are skipped');
  assert.equal(ctx.hostOf(container(['https://webcache.googleusercontent.com/x', 'https://example.net/']), 'google'), 'example.net');
  assert.equal(ctx.hostOf(container([]), 'google'), '');
});

test('with an encrypted Google link, the address line names the site', () => {
  // Seen 2026-10-29: Google sends every result through /goto?url=<opaque> in
  // some browsers, so no link says where it goes; the address line still does.
  const ctx = loadPageHelpers('https://www.google.com/search?q=cats');
  const result = (citeText) => ({
    querySelectorAll: () => [{ href: 'https://www.google.com/goto?url=CAESc0Bx', getAttribute: () => null }],
    querySelector: () => (citeText === null ? null : { textContent: citeText })
  });
  assert.equal(ctx.hostOf(result('https://www.aspca.org › pet-care › general-cat-care'), 'google'), 'aspca.org');
  assert.equal(ctx.hostOf(result('en.wikipedia.org/wiki/Cat'), 'google'), 'en.wikipedia.org');
  assert.equal(ctx.hostOf(result('8 comments · 7 years ago'), 'google'), '', 'no site in the line, no button');
  assert.equal(ctx.hostOf(result(null), 'google'), '');
  assert.equal(ctx.hostOf(result('https://support.google.com › answer'), 'google'), '', 'never the engine itself');
  assert.equal(ctx.fromText('https://www.rspca.org.uk › adviceandwelfare'), 'rspca.org.uk');
  assert.equal(ctx.fromText('192.168.1.1'), '', 'not an address someone means to block from a result');
});

// The background starts up on load and writes its default settings; seed the
// test's values once that has settled, or startup overwrites them.
async function loadBackground(initial) {
  const ctx = loadBackgroundContext();
  const store = {};
  ctx.chrome.storage.local.get = (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
    return Promise.resolve(out);
  };
  ctx.chrome.storage.local.set = (items) => { Object.assign(store, JSON.parse(JSON.stringify(items))); return Promise.resolve(); };
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, JSON.parse(JSON.stringify(initial)));
  return { ctx, store };
}

test('the result filter checks where each result really goes', () => {
  // Found while testing the Block button: on Bing every result links through
  // bing.com/ck/a, so a result from a site on the user's blocklist (or the
  // built-in one) was never held. Google's encrypted /goto links hid it too.
  const sandbox = { URL, URLSearchParams, atob, decodeURIComponent, window: { location: { href: 'https://www.bing.com/search?q=cats' } } };
  vm.createContext(sandbox);
  vm.runInContext([
    'const SEARCH_SELECTORS = { google: { urlLine: "cite" }, bing: { urlLine: "cite" } };',
    'let engine = "bing"; function getSearchEngine() { return engine; }',
    objectSource('SEARCH_ENGINE_OWN_HOSTS'),
    functionSource('unwrapSearchRedirect'),
    functionSource('hostFromAddressText'),
    functionSource('searchResultHost'),
    functionSource('elementLinkTargets'),
    'globalThis.targets = elementLinkTargets; globalThis.setEngine = (e) => { engine = e; };'
  ].join('\n'), sandbox);
  const result = (hrefs, citeText) => ({
    querySelectorAll: () => hrefs.map((href) => ({ href, getAttribute: () => null })),
    querySelector: () => (citeText ? { textContent: citeText } : null)
  });

  const bing = [...sandbox.targets(result([bingLink('https://en.wikipedia.org/wiki/Cat')]))];
  assert.ok(bing.includes('https://en.wikipedia.org/wiki/Cat'), JSON.stringify(bing));
  assert.ok(!bing.some((u) => /bing\.com/.test(u)), 'the redirect itself is not what gets checked');

  sandbox.setEngine('google');
  const google = [...sandbox.targets(result(['https://www.google.com/goto?url=CAESc0Bx'], 'https://www.britannica.com › animal › cat'))];
  assert.ok(google.includes('https://britannica.com/'), JSON.stringify(google));

  sandbox.setEngine(null);
  assert.deepEqual([...sandbox.targets(result(['https://example.com/a'], null))], ['https://example.com/a'], 'off a search page, links are read as they are');

  // Every check in the result filter reads these, the background verdict included.
  const filter = functionSource('shouldBlockElement');
  assert.match(filter, /const links = elementLinkTargets\(element\);/);
  assert.match(filter, /hasAnyBackgroundBlockedUrl\(links\)/);
  assert.doesNotMatch(filter, /link\.href/);
  assert.match(functionSource('hasBackgroundBlockedLink'), /hasAnyBackgroundBlockedUrl\(elementLinkTargets\(element\)\)/);
});

test('the background adds the confirmed site to the blocklist', async () => {
  const { ctx, store } = await loadBackground({ pblocker_settings: { customPatterns: ['# mine', 'already.example'] } });
  const added = await ctx.quickBlockSite('https://www.Cats.Example/path');
  assert.equal(added.ok, true);
  assert.equal(added.host, 'cats.example');
  assert.deepEqual(store.pblocker_settings.customPatterns, ['# mine', 'already.example', 'cats.example']);

  const again = await ctx.quickBlockSite('sub.already.example');
  assert.equal(again.ok, true);
  assert.equal(again.already, true, 'a host its parent already covers is not added twice');
  assert.equal(store.pblocker_settings.customPatterns.length, 3);
});

test('the background refuses what it should', async () => {
  const { ctx, store } = await loadBackground({
    pblocker_settings: { customPatterns: [] },
    pblocker_whitelist: [{ domain: 'trusted.example', type: 'permanent' }]
  });
  assert.equal((await ctx.quickBlockSite('not a site')).reason, 'invalid');
  assert.equal((await ctx.quickBlockSite('com')).reason, 'invalid', 'a bare TLD is too broad for a button');
  assert.equal((await ctx.quickBlockSite('www.trusted.example')).reason, 'whitelisted',
    'the whitelist would override the entry, so say so instead');
  assert.deepEqual(store.pblocker_settings.customPatterns, []);
});

test('blocklistCoversHost reads only plain host entries', async () => {
  const { ctx } = await loadBackground({});
  const list = ['# note example.com', 'example.com/path', '/regex/', 'title/x/', '*.wild.example', '.dot.example'];
  assert.equal(ctx.blocklistCoversHost('example.com', list), false);
  assert.equal(ctx.blocklistCoversHost('a.wild.example', list), true);
  assert.equal(ctx.blocklistCoversHost('b.dot.example', list), true);
});

test('the button\'s guard rails', () => {
  const slot = functionSource('quickBlockSlot');
  assert.match(slot, /line\.closest\('a'\)\) \|\| line/, 'never inside a link');
  assert.match(slot, /if \(end && !inLink\(end\)\) return \{ node: end, place: 'after' \};/);
  // Google's "⋮" sits over the end of the address line: the button goes after it.
  assert.match(source, /urlLine: 'cite',\s*\/\/[^\n]*\n[\s\S]{0,300}urlLineEnd: '\.csDOgf',/);
  // DuckDuckGo's address link is a full-width row: float beside the site name.
  assert.match(source, /urlLine: '\[data-testid="result-extras-url-link"\], \.result__url',[\s\S]{0,250}urlLinePlace: 'float',/);
  const add0 = functionSource('addQuickBlockButtons');
  assert.match(add0, /if \(slot\.place === 'float'\) slot\.node\.parentElement\.insertBefore\(button, slot\.node\.parentElement\.firstChild\);\s*else slot\.node\.after\(button\);/);
  const add = functionSource('addQuickBlockButtons');
  assert.match(add, /if \(!IS_TOP_FRAME \|\| !isEnabled \|\| !quickBlockButtons\) return;/);
  assert.match(add, /isImagesSearchContext\(\)/, 'not on image tabs');
  assert.match(add, /pblockerProcessed !== 'true' \|\| container\.dataset\.pblockerHidden === 'true'/, 'only judged results still showing');
  assert.match(add, /slot\.node\.dataset\.pblockerQuickBlock === 'true'/, 'one button per address line');
  // A press opens the box; only the box's Block adds anything, and only a real one.
  const button = functionSource('buildQuickBlockButton');
  assert.match(button, /if \(!event\.isTrusted\) return;\s*openQuickBlock\(/);
  assert.doesNotMatch(button, /quick_block_site/);
  const box = functionSource('openQuickBlock');
  assert.match(box, /if \(event && !event\.isTrusted\) return;/);
  assert.match(box, /type: 'quick_block_site', host: input\.value/);
  assert.match(box, /input\.value = host;/, 'the site is shown to confirm or edit');
  assert.doesNotMatch(box + button, /innerHTML/);
  // Both passes that judge results draw the buttons: the full pass, and the one
  // for results added later, which is the only one DuckDuckGo's ever reach.
  assert.match(functionSource('filterSearchResults'), /addQuickBlockButtons\(\);\s*\}$/);
  assert.match(functionSource('processPendingResults'), /addQuickBlockButtons\(\);\s*\}$/);
  // Every engine with results gets an address line to sit by.
  for (const engine of ['google', 'bing', 'duckduckgo', 'brave', 'yahoo', 'yandex']) {
    const block = source.slice(source.indexOf(`  ${engine}: {`), source.indexOf('\n  },', source.indexOf(`  ${engine}: {`)));
    assert.match(block, /urlLine: '/, `${engine} has an address line`);
  }
});

test('a switch in Settings, on by default everywhere it is read', () => {
  const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const opts = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
  assert.match(bg, /quickBlockButtons: true,/);
  assert.match(opts, /quickBlockButtons: true,/);
  assert.match(source, /quickBlockButtons: true,/);
  assert.match(source, /quickBlockButtons = settings\.quickBlockButtons !== false;/);
  assert.match(html, /id="quick-block-buttons"/);
  assert.match(opts, /\$\('quick-block-buttons'\)\.addEventListener\('change'/);
  // Turning it off on an open page takes the buttons away.
  assert.match(source, /if \(quickBlockButtons && isEnabled\) addQuickBlockButtons\(\);\s*else removeQuickBlockButtons\(\);/);
});
