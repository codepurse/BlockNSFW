const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// A thing that is already hidden must not be counted again.
//
// 2026-11-09 a new supporter wrote in: within a minute of installing, the
// popup's counters went past 140, then 1,000. The cause was observeImage's
// instant URL check. It hid the image and reported the block without asking
// whether the image was already hidden. hideElement did nothing the second
// time, but the report still went out. Every time a page swapped the picture
// in a held <img> (a preview reel, a carousel, a recycled feed slot), the
// counters went up by one more. Ten thumbnails changing four times a second
// added ~2,000 a minute in real Chrome.
//
// hideElement now says whether it hid anything, and callers count only then.

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function fn(name) {
  const marker = new RegExp('(?:^|\\n)(?:async )?function ' + name + '\\s*\\(', 'm');
  const m = marker.exec(CONTENT);
  assert.ok(m, `function ${name} not found in content.js`);
  const start = m.index + (CONTENT[m.index] === '\n' ? 1 : 0);
  let i = CONTENT.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; i < CONTENT.length; i++) {
    if (CONTENT[i] === '{') depth++;
    else if (CONTENT[i] === '}') { depth--; if (depth === 0) break; }
  }
  return CONTENT.slice(start, i + 1);
}

function fakeElement(tagName, attrs = {}) {
  return {
    tagName,
    dataset: {},
    style: {},
    isConnected: true,
    parentNode: null,
    classList: { add() {}, remove() {}, contains() { return false; } },
    _attrs: { ...attrs },
    getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; },
    setAttribute(name, value) { this._attrs[name] = value; }
  };
}

function harness({ blockedHosts = ['adult.invalid'], tiles = new Map() } = {}) {
  const sandbox = {
    console,
    URL,
    Promise,
    window: { location: { href: 'https://example.test/page' } },
    debugMode: false,
    isEnabled: true,
    searchResultTreatment: 'hide',
    imageObserver: { observe() {}, unobserve() {} },
    notified: [],
    pillEntries: 0,
    log() {},
    notifyBackground(type, data) { sandbox.notified.push(type); },
    recordBlockedEntry() { sandbox.pillEntries++; },
    getImageSearchTile(el) { return tiles.get(el) || null; },
    isImagesSearchContext() { return false; },
    createBlockedImagePlaceholder() { return {}; },
    createBlockedResultElement() { return {}; },
    getEffectiveImageUrl(img) { return img.getAttribute('src') || ''; },
    getImageContextLinks() { return []; },
    setupIntersectionObserver() {},
    isUrlBlockedByBackground() { return Promise.resolve(false); },
    shouldBlockImageQuickly(img) {
      try { return blockedHosts.includes(new URL(img.getAttribute('src')).hostname); } catch (_) { return false; }
    },
    isAdultURL() { return false; },
    isHostInDefaultBlocklist(host) { return blockedHosts.includes(host); },
    matchesAdultKeywordHost() { return false; },
    containsAdultKeywords() { return false; }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    fn('hideElement'), fn('observeImage'), fn('processIframe'),
    'globalThis.hideElement = hideElement;',
    'globalThis.observeImage = observeImage;',
    'globalThis.processIframe = processIframe;'
  ].join('\n'), sandbox);
  return sandbox;
}

test('hideElement says whether it hid anything', () => {
  const s = harness();
  const el = fakeElement('DIV');
  assert.equal(s.hideElement(el, 'search-result'), true);
  assert.equal(s.hideElement(el, 'search-result'), false, 'already hidden: nothing new to count');
  assert.equal(s.hideElement(null, 'image'), false);
});

test('a held thumbnail whose picture keeps changing is counted once', () => {
  const s = harness();
  const img = fakeElement('IMG', { src: 'https://adult.invalid/thumbs/1/0.jpg' });

  s.observeImage(img);
  assert.deepEqual(s.notified, ['image_filtered']);

  // A preview reel: the page swaps the frame, and the attribute observer
  // hands the same <img> back to observeImage each time.
  for (let frame = 1; frame <= 40; frame++) {
    img.setAttribute('src', `https://adult.invalid/thumbs/1/${frame % 8}.jpg`);
    s.observeImage(img);
  }

  assert.equal(img.dataset.pblockerHidden, 'true', 'still hidden');
  assert.deepEqual(s.notified, ['image_filtered'],
    'forty picture swaps on one hidden thumbnail must not add forty blocks');
  assert.equal(s.pillEntries, 1);
});

test('ten thumbnails are ten blocks, however often they change', () => {
  const s = harness();
  const imgs = Array.from({ length: 10 }, (_, i) =>
    fakeElement('IMG', { src: `https://adult.invalid/thumbs/${i}/0.jpg` }));
  imgs.forEach(img => s.observeImage(img));
  for (let frame = 1; frame <= 48; frame++) {
    imgs.forEach((img, i) => {
      img.setAttribute('src', `https://adult.invalid/thumbs/${i}/${frame % 8}.jpg`);
      s.observeImage(img);
    });
  }
  assert.equal(s.notified.length, 10);
});

test('an image-search tile is one block, not one per image inside it', () => {
  const tile = fakeElement('DIV');
  const a = fakeElement('IMG', { src: 'https://adult.invalid/a.jpg' });
  const b = fakeElement('IMG', { src: 'https://adult.invalid/b.jpg' });
  const s = harness({ tiles: new Map([[a, tile], [b, tile]]) });

  s.observeImage(a);
  s.observeImage(b);

  assert.equal(tile.dataset.pblockerHidden, 'true');
  assert.equal(b.dataset.pblockerHidden, 'true', 'the second image is marked too');
  assert.deepEqual(s.notified, ['image_filtered']);
});

test('a held frame re-pointed by an ad rotator is counted once', () => {
  const s = harness();
  const frame = fakeElement('IFRAME', { src: 'https://adult.invalid/ad/1' });

  s.processIframe(frame);
  for (let n = 2; n <= 20; n++) {
    frame.setAttribute('src', `https://adult.invalid/ad/${n}`);
    s.processIframe(frame);
  }

  assert.deepEqual(s.notified, ['iframe_filtered']);
});

test('no caller counts a block without asking hideElement whether it hid one', () => {
  // Every call must be a condition. A bare `hideElement(…);` statement
  // followed by a count is the shape that caused the bug.
  const bare = CONTENT.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*hideElement\(/.test(line));
  assert.deepEqual(bare, [], 'bare hideElement() calls: ' + bare.map(([n]) => n).join(', '));
});
