// A blocked search result used to be replaced, always, with a branded card: a
// 40px logo, a title, a description and a BLOCKED badge. That was tolerable when
// two web results in ten were hidden and became a wall once the DuckDuckGo
// Images and Videos verticals started being filtered too — twenty tiles, no
// pictures, twenty shields. Presentation is now a setting, and the accounting
// moved to one summary line above the results.
//
// These tests cover the parts that are easy to get wrong and invisible when they
// break: the tally resetting on the right boundary (DuckDuckGo switches verticals
// with pushState, so there is no navigation event to hang it off), every engine
// having somewhere to put the line, and the toolbar badge surviving the service
// worker being torn down mid-count.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadBackgroundContext } = require('./setup');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function blockSource(prefix, name) {
  const start = source.indexOf(`${prefix} ${name}`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

const functionSource = (name) => blockSource('function', name);
// `const` at the top level of a vm context stays in its lexical scope and never
// lands on the sandbox object, so the declaration is rewritten to `var`.
const objectSource = (name) =>
  blockSource('const', `${name} =`).replace(/^const /, 'var ') + ';';

function loadTreatmentContext(href = 'https://duckduckgo.com/?q=apricots') {
  const url = new URL(href);
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    window: { location: { hostname: url.hostname, pathname: url.pathname, search: url.search, href } },
    pageBlockedCount: 0,
    pageBlockedCountKey: ''
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      functionSource('normalizeSearchResultTreatment'),
      functionSource('currentSearchIdentity'),
      functionSource('addBlockedResultCount')
    ].join('\n'),
    sandbox
  );
  return sandbox;
}

test('normalizeSearchResultTreatment: only "overlay" opts into the card', () => {
  const ctx = loadTreatmentContext();
  assert.equal(ctx.normalizeSearchResultTreatment('overlay'), 'overlay');
  assert.equal(ctx.normalizeSearchResultTreatment('OVERLAY'), 'overlay');
  // Anything unrecognised falls to the quieter treatment rather than the louder
  // one: a corrupt or half-migrated setting must not restore the wall of cards.
  assert.equal(ctx.normalizeSearchResultTreatment('hide'), 'hide');
  assert.equal(ctx.normalizeSearchResultTreatment(''), 'hide');
  assert.equal(ctx.normalizeSearchResultTreatment(undefined), 'hide');
  assert.equal(ctx.normalizeSearchResultTreatment('card'), 'hide');
});

test('currentSearchIdentity: DuckDuckGo verticals are different searches', () => {
  const web = loadTreatmentContext('https://duckduckgo.com/?q=apricots');
  const images = loadTreatmentContext('https://duckduckgo.com/?q=apricots&ia=images');
  const videos = loadTreatmentContext('https://duckduckgo.com/?q=apricots&ia=videos');

  // Same host, same path, same query — only the vertical differs, and DuckDuckGo
  // switches it with pushState. If these collided, the Images tab would inherit
  // the web tab's count and report a number for results it never looked at.
  assert.notEqual(web.currentSearchIdentity(), images.currentSearchIdentity());
  assert.notEqual(images.currentSearchIdentity(), videos.currentSearchIdentity());
});

test('currentSearchIdentity: a new query is a new search, a repeat is not', () => {
  const first = loadTreatmentContext('https://duckduckgo.com/?q=apricots');
  const same = loadTreatmentContext('https://duckduckgo.com/?q=apricots');
  const other = loadTreatmentContext('https://duckduckgo.com/?q=plums');

  assert.equal(first.currentSearchIdentity(), same.currentSearchIdentity());
  assert.notEqual(first.currentSearchIdentity(), other.currentSearchIdentity());
});

test('currentSearchIdentity: reads the query key each engine actually uses', () => {
  const yahoo = loadTreatmentContext('https://search.yahoo.com/search?p=apricots');
  const yandex = loadTreatmentContext('https://yandex.com/search/?text=apricots');
  // A missing query would make every search on the host look identical, so the
  // tally would never reset. Both alternative keys have to be understood.
  assert.match(yahoo.currentSearchIdentity(), /apricots/);
  assert.match(yandex.currentSearchIdentity(), /apricots/);
});

