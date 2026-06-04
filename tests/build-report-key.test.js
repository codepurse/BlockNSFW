// Tests for the report-key dedupe helper in appwrite-client.js.
// The key is what the backend uses to detect duplicate reports, so a bug
// here could either let users spam the same report or block legitimate
// follow-up reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAppwriteClient() {
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'appwrite-client.js'),
    'utf8'
  );
  // The module exports `const PBlockerReports = (() => { ... })()`. In a vm
  // context, `const` creates a lexical binding that does not become a
  // property of the sandbox. Append a hook to expose it for tests.
  source += '\nglobalThis.__PBlockerReports = PBlockerReports;\n';
  const sandbox = {
    chrome: { storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } }, runtime: { getManifest: () => ({ version: '1.6.0' }) } },
    browser: undefined,
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    console,
    fetch: () => Promise.reject(new Error('not used here')),
    setTimeout,
    Date,
    Math
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'appwrite-client.js' });
  return sandbox.__PBlockerReports;
}

const Reports = loadAppwriteClient();

test('buildReportKey: lowercases type and domain', () => {
  assert.equal(
    Reports.buildReportKey('Should_Block', 'Example.COM'),
    'should_block:example.com'
  );
});

test('buildReportKey: keeps www. prefix (lowercases only)', () => {
  // The helper only lowercases and trims; it does not strip www.
  assert.equal(
    Reports.buildReportKey('incorrectly_blocked', 'www.example.com'),
    'incorrectly_blocked:www.example.com'
  );
});

test('buildReportKey: trims whitespace from domain', () => {
  assert.equal(
    Reports.buildReportKey('should_block', '  example.com  '),
    'should_block:example.com'
  );
});

test('buildReportKey: same type+domain produces same key', () => {
  const a = Reports.buildReportKey('should_block', 'Example.com');
  const b = Reports.buildReportKey('SHOULD_BLOCK', 'example.COM');
  assert.equal(a, b);
});

test('buildReportKey: different type produces different key', () => {
  const a = Reports.buildReportKey('should_block', 'example.com');
  const b = Reports.buildReportKey('incorrectly_blocked', 'example.com');
  assert.notEqual(a, b);
});

test('buildReportKey: handles null / undefined safely', () => {
  assert.equal(Reports.buildReportKey(null, 'example.com'), ':example.com');
  assert.equal(Reports.buildReportKey('should_block', null), 'should_block:');
});

test('isConfigured: returns true when APPWRITE_FUNCTION_URL is set', () => {
  assert.equal(Reports.isConfigured(), true);
});
