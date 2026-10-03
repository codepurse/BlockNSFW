// Every script and stylesheet an extension page loads must be copied into both
// builds.
//
// The build scripts list their files by hand. A page that gains a new
// <script src> or <link rel="stylesheet"> works when the unpacked folder is
// loaded, but the packaged extension is missing the file: the page loses
// whatever it did, and nothing reports it beyond a 404 in that page's console.
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
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\brel="stylesheet"/.test(tag))
    .map((tag) => (tag.match(/\bhref="([^"]+)"/) || [])[1])
    .filter(Boolean);
  return scripts.concat(styles)
    .filter((src) => !/^[a-z]+:/i.test(src) && !src.startsWith('//'));
}

for (const build of ['build-chrome.ps1', 'build-firefox.ps1']) {
  test(`${build}: ships every script and stylesheet its pages load`, () => {
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
    assert.deepEqual(missing, [], `${build} leaves out files its pages load`);
  });

  // A stylesheet's url() is the same trap one step further down: the Verse
  // design's typeface is a file in fonts/, and a build without it falls back
  // to another face without a word.
  test(`${build}: ships every file its stylesheets load`, () => {
    const source = fs.readFileSync(path.join(ROOT, build), 'utf8');
    const files = listIn(source, 'RuntimeFiles');
    const folders = listIn(source, 'RuntimeFolders');
    const shipped = (p) => files.includes(p) || folders.some((f) => p.startsWith(f + '/'));

    const missing = [];
    for (const sheet of files.filter((f) => f.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(ROOT, sheet), 'utf8');
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const ref = m[1].trim();
        if (/^[a-z-]+:/i.test(ref) || ref.startsWith('#') || ref.startsWith('//')) continue;
        const rel = ref.replace(/^\.\//, '');
        if (!shipped(rel)) missing.push(`${sheet} -> ${rel}`);
        else if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${sheet} -> ${rel} (no such file)`);
      }
    }
    assert.deepEqual(missing, [], `${build} leaves out files its stylesheets load`);
  });
}

// The manifest's CSP for extension pages is script-src 'self', so the browser
// refuses inline code without a word outside the page's console. Both
// options.html (sidebar highlight) and stats.html (streak ring) shipped inline
// scripts that only ever ran when the page was opened outside the extension.
test('no shipped page relies on inline script', () => {
  const source = fs.readFileSync(path.join(ROOT, 'build-chrome.ps1'), 'utf8');
  const pages = listIn(source, 'RuntimeFiles').filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0, 'expected the build to ship some pages');

  const found = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      const attrs = m[1];
      if (/\bsrc=/.test(attrs)) continue;
      // Data blocks are not executed, so the CSP has nothing to refuse.
      if (/\btype="application\/(ld\+)?json"/.test(attrs)) continue;
      found.push(`${page}: inline <script${attrs}>`);
    }
    for (const m of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=\s*["']/gi)) {
      found.push(`${page}: inline ${m[1]}= handler`);
    }
    if (/\bhref\s*=\s*["']\s*javascript:/i.test(html)) {
      found.push(`${page}: javascript: link`);
    }
  }
  assert.deepEqual(found, [], 'move inline code into a script file the page loads');
});
