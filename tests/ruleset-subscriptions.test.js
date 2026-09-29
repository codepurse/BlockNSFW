// Ruleset subscriptions: following a blocklist somebody else maintains.
//
// The format is uBlacklist's on purpose, so addresses a user already follows in
// that extension can be pasted straight in. That makes the parser the contract:
// if it mis-reads a real ruleset file, the subscription silently blocks the
// wrong things or nothing at all.
//
// The rule that matters most here is the one that is not about parsing. A
// subscribed list may ADD blocks and do nothing else. There is no allow form, so
// a file downloaded from a stranger cannot unblock a site, cannot touch the
// whitelist, and cannot turn anything off. On a porn blocker, a remote off
// switch is the one feature that must not exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Ruleset = require('../shared/ruleset.js');
const KeywordPattern = require('../shared/keyword-pattern.js');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function functionSource(source, name) {
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

const plain = (value) => Array.from(value);

// --- parsing a ruleset file --------------------------------------------------

test('parseRuleset: a bare list of domains', () => {
  const parsed = Ruleset.parseRuleset('a.example\nb.example\nc.example\n');
  assert.deepEqual(plain(parsed.entries), ['a.example', 'b.example', 'c.example']);
  assert.equal(parsed.name, '');
});

test('parseRuleset: YAML front matter supplies the name', () => {
  const parsed = Ruleset.parseRuleset([
    '---',
    'name: Example spam list',
    'homepage: https://example.com/list',
    '---',
    'spam.example'
  ].join('\n'));

  assert.equal(parsed.name, 'Example spam list');
  assert.equal(parsed.homepage, 'https://example.com/list');
  // The header must not leak into the rules; 'name: ...' as a blocking rule
  // would be nonsense that matches nothing.
  assert.deepEqual(plain(parsed.entries), ['spam.example']);
});

test('parseRuleset: quoted header values are unwrapped', () => {
  const parsed = Ruleset.parseRuleset('---\nname: "Quoted Name"\n---\na.example');
  assert.equal(parsed.name, 'Quoted Name');
});

test('parseRuleset: an unterminated header is treated as rules, not swallowed', () => {
  // A stray '---' at the top must not cost the user their entire list.
  const parsed = Ruleset.parseRuleset('---\na.example\nb.example');
  assert.equal(parsed.entries.includes('a.example'), true);
  assert.equal(parsed.entries.includes('b.example'), true);
});

test('parseRuleset: comments and blank lines are dropped', () => {
  const parsed = Ruleset.parseRuleset([
    '# maintained by someone',
    '',
    'a.example',
    '! another note',
    '   ',
    'b.example'
  ].join('\n'));
  assert.deepEqual(plain(parsed.entries), ['a.example', 'b.example']);
});

test('parseRuleset: all three rule forms survive', () => {
  const parsed = Ruleset.parseRuleset([
    'plain.example',
    '*.wild.example',
    '/example\\.(net|org)/',
    'title/Example Domain/'
  ].join('\n'));
  // '*.wild.example' and 'wild.example' match exactly the same hosts, so the
  // wildcard is stored as the host: a lookup instead of a loop.
  assert.deepEqual(plain(parsed.entries), [
    'plain.example',
    'wild.example',
    '/example\\.(net|org)/',
    'title/Example Domain/'
  ]);
  assert.deepEqual(plain(parsed.hosts), ['plain.example', 'wild.example']);
  assert.deepEqual(plain(parsed.patterns), ['/example\\.(net|org)/', 'title/Example Domain/']);
});

// --- uBlacklist match patterns ----------------------------------------------
//
// The form real uBlacklist lists are written in. Before it was understood,
// every line of OISD's NSFW list was rejected and the list parsed to nothing.

test('parseRuleset: a match pattern for a whole site reads as that host', () => {
  const parsed = Ruleset.parseRuleset([
    '*://*.one.example/*',
    '*://two.example/*',
    'https://three.example/*',
    'http://*.four.example/',
    '*://*.FIVE.Example/*'
  ].join('\n'));
  assert.deepEqual(plain(parsed.hosts),
    ['one.example', 'two.example', 'three.example', 'four.example', 'five.example']);
  assert.deepEqual(plain(parsed.patterns), []);
  assert.equal(parsed.skipped, 0);
});

test('parseRuleset: a match pattern with a path keeps the path', () => {
  const parsed = Ruleset.parseRuleset('*://*.forum.example/nsfw/*');
  assert.deepEqual(plain(parsed.hosts), []);
  assert.deepEqual(plain(parsed.patterns), ['forum.example/nsfw/*']);
});

test('parseRuleset: a match pattern for a whole TLD stays a wildcard', () => {
  // OISD's list carries four of these (.adult, .porn, .sex, .xxx). A single
  // label is not a host the lookup can hold, so it keeps the pattern form the
  // blocked-site box already accepts.
  const parsed = Ruleset.parseRuleset('*://*.xxx/*\n*://*.porn/*');
  assert.deepEqual(plain(parsed.patterns), ['*.xxx', '*.porn']);
});

test('parseRuleset: match patterns that cannot be a blocklist entry are skipped', () => {
  const parsed = Ruleset.parseRuleset([
    '*://*/*',                     // every site on the web
    '<all_urls>',
    'ftp://files.example/*',       // not a scheme a page is loaded over
    '*://example.com:8080/*',      // ports are not part of match patterns
    '*://ex*mple.com/*',           // a wildcard inside a name is not allowed
    'kept.example'
  ].join('\n'));
  assert.deepEqual(plain(parsed.entries), ['kept.example']);
  assert.equal(parsed.skipped, 5);
});

test('parseRuleset: uBlacklist allow and highlight rules are not rules here', () => {
  const parsed = Ruleset.parseRuleset([
    '@*://*.allowed.example/*',
    '@1*://*.highlighted.example/*',
    '*://*.blocked.example/*'
  ].join('\n'));
  assert.deepEqual(plain(parsed.entries), ['blocked.example']);
  assert.equal(parsed.skipped, 2);
});

test('parseRuleset: www is dropped from a host, as every lookup drops it', () => {
  // Stored with its www., an entry could never be found: the matchers strip
  // www. from the host they are asked about before looking it up.
  const parsed = Ruleset.parseRuleset('*://www.site.example/*\nwww.other.example');
  assert.deepEqual(plain(parsed.hosts), ['site.example', 'other.example']);
});

test('parseRuleset: an internationalised host is stored in punycode', () => {
  const parsed = Ruleset.parseRuleset('*://*.bücher.example/*');
  assert.deepEqual(plain(parsed.hosts), ['xn--bcher-kva.example']);
});

test('parseRuleset: the same site spelled several ways is one entry', () => {
  const parsed = Ruleset.parseRuleset([
    '*://*.dup.example/*',
    '*://dup.example/*',
    'dup.example',
    '*.dup.example',
    '.dup.example',
    'dup.example/*'
  ].join('\n'));
  assert.deepEqual(plain(parsed.entries), ['dup.example']);
});

test('parseRuleset: an OISD-shaped file comes through whole', () => {
  // The shape of https://nsfw.oisd.nl/ublacklist, at its real size: comment
  // header, then a match pattern per line. Every rule must survive, and it must
  // parse well inside the time a background task can reasonably take.
  const count = 481222;
  const lines = [
    '# Title: oisd nsfw',
    '# Syntax: uBlacklist',
    `# Entries: ${count}`,
    ''
  ];
  for (let i = 0; i < count - 4; i++) lines.push(`*://*.site${i}.example/*`);
  lines.push('*://*.adult/*', '*://*.porn/*', '*://*.sex/*', '*://*.xxx/*');
  const text = lines.join('\n');
  assert.ok(text.length > 12 * 1024 * 1024, 'the fixture is at least as big as the real file');
  assert.ok(text.length < Ruleset.MAX_FILE_BYTES, 'and within the size limit');

  const started = Date.now();
  const parsed = Ruleset.parseRuleset(text);
  const elapsed = Date.now() - started;

  assert.equal(parsed.hosts.length, count - 4);
  assert.equal(parsed.patterns.length, 4);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.truncated, false);
  assert.ok(elapsed < 10000, `parse took ${elapsed} ms`);
});

