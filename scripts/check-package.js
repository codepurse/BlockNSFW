// scripts/check-package.js
// Checks a finished package, and keeps a note of what went into it.
// build-chrome.ps1 and build-firefox.ps1 run it after -Zip; RELEASE_CHECKLIST.md
// says what to do with the note.
//
//   node scripts/check-package.js tree
//       Before a store package: refuses (exit 1) while either repository has
//       changes not yet committed in anything that ships, so the note can say
//       exactly which code a release carries.
//
//   node scripts/check-package.js zip <zip> <chrome|firefox> <store|test|open-source>
//       Reads the zip back and refuses (exit 1) when:
//         - a Supporter extra is missing, empty, still the stand-in, or not
//           the file in extras-private (store and test packages);
//         - any of the extras' code is in it at all (open-source packages);
//         - it carries anything that must never ship: tests, tools, notes,
//           keys, the private repository's other files, Chrome's _metadata;
//         - its Supporter settings don't match the kind of package (a store
//           package must sell through Polar's live store).
//       Then writes <zip without .zip>.build.txt: the version, the package's
//       SHA-256, and the commit of each repository it was built from.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { problems: storeProblems } = require('./check-store-mode.js');

const ROOT = path.join(__dirname, '..');
const PRIVATE = path.join(ROOT, 'extras-private');
// Every file of the extras starts by saying so; nothing else in a package may.
const MARK = 'extras-private/, not open source';
// What can reach a package from each checkout: the folders that ship whole
// (build-*.ps1 $RuntimeFolders), the pages and scripts at the top, and the one
// data file; from the private one, its extras.
const SHIPPED = ['icons/', 'rules/', 'shared/', 'vendor/', 'fonts/', 'ui/', 'extras/', 'nsfwjs/', 'models/'];
const shipsPublic = (file) => SHIPPED.some((f) => file.startsWith(f)) ||
  (!file.includes('/') && /\.(html|js|json|css)$|^LICENSE$/.test(file)) || file === 'data/public-suffixes.txt';
const shipsPrivate = (file) => file.startsWith('extras/');

// --- Zip --------------------------------------------------------------------------------

// [{ name, data }] for every file in a zip (stored or deflated, no zip64:
// what .NET's ZipFile writes for a package this size).
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`broken entry: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${name}: compression method ${method}`);
    out.push({ name, data });
  }
  return out;
}

// --- What a package must and mustn't hold ---------------------------------------------------

// The stand-ins in the public extras/ folder: the names the build fills in.
function standIns(root = ROOT) {
  return fs.readdirSync(path.join(root, 'extras'))
    .filter((f) => f.endsWith('.js'))
    .sort();
}

const NEVER = [
  [/\\/, 'a backslash in its path (zip paths use /)'],
  [/(^|\/)\.\.(\/|$)|^\//, 'a path outside the package'],
  [/(^|\/)(extras-private|tests?|tools|scripts|node_modules|\.git|\.github|\.verify|_metadata)\//, 'a folder that never ships'],
  [/\.(md|mjs|ps1|jwk|pem|key|env|map|log)$/i, 'a kind of file that never ships'],
  [/\.test\.js$/, 'a test'],
  [/(^|\/)(package(-lock)?\.json|\.gitignore|\.DS_Store|Thumbs\.db)$/, 'a file that never ships']
];

// The Supporter settings inside the package, as shared/supporter.js says them.
function supporterIn(entries) {
  const file = entries.find((e) => e.name === 'shared/supporter.js');
  if (!file) return null;
  const module = { exports: {} };
  vm.runInNewContext(file.data.toString('utf8'), { module, exports: module.exports });
  return module.exports;
}

// Everything wrong with a package, as sentences. `mode` is store, test or
// open-source; `root` holds extras/ and, for store and test, extras-private/.
function check(entries, mode, root = ROOT) {
  const out = [];
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('manifest.json')) out.push('no manifest.json');

  for (const { name } of entries) {
    for (const [pattern, why] of NEVER) if (pattern.test(name)) out.push(`${name}: ${why}`);
  }

  const stubs = standIns(root);
  const extras = entries.filter((e) => e.name.startsWith('extras/'));
  for (const e of extras) {
    if (!stubs.includes(e.name.slice('extras/'.length))) out.push(`${e.name}: not one of the extras`);
  }
  for (const name of stubs) {
    const entry = entries.find((e) => e.name === `extras/${name}`);
    if (!entry) { out.push(`extras/${name}: missing`); continue; }
    const stub = fs.readFileSync(path.join(root, 'extras', name));
    if (mode === 'open-source') {
      if (!entry.data.equals(stub)) out.push(`extras/${name}: not the open-source stand-in`);
      continue;
    }
    const realPath = path.join(root, 'extras-private', 'extras', name);
    if (!entry.data.length) out.push(`extras/${name}: empty`);
    else if (entry.data.equals(stub)) out.push(`extras/${name}: still the empty stand-in`);
    else if (!entry.data.toString('utf8', 0, 200).includes(MARK)) out.push(`extras/${name}: doesn't look like the Supporter extra`);
    if (!fs.existsSync(realPath)) out.push(`extras/${name}: extras-private has no such file to compare`);
    else if (!entry.data.equals(fs.readFileSync(realPath))) out.push(`extras/${name}: differs from extras-private/extras/${name}`);
  }

  // The extras' code belongs in extras/ only, and in an open-source package
  // nowhere at all.
  for (const e of entries) {
    if (!/\.(js|html|json|css)$/.test(e.name)) continue;
    if (e.name.startsWith('extras/') && mode !== 'open-source') continue;
    if (e.data.includes(MARK)) out.push(`${e.name}: carries private Supporter code`);
  }

  let Supporter = null;
  try { Supporter = supporterIn(entries); } catch (err) { out.push(`shared/supporter.js: won't load (${err.message})`); }
  if (!Supporter && !out.some((p) => p.startsWith('shared/supporter.js'))) out.push('shared/supporter.js: missing');
  if (Supporter) {
    const mode_ = Supporter.STORE && Supporter.STORE.mode;
    if (mode === 'store') for (const p of storeProblems(Supporter)) out.push(`Supporter: ${p}`);
    if (mode === 'test' && mode_ !== 'sandbox') out.push(`Supporter: a test package should use Polar's sandbox, not '${mode_}'`);
  }
  return out;
}

// --- Repositories ---------------------------------------------------------------------------

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
}

