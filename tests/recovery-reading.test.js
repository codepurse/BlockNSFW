// Recovery pages held as adult, door by door.
//
// A user in recovery was held at the fourth door (address & search) visiting
// a site about quitting porn. Measured on 56 real recovery addresses, the
// address door held 46: every Fight the New Drug article, NoFap forum threads,
// Healthline and WebMD pages, a YouTube search for "how to quit porn". Its path
// check held any address with "porn" in it, whatever the words around it said.
// The same measurement found the old search reading too loose the other way:
// "teen porn addiction", "how to bypass porn blocker" and "stepsister porn
// addiction" all went through.
//
// The fix reads an address the way the page-text door reads a page: the words
// around the match decide (shared/url-scan.js isRecoveryAddress). A host name
// gets only phrases that never name an adult site (shared/host-keywords.js
// recoveryHostMatches). The page-text door, which held Fight the New Drug's
// own titles, now asks the same question of a title and a line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const UrlScan = require('../shared/url-scan.js');
const HK = require('../shared/host-keywords.js');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

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

// The address door's two early checks, lifted out of content.js and run
// against the real shared modules.
function loadAddressDoor() {
  const sandbox = {
    console, String, Array,
    HostBlockKeywords: HK,
    UrlScan,
    buildUrlScanText: UrlScan.buildUrlScanText,
    normalizeHost: value => String(value || '').trim().toLowerCase().replace(/^www\./, '')
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource('isLikelyAdultHostEarly'), sandbox);
  vm.runInContext(functionSource('isLikelyAdultPathEarly'), sandbox);
  return (url) => {
    const host = sandbox.normalizeHost(new URL(url).hostname);
    return HK.matchesAdultKeywordHost(host) ||
      sandbox.isLikelyAdultHostEarly(host) ||
      sandbox.isLikelyAdultPathEarly(url);
  };
}
const heldAtAddressDoor = loadAddressDoor();

test('recovery addresses pass the address door', () => {
  const recovery = [
    // Articles, threads and pages about getting away from it
    'https://fightthenewdrug.org/how-porn-affects-the-brain-like-a-drug/',
    'https://fightthenewdrug.org/10-reasons-why-porn-is-unhealthy-for-consumers/',
    'https://fightthenewdrug.org/how-porn-can-hurt-your-relationship/',
    'https://www.healthline.com/health/porn-addiction',
    'https://www.psychologytoday.com/us/blog/202301/why-porn-addiction-is-so-hard-to-quit',
    'https://www.webmd.com/sex/what-is-pornography-addiction',
    'https://www.medicalnewstoday.com/articles/porn-induced-erectile-dysfunction',
    'https://www.betterhelp.com/advice/addiction/how-to-stop-watching-porn/',
    'https://forum.nofap.com/index.php?threads/day-90-no-porn.12345/',
    'https://forum.nofap.com/index.php?threads/my-relapse-after-60-days-of-no-porn.67890/',
    'https://www.desiringgod.org/articles/how-to-fight-porn',
    'https://endsexualexploitation.org/issues/pornography/',
    'https://www.amazon.com/Your-Brain-Porn-Pornography-Addiction/dp/0992716810',
    'https://apps.apple.com/us/app/quittr-quit-porn-now/id6670792826',
    'https://podcasts.apple.com/us/podcast/porn-free-radio/id1234567',
    'https://example.org/blog/living-porn-free-after-ten-years',
    'https://www.quora.com/Is-watching-porn-normal',
    'https://www.quora.com/Is-watching-porn-a-sin',
    'https://medium.com/@someone/how-i-quit-porn-after-10-years-a1b2c3',
    // Searches on engines that force SafeSearch, and YouTube's Restricted Mode
    'https://www.youtube.com/results?search_query=how+to+quit+porn',
    'https://www.youtube.com/results?search_query=porno+sucht',
    'https://www.google.com/search?q=porn+induced+erectile+dysfunction',
    'https://www.google.com/search?q=why+do+i+watch+porn',
    'https://www.google.com/search?q=porn+ruined+my+marriage',
    'https://www.google.com/search?q=how+porn+affects+the+brain',
    'https://www.google.com/search?q=no+porn+challenge',
    'https://www.google.com/search?q=is+porn+haram',
    'https://www.google.com/search?q=how+to+live+porn-free',
    'https://www.google.com/search?q=xxx+church',
    // Recovery sites whose name is the phrase
    'https://quitpornnow.com/',
    'https://www.pornaddictionhelp.org/',
    'https://pornrecoveryapp.com/',
    'https://overcomingporn.org/',
    'https://freefromporn.com/'
  ];
  for (const url of recovery) assert.equal(heldAtAddressDoor(url), false, url);
});

