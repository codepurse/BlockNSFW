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
  vm.runInContext(source, context);
  return context;
}

const ctx = loadOptionsContext();

// Top-level `const` lands in the realm's lexical scope rather than on the
// context object, so reach it by evaluating the name inside that realm.
const constant = (name) => vm.runInContext(name, ctx);

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

test('normalizeAccessCodeConfig: defaults to off at 64 characters', () => {
  const config = ctx.normalizeAccessCodeConfig(undefined);
  assert.equal(config.enabled, false);
  assert.equal(config.length, 64);
});

test('normalizeAccessCodeConfig: keeps the three supported lengths', () => {
  assert.equal(ctx.normalizeAccessCodeConfig({ length: 32 }).length, 32);
  assert.equal(ctx.normalizeAccessCodeConfig({ length: 64 }).length, 64);
  assert.equal(ctx.normalizeAccessCodeConfig({ length: 128 }).length, 128);
});

test('normalizeAccessCodeConfig: rejects an unsupported length', () => {
  // A stored "1" would otherwise turn the deterrent into a single keystroke.
  assert.equal(ctx.normalizeAccessCodeConfig({ length: 1 }).length, 64);
  assert.equal(ctx.normalizeAccessCodeConfig({ length: 'lots' }).length, 64);
});

test('normalizeAccessCodeConfig: only a real true enables it', () => {
  assert.equal(ctx.normalizeAccessCodeConfig({ enabled: 'yes' }).enabled, false);
  assert.equal(ctx.normalizeAccessCodeConfig({ enabled: 1 }).enabled, false);
  assert.equal(ctx.normalizeAccessCodeConfig({ enabled: true }).enabled, true);
});

test('normalizeAccessCodeConfig: defaults scope to critical', () => {
  assert.equal(ctx.normalizeAccessCodeConfig({}).scope, 'critical');
  assert.equal(ctx.normalizeAccessCodeConfig({ scope: 'nonsense' }).scope, 'critical');
  assert.equal(ctx.normalizeAccessCodeConfig({ scope: 'all' }).scope, 'all');
});

test('accessCodeRequiredFor: disabled never prompts', () => {
  assert.equal(ctx.accessCodeRequiredFor({ enabled: false, scope: 'all' }, true), false);
  assert.equal(ctx.accessCodeRequiredFor({ enabled: false, scope: 'all' }, false), false);
});

test('accessCodeRequiredFor: critical scope only prompts on master switches', () => {
  const config = { enabled: true, scope: 'critical' };
  assert.equal(ctx.accessCodeRequiredFor(config, true), true);
  // Editing a blocked word must NOT demand the code in this mode — that
  // friction is what drives people to switch the feature off entirely.
  assert.equal(ctx.accessCodeRequiredFor(config, false), false);
});

test('accessCodeRequiredFor: all scope prompts on every weakening change', () => {
  const config = { enabled: true, scope: 'all' };
  assert.equal(ctx.accessCodeRequiredFor(config, true), true);
  assert.equal(ctx.accessCodeRequiredFor(config, false), true);
});

test('accessCodeRequiredFor: a corrupted scope falls back to critical', () => {
  assert.equal(ctx.accessCodeRequiredFor({ enabled: true, scope: 'everything' }, false), false);
});

test('generateAccessCode: returns exactly the requested length', () => {
  for (const length of [32, 64, 128]) {
    assert.equal(ctx.generateAccessCode(length).length, length);
  }
});

test('generateAccessCode: uses only charset characters', () => {
  const allowed = new Set(constant('ACCESS_CODE_CHARS'));
  for (const char of ctx.generateAccessCode(128)) {
    assert.ok(allowed.has(char), `unexpected character: ${char}`);
  }
});

test('generateAccessCode: excludes visually ambiguous glyphs', () => {
  // Retyping should be an effort, not a guessing game. Each confusable group
  // is broken by dropping the clashing members: 0/O go, so lowercase "o" is
  // unambiguous and stays; 1/l/I go, so "i" is likewise safe to keep.
  const chars = constant('ACCESS_CODE_CHARS');
  for (const char of '0O1lI') {
    assert.ok(!chars.includes(char), `charset should not contain ${char}`);
  }
});

test('generateAccessCode: charset has no duplicate characters', () => {
  // A repeated character would be twice as likely as the rest.
  const chars = constant('ACCESS_CODE_CHARS');
  assert.equal(new Set(chars).size, chars.length);
});

test('generateAccessCode: does not repeat itself', () => {
  const codes = new Set(Array.from({ length: 20 }, () => ctx.generateAccessCode(32)));
  assert.equal(codes.size, 20);
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
