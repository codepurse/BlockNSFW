// DuckDuckGo's images and videos tabs stopped being filtered: the selectors in
// SEARCH_SELECTORS.duckduckgo targeted the pre-React layout (.tile--img,
// .tile__title), which no longer exists. The replacement DOM has hashed class
// names that change on every deploy, so these tests guard the two things that
// are stable — the data-testid hooks the selectors now use, and the unwrapping
// of DuckDuckGo's thumbnail proxy, which is where an image's real address and
// the search terms actually live.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function objectLiteralSource(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1) + ';';
  }
  throw new Error(`could not parse ${name}`);
}

function loadUnwrapContext(pageUrl = 'https://duckduckgo.com/?q=apricots&ia=images') {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    decodeURIComponent,
    window: { location: { href: pageUrl } },
    getSearchEngine: () => 'duckduckgo'
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      objectLiteralSource('WRAPPED_IMAGE_URL_PARAMS'),
      functionSource('safelyDecodeUrlCandidate'),
      functionSource('extractWrappedImageSearchUrls')
    ].join('\n'),
    sandbox
  );
  // Arrays built inside the vm realm are not reference-equal to this realm's,
  // so hand back a copy for deepEqual to work on.
  sandbox.unwrap = (...args) => Array.from(sandbox.extractWrappedImageSearchUrls(...args));
  return sandbox;
}

// A real thumbnail address from the images tab. The host is duckduckgo.com and
// the path is "/iu/", so nothing about the picture is visible until `u` is read.
const PROXIED_THUMB =
  '//external-content.duckduckgo.com/iu/?u=https%3A%2F%2Ftse3.mm.bing.net%2Fth%3Fq%3DApricot%2BDried%2BFruit%26pid%3DApi&f=1';

test('the DuckDuckGo thumbnail proxy is unwrapped to its real address', () => {
  const ctx = loadUnwrapContext();
  const urls = ctx.unwrap(PROXIED_THUMB, 'duckduckgo');

  assert.ok(urls.some(u => u.includes('tse3.mm.bing.net')), 'the proxied host should surface');
  assert.ok(
    urls.some(u => /apricot/i.test(u)),
    'the search terms carried in the proxied address should survive unwrapping'
  );
});

test('the proxy address itself is still returned alongside the unwrapped one', () => {
  const ctx = loadUnwrapContext();
  const urls = ctx.unwrap(PROXIED_THUMB, 'duckduckgo');
  assert.ok(urls.some(u => u.includes('external-content.duckduckgo.com')));
  assert.equal(urls.length, 2);
});

test('Yandex wrapper parameters keep working', () => {
  // The unwrapping used to be Yandex-only; generalizing it must not lose it.
  const ctx = loadUnwrapContext();
  const urls = ctx.unwrap(
    'https://yandex.com/images/search?img_url=https%3A%2F%2Fexample.net%2Fpic.jpg&rpt=imageview',
    'yandex'
  );
  assert.ok(urls.some(u => u === 'https://example.net/pic.jpg'));
});

test('an engine with no proxy is left alone', () => {
  const ctx = loadUnwrapContext();
  const urls = ctx.unwrap(
    'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc',
    'google'
  );
  assert.deepEqual(urls, ['https://encrypted-tbn0.gstatic.com/images?q=tbn:abc']);
});

test('a non-URL value does not throw', () => {
  const ctx = loadUnwrapContext();
  assert.deepEqual(ctx.unwrap('', 'duckduckgo'), []);
  assert.deepEqual(ctx.unwrap(null, 'duckduckgo'), []);
  assert.deepEqual(ctx.unwrap('javascript:void(0)', 'duckduckgo'), []);
  assert.deepEqual(ctx.unwrap('#', 'duckduckgo'), []);
});

// --- Selector guards -------------------------------------------------------
// These read the config rather than a live DOM, so they cannot prove the
// selectors match DuckDuckGo today. What they can do is stop the class-only
// selectors from creeping back: every one of them silently matched nothing.

function duckduckgoConfig() {
  const sandbox = { console };
  vm.createContext(sandbox);
  // `const` is lexical, so it never lands on the sandbox object by itself.
  vm.runInContext(
    objectLiteralSource('SEARCH_SELECTORS') + '\nglobalThis.SEARCH_SELECTORS = SEARCH_SELECTORS;',
    sandbox
  );
  return sandbox.SEARCH_SELECTORS.duckduckgo;
}

test('DuckDuckGo selectors are anchored on data-testid, not hashed classes', () => {
  const ddg = duckduckgoConfig();

  // Images: results live in <figure> inside the images vertical.
  assert.match(ddg.imageContext.container, /\[data-testid="zci-images"\]/);
  assert.match(ddg.imageContext.container, /figure/);

  // Videos: results are <article> inside the videos vertical, and were matched
  // by nothing at all before this fix.
  assert.match(ddg.containers, /\[data-testid="zci-videos"\]/);

  // Web results, which were the only tab still working, must keep their hook.
  assert.match(ddg.containers, /\[data-testid="result"\]/);
});

test('the pre-React selectors are kept as fallbacks, never as the only hook', () => {
  const ddg = duckduckgoConfig();
  // Old self-hosted instances still serve .tile--img, so it stays…
  assert.match(ddg.imageContext.container, /\.tile--img/);
  // …but it must not be the whole selector, which is what broke the images tab.
  assert.notEqual(ddg.imageContext.container.trim(), '.tile--img');
  assert.notEqual(ddg.imageContext.text.trim(), '.tile__title, .tile__body');
});

test('image results are hidden as a whole tile, not as a bare thumbnail', () => {
  // Hiding only the <img> leaves the figcaption — which spells out the title
  // the user blocked — on screen.
  const ddg = duckduckgoConfig();
  assert.ok(ddg.imageContext.tile, 'DuckDuckGo should declare a tile to escalate to');
  assert.match(ddg.imageContext.tile, /figure/);
});

test('the All tab\'s inline images and videos modules are result containers', () => {
  // The All tab shows a row of thumbnails for the same query. No result
  // selector reached it, so a blocked word stopped the web results above it and
  // left the pictures in place.
  const ddg = duckduckgoConfig();
  assert.match(ddg.containers, /li\[data-layout="images"\]/);
  assert.match(ddg.containers, /li\[data-layout="videos"\]/);
});

test('ads and related searches are left alone', () => {
  // Every row on the All tab is an <li data-layout="…">, so taking some rows
  // must not become taking every row.
  const ddg = duckduckgoConfig();
  const all = ddg.containers + ' ' + (ddg.explicitOnlyContainers || '');
  for (const layout of ['ad', 'wikinlp', 'related_searches', 'organic']) {
    assert.ok(
      !all.includes(`data-layout="${layout}"`),
      `${layout} rows should not be matched as results`
    );
  }
});

test('the knowledge panel is judged on explicit signals only', () => {
  // It is several hundred words of reference prose. Blocklisted links and the
  // user's own words should take it; the heuristic term lists should not get a
  // vote, because at that length they misfire on legitimate reference text.
  const ddg = duckduckgoConfig();
  assert.match(ddg.explicitOnlyContainers, /li\[data-layout="about"\]/);
  assert.ok(
    !ddg.containers.includes('data-layout="about"'),
    'the panel must not also sit in the heuristically-judged list'
  );
});

test('search results are lifted to their wrapping list item', () => {
  // A video result is `li > a > article`; hiding the article would leave the
  // replacement card inside a live link to the blocked page.
  const ddg = duckduckgoConfig();
  assert.equal(ddg.resultRoot, 'li');
});