test('addBlockedResultCount: accumulates deltas within one search', () => {
  const ctx = loadTreatmentContext();
  // The incremental pass reports what *it* blocked, not the page total —
  // DuckDuckGo hydrates results one row at a time — so these have to add up
  // rather than overwrite, or the line counts down as the page fills in.
  assert.equal(ctx.addBlockedResultCount(2), 2);
  assert.equal(ctx.addBlockedResultCount(1), 3);
  assert.equal(ctx.addBlockedResultCount(3), 6);
});

test('addBlockedResultCount: a changed search restarts the tally', () => {
  const ctx = loadTreatmentContext('https://duckduckgo.com/?q=apricots');
  assert.equal(ctx.addBlockedResultCount(4), 4);

  ctx.window.location.search = '?q=plums';
  assert.equal(ctx.addBlockedResultCount(1), 1, 'new query starts from zero');

  ctx.window.location.search = '?q=plums&ia=images';
  assert.equal(ctx.addBlockedResultCount(2), 2, 'switching vertical starts from zero');
});

test('addBlockedResultCount: zero and negative counts leave the tally alone', () => {
  const ctx = loadTreatmentContext();
  ctx.addBlockedResultCount(5);
  assert.equal(ctx.addBlockedResultCount(0), 5);
  assert.equal(ctx.addBlockedResultCount(-3), 5);
});

test('every search engine has somewhere to put the summary line', () => {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(objectSource('SEARCH_SELECTORS'), sandbox);

  const engines = Object.keys(sandbox.SEARCH_SELECTORS);
  assert.ok(engines.length >= 6, 'expected the full engine table');
  for (const engine of engines) {
    // Without an anchor the line falls back to the first result's parent, which
    // works but puts it inside the list. Adding an engine and forgetting the
    // anchor is the silent-failure case this guards.
    assert.equal(
      typeof sandbox.SEARCH_SELECTORS[engine].resultsAnchor,
      'string',
      `${engine} is missing resultsAnchor`
    );
  }
});

// --- the in-page counter pill -----------------------------------------------
// The alternative to the toolbar badge, for users who never pinned the icon and
// so never see it. Chrome hides unpinned extensions behind the puzzle-piece menu
// and offers no API to pin one, so the count has to be able to live in the page.

function loadCounterContext(href = 'https://duckduckgo.com/?q=apricots&ia=images') {
  const url = new URL(href);
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    decodeURIComponent,
    atob,
    Map,
    Set,
    setTimeout,
    window: { location: { hostname: url.hostname, pathname: url.pathname, search: url.search, href } },
    log: () => {},
    getSearchEngine: () => 'duckduckgo',
    updateFloatingCounter: () => {},
    scheduleFloatingCounterUpdate: () => {},
    pageBlockedEntries: new Map(),
    pageBlockedKinds: new Map(),
    pageBlockedByType: new Map(),
    pageBlockedTotal: 0,
    pageBlockedEntriesKey: '',
    floatingCounterExpanded: false
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      objectSource('SEARCH_SELECTORS'),
      objectSource('SEARCH_ENGINE_OWN_HOSTS'),
      functionSource('unwrapSearchRedirect'),
      functionSource('hostFromAddressText'),
      functionSource('searchResultHost'),
      objectSource('WRAPPED_IMAGE_URL_PARAMS'),
      objectSource('COUNTED_BLOCK_TYPES'),
      functionSource('safelyDecodeUrlCandidate'),
      functionSource('extractWrappedImageSearchUrls'),
      functionSource('getEffectiveImageUrl'),
      functionSource('currentSearchIdentity'),
      functionSource('blockedEntryHost'),
      functionSource('recordBlockedEntry')
    ].join('\n'),
    sandbox
  );
  return sandbox;
}

const fakeResult = (href) => ({
  querySelector: () => (href ? { getAttribute: () => null, href } : null),
  querySelectorAll: () => (href ? [{ getAttribute: () => null, href }] : [])
});

// An image keeps its address on itself, not in a descendant link, so the two
// element types are not interchangeable here.
const fakeImage = (src) => ({ currentSrc: src, src, getAttribute: () => null });

