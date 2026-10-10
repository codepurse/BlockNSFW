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
  assert.deepEqual(STANDINS, ['checkin.js', 'extras.js', 'gooddays.js', 'hardest.js', 'looks.js', 'month.js', 'path-days.js', 'photo.js']);
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
    'popup.html': ['extras/checkin.js', 'extras/extras.js'],
    'path.html': ['extras/path-days.js'],
    'gooddays.html': ['extras/checkin.js', 'extras/gooddays.js'],
    'month.html': ['extras/month.js'],
    'hardest.html': ['extras/hardest.js'],
    'options.html': ['extras/extras.js', 'extras/looks.js', 'extras/photo.js']
  };
  for (const [page, files] of Object.entries(uses)) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const f of files) assert.ok(html.includes(`"${f}"`), `${page} loads ${f}`);
  }
  for (const gone of ['shared/checkin.js', 'tools/supporter-codes.mjs']) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} belongs to the extras now`);
  }
  // The blocked page loads no extra: all five of its designs are free, here.
  const blocked = fs.readFileSync(path.join(ROOT, 'blocked.html'), 'utf8');
  assert.doesNotMatch(blocked, /extras\//);
  const themes = fs.readFileSync(path.join(ROOT, 'blocked-themes.js'), 'utf8');
  for (const name of ['renderCalm', 'renderVerse', 'renderMotivation', 'renderPlay']) assert.ok(themes.includes(`function ${name}(`), name);
});
