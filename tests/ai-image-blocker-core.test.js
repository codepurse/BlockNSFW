// Tests for the pure helpers in ai-image-blocker-core.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'ai-image-blocker-core.js'),
  'utf8'
);

function loadCore() {
  const sandbox = {
    console,
    Map,
    Set,
    Date,
    Math,
    JSON,
    RegExp,
    Promise,
    URL,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'ai-image-blocker-core.js' });
  return sandbox;
}

// ─── verdictFor ──────────────────────────────────────────────────────────

test('verdictFor: high Porn blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.80, Hentai: 0.10, Sexy: 0.05, Drawing: 0.03, Neutral: 0.02 }), 'block');
});

test('verdictFor: high Hentai blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.10, Hentai: 0.85, Sexy: 0.03, Drawing: 0.01, Neutral: 0.01 }), 'block');
});

test('verdictFor: Porn + Hentai just at 0.50 blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.30, Hentai: 0.20, Sexy: 0.40, Drawing: 0.05, Neutral: 0.05 }), 'block');
});

test('verdictFor: Porn + Hentai just below 0.50 allows even with high Sexy', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.20, Hentai: 0.20, Sexy: 0.69, Drawing: 0.05, Neutral: 0.06 }), 'allow');
});

test('verdictFor: Sexy exactly at 0.70 blocks', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.70, Drawing: 0.10, Neutral: 0.10 }), 'block');
});

test('verdictFor: Sexy 0.69 allows', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.69, Drawing: 0.10, Neutral: 0.11 }), 'allow');
});

test('verdictFor: all-Neutral allows', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.01, Hentai: 0.01, Sexy: 0.02, Drawing: 0.05, Neutral: 0.91 }), 'allow');
});

test('verdictFor: all-Drawing allows', () => {
  const ctx = loadCore();
  assert.equal(ctx.verdictFor({ Porn: 0.05, Hentai: 0.05, Sexy: 0.10, Drawing: 0.75, Neutral: 0.05 }), 'allow');
});

// ─── firstPartyMatch ─────────────────────────────────────────────────────

test('firstPartyMatch: exact match', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('example.com', 'example.com'), true);
});

test('firstPartyMatch: image is subdomain of page', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('cdn.example.com', 'example.com'), true);
});

test('firstPartyMatch: page is subdomain of image', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('example.com', 'cdn.example.com'), true);
});

test('firstPartyMatch: different registrable domains', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('evil.com', 'example.com'), false);
});

test('firstPartyMatch: suffix lookalike does not match', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('notexample.com', 'example.com'), false);
});

test('firstPartyMatch: subdomain mismatch is not first-party', () => {
  const ctx = loadCore();
  assert.equal(ctx.firstPartyMatch('other.example.com', 'sub.example.com'), false);
});

// ─── shouldSkipImage ─────────────────────────────────────────────────────

function makeImg(overrides) {
  return Object.assign({
    src: 'https://cdn.example.com/photo.jpg',
    currentSrc: 'https://cdn.example.com/photo.jpg',
    naturalWidth: 800,
    naturalHeight: 600,
    offsetParent: {},
    hostname: 'cdn.example.com',
  }, overrides);
}

test('shouldSkipImage: settings off → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg(), { aiImageBlocker: false, trustedDomains: new Set() }), true);
});

test('shouldSkipImage: degraded → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg(), { aiImageBlocker: true, degraded: true, trustedDomains: new Set() }), true);
});

test('shouldSkipImage: trusted domain → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ hostname: 'i.imgur.com' }), { aiImageBlocker: true, trustedDomains: new Set(['i.imgur.com']) }), true);
});

test('shouldSkipImage: first-party → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ hostname: 'example.com' }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'example.com' }), true);
});

test('shouldSkipImage: too small (width) → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ naturalWidth: 32, naturalHeight: 200 }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: too small (height) → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ naturalWidth: 200, naturalHeight: 32 }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: data: URL → skip', () => {
  const ctx = loadCore();
  const img = makeImg({ src: 'data:image/png;base64,AAAA', currentSrc: 'data:image/png;base64,AAAA' });
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: blob: URL → skip', () => {
  const ctx = loadCore();
  const img = makeImg({ src: 'blob:https://example.com/abc', currentSrc: 'blob:https://example.com/abc' });
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: hidden element → skip', () => {
  const ctx = loadCore();
  assert.equal(ctx.shouldSkipImage(makeImg({ offsetParent: null }), { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), true);
});

test('shouldSkipImage: already in cache → skip', () => {
  const ctx = loadCore();
  const img = makeImg();
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com', lru: new Map([[img.currentSrc, { verdict: 'allow' }]]) }), true);
});

test('shouldSkipImage: regular external image → do not skip', () => {
  const ctx = loadCore();
  const img = makeImg();
  assert.equal(ctx.shouldSkipImage(img, { aiImageBlocker: true, trustedDomains: new Set(), pageHost: 'other.com' }), false);
});

// ─── LRU helpers ─────────────────────────────────────────────────────────

test('setWithCap: writes new entries under the cap', () => {
  const ctx = loadCore();
  const m = new Map();
  ctx.setWithCap(m, 'a', 1, 3);
  ctx.setWithCap(m, 'b', 2, 3);
  assert.equal(m.size, 2);
  assert.equal(m.get('a'), 1);
  assert.equal(m.get('b'), 2);
});

test('setWithCap: evicts oldest when at cap', () => {
  const ctx = loadCore();
  const m = new Map();
  ctx.setWithCap(m, 'a', 1, 2);
  ctx.setWithCap(m, 'b', 2, 2);
  ctx.setWithCap(m, 'c', 3, 2);
  assert.equal(m.size, 2);
  assert.equal(m.has('a'), false, 'oldest should be evicted');
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 3);
});

test('setWithCap: updating existing key keeps original position (FIFO)', () => {
  const ctx = loadCore();
  const m = new Map();
  ctx.setWithCap(m, 'a', 1, 2);
  ctx.setWithCap(m, 'b', 2, 2);
  ctx.setWithCap(m, 'a', 11, 2);   // re-set 'a' — order unchanged
  ctx.setWithCap(m, 'c', 3, 2);    // 'a' is still oldest → evicted
  assert.equal(m.size, 2);
  assert.equal(m.has('a'), false, 'a should be evicted (was oldest, re-set did not promote)');
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 3);
});