test('normalizeBlockCountDisplay: only "floating" moves the count into the page', () => {
  const ctx = loadTreatmentContext();
  vm.runInContext(functionSource('normalizeBlockCountDisplay'), ctx);
  assert.equal(ctx.normalizeBlockCountDisplay('floating'), 'floating');
  assert.equal(ctx.normalizeBlockCountDisplay('FLOATING'), 'floating');
  // Default to the toolbar badge: it cannot collide with the page, so an
  // unrecognised value should not start injecting things into every site.
  assert.equal(ctx.normalizeBlockCountDisplay('badge'), 'badge');
  assert.equal(ctx.normalizeBlockCountDisplay(''), 'badge');
  assert.equal(ctx.normalizeBlockCountDisplay(undefined), 'badge');
});

test('blockedEntryHost: a web result reports the host it linked to', () => {
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  assert.equal(
    ctx.blockedEntryHost(fakeResult('https://www.Example.COM/some/page?a=1'), 'search-result'),
    'example.com',
    'lowercased, www stripped, path and query dropped'
  );
  assert.equal(ctx.blockedEntryHost(fakeResult(null), 'search-result'), '');
});

test('blockedEntryHost: an image search result reports its source, not the proxy', () => {
  const ctx = loadCounterContext();
  // DuckDuckGo serves every thumbnail through external-content.duckduckgo.com,
  // so without unwrapping the panel would claim DuckDuckGo was the blocked
  // source for every single image on the page.
  const proxied = 'https://external-content.duckduckgo.com/iu/?u=' +
    encodeURIComponent('https://images.example.com/photo.jpg');
  const host = ctx.blockedEntryHost({ currentSrc: proxied, src: proxied }, 'image');
  assert.equal(host, 'images.example.com');
});

test('blockedEntryHost: an unproxied image reports its own host', () => {
  const ctx = loadCounterContext();
  assert.equal(ctx.blockedEntryHost(fakeImage('https://cdn.example.org/a.png'), 'image'), 'cdn.example.org');
});

test('recordBlockedEntry: totals every block and groups repeats by host', () => {
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  ctx.recordBlockedEntry(fakeResult('https://a.example/1'), 'search-result');
  ctx.recordBlockedEntry(fakeResult('https://a.example/2'), 'search-result');
  ctx.recordBlockedEntry(fakeResult('https://b.example/1'), 'search-result');

  assert.equal(ctx.pageBlockedTotal, 3, 'the pill counts blocks');
  assert.equal(ctx.pageBlockedEntries.size, 2, 'the panel lists hosts');
  assert.equal(ctx.pageBlockedEntries.get('a.example'), 2);
  assert.equal(ctx.pageBlockedEntries.get('b.example'), 1);
});

test('recordBlockedEntry: keeps what each host\'s blocks were, and the page\'s', () => {
  // A user asked for the Held sources panel to say more than a number.
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  ctx.recordBlockedEntry(fakeImage('https://cdn.example/a.jpg'), 'image');
  ctx.recordBlockedEntry(fakeImage('https://cdn.example/b.jpg'), 'image');
  ctx.recordBlockedEntry(fakeImage('https://cdn.example/c.mp4'), 'video');
  ctx.recordBlockedEntry(fakeResult('https://other.example/1'), 'search-result');
  ctx.recordBlockedEntry(fakeResult(null), 'search-result');

  assert.deepEqual({ ...ctx.pageBlockedKinds.get('cdn.example') }, { image: 2, video: 1 });
  assert.deepEqual({ ...ctx.pageBlockedKinds.get('other.example') }, { 'search-result': 1 });
  // The page's tally includes the block whose source is unknown.
  assert.deepEqual(Object.fromEntries(ctx.pageBlockedByType), { image: 2, video: 1, 'search-result': 2 });

  ctx.window.location.search = '?q=apricots&ia=images';
  ctx.recordBlockedEntry(fakeImage('https://new.example/a.jpg'), 'image');
  assert.equal(ctx.pageBlockedKinds.has('cdn.example'), false, 'a new search starts a new tally');
  assert.deepEqual(Object.fromEntries(ctx.pageBlockedByType), { image: 1 });
});

