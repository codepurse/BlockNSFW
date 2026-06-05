// Tests for parseHostsFile — the most critical parsing function.
// It turns a HOSTS-format text file (the entire remote blocklist) into a Set
// of normalized domains. A bug here means either no blocking or wrong targets
// are blocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

const ctx = loadBackgroundContext();
const parseHostsFile = ctx.parseHostsFile;

test('parseHostsFile: empty input returns empty set', () => {
  const result = parseHostsFile('');
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test('parseHostsFile: null / non-string input returns empty set', () => {
  assert.equal(parseHostsFile(null).size, 0);
  assert.equal(parseHostsFile(undefined).size, 0);
  assert.equal(parseHostsFile(42).size, 0);
});

test('parseHostsFile: skips blank lines and comments', () => {
  const text = [
    '# This is a comment',
    '',
    '   ',
    '# another comment',
  ].join('\n');
  const result = parseHostsFile(text);
  assert.equal(result.size, 0);
});

test('parseHostsFile: parses 0.0.0.0 host format with one domain per line', () => {
  const text = [
    '0.0.0.0    example.com',
    '0.0.0.0\tsample.org',
    '0.0.0.0 test.net',
    '127.0.0.1 localhost.localdomain'
  ].join('\n');
  const result = parseHostsFile(text);
  // 127.0.0.1 is treated as the IP column; the next token is the host.
  assert.equal(result.size, 4);
  assert.ok(result.has('example.com'));
  assert.ok(result.has('sample.org'));
  assert.ok(result.has('test.net'));
  assert.ok(result.has('localhost.localdomain'));
});

test('parseHostsFile: handles CRLF line endings', () => {
  const text = '0.0.0.0 a.com\r\n0.0.0.0 b.com\r\n';
  const result = parseHostsFile(text);
  assert.equal(result.size, 2);
  assert.ok(result.has('a.com'));
  assert.ok(result.has('b.com'));
});

test('parseHostsFile: handles inline comments after entries', () => {
  // Tokens before an inline '#' are added; the parser breaks on the first
  // '#' token. 'example.com' is added before the break, then 'sample.org'
  // is parsed on the next line.
  const text = '0.0.0.0 example.com # inline comment\n0.0.0.0 sample.org';
  const result = parseHostsFile(text);
  assert.equal(result.size, 2);
  assert.ok(result.has('example.com'));
  assert.ok(result.has('sample.org'));
});

test('parseHostsFile: normalizes www. prefix and case', () => {
  const text = '0.0.0.0 WWW.Example.COM\n0.0.0.0 www.other.com';
  const result = parseHostsFile(text);
  assert.equal(result.size, 2);
  assert.ok(result.has('example.com'));
  assert.ok(result.has('other.com'));
});

test('parseHostsFile: rejects malformed non-domain entries', () => {
  const text = '0.0.0.0 -invalid-\n0.0.0.0 no_tld\n0.0.0.0 valid.com';
  const result = parseHostsFile(text);
  assert.equal(result.size, 1);
  assert.ok(result.has('valid.com'));
});

test('parseHostsFile: ignores IP addresses (treats them as IPs)', () => {
  const text = '0.0.0.0 1.2.3.4\n0.0.0.0 example.com';
  const result = parseHostsFile(text);
  assert.equal(result.size, 1);
  assert.ok(result.has('example.com'));
});

test('parseHostsFile: parses real-world HOSTS snapshot sample', () => {
  // First 10 lines of an actual hosts-format blocklist file
  const text = `0.0.0.0    0.nextyourcontent.com
0.0.0.0    0.oldgyhogola.com
0.0.0.0    0.xd-cdn.com
0.0.0.0    0.xxx-cdn.com
0.0.0.0    0006666.net
0.0.0.0    000free.us
0.0.0.0    0013langford.tumblr.com
0.0.0.0    002.pinknotora.net
0.0.0.0    007angels.com
0.0.0.0    007gayboys.com`;
  const result = parseHostsFile(text);
  assert.equal(result.size, 10);
  assert.ok(result.has('0006666.net'));
  assert.ok(result.has('007gayboys.com'));
});

// ---------------------------------------------------------------------------
// P0 punycode / IDN coverage (NON_ENGLISH_ADULT_BLOCKING_TODO Test Coverage)
// ---------------------------------------------------------------------------

test('parseHostsFile: punycode domains survive parse', () => {
  const text = [
    '0.0.0.0    xn--porn-tqa.net',
    '0.0.0.0    xn--80a6ad.com',
    '0.0.0.0    example.xn--fiqs8s',  // .中国 TLD (must be 2+ labels)
    '0.0.0.0    example.xn--p1ai'     // .рф TLD (must be 2+ labels)
  ].join('\n');
  const result = parseHostsFile(text);
  assert.equal(result.size, 4);
  assert.ok(result.has('xn--porn-tqa.net'));
  assert.ok(result.has('xn--80a6ad.com'));
  assert.ok(result.has('example.xn--fiqs8s'));
  assert.ok(result.has('example.xn--p1ai'));
});

test('parseHostsFile: comments and whitespace still work with punycode entries', () => {
  const text = [
    '# Curation policy header comment',
    '',
    '   ',
    '# Another comment',
    '0.0.0.0    xn--porn-tqa.net   # inline comment after punycode entry',
    '',
    '0.0.0.0\txn--80a6ad.com\t\t# tab-separated with inline comment',
    '0.0.0.0  example.xn--p1ai  ',  // 2-label host with .рф TLD
  ].join('\n');
  const result = parseHostsFile(text);
  assert.equal(result.size, 3);
  assert.ok(result.has('xn--porn-tqa.net'));
  assert.ok(result.has('xn--80a6ad.com'));
  assert.ok(result.has('example.xn--p1ai'));
});

test('parseHostsFile: malformed IDN-like garbage still rejected', () => {
  // NOTE: a single-line entry cannot contain a space inside a hostname
  // because parseHostsFile tokenizes by whitespace - the space would
  // split the entry into two separate tokens. Test space-malformed
  // entries on separate lines.
  const text = [
    '0.0.0.0    xn--.com',         // bare xn-- (no body) - ends in hyphen
    '0.0.0.0    xn--abc-.com',     // ends in hyphen
    '0.0.0.0    -xn--abc.com',     // starts with hyphen
    '0.0.0.0    xn--abc!def.com',  // invalid char in body
    '0.0.0.0    xn--abc',          // single label (rejected)
    '0.0.0.0    xn--valid.com',    // valid punycode, must survive
    '0.0.0.0    plain.com'         // valid plain, must survive
  ].join('\n');
  const result = parseHostsFile(text);
  assert.equal(result.size, 2);
  assert.ok(result.has('xn--valid.com'));
  assert.ok(result.has('plain.com'));
  assert.ok(!result.has('xn--.com'));
  assert.ok(!result.has('xn--abc-.com'));
  assert.ok(!result.has('xn--abc!def.com'));
});
