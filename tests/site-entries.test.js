// What a site entry on the blocklist covers, and that every layer agrees.
//
// Reported by a student: they blocked google.com and lost Gmail and Google
// Classroom with it. That much is how a site entry works (it covers its
// subdomains), but there was no entry that held Google searches alone: the
// in-page check compared hosts only, so "google.com/search" held all of Google
// once a page loaded, and "www.google.com" did too because the in-page check
// dropped the "www."; the navigation matcher, meanwhile, missed "/search?q=…"
// and held no search at all. The two layers carried a copy of the rule each.
//
// Both now read entries through shared/validate-domain.js. These tests drive
// the real navigation matcher (background.js) and the real in-page matcher
// (content.js) over the same entries and addresses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DomainValidate = require('../shared/validate-domain.js');
const KeywordPattern = require('../shared/keyword-pattern.js');
const { loadBackgroundContext } = require('./setup.js');

const root = path.join(__dirname, '..');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

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

function loadInPageMatcher() {
  const sandbox = { console, Map, Set, RegExp, Array, String, self: { DomainValidate }, KeywordPattern };
  vm.createContext(sandbox);
  vm.runInContext([
    'let customPatternRegexCache = new Map();',
    functionSource(contentSource, 'customPatternCompiled'),
    functionSource(contentSource, 'siteMatchAddress'),
    functionSource(contentSource, 'customPatternsMatchHost'),
    functionSource(contentSource, 'customPatternMatchingHost'),
    'globalThis.customPatternsMatchHost = customPatternsMatchHost;'
  ].join('\n'), sandbox);
  return (entry, url) => sandbox.customPatternsMatchHost(url, new URL(url).hostname, [entry]);
}

const ctx = loadBackgroundContext();
const inPage = loadInPageMatcher();
const navigation = (entry, url) => ctx.buildHostPatterns([entry]).some((re) => re.test(url));

// Each entry, the addresses it must hold, and the ones it must leave open.
const CASES = [
  {
    entry: 'google.com',
    held: ['https://www.google.com/search?q=test', 'https://classroom.google.com/u/0/h', 'https://mail.google.com/mail/u/0/'],
    open: ['https://notgoogle.com/', 'https://example.com/?q=google.com']
  },
  {
    // "www." is typed out of habit and means the site: read narrowly, it
    // would open google.com to everyone who wrote it that way.
    entry: 'www.google.com',
    held: ['https://www.google.com/', 'https://google.com/', 'https://classroom.google.com/u/0/h'],
    open: ['https://notgoogle.com/']
  },
  {
    // The way to hold Google searches and leave the rest of Google open.
    entry: 'google.com/search',
    held: ['https://www.google.com/search?q=test', 'https://www.google.com/search', 'https://www.google.com/search/about', 'https://www.google.com/search#q=x'],
    open: ['https://www.google.com/', 'https://classroom.google.com/u/0/h', 'https://mail.google.com/mail/u/0/',
      'https://docs.google.com/document/d/x', 'https://www.google.com/searchengine', 'https://example.com/?u=google.com/search']
  },
  {
    entry: 'example.org/adult',
    held: ['https://example.org/adult', 'https://example.org/adult/page', 'https://example.org/adult?page=2', 'https://sub.example.org/adult', 'https://example.org:8443/adult'],
    open: ['https://example.org/', 'https://example.org/adulting', 'https://example.org/other/adult']
  },
  {
    entry: 'example.org/adult/*',
    held: ['https://example.org/adult/page', 'https://www.example.org/adult/a/b'],
    open: ['https://example.org/', 'https://example.org/other']
  },
  {
    // A path of "/" or "/*" is the whole site.
    entry: 'example.net/',
    held: ['https://example.net/', 'https://example.net/any/page', 'https://sub.example.net/x'],
    open: ['https://example.com/']
  },
  {
    entry: 'example.net/*',
    held: ['https://example.net/', 'https://example.net/any/page', 'https://sub.example.net/x'],
    open: ['https://example.com/']
  },
  {
    // An address pasted from the address bar: the scheme and "www." change
    // nothing, and what's below a path ending in "/" is covered.
    entry: 'https://www.reddit.com/r/foo/',
    held: ['https://www.reddit.com/r/foo/', 'https://old.reddit.com/r/foo/comments/1/x', 'http://reddit.com/r/foo/'],
    open: ['https://www.reddit.com/', 'https://www.reddit.com/r/foobar/']
  },
  {
    entry: 'reddit.com/r/bar',
    held: ['https://www.reddit.com/r/bar/', 'https://www.reddit.com/r/Bar', 'https://www.reddit.com/r/bar?sort=new'],
    open: ['https://www.reddit.com/r/barn/', 'https://www.reddit.com/']
  },
  {
    entry: '*.example.com',
    held: ['https://example.com/', 'https://a.b.example.com/x'],
    open: ['https://www.google.com/search?q=site.example.com']
  },
  {
    // A wildcard in the host stops at the end of the host.
    entry: 'porn*.test',
    held: ['https://pornsite.test/', 'https://www.pornhub.test/x'],
    open: ['https://other.test/porn.test', 'https://other.test/']
  },
  {
    entry: '.xyz',
    held: ['https://spam.xyz/', 'https://deep.sub.xyz/a'],
    open: ['https://notxyz.com/', 'https://en.wikipedia.org/wiki/a.xyz']
  }
];

