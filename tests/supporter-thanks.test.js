// A supporter is thanked, not sold to.
//
// Settings › Supporter showed a supporter the same band as everyone else:
// "Protection was never for sale", what other blockers charge, and the note
// about what support pays for, with only the plans hidden. A supporter now
// sees a band of its own in that place: a short letter signed by hand, and a
// heart woven of many threads with theirs in gold. These check the wiring
// that makes the swap; the motion was checked in Chrome
// (.verify/pact/cdp-thanks.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('options.html');
const js = read('options-supporter.js');

test('the thank-you band sits beside the offer, hidden until the plan is known', () => {
  const offer = html.indexOf('id="supporter-band"');
  const thanks = html.indexOf('id="supporter-thanks-band"');
  const compare = html.indexOf('id="supporter-compare"');
  assert.ok(offer > 0 && offer < thanks && thanks < compare);
  assert.match(html, /<div class="supporter-band supporter-thanks-band band-pine" id="supporter-thanks-band" hidden>/);
  assert.match(html, /<h3 class="thanks-head thanks-rise" id="thanks-head" tabindex="-1">Thank you\.<\/h3>/);
  assert.match(html, /<p class="thanks-sign">Monolab<\/p>/);
  assert.match(html, /id="thanks-heart" role="img" aria-label="[^"]+"/);
});

test('a supporter gets the thank-you in place of the offer, and the plan group says what the plan is', () => {
  assert.match(js, /\$\('supporter-band'\)\.hidden = thanked;/);
  assert.match(js, /\$\('supporter-thanks-band'\)\.hidden = !thanked;/);
  assert.match(js, /'Your extras, and what your support keeps going\.'/);
  assert.match(js, /\$\('supporter-code-title'\)\.textContent = 'Your plan';/);
  assert.doesNotMatch(js, /You’re a supporter/);
});

test('the heart has a row for every stitch line and one gold thread', () => {
  const rows = [];
  for (let y = 34; y <= 196; y += 6) if (y !== 112) rows.push(y);
  assert.equal(rows.length, 27);
  assert.match(js, /const HEART_GOLD = 112;/);
  assert.match(js, /for \(let y = 34; y <= 196; y \+= 6\)/);
});

test('every drift moves its row by exactly one stitch and gap, so the loop has no seam', () => {
  for (const [n, dash, gap] of [[1, 24, 6], [2, 34, 8], [3, 16, 5]]) {
    assert.match(html, new RegExp(`\\.heart-row\\.stitch-${n} \\{\\s*stroke-dasharray: ${dash} ${gap};`));
    assert.match(html, new RegExp(`@keyframes heart-drift-${n} \\{\\s*to \\{ stroke-dashoffset: -${dash + gap}; \\}`));
  }
});

test('reduced motion stops the band and hides the spark', () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{\s*\.supporter-thanks-band,\s*\.supporter-thanks-band \* \{\s*animation: none !important;/);
  assert.match(html, /\.heart-spark \{\s*display: none;/);
});

test('the signature typeface is bundled with its licence, never fetched', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'fonts', 'MrsSaintDelafield-latin.woff2')));
  assert.match(read('fonts/MrsSaintDelafield-OFL.txt'), /SIL OPEN FONT LICENSE/);
  assert.match(read('ui/tokens.css'), /--font-signature: "Mrs Saint Delafield"/);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
});