test('parseRuleset: non-host rules are capped separately from hosts', () => {
  // Patterns are walked one by one per image; hosts are a lookup. A list of
  // thousands of path rules must not slow every page, however many hosts it
  // carries alongside.
  const lines = [];
  for (let i = 0; i < Ruleset.MAX_PATTERN_ENTRIES + 25; i++) lines.push(`host${i}.example/path`);
  for (let i = 0; i < 100; i++) lines.push(`plain${i}.example`);
  const parsed = Ruleset.parseRuleset(lines.join('\n'));
  assert.equal(parsed.patterns.length, Ruleset.MAX_PATTERN_ENTRIES);
  assert.equal(parsed.hosts.length, 100, 'the pattern cap does not touch hosts');
  assert.equal(parsed.skipped, 25, 'patterns past the cap are reported');
});

test('parseRuleset: a broken regex in someone else\'s file is skipped, not fatal', () => {
  const parsed = Ruleset.parseRuleset([
    'good.example',
    '/unclosed(/',
    'also-good.example'
  ].join('\n'));

  // One bad line must not cost the user the other 30,000.
  assert.equal(parsed.entries.includes('good.example'), true);
  assert.equal(parsed.entries.includes('also-good.example'), true);
  assert.equal(parsed.skipped >= 1, true);
});