for (const { entry, held, open } of CASES) {
  test(`${entry}: holds what it names and nothing else, in both layers`, () => {
    for (const url of held) {
      assert.equal(navigation(entry, url), true, `navigation should hold ${url}`);
      assert.equal(inPage(entry, url), true, `in-page should hold ${url}`);
    }
    for (const url of open) {
      assert.equal(navigation(entry, url), false, `navigation should leave ${url}`);
      assert.equal(inPage(entry, url), false, `in-page should leave ${url}`);
    }
  });
}

test('an address given relatively, or not at all, is read against its host', () => {
  // Image and link addresses reach the in-page check as the page wrote them.
  // Without a page to resolve against, the host's front page stands in.
  const sandbox = { console, Map, Set, RegExp, Array, String, self: { DomainValidate }, KeywordPattern };
  vm.createContext(sandbox);
  vm.runInContext([
    'let customPatternRegexCache = new Map();',
    functionSource(contentSource, 'customPatternCompiled'),
    functionSource(contentSource, 'siteMatchAddress'),
    functionSource(contentSource, 'customPatternsMatchHost'),
    functionSource(contentSource, 'customPatternMatchingHost'),
    'globalThis.matches = customPatternsMatchHost;'
  ].join('\n'), sandbox);
  assert.equal(sandbox.matches('', 'www.google.com', ['google.com']), true);
  assert.equal(sandbox.matches('', 'classroom.google.com', ['google.com/search']), false);
  assert.equal(sandbox.matches('', '', ['google.com']), false);
});

test('notes, /patterns/ and title rules are not sites', () => {
  for (const entry of ['# google.com/search', '! example.com', '/example\\.(net|org)/', 'title/Example Domain/', '', '   ', '/']) {
    assert.equal(DomainValidate.parseSiteEntry(entry), null, JSON.stringify(entry));
    assert.equal(DomainValidate.siteEntryRegex(entry), null, JSON.stringify(entry));
  }
  assert.equal(DomainValidate.parseSiteEntry(null), null);
});

test('parseSiteEntry names the site', () => {
  const parse = (entry) => ({ ...DomainValidate.parseSiteEntry(entry) });
  assert.deepEqual(parse('WWW.Google.com'), { host: 'google.com', path: '', wholeSite: true });
  assert.deepEqual(parse('*.example.com/a/b'), { host: 'example.com', path: '/a/b', wholeSite: false });
  assert.deepEqual(parse('https://www.reddit.com/r/foo/'), { host: 'reddit.com', path: '/r/foo/', wholeSite: false });
  assert.deepEqual(parse('example.net/*'), { host: 'example.net', path: '/*', wholeSite: true });
  assert.deepEqual(parse('.xyz'), { host: 'xyz', path: '', wholeSite: true });
  assert.deepEqual(parse('www'), { host: 'www', path: '', wholeSite: true });
});

test('blocksWholeSite counts parents and www., never a path', () => {
  assert.equal(DomainValidate.blocksWholeSite(['www.google.com'], 'classroom.google.com'), true);
  assert.equal(DomainValidate.blocksWholeSite(['*.google.com'], 'google.com'), true);
  assert.equal(DomainValidate.blocksWholeSite(['google.com/'], 'mail.google.com'), true);
  assert.equal(DomainValidate.blocksWholeSite(['google.com/search'], 'www.google.com'), false);
  assert.equal(DomainValidate.blocksWholeSite(['notgoogle.com'], 'google.com'), false);
  assert.equal(DomainValidate.blocksWholeSite(undefined, 'google.com'), false);
});