test('Held sources panel: says what was held, and from how many sites', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  const wordsAt = source.indexOf('const HELD_KIND_WORDS');
  vm.runInContext([
    source.slice(wordsAt, source.indexOf('];', wordsAt) + 2),
    functionSource('heldKindsList'),
    functionSource('heldSummaryText')
  ].join('\n') + '\nglobalThis.list = heldKindsList; globalThis.summary = heldSummaryText;', sandbox);

  assert.deepEqual([...sandbox.list({ video: 2, image: 12 })], ['12 images', '2 videos'], 'images first, whatever the order counted');
  assert.deepEqual([...sandbox.list({ iframe: 1, 'search-result': 1 })], ['1 frame', '1 search result']);
  assert.deepEqual([...sandbox.list({})], []);
  assert.equal(sandbox.summary({ image: 14, video: 3, iframe: 1 }, 3), '14 images, 3 videos and 1 frame, from 3 sites');
  assert.equal(sandbox.summary({ image: 1 }, 1), '1 image, from 1 site');
  assert.equal(sandbox.summary({ 'search-result': 2 }, 0), '2 search results');
  assert.equal(sandbox.summary({}, 0), '');
});

test('Held sources panel: the site list scrolls in its own box, with a cue', () => {
  // Windows 11 and macOS hide scroll bars until you scroll, so a long list
  // looked like it simply ended.
  const rules = source.slice(source.indexOf('const HELD_UI_RULES'), source.indexOf('// The Held icon'));
  assert.match(rules, /'bn-panel-list': '[^']*max-height:[^']*overflow-y: auto;[^']*scrollbar-width: thin;/);
  assert.doesNotMatch(rules.match(/'bn-panel': '([^']*)'/)[1], /overflow/, 'the heading and summary stay put');
  assert.doesNotMatch(rules, /gradient/, 'no gradients in the held UI');
  const cue = functionSource('updateHeldMoreCue');
  assert.match(cue, /Scroll for all \$\{sites\} sites/);
  assert.match(cue, /parts\.more\.hidden = !\(below > 2\)/);
  const build = functionSource('buildFloatingCounterUi');
  assert.match(build, /list\.addEventListener\('scroll', \(\) => updateHeldMoreCue\(parts\)/);
  assert.match(build, /setHeldAttrs\(list, \{ tabindex: '0'/, 'the list scrolls from the keyboard');
  // Hosts stay inert text, with no address beyond the host.
  const draw = functionSource('updateFloatingCounter');
  assert.doesNotMatch(draw, /createElement\('a'\)|href/);
});

test('recordBlockedEntry: a held result is credited to its own site, not the engine', () => {
  // A supporter's Held sources list showed "duckduckgo.com 1" for a site they
  // never blocked: in every DuckDuckGo result the first link is the engine's own
  // "Search domain …" icon, and the list took the first link.
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  const ddgResult = (site) => {
    const links = [
      { getAttribute: () => 'result-extras-site-search-link', href: 'https://duckduckgo.com/?q=' + site + '&ia=web' },
      { getAttribute: () => null, href: 'https://www.' + site + '/page' }
    ];
    return { querySelector: () => links[0], querySelectorAll: () => links };
  };
  ctx.recordBlockedEntry(ddgResult('reddit.com'), 'search-result');
  ctx.recordBlockedEntry(ddgResult('medium.com'), 'search-result');
  assert.equal(ctx.pageBlockedEntries.has('duckduckgo.com'), false);
  assert.equal(ctx.pageBlockedEntries.get('reddit.com'), 1);
  assert.equal(ctx.pageBlockedEntries.get('medium.com'), 1);
});

test('recordBlockedEntry: a block with no recoverable host still counts', () => {
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  ctx.recordBlockedEntry(fakeResult(null), 'search-result');
  // The count is what the pill shows; an unlistable source must not make the
  // block vanish from the total.
  assert.equal(ctx.pageBlockedTotal, 1);
  assert.equal(ctx.pageBlockedEntries.size, 0);
});

test('recordBlockedEntry: social posts are not counted', () => {
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  // They do not feed the toolbar badge either, and a pill that reappears on
  // every scroll of a feed is the noise this change set out to remove.
  ctx.recordBlockedEntry(fakeResult('https://a.example/1'), 'social-post');
  assert.equal(ctx.pageBlockedTotal, 0);
  assert.equal(ctx.pageBlockedEntries.size, 0);
});

test('recordBlockedEntry: switching vertical starts a new list', () => {
  const ctx = loadCounterContext('https://duckduckgo.com/?q=apricots');
  ctx.recordBlockedEntry(fakeResult('https://a.example/1'), 'search-result');
  assert.equal(ctx.pageBlockedTotal, 1);

  ctx.window.location.search = '?q=apricots&ia=images';
  ctx.recordBlockedEntry(fakeImage('https://b.example/photo.jpg'), 'image');

  assert.equal(ctx.pageBlockedTotal, 1, 'total restarts');
  assert.equal(ctx.pageBlockedEntries.size, 1);
  assert.equal(ctx.pageBlockedEntries.has('a.example'), false, 'previous tab does not carry over');
});

test('bumpTabBadge: stands down when the count lives in the page', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  // Set before the first bump, while the display preference is still uncached.
  ctx.chrome.storage.local.get = () =>
    Promise.resolve({ pblocker_settings: { blockCountDisplay: 'floating' } });

  await ctx.bumpTabBadge(5, 3);
  assert.equal(badges.size, 0, 'the same blocks must not be reported in two places');
});

test('bumpTabBadge: reads the badge back so a torn-down worker cannot reset it', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  await ctx.bumpTabBadge(7, 3);
  assert.equal(badges.get(7), '3');

  // Simulate the service worker being torn down and revived: any in-memory tally
  // would be gone, but the badge text the browser is drawing is not.
  await ctx.bumpTabBadge(7, 2);
  assert.equal(badges.get(7), '5', 'continues from the badge, not from zero');
});

