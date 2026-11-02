// Words that are adult only sometimes, at the address door (4th) and the
// page-text door (5th).
//
// A review: "it won't let me listen to one of my favorite songs", "I will
// search up something completely innocent and it will redirect me". Measured
// on 50 ordinary and looking addresses and titles, 22 were judged wrong. The
// address door held any address with "nude", "naked" or "xxx" in it: a
// YouTube search for Radiohead's "Nude", Kendrick Lamar's "XXX." on Genius,
// Sephora's nude lipstick, Naked Juice, The Naked Gun. The page-text door held
// a page whose title said "fetish", "xxx", "nsfw" or "erotic" once: Selena
// Gomez's "Fetish" video, xXx on IMDb, the dictionary entry for NSFW.
//
// A weak word now holds only beside a word that is looking ("nude pics",
// "xxx videos", "naked girls"), about minors, or another adult word, and an
// address or title must also say what it is about ("lyrics", "lipstick",
// "Wikipedia"). In a search SafeSearch filters, any other word does that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const UrlScan = require('../shared/url-scan.js');
const HK = require('../shared/host-keywords.js');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const lines = content.split('\n');

function functionSource(name) {
  const start = content.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  const bodyStart = content.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < content.length; index++) {
    if (content[index] === '{') depth++;
    if (content[index] === '}') depth--;
    if (depth === 0) return content.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

// The address door's checks and the page-text door's title rule, lifted out of
// content.js and run against the real shared modules and keyword lists.
const sandbox = {
  console, String, Array, Set, Math, Object, RegExp, URL, URLSearchParams,
  customKeywordList: [],
  HostBlockKeywords: HK,
  UrlScan,
  buildUrlScanText: UrlScan.buildUrlScanText,
  normalizeHost: value => String(value || '').trim().toLowerCase().replace(/^www\./, ''),
  TokenMatch: require('../shared/token-match.js')
};
vm.createContext(sandbox);
const listsFrom = lines.findIndex(l => l.startsWith('const ADULT_CONTENT_KEYWORDS = ['));
const listsTo = lines.findIndex(l => l.startsWith('const CONTEXT_WINDOW ='));
vm.runInContext(lines.slice(listsFrom, listsTo + 1).join('\n').replace(/^const /gm, 'var '), sandbox);
vm.runInContext(lines.find(l => l.startsWith('const WEAK_PAGE_WORDS')).replace(/^const /, 'var '), sandbox);
for (const name of ['isLikelyAdultHostEarly', 'isLikelyAdultPathEarly', 'indexOfSiteToken', 'matchingCustomKeyword',
  'analyzeTextForAdultContent', 'readsAsRecoveryText', 'readsAsPlainMentionText']) {
  vm.runInContext(functionSource(name), sandbox);
}
const metadataThreshold = Number(content.match(/METADATA_BLOCK_THRESHOLD = (\d+)/)[1]);

const heldAtAddressDoor = (url) => {
  const host = sandbox.normalizeHost(new URL(url).hostname);
  return HK.matchesAdultKeywordHost(host) || sandbox.isLikelyAdultHostEarly(host) || sandbox.isLikelyAdultPathEarly(url);
};
// checkPageMetadata's decision, on a title alone.
const heldByTitle = (title) => {
  const analysis = sandbox.analyzeTextForAdultContent(title);
  if (analysis.totalMatches - analysis.safeMatches < metadataThreshold) return false;
  return !sandbox.readsAsRecoveryText(title) && !sandbox.readsAsPlainMentionText(title, analysis);
};

test('ordinary addresses with a weak word pass the address door', () => {
  for (const url of [
    'https://www.youtube.com/results?search_query=radiohead+nude',
    'https://genius.com/Radiohead-nude-lyrics',
    'https://www.youtube.com/results?search_query=kendrick+lamar+xxx',
    'https://genius.com/Kendrick-lamar-xxx-lyrics',
    'https://genius.com/James-arthur-naked-lyrics',
    'https://www.google.com/search?q=avril+lavigne+naked',
    'https://www.youtube.com/results?search_query=naked+and+afraid',
    'https://www.sephora.com/shop/nude-lipstick',
    'https://www.google.com/search?q=nude+heels',
    'https://www.google.com/search?q=naked+juice+smoothie',
    'https://www.amazon.com/s?k=nude+eyeshadow+palette',
    'https://www.google.com/search?q=xxx+vin+diesel',
    'https://www.google.com/search?q=the+naked+gun+2025',
    'https://www.google.com/search?q=nsfw+meaning'
  ]) assert.equal(heldAtAddressDoor(url), false, url);
});

test('looking addresses are still held at the address door', () => {
  for (const url of [
    'https://www.google.com/search?q=nude',
    'https://www.google.com/search?q=xxx',
    'https://www.google.com/search?q=nude+pics',
    'https://www.google.com/search?q=naked+girls',
    'https://www.google.com/search?q=xxx+videos',
    'https://www.google.com/search?q=celebrity+nude+scenes',
    'https://www.google.com/search?q=nude+erotic',
    'https://www.youtube.com/results?search_query=nude+tiktok',
    'https://www.google.com/search?q=porn+lyrics',
    'https://example.com/emma-watson-nude',
    'https://example.com/nude-lipstick-pics',
    'https://example.com/category/nude-girls',
    'https://example.com/tags/xxx',
    'https://x.com/search?q=emma+watson+nude',
    'https://example.com/porn/videos'
  ]) assert.equal(heldAtAddressDoor(url), true, url);
});

test('a weak word beside a word about minors is always held', () => {
  for (const q of ['naked+teen', 'nude+kids+lipstick', 'xxx+school+song']) {
    assert.equal(heldAtAddressDoor(`https://www.google.com/search?q=${q}`), true, q);
  }
});

test('ordinary titles with a weak word pass the page-text door', () => {
  for (const title of [
    'Selena Gomez - Fetish (Official Video) ft. Gucci Mane - YouTube',
    'Kendrick Lamar - XXX. FEAT. U2 (Official Audio) - YouTube',
    'Kendrick Lamar – XXX. Lyrics | Genius Lyrics',
    'xXx: Return of Xander Cage (2017) - IMDb',
    'XXX (2002 film) - Wikipedia',
    'Fetish (song) - Wikipedia',
    'NSFW (Not Safe For Work) - Meaning & Origin | Dictionary.com',
    'Erotic thriller - Wikipedia'
  ]) assert.equal(heldByTitle(title), false, title);
});

test('looking titles are still held by the page-text door', () => {
  for (const title of [
    'Free Porn Videos - XXX Tube',
    'Hot fetish porn videos',
    'XXX Videos - Watch Free',
    'Fetish Videos',
    'Free XXX Movies',
    'Erotic Massage Videos',
    'XXX Official Site',
    'NSFW Gallery',
    'Fetish Club | Members Only',
    // A strong word is never excused, whatever the title says beside it.
    'Porn lyrics - Wikipedia'
  ]) assert.equal(heldByTitle(title), true, title);
});

test("the user's own blocked words are never excused as a plain mention", () => {
  const analysis = { customRule: 'fetish', matchedKeywords: ['fetish'] };
  assert.equal(sandbox.readsAsPlainMentionText('Fetish (song) - Wikipedia', analysis), false);
  const siteName = { matchedKeywords: ['pornhub'] };
  assert.equal(sandbox.readsAsPlainMentionText('Pornhub lyrics - Wikipedia', siteName), false);
});

test('the page-text door applies the same reading to lines', () => {
  const body = functionSource('checkPageBodyText');
  assert.match(body, /readsAsPlainMentionText\(metadata, analyzeTextForAdultContent\(metadata\)\)/);
  assert.match(body, /readsAsPlainMentionText\(line, analysis\)/);
  assert.match(body, /analysis\.matchedKeywords\.every\(keyword => WEAK_PAGE_WORDS\.has\(keyword\)\)/);
  assert.match(functionSource('checkPageMetadata'), /readsAsPlainMentionText\(textToCheck, analysis\)/);
});
