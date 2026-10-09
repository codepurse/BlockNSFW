// The design tokens in ui/tokens.css hold the contrast every page relies on.
//
// The light theme is monolab Threshold's, unchanged; the dark theme is the
// extension's own. A colour that drifts by a few points can drop a label
// below WCAG AA without anyone seeing it on their own screen, so every text
// pair is asserted at 4.5:1 and every control edge and focus ring at 3:1, in
// both themes. Extension pages also must not reach the network for type or
// style: the four fonts are bundled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKENS = fs.readFileSync(path.join(ROOT, 'ui', 'tokens.css'), 'utf8');

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function lightTokens() {
  const block = TOKENS.match(/^:root\s*\{([\s\S]*?)^\}/m);
  assert.ok(block, 'expected a top-level :root block');
  return declarations(block[1]);
}

// Dark is written twice: under the media query, for pages that follow the
// system (and are not kept light), and for pages kept dark in Settings.
function systemDarkTokens() {
  const media = TOKENS.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-scheme="light"\]\)\s*\{([\s\S]*?)\}\s*\}/);
  assert.ok(media, 'expected a dark :root:not([data-scheme="light"]) block under prefers-color-scheme');
  return declarations(media[1]);
}

function keptDarkTokens() {
  const block = TOKENS.match(/^:root\[data-scheme="dark"\]\s*\{([\s\S]*?)^\}/m);
  assert.ok(block, 'expected a top-level :root[data-scheme="dark"] block');
  return declarations(block[1]);
}

function darkTokens() {
  return { ...lightTokens(), ...systemDarkTokens() };
}

test('ui tokens (dark): the system dark and the kept dark carry the same values', () => {
  const system = systemDarkTokens();
  assert.ok(Object.keys(system).length >= 20, 'expected the full dark set');
  assert.deepEqual(keptDarkTokens(), system);
  assert.match(TOKENS, /:root\[data-scheme="dark"\]\s*\{\s*color-scheme: dark;/);
});

test('blocked-themes.css: Verse keeps the same dark wall whether it follows the system or is kept dark', () => {
  const css = fs.readFileSync(path.join(ROOT, 'blocked-themes.css'), 'utf8');
  const system = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*html\[data-theme="verse"\]:not\(\[data-scheme="light"\]\)\s*\{([\s\S]*?)\}\s*\}/);
  const kept = css.match(/^html\[data-theme="verse"\]\[data-scheme="dark"\]\s*\{([\s\S]*?)^\}/m);
  assert.ok(system && kept, 'expected both Verse dark blocks');
  assert.deepEqual(declarations(kept[1]), declarations(system[1]));
  assert.doesNotMatch(css.replace(system[0], ''), /prefers-color-scheme/,
    'every other dark rule would ignore the theme chosen in Settings');
});