test('parseRuleset: duplicates within a file collapse', () => {
  const parsed = Ruleset.parseRuleset('a.example\nA.EXAMPLE\na.example');
  assert.equal(parsed.entries.length, 1);
});

test('parseRuleset: an HTML page yields nothing usable', () => {
  // The common mistake is pasting the GitHub page instead of the raw file. The
  // caller treats an empty result as an error and says so.
  const parsed = Ruleset.parseRuleset('<!doctype html>\n<html><body><p>Not a ruleset</p></body></html>');
  assert.equal(parsed.entries.length, 0);
});

test('parseRuleset: entry count is capped', () => {
  const many = Array.from({ length: Ruleset.MAX_ENTRIES + 500 }, (_, i) => `host${i}.example`).join('\n');
  const parsed = Ruleset.parseRuleset(many);
  assert.equal(parsed.entries.length, Ruleset.MAX_ENTRIES);
  // Reported rather than silently applied, so the UI can say the list was cut.
  assert.equal(parsed.truncated, true);
});

// --- the rule that cannot bend ----------------------------------------------

test('a subscribed list has no way to express "allow"', () => {
  // uBlacklist has an '@' prefix for allow rules. This format deliberately does
  // not, and anything resembling one must not parse into something meaningful.
  const parsed = Ruleset.parseRuleset([
    '@@allowed.example',
    '@allowed.example',
    'blocked.example'
  ].join('\n'));

  for (const entry of parsed.entries) {
    const kind = KeywordPattern.parseListEntry(entry).kind;
    // Every surviving entry is a block of some kind. None of them is an
    // instruction to permit anything.
    assert.ok(['wildcard', 'url', 'title'].includes(kind), `${entry} parsed as ${kind}`);
  }
});

// --- splitting for match speed ----------------------------------------------

test('splitEntries: bare hosts go to the fast set, patterns keep the slow path', () => {
  const split = Ruleset.splitEntries([
    'plain.example',
    'sub.plain.example',
    '*.wild.example',
    '/regex\\.example/',
    'title/Some Title/',
    'has.path.example/section'
  ]);

  // '*.wild.example' covers exactly what 'wild.example' does, so it is a host.
  assert.deepEqual(plain(split.hosts), ['plain.example', 'sub.plain.example', 'wild.example']);
  assert.deepEqual(plain(split.patterns), [
    '/regex\\.example/',
    'title/Some Title/',
    'has.path.example/section'
  ]);
});

// --- the packed host index ---------------------------------------------------

test('createHostIndex: finds every packed host and nothing else', () => {
  const hosts = ['b.example', 'a.example', 'c.example', 'a.example', 'zz.example', '0.example'];
  const index = Ruleset.createHostIndex(Ruleset.packHosts(hosts));
  assert.equal(index.size, 5, 'duplicates are packed once');
  for (const host of hosts) assert.equal(index.has(host), true, host);
  for (const host of ['', 'example', 'd.example', 'a.exampl', 'a.examplee', 'b.example\na.example']) {
    assert.equal(index.has(host), false, JSON.stringify(host));
  }
});

test('createHostIndex: prefixes of listed hosts are not matches', () => {
  // Line boundaries are what separate "ab.example" from "ab.example.net"; a
  // compare that ran past the end of a line would conflate them.
  const index = Ruleset.createHostIndex(Ruleset.packHosts(['ab.example', 'ab.example.net']));
  assert.equal(index.has('ab.example'), true);
  assert.equal(index.has('ab.example.net'), true);
  assert.equal(index.has('ab.exampl'), false);
  assert.equal(index.has('ab.example.ne'), false);
});

test('createHostIndex: empty and missing input match nothing', () => {
  for (const packed of ['', undefined, null, 42]) {
    const index = Ruleset.createHostIndex(packed);
    assert.equal(index.size, 0);
    assert.equal(index.has('a.example'), false);
  }
});

