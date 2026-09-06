// Tests for the options page's protection-strength guards — the helpers that
// decide whether a settings change needs the PIN. The rule: tightening is
// always free, loosening is gated. A gap here is a silent bypass, so these are
// worth pinning down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadOptionsContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  // The access code moved to a shared module (issue #29). options.html loads
  // it before options.js, so do the same here.
  const accessCode = fs.readFileSync(path.join(__dirname, '..', 'shared', 'access-code.js'), 'utf8');
  // options.js only touches the DOM from inside its DOMContentLoaded handler,
  // so stubbing the listener is enough to evaluate it here.
  const context = {
    chrome: { storage: { local: {}, session: {} }, runtime: {} },
    window: {},
    document: { addEventListener() {} },
    crypto: require('node:crypto').webcrypto,
    console,
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(accessCode, context);
  vm.runInContext(source, context);
  return context;
}

const ctx = loadOptionsContext();

test('hasRemovals: deleting an entry is a removal', () => {
  assert.equal(ctx.hasRemovals(['apricot', 'plum'], ['plum']), true);
});

test('hasRemovals: adding an entry is not a removal', () => {
  assert.equal(ctx.hasRemovals(['plum'], ['plum', 'apricot']), false);
});

test('hasRemovals: unchanged list is not a removal', () => {
  assert.equal(ctx.hasRemovals(['plum'], ['plum']), false);
});

test('hasRemovals: missing/undefined previous list is not a removal', () => {
  assert.equal(ctx.hasRemovals(undefined, ['plum']), false);
  assert.equal(ctx.hasRemovals(null, []), false);
});

test('hasRemovals: swapping one entry for another still counts', () => {
  assert.equal(ctx.hasRemovals(['apricot'], ['plum']), true);
});

test('hasRemovals: collapsing a case-duplicate is not a removal', () => {
  // serializePatterns dedups case-insensitively, so this pair collapses on
  // save. Protection is unchanged, so it must not demand the PIN.
  assert.equal(ctx.hasRemovals(['Apple', 'apple'], ['Apple']), false);
});

test('hasRemovals: re-casing an entry is not a removal', () => {
  assert.equal(ctx.hasRemovals(['Apple'], ['apple']), false);
});

test('hasAdditions: adding a trusted domain loosens protection', () => {
  assert.equal(ctx.hasAdditions(['a.com'], ['a.com', 'b.com']), true);
});

test('hasAdditions: removing a trusted domain does not', () => {
  assert.equal(ctx.hasAdditions(['a.com', 'b.com'], ['a.com']), false);
});

test('hasAdditions: missing/undefined lists are handled', () => {
  assert.equal(ctx.hasAdditions(undefined, ['a.com']), true);
  assert.equal(ctx.hasAdditions(['a.com'], undefined), false);
});

test('hasAdditions: re-casing an existing entry is not an addition', () => {
  assert.equal(ctx.hasAdditions(['a.com'], ['A.com']), false);
});

// Arrays built inside the VM realm have a different prototype than this one,
// so copy them out before comparing.
const patterns = (text) => Array.from(ctx.serializePatterns(text));

test('serializePatterns: drops blank lines and trims', () => {
  assert.deepEqual(patterns('  plum  \n\n\n  apricot\n'), ['apricot', 'plum']);
});

test('serializePatterns: sorts A-Z regardless of case', () => {
  assert.deepEqual(patterns('zebra\nApple\nmango'), ['Apple', 'mango', 'zebra']);
});

test('serializePatterns: removes duplicates, first spelling wins', () => {
  assert.deepEqual(patterns('Apricot\napricot\nAPRICOT'), ['Apricot']);
});

test('serializePatterns: empty input yields an empty list', () => {
  assert.deepEqual(patterns(''), []);
  assert.deepEqual(patterns('\n  \n'), []);
});

// --- list import / export --------------------------------------------------

const parse = (text) => Array.from(ctx.parseListFile(text));

test('parseListFile: one entry per line, trimmed, blanks dropped', () => {
  assert.deepEqual(parse('apple\n\n  mango  \r\nzebra\n'), ['apple', 'mango', 'zebra']);
});

test('parseListFile: an unquoted line stays one entry even with commas', () => {
  // A list user typing "hello, world" means one phrase, not two entries.
  assert.deepEqual(parse('hello, world\nplum'), ['hello, world', 'plum']);
});

test('parseListFile: quoted fields keep their commas', () => {
  assert.deepEqual(parse('"buy now, act fast"\nplum'), ['buy now, act fast', 'plum']);
});