test('partialSiteEntries lists entries that block part of a site not blocked whole', () => {
  const list = ['reddit.com/r/x', 'example.com/a', 'www.example.com', 'https://x.test/a', '# note.test/x',
    '/regex\\/x/', 'title/foo/', 'site.test/', 'other.test/*', '  spaced.test/a  '];
  assert.deepEqual(Array.from(DomainValidate.partialSiteEntries(list)), ['reddit.com/r/x', 'https://x.test/a', 'spaced.test/a']);
  assert.deepEqual(Array.from(DomainValidate.partialSiteEntries(null)), []);
});

test('the popup, the quick Block button and the image rule read entries the same way', () => {
  // A www. entry already covers the site, so neither button adds a duplicate.
  assert.equal(ctx.blocklistCoversHost('example.com', ['www.example.com']), true);
  assert.equal(ctx.blocklistCoversHost('www.example.com', ['example.com/news']), false);
  const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  assert.match(functionSource(popupSource, 'hostCoveredByPatterns'), /DomainValidate\.blocksWholeSite\(patterns, host\)/);

  // The image rule blocks the site navigation blocks: "www." and "/" change
  // nothing, and a path still never becomes a host-wide image block.
  const domainsFor = (patterns) => Array.from(ctx.customPatternsToImageBlockDomains(patterns));
  assert.deepEqual(domainsFor(['www.example.com']), ['example.com']);
  assert.deepEqual(domainsFor(['example.com/', 'example.org/*', 'https://www.example.net']), ['example.com', 'example.org', 'example.net']);
  assert.deepEqual(domainsFor(['example.com/gallery', 'google.com/search']), []);
});

test('every content script that matches entries loads the shared rule first', () => {
  for (const file of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const script of manifest.content_scripts || []) {
      const at = script.js.indexOf('content.js');
      if (at === -1) continue;
      const shared = script.js.indexOf('shared/validate-domain.js');
      assert.ok(shared !== -1 && shared < at, `${file}: shared/validate-domain.js must load before content.js`);
    }
  }
});

// --- The notice after the update ------------------------------------------------

async function runNotePathEntries({ patterns, builtIn = [], previousVersion, reason = 'update', version = '2.0.3' }) {
  // The worker loads VersionCompare with importScripts, which the harness has
  // no stand-in for.
  const context = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.VersionCompare = require('../shared/version-compare.js');
  });
  await vm.runInContext('backgroundInitializationPromise', context);
  vm.runInContext(`defaultBlocklistSet = new Set(${JSON.stringify(builtIn)})`, context);
  const writes = [];
  context.chrome.runtime.getManifest = () => ({ version });
  context.chrome.storage.local.get = () => Promise.resolve({ pblocker_settings: { customPatterns: patterns } });
  context.chrome.storage.local.set = (items) => { writes.push(JSON.parse(JSON.stringify(items))); return Promise.resolve(); };
  const noted = await context.notePathEntries({ reason, previousVersion });
  return { noted, writes };
}

test('updating to 2.0.3 notes the entries that used to hold their whole site', async () => {
  const { noted, writes } = await runNotePathEntries({
    previousVersion: '2.0.2',
    builtIn: ['blocked.example'],
    patterns: [
      'reddit.com/r/x',
      'news.test/gossip*',
      // Already read by its path in-page, so nothing changes for it.
      'https://www.tumblr.com/tagged/a',
      // Its whole site is on the list too.
      'example.com/a', 'example.com',
      // The built-in list holds the whole site whatever the entry says.
      'blocked.example/videos',
      'plain.test'
    ]
  });
  assert.equal(noted, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].pblocker_path_entries_notice.entries, ['reddit.com/r/x', 'news.test/gossip*']);
  assert.equal(typeof writes[0].pblocker_path_entries_notice.at, 'number');
});