// { commit, branch, unpushed, changes: [paths] } for a checkout, or null.
// `changes` are the paths not committed (changed, new or deleted) that
// `ships` says could reach a package.
function repoState(dir, ships) {
  const commit = git(dir, ['rev-parse', 'HEAD']);
  if (!commit) return null;
  const changes = [];
  for (const line of (git(dir, ['status', '--porcelain']) || '').split('\n')) {
    if (!line.trim()) continue;
    const file = line.slice(3).replace(/^"|"$/g, '').replace(/^.* -> /, '');
    if (ships(file)) changes.push(file);
  }
  const ahead = git(dir, ['rev-list', '--count', '@{u}..HEAD']);
  return {
    commit,
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?',
    unpushed: ahead === null ? null : Number(ahead),
    changes
  };
}

function describe(label, state, remote) {
  if (!state) return `${label}not included`;
  const lines = [`${label}${state.commit} (${state.branch}, ${remote})`];
  if (state.changes.length) lines.push(`         NOT COMMITTED: ${state.changes.join(', ')}`);
  if (state.unpushed) lines.push(`         not pushed yet: ${state.unpushed} commit${state.unpushed === 1 ? '' : 's'}`);
  if (state.unpushed === null) lines.push('         no upstream branch to compare with');
  return lines.join('\n');
}

// --- Commands ---------------------------------------------------------------------------------

function tree() {
  const pub = repoState(ROOT, shipsPublic);
  const priv = repoState(PRIVATE, shipsPrivate);
  const left = [];
  if (!pub) left.push('the public checkout is not a git repository');
  else for (const f of pub.changes) left.push(`public: ${f}`);
  if (priv) for (const f of priv.changes) left.push(`extras-private: ${f}`);
  if (left.length) {
    console.error('Commit these first, so the package matches a commit (RELEASE_CHECKLIST.md):');
    for (const l of left) console.error('  - ' + l);
    process.exit(1);
  }
  console.log('Both repositories: everything that ships is committed.');
}

function zip(zipPath, browser, mode) {
  if (!zipPath || !['chrome', 'firefox'].includes(browser) || !['store', 'test', 'open-source'].includes(mode)) {
    console.error('Usage: node scripts/check-package.js zip <zip> <chrome|firefox> <store|test|open-source>');
    process.exit(2);
  }
  const buf = fs.readFileSync(zipPath);
  const entries = readZip(buf);
  const left = check(entries, mode);
  if (left.length) {
    console.error(`The package is not right (${path.basename(zipPath)}):`);
    for (const l of left) console.error('  - ' + l);
    process.exit(1);
  }

  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  const kind = { store: 'store package', test: 'TEST PACKAGE (Polar sandbox: never upload it)', 'open-source': 'open-source package (GitHub Releases)' }[mode];
  const now = new Date();
  const note = [
    `BlockNSFW ${manifest.version} for ${browser === 'chrome' ? 'Chrome and Edge' : 'Firefox'}: ${kind}`,
    `Built:   ${now.toISOString()}`,
    `Package: ${path.basename(zipPath)}, ${entries.length} files, SHA-256 ${crypto.createHash('sha256').update(buf).digest('hex')}`,
    describe('Public:  ', repoState(ROOT, shipsPublic), 'codepurse/BlockNSFW'),
    describe('Extras:  ', mode === 'open-source' ? null : repoState(PRIVATE, shipsPrivate), 'codepurse/BlockNSFW-extras'),
    'Checks:  passed',
    ''
  ].join('\n');
  const notePath = zipPath.replace(/\.zip$/i, '') + '.build.txt';
  fs.writeFileSync(notePath, note);
  console.log(`Package checked: ${entries.length} files, nothing missing, nothing that shouldn't ship.`);
  console.log(`Build note: ${notePath}`);
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'tree') tree();
  else if (cmd === 'zip') zip(...args);
  else {
    console.error('Usage: node scripts/check-package.js tree | zip <zip> <chrome|firefox> <store|test|open-source>');
    process.exit(2);
  }
}

module.exports = { readZip, check, standIns, repoState, shipsPublic, MARK, NEVER };
