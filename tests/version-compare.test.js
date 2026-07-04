// Tests for shared/version-compare.js — the update checker's version math.
// Pure module (no chrome.*, no DOM), so we require it directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../shared/version-compare.js');

test('parseVersion: splits dotted numeric versions', () => {
  assert.deepEqual(VC.parseVersion('1.6.1'), [1, 6, 1]);
  assert.deepEqual(VC.parseVersion('2'), [2]);
  assert.deepEqual(VC.parseVersion(' 1.0.0 '), [1, 0, 0]);
});

test('parseVersion: stops at the first non-numeric part (build tags)', () => {
  assert.deepEqual(VC.parseVersion('1.7.0pre1'), [1, 7, 0]);
  assert.deepEqual(VC.parseVersion('1.7.0-beta'), [1, 7, 0]);
});

test('parseVersion: returns [] for unusable input', () => {
  assert.deepEqual(VC.parseVersion(''), []);
  assert.deepEqual(VC.parseVersion('abc'), []);
  assert.deepEqual(VC.parseVersion(null), []);
  assert.deepEqual(VC.parseVersion(undefined), []);
});

test('compareVersions: orders versions correctly', () => {
  assert.equal(VC.compareVersions('1.6.1', '1.7.0'), -1);
  assert.equal(VC.compareVersions('1.7.0', '1.6.1'), 1);
  assert.equal(VC.compareVersions('1.6.1', '1.6.1'), 0);
  assert.equal(VC.compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(VC.compareVersions('1.10.0', '1.9.0'), 1); // numeric, not lexical
});

test('compareVersions: missing trailing parts count as zero', () => {
  assert.equal(VC.compareVersions('1.6', '1.6.0'), 0);
  assert.equal(VC.compareVersions('1.6.0', '1.6'), 0);
  assert.equal(VC.compareVersions('1.6', '1.6.1'), -1);
});

test('compareVersions: unparseable input is treated as equal (never outdated)', () => {
  assert.equal(VC.compareVersions('', '1.0.0'), 0);
  assert.equal(VC.compareVersions('1.0.0', 'not-a-version'), 0);
});

test('isOutdated: true only when current is strictly older', () => {
  assert.equal(VC.isOutdated('1.6.1', '1.7.0'), true);
  assert.equal(VC.isOutdated('1.6.1', '1.6.1'), false);
  assert.equal(VC.isOutdated('1.7.0', '1.6.1'), false);
  // Garbage from a malformed version.json must not trigger a false banner.
  assert.equal(VC.isOutdated('1.6.1', ''), false);
  assert.equal(VC.isOutdated('1.6.1', 'latest'), false);
});
