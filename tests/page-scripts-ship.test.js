// Every script an extension page loads must be copied into both builds.
//
// The build scripts list their files by hand. A page that gains a new
// <script src> works when the unpacked folder is loaded, but the packaged
// extension is missing the file: the page loses whatever that script did, and
// nothing reports it beyond a 404 in that page's console.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function listIn(source, name) {
  const block = source.match(new RegExp('\\$' + name + '\\s*=\\s*@\\(([\\s\\S]*?)\\)'));
  assert.ok(block, `expected a $${name} list`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function localScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !/^[a-z]+:/i.test(src) && !src.startsWith('//'));
}

for (const build of ['build-chrome.ps1', 'build-firefox.ps1']) {
  test(`${build}: ships every script its pages load`, () => {
    const source = fs.readFileSync(path.join(ROOT, build), 'utf8');
    const files = listIn(source, 'RuntimeFiles');
    const folders = listIn(source, 'RuntimeFolders');
    const shipped = (p) => files.includes(p) || folders.some((f) => p.startsWith(f + '/'));

    const pages = files.filter((f) => f.endsWith('.html'));
    assert.ok(pages.length > 0, 'expected the build to ship some pages');

    const missing = [];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      for (const src of localScripts(html)) {
        const rel = src.replace(/^\.\//, '');
        if (!shipped(rel)) missing.push(`${page} -> ${rel}`);
      }
    }
    assert.deepEqual(missing, [], `${build} leaves out scripts its pages load`);
  });
}