test('bumpTabBadge: counts stay per tab', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  await ctx.bumpTabBadge(1, 4);
  await ctx.bumpTabBadge(2, 1);
  assert.equal(badges.get(1), '4');
  assert.equal(badges.get(2), '1');
});

test('bumpTabBadge: caps instead of putting a four-digit number on the toolbar', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  await ctx.bumpTabBadge(3, 98);
  assert.equal(badges.get(3), '98');
  await ctx.bumpTabBadge(3, 5);
  assert.equal(badges.get(3), '99+');
  // Once capped it stops reading and adding — a scrolling image page would
  // otherwise keep doing storage round-trips forever to display the same text.
  await ctx.bumpTabBadge(3, 500);
  assert.equal(badges.get(3), '99+');
});

test('bumpTabBadge: ignores messages with no real tab behind them', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  // Messages from the options page or the popup arrive with no sender.tab.
  await ctx.bumpTabBadge(undefined, 1);
  await ctx.bumpTabBadge(-1, 1);
  assert.equal(badges.size, 0);
});

test('bumpTabBadge: a pass that blocked several results counts all of them', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  // updateStats records a filtering pass as one event; the badge is supposed to
  // reflect results, so the count carried in the message has to be honoured.
  await ctx.bumpTabBadge(9, 7);
  assert.equal(badges.get(9), '7');
});

test('clearTabBadge: a navigation empties the count', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;

  await ctx.bumpTabBadge(4, 6);
  ctx.clearTabBadge(4);
  assert.equal(badges.has(4), false);
});

test('the tabs.onUpdated listener resets on both signals it can get', async () => {
  const ctx = loadBackgroundContext();
  const badges = ctx.chrome.action._badges;
  const listeners = ctx.chrome.tabs.onUpdated.listeners;
  assert.ok(listeners.length >= 1, 'background should register a tabs.onUpdated listener');

  const fire = (tabId, changeInfo) => listeners.forEach((fn) => fn(tabId, changeInfo));

  // changeInfo.url covers history-driven navigation but Firefox withholds it
  // without the "tabs" permission, which this extension does not request.
  await ctx.bumpTabBadge(11, 2);
  fire(11, { url: 'https://duckduckgo.com/?q=plums' });
  assert.equal(badges.has(11), false, 'url change should clear');

  // status:'loading' needs no permission but only fires on a real page load.
  await ctx.bumpTabBadge(12, 2);
  fire(12, { status: 'loading' });
  assert.equal(badges.has(12), false, 'load should clear');

  // Anything else must not: a title or favicon update mid-search would otherwise
  // wipe a count that is still accurate.
  await ctx.bumpTabBadge(13, 2);
  fire(13, { status: 'complete' });
  fire(13, { title: 'plums at DuckDuckGo' });
  assert.equal(badges.get(13), '2', 'unrelated updates must not clear');
});
