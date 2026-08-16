// Tests for shared/token-match.js — standalone-token matching for adult *site*
// names in free text.
//
// Regression: "erome" (erome.com) was substring-matched against page titles,
// body text and search queries, and a single hit blocks on its own, so every
// page mentioning "Jerome" was blocked — the name, Jerome Powell, Jerome AZ,
// St. Jerome.
const test = require('node:test');
const assert = require('node:assert/strict');
const { indexOfStandaloneToken, containsStandaloneToken } = require('../shared/token-match.js');

const has = (text, token) => containsStandaloneToken(text.toLowerCase(), token);

test('the reported false positive: "Jerome" is not "erome"', () => {
  assert.equal(has('Jerome', 'erome'), false);
  assert.equal(has('Jerome Powell testified today', 'erome'), false);
  assert.equal(has('Visiting Jerome, Arizona', 'erome'), false);
  assert.equal(has('St. Jerome and the Vulgate', 'erome'), false);
  assert.equal(has("Jerome's Furniture", 'erome'), false);
  // Greek "eromenos" also merely contains the token.
  assert.equal(has('the eromenos in Athenian society', 'eromenos'.slice(0, 5)), false);
});

test('the real site name still matches', () => {
  assert.equal(has('erome.com', 'erome'), true);
  assert.equal(has('watch on erome', 'erome'), true);
  assert.equal(has('EROME', 'erome'), true);
  assert.equal(has('https://www.erome.com/a/xyz', 'erome'), true);
  assert.equal(has('erome/album/1', 'erome'), true);
  // Digits and punctuation are inside the boundary, only letters are outside.
  assert.equal(has('erome_2', 'erome'), true);
  assert.equal(has('erome2', 'erome'), true);
  assert.equal(has('(erome)', 'erome'), true);
});

test('other site names in the list behave the same way', () => {
  assert.equal(has('pornhub.com/view', 'pornhub'), true);
  assert.equal(has('tube8.com', 'tube8'), true);
  assert.equal(has('onlyfans.com/creator', 'onlyfans'), true);
  // ...and are not matched inside a longer word.
  assert.equal(has('youtube8k review', 'tube8'), false);
  assert.equal(has('theonlyfansite', 'onlyfans'), false);
});

test('a token at the very start or end of the text matches', () => {
  assert.equal(has('erome', 'erome'), true);
  assert.equal(has('site: erome', 'erome'), true);
  assert.equal(has('erome hosts albums', 'erome'), true);
});

test('indexOfStandaloneToken: reports the position of the standalone hit', () => {
  assert.equal(indexOfStandaloneToken('jerome and erome.com', 'erome', 0), 11);
  assert.equal(indexOfStandaloneToken('jerome only', 'erome', 0), -1);
  // fromIndex skips an earlier hit.
  assert.equal(indexOfStandaloneToken('erome and erome', 'erome', 1), 10);
});

test('indexOfStandaloneToken: overlapping occurrences are not skipped', () => {
  // Stepping by token length instead of 1 would miss the second "aba".
  assert.equal(indexOfStandaloneToken('-ababa-', 'aba', 0), -1);
  assert.equal(indexOfStandaloneToken('xaba aba', 'aba', 0), 5);
});

test('indexOfStandaloneToken: empty and missing input is safe', () => {
  assert.equal(indexOfStandaloneToken('', 'erome', 0), -1);
  assert.equal(indexOfStandaloneToken('erome', '', 0), -1);
  assert.equal(indexOfStandaloneToken(null, 'erome', 0), -1);
  assert.equal(indexOfStandaloneToken('erome', null, 0), -1);
  assert.equal(indexOfStandaloneToken('erome', 'erome', undefined), 0);
});