test('createHostIndex: agrees with a Set over a large random list', () => {
  const hosts = new Set();
  // 32-bit LCG in integer arithmetic; a float multiply here loses precision
  // and falls into a short cycle.
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  while (hosts.size < 20000) hosts.add(`${next().toString(36)}.${next() % 2 ? 'com' : 'net'}`);
  const index = Ruleset.createHostIndex(Ruleset.packHosts([...hosts]));
  for (const host of hosts) assert.equal(index.has(host), true);
  for (let i = 0; i < 20000; i++) {
    const probe = `${next().toString(36)}.com`;
    assert.equal(index.has(probe), hosts.has(probe), probe);
  }
});

test('splitEntries: a single-word entry is not treated as a host', () => {
  // 'localhost' or a stray word has no dot and would otherwise land in the host
  // set, where it could match nothing useful but cost a lookup.
  const split = Ruleset.splitEntries(['localhost', 'real.example']);
  assert.deepEqual(plain(split.hosts), ['real.example']);
});

// --- matching in the content script -----------------------------------------

function loadMatcherContext(entries) {
  const split = Ruleset.splitEntries(entries);
  const sandbox = {
    console,
    Set,
    URL,
    subscriptionHostSet: new Set(split.hosts),
    subscriptionPatterns: split.patterns,
    // Only the host set is under test here; the pattern path is customPatternsMatchHost,
    // which is already covered by the custom-blocklist tests.
    customPatternsMatchHost: () => false,
    normalizeHost: (host) => String(host || '').trim().toLowerCase().replace(/^www\./, '')
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource(contentSource, 'matchesSubscriptionRule'), sandbox);
  return sandbox;
}

test('matchesSubscriptionRule: an exact host matches', () => {
  const ctx = loadMatcherContext(['blocked.example']);
  assert.equal(ctx.matchesSubscriptionRule('https://blocked.example/page', 'blocked.example'), true);
  assert.equal(ctx.matchesSubscriptionRule('https://other.example/', 'other.example'), false);
});

test('matchesSubscriptionRule: a host rule covers its subdomains', () => {
  const ctx = loadMatcherContext(['blocked.example']);
  assert.equal(
    ctx.matchesSubscriptionRule('https://cdn.blocked.example/i.jpg', 'cdn.blocked.example'),
    true
  );
  assert.equal(
    ctx.matchesSubscriptionRule('https://a.b.blocked.example/i.jpg', 'a.b.blocked.example'),
    true
  );
});

test('matchesSubscriptionRule: a sibling domain is not caught by accident', () => {
  const ctx = loadMatcherContext(['blocked.example']);
  // The failure this guards: naive suffix matching where 'notblocked.example'
  // ends with 'blocked.example'.
  assert.equal(
    ctx.matchesSubscriptionRule('https://notblocked.example/', 'notblocked.example'),
    false
  );
});

test('matchesSubscriptionRule: the walk up stops before the public suffix', () => {
  const ctx = loadMatcherContext(['example']);
  // A one-label entry must never match everything under '.example'.
  assert.equal(ctx.matchesSubscriptionRule('https://anything.example/', 'anything.example'), false);
});

test('matchesSubscriptionRule: no subscriptions means no work and no match', () => {
  const ctx = loadMatcherContext([]);
  assert.equal(ctx.matchesSubscriptionRule('https://anything.example/', 'anything.example'), false);
});

test('matchesSubscriptionRule: www is normalised away', () => {
  const ctx = loadMatcherContext(['blocked.example']);
  assert.equal(
    ctx.matchesSubscriptionRule('https://www.blocked.example/', 'www.blocked.example'),
    true
  );
});

// --- URL validation ----------------------------------------------------------

test('isHttpUrl: only http(s) can be subscribed to', () => {
  assert.equal(Ruleset.isHttpUrl('https://example.com/list.txt'), true);
  assert.equal(Ruleset.isHttpUrl('http://example.com/list.txt'), true);
  assert.equal(Ruleset.isHttpUrl('  https://example.com/list.txt  '), true);

  // A subscription is fetched by the extension, so these would be asking it to
  // read the local disk or run script on its own behalf.
  assert.equal(Ruleset.isHttpUrl('file:///etc/passwd'), false);
  assert.equal(Ruleset.isHttpUrl('javascript:alert(1)'), false);
  assert.equal(Ruleset.isHttpUrl('data:text/plain,a.example'), false);
  assert.equal(Ruleset.isHttpUrl('chrome-extension://abc/list.txt'), false);
  assert.equal(Ruleset.isHttpUrl(''), false);
});
