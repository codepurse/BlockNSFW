// Comment lines in the three user lists. Requested by a user moving over from
// uBlacklist, where '#' starts a note; uBlock Origin and AdGuard use '!', and
// lists get pasted between all three, so both markers are accepted.
//
// Two things here are easy to get wrong and quiet when they break:
//
//   1. A comment must never reach a matcher. The lists are stored as one array
//      of lines, so a '# adult sites' line compiled as a host pattern would
//      block whatever domain the note happened to mention.
//   2. Saving sorts A-Z and de-duplicates. A note is a heading for the lines
//      under it, so sorting lines individually would strand every comment away
//      from its group — the sort has to move blocks, not lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KeywordPattern = require('../shared/keyword-pattern.js');

const optionsSource = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');

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

// serializePatterns is what the Save buttons run. Loaded with the real shared
// module so the test exercises the same comment rule production does.
function loadOptionsListContext() {
  const sandbox = { console, Set, Map, KeywordPattern };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      functionSource(optionsSource, 'isCommentLine'),
      functionSource(optionsSource, 'serializePatterns'),
      functionSource(optionsSource, 'countRealEntries'),
      functionSource(optionsSource, 'deserializePatterns')
    ].join('\n'),
    sandbox
  );
  return sandbox;
}

// Arrays built inside a vm context carry that context's Array prototype, so
// deepStrictEqual rejects them as not reference-equal even when the contents
// match. Copy into a host-realm array before comparing.
const plain = (value) => Array.from(value);

// --- the shared rule --------------------------------------------------------

test('isCommentEntry: both markers, leading whitespace tolerated', () => {
  assert.equal(KeywordPattern.isCommentEntry('# uBlacklist style'), true);
  assert.equal(KeywordPattern.isCommentEntry('! uBlock and AdGuard style'), true);
  assert.equal(KeywordPattern.isCommentEntry('   # indented'), true);
  assert.equal(KeywordPattern.isCommentEntry('#no space needed'), true);
  assert.equal(KeywordPattern.isCommentEntry('!==== heading ===='), true);

  assert.equal(KeywordPattern.isCommentEntry('example.com'), false);
  assert.equal(KeywordPattern.isCommentEntry('/p[o0]rn/'), false);
  assert.equal(KeywordPattern.isCommentEntry('title/Example/'), false);
  assert.equal(KeywordPattern.isCommentEntry(''), false);
  assert.equal(KeywordPattern.isCommentEntry(null), false);
  // A '#' mid-entry is part of the entry — a URL fragment, for instance.
  assert.equal(KeywordPattern.isCommentEntry('example.com/#/gallery'), false);
});

test('stripCommentEscape: one backslash protects a #/! entry and nothing else', () => {
  assert.equal(KeywordPattern.stripCommentEscape('\\#nsfw'), '#nsfw');
  assert.equal(KeywordPattern.stripCommentEscape('\\!important'), '!important');
  // A backslash before anything else belongs to the entry — regexes are full of
  // them, and eating one would silently change what a pattern matches.
  assert.equal(KeywordPattern.stripCommentEscape('/\\d+/'), '/\\d+/');
  assert.equal(KeywordPattern.stripCommentEscape('\\w'), '\\w');
  assert.equal(KeywordPattern.stripCommentEscape('example.com'), 'example.com');
});

test('effectiveEntries: comments dropped, escapes resolved', () => {
  const stored = [
    '# === Social ===',
    'twitter.com',
    '! also a note',
    '\\#nsfw',
    '',
    '   ',
    '/p[o0]rn/'
  ];
  assert.deepEqual(KeywordPattern.effectiveEntries(stored), [
    'twitter.com',
    '#nsfw',
    '/p[o0]rn/'
  ]);
});

test('effectiveEntries: a comment can never become a pattern', () => {
  // The failure this guards: '# block example.com later' compiled as a host
  // pattern would block example.com.
  const out = KeywordPattern.effectiveEntries(['# block example.com later']);
  assert.deepEqual(plain(out), []);
});

// --- validation must not judge a note ---------------------------------------

test('validateEntry: a comment is valid and is not a regex', () => {
  const result = KeywordPattern.validateEntry('# /unclosed(');
  // '/unclosed(' would be a broken regex and would block the save. As a comment
  // it has to pass, or a note containing pattern-ish text becomes unsavable.
  assert.equal(result.ok, true);
  assert.equal(result.isRegex, false);
  assert.equal(result.isComment, true);
});

test('validateListEntry: a comment reports kind "comment" and passes', () => {
  const result = KeywordPattern.validateListEntry('! (a+)+$ mentioned in a note');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'comment');
});

