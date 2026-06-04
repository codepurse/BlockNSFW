// Tests for patternToRegex, isLikelyDomain, normalizeDomainForCache,
// chunkArray, isHttpUrl — small but high-leverage helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

const ctx = loadBackgroundContext();

test('patternToRegex: literal pattern matches exact host', () => {
  const re = ctx.patternToRegex('example.com');
  assert.ok(re.test('example.com'));
  assert.ok(re.test('EXAMPLE.COM'));
  assert.ok(!re.test('notexample.com'));
  assert.ok(!re.test('example.org'));
});

test('patternToRegex: glob * matches any number of chars', () => {
  const re = ctx.patternToRegex('*.example.com');
  assert.ok(re.test('foo.example.com'));
  assert.ok(re.test('a.b.example.com'));
  assert.ok(!re.test('example.com'));
});

test('patternToRegex: glob ? matches single char', () => {
  const re = ctx.patternToRegex('a?b.com');
  assert.ok(re.test('axb.com'));
  assert.ok(re.test('ayb.com'));
  assert.ok(!re.test('ab.com'));
});

test('patternToRegex: escapes regex metacharacters in pattern', () => {
  const re = ctx.patternToRegex('a.b+c.com');
  // The literal dot should be escaped so it does not match any char
  assert.ok(re.test('a.b+c.com'));
  assert.ok(!re.test('aabbc.com'));
});

test('patternToRegex: full URL pattern matches that URL only', () => {
  const re = ctx.patternToRegex('https://example.com/foo');
  assert.ok(re.test('https://example.com/foo'));
  assert.ok(!re.test('https://example.com/bar'));
  assert.ok(!re.test('http://example.com/foo'));
});

test('isLikelyDomain: accepts simple valid domains', () => {
  assert.equal(ctx.isLikelyDomain('example.com'), true);
  assert.equal(ctx.isLikelyDomain('a.b.c.example.com'), true);
  assert.equal(ctx.isLikelyDomain('example.co.uk'), true);
});

test('isLikelyDomain: rejects invalid input', () => {
  assert.equal(ctx.isLikelyDomain(''), false);
  assert.equal(ctx.isLikelyDomain(null), false);
  assert.equal(ctx.isLikelyDomain(undefined), false);
  assert.equal(ctx.isLikelyDomain('-leading.com'), false);
  assert.equal(ctx.isLikelyDomain('no_tld'), false);
  assert.equal(ctx.isLikelyDomain('no spaces.com'), false);
  assert.equal(ctx.isLikelyDomain('a'.repeat(254)), false); // too long
});

test('normalizeDomainForCache: lowercases, trims, strips www.', () => {
  assert.equal(ctx.normalizeDomainForCache('  WWW.Example.COM  '), 'example.com');
  assert.equal(ctx.normalizeDomainForCache('sample.org'), 'sample.org');
  assert.equal(ctx.normalizeDomainForCache(''), '');
  assert.equal(ctx.normalizeDomainForCache(null), '');
  assert.equal(ctx.normalizeDomainForCache('www.abc.com'), 'abc.com');
});

test('chunkArray: splits into fixed-size chunks', () => {
  // Spread into a host-context array so deepStrictEqual can compare.
  assert.deepEqual([...ctx.chunkArray([1, 2, 3, 4, 5], 2)], [[1, 2], [3, 4], [5]]);
  assert.deepEqual([...ctx.chunkArray([], 3)], []);
  assert.deepEqual([...ctx.chunkArray([1, 2, 3], 5)], [[1, 2, 3]]);
});

test('chunkArray: rejects invalid input', () => {
  assert.deepEqual([...ctx.chunkArray(null, 3)], []);
  assert.deepEqual([...ctx.chunkArray('not array', 3)], []);
  assert.deepEqual([...ctx.chunkArray([1, 2, 3], 0)], []);
  assert.deepEqual([...ctx.chunkArray([1, 2, 3], -1)], []);
});

test('isHttpUrl: accepts http and https only', () => {
  assert.equal(ctx.isHttpUrl('http://example.com'), true);
  assert.equal(ctx.isHttpUrl('https://example.com/path'), true);
  // isHttpUrl is case-sensitive: uppercase schemes are not matched.
  assert.equal(ctx.isHttpUrl('HTTP://EXAMPLE.COM'), false);
  assert.equal(ctx.isHttpUrl('ftp://example.com'), false);
  assert.equal(ctx.isHttpUrl('chrome://settings'), false);
  assert.equal(ctx.isHttpUrl('about:blank'), false);
  assert.equal(ctx.isHttpUrl('not a url'), false);
  assert.equal(ctx.isHttpUrl(''), false);
});
