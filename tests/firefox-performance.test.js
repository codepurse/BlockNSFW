const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

test('content initialization does not clone the full blocklist into every page', () => {
  const loadSettings = contentSource.slice(
    contentSource.indexOf('async function loadSettings()'),
    contentSource.indexOf('function isFacebookHost')
  );
  assert.doesNotMatch(loadSettings, /await\s+loadBlocklist\s*\(/);
  assert.match(contentSource, /type:\s*['"]check_blocklist_hosts['"]/);
  assert.match(contentSource, /querySelectorAll\?\.\(['"]img, video, iframe['"]\)/);
});

test('background URL checks use the blocklist index without a regex per domain', () => {
  assert.doesNotMatch(backgroundSource, /preCompiledDomainPatterns/);
  assert.match(backgroundSource, /if \(isUrlInDefaultBlocklist\(urlStr\)\)/);
  assert.doesNotMatch(backgroundSource, /domainTrie\.batchInsert\(filterSharedCDNParents\(hostEntries\)\)/);
  assert.match(backgroundSource, /backgroundInitializationPromise/);
  assert.doesNotMatch(backgroundSource, /defaultBlocklistSet = new Set\(hostEntries\)/);
});

test('bundled blocklist suppresses an immediate fresh-install refresh', () => {
  assert.match(backgroundSource, /source:\s*['"]bundled['"]/);
});

test('set-based default blocklist keeps exact, subdomain, and shared-CDN semantics', () => {
  const context = loadBackgroundContext();
  vm.runInContext(
    "defaultBlocklistSet = new Set(['blocked.example', 'tenant.cloudfront.net', 'cloudfront.net'])",
    context
  );
  assert.equal(context.isUrlInDefaultBlocklist('https://blocked.example/path'), true);
  assert.equal(context.isUrlInDefaultBlocklist('https://sub.blocked.example/path'), true);
  assert.equal(context.isUrlInDefaultBlocklist('https://tenant.cloudfront.net/image.jpg'), true);
  assert.equal(context.isUrlInDefaultBlocklist('https://safe.cloudfront.net/image.jpg'), false);
  assert.equal(context.isUrlInDefaultBlocklist('https://safe.example/path'), false);
});
