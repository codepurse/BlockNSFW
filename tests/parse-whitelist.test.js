// Tests for parseWhitelistFile — the global allow-list parser.
// A bug here would let a whitelisted (never-block) domain be blocked, or
// block a domain that should be allowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

const ctx = loadBackgroundContext();
const parseWhitelistFile = ctx.parseWhitelistFile;

test('parseWhitelistFile: empty input returns empty set', () => {
  const result = parseWhitelistFile('');
  assert.equal(result.size, 0);
});

test('parseWhitelistFile: parses full URL form', () => {
  const text = 'https://example.com\nhttps://sample.org/path\nhttp://test.net';
  const result = parseWhitelistFile(text);
  assert.equal(result.size, 3);
  assert.ok(result.has('example.com'));
  assert.ok(result.has('sample.org'));
  assert.ok(result.has('test.net'));
});

test('parseWhitelistFile: parses bare domain form', () => {
  const text = 'example.com\nsample.org';
  const result = parseWhitelistFile(text);
  assert.equal(result.size, 2);
  assert.ok(result.has('example.com'));
  assert.ok(result.has('sample.org'));
});

test('parseWhitelistFile: skips comments and blanks', () => {
  const text = '# comment\nexample.com\n\n   \n# another\nsample.org';
  const result = parseWhitelistFile(text);
  assert.equal(result.size, 2);
});

test('parseWhitelistFile: strips www. prefix', () => {
  const text = 'https://www.example.com\nwww.sample.org';
  const result = parseWhitelistFile(text);
  assert.equal(result.size, 2);
  assert.ok(result.has('example.com'));
  assert.ok(result.has('sample.org'));
});

test('parseWhitelistFile: rejects malformed entries', () => {
  const text = 'https://\nnot a domain at all !!\nexample.com';
  const result = parseWhitelistFile(text);
  // The URL constructor will fail on "not a domain at all !!" and the fallback
  // path will reject it as a non-domain.
  assert.equal(result.size, 1);
  assert.ok(result.has('example.com'));
});
