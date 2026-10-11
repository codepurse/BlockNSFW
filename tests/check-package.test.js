// The package check (scripts/check-package.js): both build scripts read every
// zip back before calling it done. A store or test package must carry each
// Supporter extra, whole and exactly as extras-private has it; an open-source
// one must carry none of them; and none may carry tests, tools, notes, keys or
// anything else that never ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readZip, check, shipsPublic, MARK } = require('../scripts/check-package.js');

const ROOT = path.join(__dirname, '..');

// A zip as .NET's ZipFile writes one: some entries stored, some deflated.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of files) {
    const data = Buffer.from(content);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(zlib.crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(zlib.crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const SANDBOX = `module.exports = { STORE: { mode: 'sandbox', organizationId: '35c82b93-77a2-4b87-8478-39fc5dd4e666' }, PLANS: [{ id: 'monthly', url: 'https://sandbox-api.polar.sh/v1/checkout-links/x/redirect' }] };`;
const LIVE = `module.exports = { STORE: { mode: 'live', organizationId: '00000000-1111-2222-3333-444444444444' }, PLANS: [{ id: 'monthly', url: 'https://buy.polar.sh/polar_cl_a' }, { id: 'yearly', url: 'https://buy.polar.sh/polar_cl_b' }, { id: 'lifetime', url: 'https://buy.polar.sh/polar_cl_c' }] };`;

// A checkout with two extras: the public stand-ins and the private files.
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-pkg-'));
  fs.mkdirSync(path.join(root, 'extras'));
  fs.mkdirSync(path.join(root, 'extras-private', 'extras'), { recursive: true });
  const extras = {};
  for (const name of ['extras.js', 'month.js']) {
    const stub = `// extras/${name}: an empty stand-in\n`;
    const real = `// extras/${name} (a Supporter extra; ${MARK})\nself.Thing = { real: true };\n`;
    fs.writeFileSync(path.join(root, 'extras', name), stub);
    fs.writeFileSync(path.join(root, 'extras-private', 'extras', name), real);
    extras[name] = { stub, real };
  }
  fs.writeFileSync(path.join(root, 'extras', 'README.md'), '# stand-ins\n');
  return { root, extras };
}

function entries(files) {
  return files.map(([name, content]) => ({ name, data: Buffer.from(content) }));
}

function basePackage(extras, which, supporter = SANDBOX) {
  return [
    ['manifest.json', '{"version":"2.0.0"}'],
    ['shared/supporter.js', supporter],
    ['popup.js', 'console.log(1);'],
    ...Object.entries(extras).map(([name, v]) => [`extras/${name}`, v[which]])
  ];
}

test('reads back what a zip holds, stored or deflated', () => {
  const zip = makeZip([['manifest.json', '{"a":1}', false], ['shared/x.js', 'x'.repeat(5000), true], ['icons/', '', false]]);
  const got = readZip(zip);
  assert.deepEqual(got.map((e) => e.name), ['manifest.json', 'shared/x.js']);
  assert.equal(got[1].data.toString(), 'x'.repeat(5000));
});

test('a test package with every extra, exactly as extras-private has it, passes', () => {
  const { root, extras } = checkout();
  assert.deepEqual(check(entries(basePackage(extras, 'real')), 'test', root), []);
});

test('an extra missing, empty, still the stand-in, or not the private file: refused', () => {
  const { root, extras } = checkout();
  const good = basePackage(extras, 'real');
  const without = good.filter(([n]) => n !== 'extras/month.js');
  assert.match(check(entries(without), 'test', root).join('\n'), /extras\/month\.js: missing/);
  const swap = (content) => good.map(([n, c]) => [n, n === 'extras/month.js' ? content : c]);
  assert.match(check(entries(swap('')), 'test', root).join('\n'), /extras\/month\.js: empty/);
  assert.match(check(entries(swap(extras['month.js'].stub)), 'test', root).join('\n'), /still the empty stand-in/);
  assert.match(check(entries(swap(extras['month.js'].real + '// changed\n')), 'test', root).join('\n'), /differs from extras-private/);
  assert.match(check(entries([...good, ['extras/unknown.js', 'x']]), 'test', root).join('\n'), /extras\/unknown\.js: not one of the extras/);
});

test('nothing that never ships gets in: tests, tools, notes, keys, Chrome\'s _metadata, backslashes', () => {
  const { root, extras } = checkout();
  const good = basePackage(extras, 'real');
  for (const bad of [
    'tests/supporter.test.js',
    'extras-private/tools/supporter-codes.mjs',
    'tools/supporter-codes.mjs',
    'extras/README.md',
    'RELEASE_NOTES.md',
    '_metadata/generated_indexed_rulesets/_ruleset1',
    'supporter-signing-key.jwk',
    'node_modules/x/index.js',
    'shared\\supporter.js',
    'package.json'
  ]) {
    assert.notDeepEqual(check(entries([...good, [bad, 'x']]), 'test', root), [], `${bad} should be refused`);
  }
});

test('an open-source package carries the stand-ins and none of the extras\' code, anywhere', () => {
  const { root, extras } = checkout();
  assert.deepEqual(check(entries(basePackage(extras, 'stub')), 'open-source', root), []);
  assert.match(check(entries(basePackage(extras, 'real')), 'open-source', root).join('\n'), /not the open-source stand-in/);
  const smuggled = [...basePackage(extras, 'stub'), ['shared/more.js', extras['month.js'].real]];
  assert.match(check(entries(smuggled), 'open-source', root).join('\n'), /shared\/more\.js: carries private Supporter code/);
  // In a store package too, the extras' code belongs in extras/ only.
  assert.match(check(entries([...basePackage(extras, 'real'), ['popup2.js', extras['month.js'].real]]), 'test', root).join('\n'), /popup2\.js: carries private/);
});

test('the Supporter settings inside must match the kind of package', () => {
  const { root, extras } = checkout();
  assert.match(check(entries(basePackage(extras, 'real', SANDBOX)), 'store', root).join('\n'), /STORE\.mode is 'sandbox'/);
  assert.deepEqual(check(entries(basePackage(extras, 'real', LIVE)), 'store', root), []);
  assert.match(check(entries(basePackage(extras, 'real', LIVE)), 'test', root).join('\n'), /test package should use Polar's sandbox/);
});

test('the real extras each say they are the Supporter extra, so the check can tell them from a stand-in', () => {
  const dir = path.join(ROOT, 'extras-private', 'extras');
  if (!fs.existsSync(dir)) return;   // the open-source checkout
  for (const name of fs.readdirSync(path.join(ROOT, 'extras')).filter((f) => f.endsWith('.js'))) {
    assert.ok(fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 200).includes(MARK), `extras-private/extras/${name} must start by saying it is private`);
    assert.ok(!fs.readFileSync(path.join(ROOT, 'extras', name), 'utf8').includes(MARK), `extras/${name} (public) must not`);
  }
});

test('only what ships counts as uncommitted before a store package', () => {
  for (const f of ['options.html', 'shared/supporter.js', 'extras/month.js', 'manifest.firefox.json', 'LICENSE', 'data/public-suffixes.txt']) assert.equal(shipsPublic(f), true, f);
  for (const f of ['README.md', 'tests/supporter.test.js', 'scripts/check-package.js', 'RELEASE_NOTES_1.9.0.md', 'data/HOSTS.txt', 'build-chrome.ps1']) assert.equal(shipsPublic(f), false, f);
});

test('both build scripts check the tree before a store package, and every zip after', () => {
  for (const script of ['build-chrome.ps1', 'build-firefox.ps1']) {
    const src = fs.readFileSync(path.join(ROOT, script), 'utf8');
    const guard = src.indexOf('check-package.js") tree');
    const clean = src.indexOf('Remove-Item -Path $OutDir');
    assert.ok(guard > 0 && guard < clean, `${script}: the tree check runs before dist is cleaned`);
    assert.match(src, /check-package\.js"\) zip \$ZipPath (chrome|firefox) \$PackageKind/, `${script}: reads the zip back`);
    assert.match(src, /Remove-Item \$ZipPath -Force\s+throw "The package failed its check/, `${script}: removes a package that fails`);
  }
});