function rgba(value) {
  const v = value.trim();
  if (v.startsWith('#')) {
    const h = v.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(m, `not a colour: ${value}`);
  const parts = m[1].split(',').map((p) => Number(p.trim()));
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Contrast of a (possibly translucent) colour laid over an opaque ground.
function contrast(tokens, fgName, bgName) {
  const bg = rgba(tokens[bgName]);
  const fg = rgba(tokens[fgName]);
  assert.equal(bg[3], 1, `${bgName} must be opaque to be a ground`);
  const a = fg[3];
  const over = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  const l1 = luminance(over);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// [foreground, ground, minimum]
const PAIRS = [
  // Text
  ['--color-ink', '--color-paper', 4.5],
  ['--color-ink', '--color-sheet', 4.5],
  ['--color-ink-2', '--color-paper', 4.5],
  ['--color-ink-2', '--color-sheet', 4.5],
  ['--color-ink-3', '--color-paper', 4.5],
  ['--color-ink-3', '--color-sheet', 4.5],
  ['--color-pine', '--color-paper', 4.5],
  ['--color-pine', '--color-sheet', 4.5],
  ['--color-pine-2', '--color-paper', 4.5],
  ['--color-pine-2', '--color-sheet', 4.5],
  ['--color-brass', '--color-paper', 4.5],
  ['--color-brass', '--color-sheet', 4.5],
  ['--color-danger', '--color-paper', 4.5],
  ['--color-danger', '--color-sheet', 4.5],
  ['--color-pine', '--color-pine-3', 4.5],
  ['--color-ink', '--color-pine-3', 4.5],
  ['--color-on-primary', '--color-primary', 4.5],
  ['--color-on-primary', '--color-primary-hover', 4.5],
  ['--color-on-primary', '--color-primary-busy', 4.5],
  ['--color-on-danger', '--color-danger', 4.5],
  ['--color-on-danger', '--color-danger-hover', 4.5],
  // The pine band
  ['--color-on-band', '--color-band', 4.5],
  ['--color-on-band-2', '--color-band', 4.5],
  ['--color-band-signal', '--color-band', 4.5],
  // Control edges, the switch and the focus ring
  ['--color-rule-3', '--color-paper', 3],
  ['--color-rule-3', '--color-sheet', 3],
  ['--color-rule-3', '--color-recess', 3],
  ['--color-pine-2', '--color-paper', 3],
  ['--color-pine', '--color-paper', 3],
  ['--color-sheet', '--color-pine', 3],
  ['--color-ink-3', '--color-recess', 3]
];

for (const [name, read] of [['light', lightTokens], ['dark', darkTokens]]) {
  test(`ui tokens (${name}): every text pair reaches 4.5:1 and every control edge 3:1`, () => {
    const tokens = read();
    const failures = [];
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrast(tokens, fg, bg);
      if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('ui tokens (dark): ink-3 never meets 4.5:1 on pine-3, so it is never set there', () => {
  // Documented in the token notes; this pins the reason the rule exists.
  assert.ok(contrast(darkTokens(), '--color-ink-3', '--color-pine-3') < 4.5);
});

test('ui tokens (light): Threshold colours are unchanged', () => {
  // monolab Threshold tokens.json, synced 2026-10-08.
  const threshold = {
    '--color-paper': '#f4f1e9',
    '--color-sheet': '#fbf9f4',
    '--color-recess': '#ebe6da',
    '--color-recess-2': '#ddd7c7',
    '--color-ink': '#1a1a16',
    '--color-ink-2': '#57574d',
    '--color-ink-3': '#6e6d63',
    '--color-pine': '#0d3b31',
    '--color-pine-2': '#1c5f4f',
    '--color-pine-3': '#d5e0da',
    '--color-pine-ink': '#9db3aa',
    '--color-brass': '#8a6218',
    '--color-brass-2': '#c99a3a',
    '--color-rule': 'rgba(26, 26, 22, 0.15)',
    '--color-rule-2': 'rgba(26, 26, 22, 0.27)',
    '--color-rule-dark': 'rgba(255, 255, 255, 0.16)'
  };
  const tokens = lightTokens();
  for (const [key, value] of Object.entries(threshold)) assert.equal(tokens[key], value, key);
});

test('ui tokens: the four bundled fonts exist and no stylesheet reaches the network', () => {
  for (const file of [
    'Newsreader-latin.woff2',
    'Newsreader-Italic-latin.woff2',
    'InstrumentSans-latin.woff2',
    'JetBrainsMono-latin.woff2'
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'fonts', file)), `fonts/${file} is missing`);
    assert.ok(TOKENS.includes(`../fonts/${file}`), `ui/tokens.css does not load ${file}`);
  }
  for (const css of ['ui/tokens.css', 'ui/components.css', 'blocked-themes.css']) {
    const source = fs.readFileSync(path.join(ROOT, css), 'utf8');
    assert.doesNotMatch(source, /@import/, `${css} must not @import`);
    assert.doesNotMatch(source, /url\(\s*["']?(https?:)?\/\//, `${css} must not load from the network`);
  }
});

test('ui: the field drawing ships in both themes, inert, and the blocked page draws it from the package', () => {
  for (const file of ['field-still.svg', 'field-still-dark.svg']) {
    const svg = fs.readFileSync(path.join(ROOT, 'ui', file), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${file} is an SVG`);
    assert.doesNotMatch(svg, /<script|<foreignObject|\son[a-z]+=|href=/i, `${file} must be pictures only`);
  }
  const blocked = fs.readFileSync(path.join(ROOT, 'blocked.html'), 'utf8');
  assert.match(blocked, /<div class="field-art" aria-hidden="true">/);
  assert.match(blocked, /src="ui\/field-still\.svg"/);
  assert.match(blocked, /src="ui\/field-still-dark\.svg"/);
  // Each theme shows its own copy, through the tokens' show switches.
  assert.equal(lightTokens()['--show-light'], 'block');
  assert.equal(darkTokens()['--show-light'], 'none');
  assert.equal(darkTokens()['--show-dark'], 'block');
});

const PAGES = [
  'popup.html',
  'options.html',
  'blocked.html',
  'onboarding.html',
  'stats.html',
  'audit.html',
  'community.html',
  'changelog.html'
];

for (const page of PAGES) {
  test(`${page}: loads the shared tokens and components, and nothing from the network`, () => {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const sheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
      .map((m) => (m[0].match(/\bhref="([^"]+)"/) || [])[1]);
    assert.ok(sheets.indexOf('ui/tokens.css') === 0, 'ui/tokens.css must be the first stylesheet');
    assert.ok(sheets.indexOf('ui/components.css') === 1, 'ui/components.css must come second');
    // The theme has to be on <html> before the first paint, so its script
    // runs in <head>, ahead of the stylesheets.
    const head = html.slice(0, html.indexOf('</head>'));
    const scheme = head.indexOf('<script src="ui/scheme.js"></script>');
    assert.ok(scheme !== -1, `${page} must load ui/scheme.js in <head>`);
    assert.ok(scheme < head.indexOf('href="ui/tokens.css"'), 'ui/scheme.js must come before ui/tokens.css');
    for (const href of sheets) assert.doesNotMatch(href, /^(https?:)?\/\//, `${page} loads ${href}`);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdnjs|jsdelivr|unpkg/);
    assert.doesNotMatch(html, /@font-face/, `${page} declares its own @font-face; ui/tokens.css owns the fonts`);
  });
}
