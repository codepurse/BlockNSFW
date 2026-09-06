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
  // 'localhost' used to be listed here as "no TLD". It is now deliberately
  // accepted — see "accepts localhost and its subtree" below — because refusing
  // it left no way to whitelist a local dev server.
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

// --- Local and private hosts ------------------------------------------------
// The whitelist inputs refused `localhost` and every bare IP: DOMAIN_REGEX
// requires a dot and a letters-only TLD, so someone trying to allow their own
// dev server got "Please enter a valid domain" whatever they typed. There was
// no accepted spelling, which meant no way out of a page-level block.

test('validateDomain: accepts localhost and its subtree', () => {
  assert.equal(validateDomain('localhost'), 'localhost');
  assert.equal(validateDomain('localhost:3000'), 'localhost');
  assert.equal(validateDomain('http://localhost:8080/app'), 'localhost');
  assert.equal(validateDomain('dev.localhost'), 'dev.localhost');
});

test('validateDomain: accepts a bare IPv4 address', () => {
  assert.equal(validateDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(validateDomain('127.0.0.1:5173'), '127.0.0.1');
  assert.equal(validateDomain('192.168.1.10'), '192.168.1.10');
  assert.equal(validateDomain('10.0.0.5'), '10.0.0.5');
});

test('validateDomain: still refuses a bare label', () => {
  // This is the reason localhost is special-cased rather than single labels
  // being allowed in general: a whitelist entry covers its subdomains, so "com"
  // would quietly allow every .com domain there is.
  assert.equal(validateDomain('com'), null);
  assert.equal(validateDomain('xyz'), null);
  assert.equal(validateDomain('localhosts'), null);
  assert.equal(validateDomain('notlocalhost'), null);
});

test('validateDomain: refuses a malformed address', () => {
  assert.equal(validateDomain('999.1.1.1'), null);
  assert.equal(validateDomain('1.2.3'), null);
  // A leading zero reads as octal to some resolvers and decimal to others;
  // refuse rather than pick one.
  assert.equal(validateDomain('127.00.0.1'), null);
});
