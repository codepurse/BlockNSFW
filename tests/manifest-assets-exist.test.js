// Every path a manifest names must exist on disk, and every vendored runtime
// file must be referenced by something.
//
// Regression guard: `classify.worker.js` (plus the `tf.min.js` /
// `nsfwjs.min.js` pair it imported) survived the move to the SW-delegated
// classifier as dead weight. Nothing spawned the worker, Chrome's manifest did
// not even expose it, but build-chrome.ps1 copied all of vendor/ wholesale, so
// ~856 KB of compressed dead code shipped in every release. Neither direction
// of that drift was caught by a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readManifest(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
}

// Collect every literal file path a manifest points at. Glob patterns are
// skipped — only literal paths can be existence-checked.
function manifestPaths(manifest) {
  const out = [];
  const push = (p) => {
    if (typeof p === 'string' && p && !p.includes('*')) out.push(p);
  };

  for (const entry of manifest.web_accessible_resources || []) {
    for (const res of (entry && entry.resources) || []) push(res);
  }
  for (const entry of manifest.content_scripts || []) {
    for (const js of (entry && entry.js) || []) push(js);
    for (const css of (entry && entry.css) || []) push(css);
  }
  const bg = manifest.background || {};
  push(bg.service_worker);
  for (const s of bg.scripts || []) push(s);
  push((manifest.action || {}).default_popup);
  push((manifest.options_ui || {}).page);
  for (const icon of Object.values(manifest.icons || {})) push(icon);
  for (const icon of Object.values((manifest.action || {}).default_icon || {})) push(icon);

  return out;
}

for (const name of ['manifest.json', 'manifest.firefox.json']) {
  test(`${name}: every declared path exists on disk`, () => {
    const paths = manifestPaths(readManifest(name));
    assert.ok(paths.length > 0, 'expected the manifest to declare some paths');
    const missing = paths.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    assert.deepEqual(missing, [], `${name} names files that do not exist`);
  });
}

test('no vendored runtime file is dead weight', () => {
  const vendorFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else vendorFiles.push(rel);
    }
  };
  walk('vendor');
  assert.ok(vendorFiles.length > 0, 'expected vendored runtime files');

  // A vendored file earns its place by being named in source we ship: a
  // manifest, an extension page, or a script that loads it at runtime.
  const haystack = [
    'manifest.json',
    'manifest.firefox.json',
    'background.js',
    'offscreen.html',
    'offscreen.js',
    'build-chrome.ps1',
    'build-firefox.ps1'
  ].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

  const orphans = vendorFiles.filter((f) => !haystack.includes(f));
  assert.deepEqual(orphans, [], 'vendored files nothing references (delete them or wire them up)');
});