test('parseListFile: doubled quotes unescape to one quote', () => {
  assert.deepEqual(parse('"say ""hi"" now"'), ['say "hi" now']);
});

test('parseListFile: quoted field may span lines', () => {
  assert.deepEqual(parse('"two\nlines"\nplum'), ['two\nlines', 'plum']);
});

test('parseListFile: strips a UTF-8 BOM from the first entry', () => {
  // Excel writes a BOM; without stripping it the first entry silently
  // mismatches everything and never blocks.
  assert.deepEqual(parse('﻿apple\nmango'), ['apple', 'mango']);
});

test('parseListFile: empty input yields nothing', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('\r\n  \n'), []);
});

test('serializeListFile: quotes only what needs quoting', () => {
  assert.equal(ctx.serializeListFile(['plum', 'hello, world', 'say "hi"']),
    'plum\r\n"hello, world"\r\n"say ""hi"""');
});

test('serializeListFile / parseListFile: survive a round trip', () => {
  const entries = ['plum', 'hello, world', 'say "hi"', 'multi\nline', 'apricot'];
  assert.deepEqual(parse(ctx.serializeListFile(entries)), entries);
});

// The access code's own rules (charset, lengths, scope) are tested against
// shared/access-code.js in tests/access-code.test.js. What matters here is
// that options.js still reaches them.
test('options.js delegates the access-code decision to the shared module', () => {
  assert.equal(ctx.accessCodeRequiredFor({ enabled: true, scope: 'critical' }, true), true);
  assert.equal(ctx.accessCodeRequiredFor({ enabled: true, scope: 'critical' }, false), false);
  assert.equal(ctx.normalizeAccessCodeConfig({ length: 1 }).length, 64);
  assert.equal(ctx.generateAccessCode(32).length, 32);
});

test('accessCodeTier: maps the gate options onto the shared tiers', () => {
  assert.equal(ctx.accessCodeTier({ tier: 'tuning' }), 'tuning');
  assert.equal(ctx.accessCodeTier({ critical: true }), 'critical');
  // A plain gate call stays 'normal' — the default must never be 'tuning'.
  assert.equal(ctx.accessCodeTier(undefined), 'normal');
  assert.equal(ctx.accessCodeTier({}), 'normal');
  assert.equal(ctx.accessCodeTier({ critical: false }), 'normal');
});

test('the sensitivity dials are tuning, so they skip the code entirely', () => {
  // The complaint this fixes: on the 'all' scope, lowering image detection
  // strictness demanded the full 32-256 character code. The PIN still applies.
  const all = { enabled: true, scope: 'all' };
  assert.equal(ctx.accessCodeRequiredFor(all, ctx.accessCodeTier({ tier: 'tuning' })), false);
  assert.equal(ctx.accessCodeRequiredFor(all, ctx.accessCodeTier({})), true);
});

test('weakensImageFilter: lowering the level weakens', () => {
  assert.equal(ctx.weakensImageFilter('strict', 'moderate'), true);
  assert.equal(ctx.weakensImageFilter('strict', 'lenient'), true);
  assert.equal(ctx.weakensImageFilter('moderate', 'lenient'), true);
});

test('weakensImageFilter: raising or keeping the level does not', () => {
  assert.equal(ctx.weakensImageFilter('lenient', 'strict'), false);
  assert.equal(ctx.weakensImageFilter('moderate', 'moderate'), false);
});

test('weakensImageFilter: unknown values normalize to strict', () => {
  // An unset/garbage previous value is treated as strict, so moving to
  // anything lower is still gated rather than slipping through.
  assert.equal(ctx.weakensImageFilter(undefined, 'lenient'), true);
  assert.equal(ctx.weakensImageFilter('lenient', 'nonsense'), false);
});

test('weakensAiStrictness: lowering strictness weakens', () => {
  assert.equal(ctx.weakensAiStrictness('strict', 'balanced'), true);
  assert.equal(ctx.weakensAiStrictness('balanced', 'relaxed'), true);
});

test('weakensAiStrictness: raising or keeping strictness does not', () => {
  assert.equal(ctx.weakensAiStrictness('relaxed', 'strict'), false);
  assert.equal(ctx.weakensAiStrictness('balanced', 'balanced'), false);
});

test('weakensAiStrictness: unknown values normalize to balanced', () => {
  assert.equal(ctx.weakensAiStrictness(undefined, 'relaxed'), true);
  assert.equal(ctx.weakensAiStrictness(undefined, 'strict'), false);
});
