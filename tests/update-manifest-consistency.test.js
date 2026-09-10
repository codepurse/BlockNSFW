// Guards on data/version.json, the file that drives the in-product update
// banner (audit finding M13, wider than first reported).
//
// checkForUpdate() fetches this file from the repository's main branch and
// compares `latest` against the installed manifest version. It sat at 1.6.1
// from June through the 1.7.0-1.7.6 releases, so for every real user
// isOutdated("1.7.x", "1.6.1") was false and the banner never appeared once.
// The whole self-hosted update-notification feature — the TTL cache, the
// per-store URLs, the popup and options banners — was dead, and nothing said
// so, because a version that is merely stale is not an error anywhere.
//
// What can and cannot be automated:
//   - "latest is NEWER than the manifest" is always a bug: it points users at
//     a build that does not exist. Asserted here.
//   - "latest is too OLD" cannot be decided from the tree, because only the
//     store knows what is actually published. During release prep the manifest
//     is deliberately ahead. That one is a checklist step at publish time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VC = require('../shared/version-compare.js');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const versionInfo = JSON.parse(read(path.join('data', 'version.json')));
const manifest = JSON.parse(read('manifest.json'));
const firefoxManifest = JSON.parse(read('manifest.firefox.json'));
const pkg = JSON.parse(read('package.json'));
const changelog = read('CHANGELOG.md');

test('the three manifests and package.json agree on the version', () => {
  assert.equal(firefoxManifest.version, manifest.version,
    'manifest.firefox.json is out of step with manifest.json');
  assert.equal(pkg.version, manifest.version,
    'package.json is out of step with manifest.json');
});

test('the version being built has a changelog entry', () => {
  assert.ok(changelog.includes(`## [${manifest.version}]`),
    `CHANGELOG.md has no section for ${manifest.version}`);
});

test('version.json never advertises a version that does not exist yet', () => {
  const latest = versionInfo.latest;
  assert.equal(typeof latest, 'string');
  assert.match(latest, /^\d+\.\d+\.\d+$/, 'latest must be a plain semver');

  // Newer than what is being built means the banner points at a build nobody
  // can install. Equal is normal after a release; older is normal during prep.
  assert.ok(VC.compareVersions(latest, manifest.version) <= 0,
    `data/version.json advertises ${latest}, which is newer than the manifest's ` +
    `${manifest.version} — users would be told to fetch a build that does not exist`);
});

test('the version version.json advertises is one the changelog documents', () => {
  assert.ok(changelog.includes(`## [${versionInfo.latest}]`),
    `data/version.json advertises ${versionInfo.latest}, which has no CHANGELOG entry — ` +
    'either it is a typo or the release was never written up');
});

test('version.json carries a store URL for every browser the README lists', () => {
  for (const key of ['url', 'chromeUrl', 'firefoxUrl', 'edgeUrl']) {
    assert.equal(typeof versionInfo[key], 'string', `${key} is missing`);
    assert.match(versionInfo[key], /^https:\/\//, `${key} must be https`);
  }
  assert.match(versionInfo.firefoxUrl, /addons\.mozilla\.org/);
  assert.match(versionInfo.chromeUrl, /chromewebstore\.google\.com/);
  assert.match(versionInfo.edgeUrl, /microsoftedge\.microsoft\.com/);
});

test('pickUpdateUrl sends each browser to its own store', () => {
  // Edge has its own key in detectBrowserKey and its own listing, but
  // pickUpdateUrl used to branch on Firefox alone and send everything else to
  // chromeUrl — handing Edge users a Chrome Web Store link they cannot update
  // an Edge-installed extension from.
  const source = read('background.js');
  const start = source.indexOf('function pickUpdateUrl(');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('\n}', start));

  const pickUpdateUrl = new Function('data', 'detectBrowserKey', 'DEFAULT_UPDATE_URL',
    body.replace('function pickUpdateUrl(data) {', '') + '\n');

  const fallback = 'https://github.com/codepurse/BlockNSFW/releases';
  for (const [browser, expected] of [
    ['firefox', versionInfo.firefoxUrl],
    ['edge', versionInfo.edgeUrl],
    ['chrome', versionInfo.chromeUrl]
  ]) {
    assert.equal(pickUpdateUrl(versionInfo, () => browser, fallback), expected,
      `${browser} should be sent to its own store`);
  }

  // A Chromium fork with no store of its own buckets as 'chrome', which is
  // correct — same engine, same store.
  assert.equal(pickUpdateUrl(versionInfo, () => 'chrome', fallback), versionInfo.chromeUrl);

  // Missing per-browser entries fall back to the generic URL, then the default.
  assert.equal(pickUpdateUrl({ url: fallback }, () => 'edge', fallback), fallback);
  assert.equal(pickUpdateUrl({}, () => 'chrome', fallback), fallback);
  assert.equal(pickUpdateUrl(null, () => 'chrome', fallback), fallback);
});

test('README states the version being built', () => {
  const readme = read('README.md');
  assert.ok(readme.includes(`\`${manifest.version}\``),
    `README.md does not mention ${manifest.version} — it drifted to a stale version twice before`);
});