test('looking, and getting past a blocker, is still held', () => {
  const looking = [
    'https://example.com/porn/videos',
    'https://example.com/free-porn',
    'https://example.com/porn-free-videos',
    'https://example.com/porn-addiction-xxx-videos',
    'https://example.com/porn-addiction/milf-videos',
    'https://example.com/how-to-quit-porn-hd',
    'https://example.com/quit-porn-proxy',
    'https://example.com/nude/how-to-quit-porn',
    'https://www.reddit.com/r/porn/',
    'https://www.google.com/search?q=porn',
    'https://www.google.com/search?q=porn+free',
    'https://www.google.com/search?q=quit+free+porn',
    'https://www.google.com/search?q=porn+help+videos',
    'https://www.google.com/search?q=porn+naked+help',
    'https://www.google.com/search?q=porn+unblocked+help',
    'https://www.google.com/search?q=how+to+bypass+porn+blocker',
    'https://www.google.com/search?q=family+therapy+porn',
    'https://www.google.com/search?q=porn+stars+addiction',
    'https://www.google.com/search?q=stepsister+porn+addiction',
    'https://www.youtube.com/results?search_query=porn',
    'https://quitporn-tube.example/',
    'https://quitpornhd.example/',
    'https://nonstopporn.example/',
    'https://pornaddict.example/',
    'https://catfightporn.example/',
    'https://hdpornfree.example/'
  ];
  for (const url of looking) assert.equal(heldAtAddressDoor(url), true, url);
});

test('words about minors are never read as recovery', () => {
  // The price of the rule: some real help searches are held. "how to quit
  // porn" and "porn blocker" are the way through.
  for (const q of ['teen+porn+addiction', 'protect+kids+from+porn', 'porn+addiction+in+young+men']) {
    assert.equal(heldAtAddressDoor(`https://www.google.com/search?q=${q}`), true, q);
  }
});

test('a recovery word only speaks for the piece of the address it is in', () => {
  assert.equal(UrlScan.isRecoveryAddress('https://example.com/porn?quit'), false);
  assert.equal(UrlScan.isRecoveryAddress('https://example.com/porn?ref=quit+porn'), false);
  assert.equal(UrlScan.isRecoveryAddress('https://example.com/how-to-quit-porn?utm_source=newsletter'), true);
});

test('a search box on a site without SafeSearch is never read as recovery', () => {
  assert.equal(UrlScan.isRecoveryAddress('https://x.com/search?q=quit+porn'), false);
  assert.equal(UrlScan.isRecoveryAddress('https://www.reddit.com/search/?q=porn+recovery'), false);
  assert.equal(UrlScan.isRecoveryAddress('https://example.com/?s=porn+addiction'), false);
  assert.equal(UrlScan.isRecoveryAddress('https://www.google.com/search?q=porn+recovery'), true);
});

test("an engine's copy of the half-typed search doesn't outvote the search", () => {
  assert.equal(UrlScan.isRecoveryAddress(
    'https://www.bing.com/search?q=porn+addiction+help&form=QBLH&sp=-1&pq=porn+addic&sc=10-10'), true);
  assert.equal(UrlScan.isRecoveryAddress(
    'https://www.google.com/search?q=porn+addiction&oq=porn+add&sourceid=chrome&ie=UTF-8'), true);
  assert.equal(UrlScan.isRecoveryAddress('https://www.google.com/search?q=porn&oq=porn+addiction'), false);
});

test('an address with no adult word is not "recovery" from anything', () => {
  assert.equal(UrlScan.isRecoveryAddress('https://example.com/how-to-quit-smoking'), false);
  assert.equal(UrlScan.isRecoveryAddress('not a url'), false);
  assert.equal(UrlScan.isRecoveryAddress(null), false);
});