test('the notice is left for an update that crosses 2.0.3, and only then', async () => {
  const patterns = ['reddit.com/r/x'];
  assert.equal((await runNotePathEntries({ patterns, previousVersion: '1.7.6' })).noted, true);
  for (const run of [
    { patterns, previousVersion: '2.0.3' },
    { patterns, previousVersion: '2.0.3', version: '2.0.4' },
    { patterns, reason: 'install' },
    { patterns: ['example.com', '/x/'], previousVersion: '2.0.2' }
  ]) {
    const { noted, writes } = await runNotePathEntries(run);
    assert.equal(noted, false, JSON.stringify(run));
    assert.equal(writes.length, 0, JSON.stringify(run));
  }
});

// --- Sites that hold other things people need ------------------------------------

test('sharedSite knows google.com and yahoo.com, not their subdomains', () => {
  assert.equal(DomainValidate.sharedSite('google.com').host, 'google.com');
  assert.equal(DomainValidate.sharedSite('WWW.Google.com.').host, 'google.com');
  assert.equal(DomainValidate.sharedSite('yahoo.com').host, 'yahoo.com');
  for (const host of ['mail.google.com', 'classroom.google.com', 'google.co.uk', 'notgoogle.com', '', null]) {
    assert.equal(DomainValidate.sharedSite(host), null, String(host));
  }
});

test('each shared site takes what the warning names, and its searches entry keeps it', () => {
  const named = {
    'google.com': ['https://mail.google.com/mail/u/0/', 'https://classroom.google.com/u/0/h',
      'https://docs.google.com/document/d/x', 'https://drive.google.com/drive/my-drive', 'https://meet.google.com/abc-defg-hij'],
    'yahoo.com': ['https://mail.yahoo.com/d/folders/1']
  };
  for (const site of DomainValidate.SHARED_SITES) {
    assert.ok(named[site.host], `${site.host} needs addresses for what it holds`);
    for (const url of named[site.host]) {
      assert.equal(navigation(site.host, url), true, `${site.host} should take ${url}`);
      assert.equal(navigation(site.search, url), false, `${site.search} should keep ${url}`);
      assert.equal(inPage(site.search, url), false, `${site.search} should keep ${url} in-page`);
    }
    assert.equal(navigation(site.search, site.searchExample), true, `${site.search} should hold a search`);
    assert.equal(inPage(site.search, site.searchExample), true, `${site.search} should hold a search in-page`);
  }
});

test('blocksAddress asks every site entry in a list', () => {
  assert.equal(DomainValidate.blocksAddress(['# note', 'google.com/search'], 'https://www.google.com/search?q=x'), true);
  assert.equal(DomainValidate.blocksAddress(['google.com/search'], 'https://mail.google.com/'), false);
  assert.equal(DomainValidate.blocksAddress(['/google/'], 'https://www.google.com/'), false, 'a /pattern/ is not a site entry');
  assert.equal(DomainValidate.blocksAddress(undefined, 'https://www.google.com/'), false);
});

test('the popup asks before blocking a shared site, and offers its searches', () => {
  const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const block = functionSource(popupSource, 'blockCurrentSite');
  assert.match(block, /DomainValidate\.sharedSite\(domain\)/);
  assert.match(block, /showSharedSiteDialog\(shared, domain, searchListed\)/);
  assert.match(block, /if \(!choice\) return;/, 'Cancel adds nothing');
  assert.match(block, /choice === 'search'\) entry = shared\.search/);
  for (const id of ['shared-site-modal-overlay', 'shared-site-modal-title', 'shared-site-modal-desc', 'shared-site-cancel', 'shared-site-all', 'shared-site-search']) {
    assert.match(popupHtml, new RegExp(`id="${id}"`), id);
  }
  assert.match(popupSource, /holdFocusIn\(\$\('shared-site-modal-overlay'\), \$\('shared-site-cancel'\)\)/);
});

test('the Block box beside a search result says what google.com also holds', () => {
  const sandbox = { self: { DomainValidate } };
  vm.createContext(sandbox);
  vm.runInContext(functionSource(contentSource, 'quickBlockHint') + '\nglobalThis.hint = quickBlockHint;', sandbox);
  assert.equal(sandbox.hint('google.com'),
    'This also blocks Gmail, Google Classroom, Docs, Drive and Meet. To block only Google searches, add google.com/search to your blocklist in Settings.');
  assert.equal(sandbox.hint('mail.google.com'), 'Its subdomains are blocked too. Shorten it to block more of a site.');
  assert.match(functionSource(contentSource, 'openQuickBlock'), /input\.addEventListener\('input', \(\) => \{ hint\.textContent = quickBlockHint\(input\.value\); \}\)/);
});
