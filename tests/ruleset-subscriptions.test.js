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
  assert.deepEqual(plain(parsed.entries), [
    'plain.example',
    '*.wild.example',
    '/example\\.(net|org)/',
    'title/Example Domain/'
  ]);
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

  assert.deepEqual(plain(split.hosts), ['plain.example', 'sub.plain.example']);
  assert.deepEqual(plain(split.patterns), [
    '*.wild.example',
    '/regex\\.example/',
    'title/Some Title/',
    'has.path.example/section'
  ]);
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
