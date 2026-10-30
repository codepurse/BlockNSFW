// extras/ holds empty stand-ins for the Supporter extras, which are not open
// source (extras/README.md). These hold the line: the stand-ins stay empty,
// the private repository stays out of this one, and every page that loads an
// extra still works without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'extras');
const STANDINS = fs.readdirSync(DIR).filter((f) => !f.endsWith('.md')).sort();

test('the stand-ins are the extras and the list of them', () => {
  assert.deepEqual(STANDINS, ['checkin.js', 'extras.js', 'face.js', 'gooddays.js', 'hardest.js', 'looks.js', 'month.js', 'path-days.js', 'photo.js', 'proof.js', 'storm.js', 'sync.js', 'voice.js']);
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  for (const f of STANDINS) assert.ok(readme.includes('`' + f + '`'), `extras/README.md names ${f}`);
});

test('every stand-in is empty: comments, and extras.js saying there are none', () => {
  for (const f of STANDINS) {
    const code = fs.readFileSync(path.join(DIR, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim();
    assert.equal(code, f === 'extras.js' ? 'self.SupporterExtras = null;' : '', f);
  }
});

test('the private repository can never be committed here', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/extras-private\/$/m);
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', '--', 'extras-private'], { cwd: ROOT, encoding: 'utf8' });
  } catch (_) {
    return; // Not a git checkout (a source zip): nothing to hold.
  }
  assert.equal(tracked.trim(), '', 'files under extras-private/ are tracked');
});

test('the pages load the extras they use, and nothing of the extras is left outside extras/', () => {
  const uses = {
    'popup.html': ['extras/checkin.js', 'extras/extras.js', 'extras/storm.js', 'extras/face.js'],
    'path.html': ['extras/path-days.js'],
    'gooddays.html': ['extras/checkin.js', 'extras/gooddays.js'],
    'month.html': ['extras/month.js'],
    'hardest.html': ['extras/hardest.js'],
    'options.html': ['extras/extras.js', 'extras/looks.js', 'extras/photo.js', 'extras/proof.js', 'extras/storm.js', 'extras/face.js'],
    'blocked.html': ['extras/proof.js']
  };
  for (const [page, files] of Object.entries(uses)) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const f of files) assert.ok(html.includes(`"${f}"`), `${page} loads ${f}`);
  }
  for (const gone of ['shared/checkin.js', 'tools/supporter-codes.mjs']) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} belongs to the extras now`);
  }
  // The blocked page loads one extra, Proof it passes, and only that: all
  // five of its designs are free, here. The page works without it.
  const blocked = fs.readFileSync(path.join(ROOT, 'blocked.html'), 'utf8');
  assert.deepEqual([...blocked.matchAll(/"(extras\/[^"]+)"/g)].map((m) => m[1]), ['extras/proof.js']);
  assert.ok(blocked.indexOf('"extras/proof.js"') < blocked.indexOf('"blocked.js"'), 'the extra loads before the page uses it');
  const page = fs.readFileSync(path.join(ROOT, 'blocked.js'), 'utf8');
  const mount = page.slice(page.indexOf('async function mountProof('), page.indexOf('function wireWaitTimer('));
  assert.match(mount, /if \(!extra \|\| !Moments\.proofOn\(raw\)\) return null;/, 'no extra or the switch off: the plain timer');
  assert.match(mount, /try \{[\s\S]*\} catch/, 'a fault in the extra costs the dial, never the page');
  const themes = fs.readFileSync(path.join(ROOT, 'blocked-themes.js'), 'utf8');
  for (const name of ['renderCalm', 'renderVerse', 'renderMotivation', 'renderPlay']) assert.ok(themes.includes(`function ${name}(`), name);
});