test('readsAsRecovery: titles about getting away from it, and titles selling it', () => {
  for (const title of [
    'How Porn Can Affect the Brain Like a Drug',
    'Get The Facts - Fight the New Drug™ Decades of research show how consuming porn can impact you',
    'Recovery from porn addiction: why it starts in the brain',
    'Day 90 no porn | NoFap'
  ]) assert.equal(UrlScan.readsAsRecovery(title), true, title);
  for (const title of [
    'Free Porn Videos & Sex Movies - Porno, XXX, Porn Tube',
    'Porn Addiction? Watch our hottest porn videos',
    'Porn Help Desk - Live Cams',
    'Porn Stars Who Quit',
    'Quit porn - free hd videos',
    'Best Porn Sites List',
    'Fight the New Drug'
  ]) assert.equal(UrlScan.readsAsRecovery(title), false, title);
});

// --- Host names --------------------------------------------------------------

test('recoveryHostMatches: one-word recovery names, and the near misses', () => {
  for (const host of ['quitporn.org', 'quittingporn.com', 'yourbrainonporn.com', 'antiporn.org',
    'pornaddictionhelp.org', 'pornographyaddiction.blogspot.com', 'pornrecovery.app',
    'overcomingporn.org', 'freefromporn.com', 'stopporn.fr']) {
    assert.equal(HK.recoveryHostMatches(host), true, host);
  }
  for (const host of ['nonstopporn.com', 'pornaddict.com', 'hdpornfree.tv', 'africanoporn.com',
    'girlfriendporn.net', 'catfightporn.com', 'quitporn-tube.com', 'quitpornhd.com',
    'pornrecoverysex.com', 'pornhub.com', 'example.com']) {
    assert.equal(HK.recoveryHostMatches(host), false, host);
  }
});

// Every phrase was checked against the adult list when it was chosen. The list
// grows every day, so this keeps checking: a new adult host that one of them
// would release fails here, for a person to look at.
test('no host on the adult list is released by a recovery phrase', () => {
  const text = fs.readFileSync(path.join(ROOT, 'data', 'HOSTS.txt'), 'utf8');
  const released = new Set();
  for (const line of text.split('\n')) {
    const match = line.match(/^0\.0\.0\.0\s+(\S+)/);
    if (!match) continue;
    const host = match[1].toLowerCase().replace(/^www\./, '');
    if (HK.recoveryHostMatches(host)) released.add(host);
  }
  // Both look anti-porn but neither answers, so they stay listed.
  assert.deepEqual([...released].sort(), ['istoppornography.org', 'stoppornography.net']);
});

test('recovery sites the adult list had by mistake are off it and whitelisted', () => {
  const hosts = fs.readFileSync(path.join(ROOT, 'data', 'HOSTS.txt'), 'utf8');
  const whitelist = fs.readFileSync(path.join(ROOT, 'data', 'WHITELIST.txt'), 'utf8');
  for (const site of ['yourbrainonporn.com', 'realyourbrainonporn.com', 'xxxchurch.com', 'stopporn.fr',
    'wefightporn.com', 'pornographyaddiction.blogspot.com', 'nopornoinfantil.blogspot.com']) {
    const listed = new RegExp(`^0\\.0\\.0\\.0\\s+(www\\.)?${site.replace(/\./g, '\\.')}\\s*$`, 'm');
    assert.equal(listed.test(hosts), false, `${site} is still on data/HOSTS.txt`);
    // The curation bot skips whitelisted domains, so this keeps it off.
    assert.ok(whitelist.includes(`https://${site}/`), `${site} should be on data/WHITELIST.txt`);
  }
});

// --- The page-text door ------------------------------------------------------

test('the page-text door asks the same question of a title and a line', () => {
  const metadata = functionSource('checkPageMetadata');
  assert.match(metadata, /readsAsRecoveryText\(textToCheck\)/);
  const body = functionSource('checkPageBodyText');
  assert.match(body, /readsAsRecoveryText\(pageMetadataText\(\)\)/);
  assert.match(body, /readsAsRecoveryText\(line\)/);
  // The user's own words and the multilingual list are never overruled.
  assert.match(body, /if \(!analysis\.customRule && !containsMultilingualAdultKeyword\(line\.toLowerCase\(\)\)\)/);
  assert.match(functionSource('readsAsRecoveryText'), /containsMultilingualAdultKeyword/);
});
