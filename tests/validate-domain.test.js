// Tests for shared/validate-domain.js — the whitelist input validator used by
// both the popup and the options page. Regression coverage for issue #5, where
// the old regex only accepted a single "label.tld" form and rejected every
// domain that had a subdomain (e.g. bintv-nett.blogspot.com) or a multi-part
// TLD, so users could never whitelist a false-positive page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDomain } = require('../shared/validate-domain.js');

test('validateDomain: accepts the domain from bug report #5', () => {
  assert.equal(validateDomain('bintv-nett.blogspot.com'), 'bintv-nett.blogspot.com');
});

test('validateDomain: accepts a plain second-level domain', () => {
  assert.equal(validateDomain('example.com'), 'example.com');
});

test('validateDomain: accepts subdomains of any depth', () => {
  assert.equal(validateDomain('sub.domain.example.org'), 'sub.domain.example.org');
  assert.equal(validateDomain('a.b.c.d.example.com'), 'a.b.c.d.example.com');
});

test('validateDomain: accepts multi-part TLDs', () => {
  assert.equal(validateDomain('example.co.uk'), 'example.co.uk');
});

test('validateDomain: accepts punycode (xn--) host labels', () => {
  assert.equal(validateDomain('xn--80ak6aa92e.com'), 'xn--80ak6aa92e.com');
});

test('validateDomain: strips scheme, www., path, port and trailing dot', () => {
  assert.equal(validateDomain('https://www.bintv-nett.blogspot.com/live'), 'bintv-nett.blogspot.com');
  assert.equal(validateDomain('http://example.com:8080'), 'example.com');
  assert.equal(validateDomain('example.com.'), 'example.com');
});

test('validateDomain: lowercases the result (domains are case-insensitive)', () => {
  assert.equal(validateDomain('BinTV-Nett.BlogSpot.COM'), 'bintv-nett.blogspot.com');
});

test('validateDomain: trims surrounding whitespace', () => {
  assert.equal(validateDomain('  example.com  '), 'example.com');
});

test('validateDomain: rejects malformed input', () => {
  assert.equal(validateDomain(''), null);
  assert.equal(validateDomain('localhost'), null);          // no TLD
  assert.equal(validateDomain('not a domain at all !!'), null);
  assert.equal(validateDomain('.com'), null);               // empty label
  assert.equal(validateDomain('example.'), null);           // empty TLD
  assert.equal(validateDomain('-bad.com'), null);           // leading hyphen
  assert.equal(validateDomain('bad-.com'), null);           // trailing hyphen
  assert.equal(validateDomain('exam ple.com'), null);       // embedded space
  assert.equal(validateDomain('example.c'), null);          // 1-char TLD
  assert.equal(validateDomain(null), null);
  assert.equal(validateDomain(undefined), null);
  assert.equal(validateDomain(12345), null);
});