test('parseListEntry: comments are their own kind; escaped entries parse as entries', () => {
  assert.equal(KeywordPattern.parseListEntry('# note').kind, 'comment');
  assert.equal(KeywordPattern.parseListEntry('!note').kind, 'comment');
  assert.equal(KeywordPattern.parseListEntry('\\#nsfw').kind, 'wildcard');
  assert.equal(KeywordPattern.parseListEntry('example.com').kind, 'wildcard');
  assert.equal(KeywordPattern.parseListEntry('/example\\.org/').kind, 'url');
  assert.equal(KeywordPattern.parseListEntry('title/Example/').kind, 'title');
});

test('compileListEntry: a comment compiles to nothing', () => {
  const compiled = KeywordPattern.compileListEntry('# example.com');
  assert.equal(compiled.kind, 'comment');
  assert.equal(compiled.regex, null);
});

// --- saving: sort blocks, not lines -----------------------------------------

test('serializePatterns: a note stays with the entry written under it', () => {
  const ctx = loadOptionsListContext();
  const out = ctx.serializePatterns([
    '# === Video ===',
    'youtube.com',
    '# === Shopping ===',
    'amazon.com'
  ].join('\n'));

  // Sorted by entry (amazon before youtube), each heading carried along. Sorting
  // the lines on their own would have put both '#' lines together at one end.
  assert.deepEqual(plain(out), [
    '# === Shopping ===',
    'amazon.com',
    '# === Video ===',
    'youtube.com'
  ]);
});

test('serializePatterns: several notes above one entry all travel with it', () => {
  const ctx = loadOptionsListContext();
  const out = ctx.serializePatterns([
    'zebra.com',
    '# reported by a user',
    '! see issue 42',
    'apple.com'
  ].join('\n'));

  assert.deepEqual(plain(out), [
    '# reported by a user',
    '! see issue 42',
    'apple.com',
    'zebra.com'
  ]);
});

test('serializePatterns: identical notes are kept, identical entries are not', () => {
  const ctx = loadOptionsListContext();
  const out = ctx.serializePatterns([
    '# ---',
    'a.com',
    '# ---',
    'b.com'
  ].join('\n'));

  // Two '# ---' separators are both meant to be there; de-duplicating them would
  // collapse the visual structure the user built.
  assert.deepEqual(plain(out), ['# ---', 'a.com', '# ---', 'b.com']);
});

test('serializePatterns: a duplicate entry keeps its note on the surviving copy', () => {
  const ctx = loadOptionsListContext();
  const out = ctx.serializePatterns([
    '# first mention',
    'twitter.com',
    '# second mention',
    'twitter.com'
  ].join('\n'));

  // The entry is deduped. Its second note describes the same entry, so it joins
  // the surviving block rather than being dropped or drifting to another entry.
  assert.deepEqual(plain(out), ['# first mention', '# second mention', 'twitter.com']);
});

test('serializePatterns: trailing notes with no entry below are kept at the end', () => {
  const ctx = loadOptionsListContext();
  const out = ctx.serializePatterns([
    'a.com',
    '# todo: add more later'
  ].join('\n'));

  assert.deepEqual(plain(out), ['a.com', '# todo: add more later']);
});

test('serializePatterns: a list with no comments is unchanged from before', () => {
  const ctx = loadOptionsListContext();
  // The regression that matters most: existing lists must sort exactly as they
  // did before comments existed.
  assert.deepEqual(
    plain(ctx.serializePatterns('zebra.com\napple.com\nApple.com\n\nmango.com')),
    ['apple.com', 'mango.com', 'zebra.com']
  );
});

test('countRealEntries: notes are not entries', () => {
  const ctx = loadOptionsListContext();
  assert.equal(ctx.countRealEntries(['# a', 'b.com', '! c', 'd.com']), 2);
  assert.equal(ctx.countRealEntries(['# only notes']), 0);
  assert.equal(ctx.countRealEntries([]), 0);
});

test('escapeCommentEntry: migrating a list saved before comments existed', () => {
  // '#nsfw' was a working blocked word. After this change it would read as a
  // note and quietly stop blocking, so it is rewritten to mean what it meant.
  assert.equal(KeywordPattern.escapeCommentEntry('#nsfw'), '\\#nsfw');
  assert.equal(KeywordPattern.escapeCommentEntry('!important'), '\\!important');
  assert.equal(KeywordPattern.escapeCommentEntry('example.com'), 'example.com');
  assert.equal(KeywordPattern.escapeCommentEntry('/p[o0]rn/'), '/p[o0]rn/');

  // And the escape round-trips back to the original meaning.
  assert.equal(
    KeywordPattern.stripCommentEscape(KeywordPattern.escapeCommentEntry('#nsfw')),
    '#nsfw'
  );
});

test('a migrated hashtag entry still matches after the round trip', () => {
  const migrated = KeywordPattern.escapeCommentEntry('#nsfw');
  assert.deepEqual(KeywordPattern.effectiveEntries([migrated]), ['#nsfw']);
});
