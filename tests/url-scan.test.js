// Tests for shared/url-scan.js — the query-string sanitizer behind the early
// path/URL keyword block in content.js.
//
// Regression: a 4get.ca user reported that the engine's own adult filter,
// expressed as `&nsfw=no` in the URL, tripped the blocker because the raw query
// string contains the word "nsfw". Filter switches must read as controls; the
// same page with the filter turned off must still block.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUrlScanText, isFilterSwitchEngaged } = require('../shared/url-scan.js');

// The regex the early block runs over buildUrlScanText's output.
const EARLY_PATH_KEYWORDS = /\b(porn|porno|pornography|xxx|nsfw|hentai|nude|naked|erotic)\b/i;
const blocks = (url) => EARLY_PATH_KEYWORDS.test(buildUrlScanText(url));

test('4get: a search with the built-in adult filter on is not blocked', () => {
  assert.equal(blocks('https://4get.ca/web?s=cats&nsfw=no'), false);
  assert.equal(blocks('https://4get.ca/web?s=cats&nsfw=no&scraper=duckduckgo'), false);
  assert.equal(blocks('https://4get.ca/images?s=puppies&nsfw=no'), false);
});

test('4get: a search with the adult filter switched off still blocks', () => {
  assert.equal(blocks('https://4get.ca/web?s=cats&nsfw=yes'), true);
  assert.equal(blocks('https://4get.ca/web?s=cats&nsfw=only'), true);
});

test('filter switches are recognized in both polarities', () => {
  // Positively named switch: an "off" value means the filter is engaged.
  assert.equal(blocks('https://example.com/search?q=cats&nsfw=0'), false);
  assert.equal(blocks('https://example.com/search?q=cats&nsfw=false'), false);
  assert.equal(blocks('https://example.com/search?q=cats&nsfw=exclude'), false);
  // Negatively named switch: an "on" value means the same thing.
  assert.equal(blocks('https://example.com/search?q=cats&hide-nsfw=true'), false);
  assert.equal(blocks('https://example.com/search?q=cats&nsfw-filter=1'), false);
  // ...and the negated switch turned off is a real signal again.
  assert.equal(blocks('https://example.com/search?q=cats&hide-nsfw=false'), true);
  assert.equal(blocks('https://example.com/search?q=cats&nsfw-filter=off'), true);

  assert.equal(isFilterSwitchEngaged('hide_nsfw', 'true'), true);
  assert.equal(isFilterSwitchEngaged('hide_nsfw', 'false'), false);
  assert.equal(isFilterSwitchEngaged('show_nsfw', '0'), true);
  assert.equal(isFilterSwitchEngaged('nsfw_filter', 'on'), true);
});

// Pre-existing property of the keyword regexes, unchanged by the sanitizer:
// "_" is a word character, so \bnsfw\b never matched an underscore-joined
// parameter name in the first place. Documented so a future \b widening
// doesn't reintroduce the false positive through the back door.
test('underscore-joined parameter names never reach the keyword regex', () => {
  assert.equal(blocks('https://example.com/search?q=cats&show_nsfw=0'), false);
  assert.equal(blocks('https://example.com/search?q=cats&show_nsfw=1'), false);
});

test('keywords in parameter values are still scanned', () => {
  assert.equal(blocks('https://example.com/search?q=porn'), true);
  assert.equal(blocks('https://example.com/search?q=porn&nsfw=no'), true);
  assert.equal(blocks('https://example.com/watch?category=hentai&nsfw=no'), true);
});

test('keywords in the path are still scanned, filter switch or not', () => {
  assert.equal(blocks('https://example.com/porn/videos'), true);
  assert.equal(blocks('https://example.com/porn/videos?nsfw=no'), true);
  assert.equal(blocks('https://example.com/hentai?safesearch=strict'), true);
});

test('percent-encoded keywords in path and value survive decoding', () => {
  assert.equal(blocks('https://example.com/%70orn/clip'), true);
  assert.equal(blocks('https://example.com/search?q=%6Eude'), true);
});

test('a bare flag keeps its old meaning (no polarity stated)', () => {
  assert.equal(blocks('https://example.com/gallery?nsfw'), true);
  assert.equal(blocks('https://example.com/gallery?nsfw='), true);
});

test('ordinary URLs produce no keyword hits', () => {
  assert.equal(blocks('https://example.com/'), false);
  assert.equal(blocks('https://example.com/docs/getting-started?lang=en'), false);
  assert.equal(blocks('https://en.wikipedia.org/wiki/Essex'), false);
});

test('buildUrlScanText: pathname and retained query are space-joined', () => {
  assert.equal(buildUrlScanText('https://example.com/a/b?x=1&y=2'), '/a/b x 1 y 2');
  assert.equal(buildUrlScanText('https://example.com/a/b'), '/a/b');
  assert.equal(buildUrlScanText('https://example.com/a/b?nsfw=no'), '/a/b');
});

test('buildUrlScanText: includeQuery:false scans the path only', () => {
  assert.equal(buildUrlScanText('https://example.com/a?q=porn', { includeQuery: false }), '/a');
});

test('buildUrlScanText: accepts a URL object as well as a string', () => {
  const u = new URL('https://4get.ca/web?s=cats&nsfw=no');
  assert.equal(buildUrlScanText(u), '/web s cats');
});

test('buildUrlScanText: unparseable input degrades to the raw text', () => {
  assert.equal(buildUrlScanText('not a url at all'), 'not a url at all');
  assert.equal(buildUrlScanText(''), '');
  assert.equal(buildUrlScanText(null), '');
});

test('isFilterSwitchEngaged: values outside the boolean vocabulary are kept', () => {
  assert.equal(isFilterSwitchEngaged('nsfw', 'no'), true);
  assert.equal(isFilterSwitchEngaged('nsfw', 'yes'), false);
  assert.equal(isFilterSwitchEngaged('nsfw', 'maybe'), false);
  assert.equal(isFilterSwitchEngaged('q', 'porn'), false);
  assert.equal(isFilterSwitchEngaged('nsfw', ''), false);
  assert.equal(isFilterSwitchEngaged(null, null), false);
});
