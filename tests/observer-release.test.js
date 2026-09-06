const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

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

// H4: IntersectionObserver holds a STRONG reference to every target, and the
// only paths that unobserved were "it intersected" and "filtering was switched
// off". On a virtualised feed, nodes are created and discarded by the hundred
// without most of them ever intersecting, so the observer pinned every <img>
// the tab had rendered.
//
// The release path has to do two things, and doing only the first is worse than
// doing neither: unobserve the node, AND clear the marker that observeImage
// early-returns on. A feed that recycles a row detaches and re-attaches the same
// node — release-without-clear leaves it unobserved and refused a fresh observe,
// which silently drops its viewport check and AI classification.

function fakeNode(tag, attrs = {}) {
  const children = [];
  return {
    tagName: tag,
    dataset: {},
    isConnected: true,
    children,
    appendChild(node) { children.push(node); return node; },
    querySelectorAll(selector) {
      const want = selector.toUpperCase();
      return children.filter(c => c.tagName === want);
    }
  };
}

function harness() {
  const observed = { img: new Set(), video: new Set() };
  const sandbox = {
    console,
    imageObserver: {
      observe: (el) => observed.img.add(el),
      unobserve: (el) => observed.img.delete(el)
    },
    mediaObserver: {
      observe: (el) => observed.video.add(el),
      unobserve: (el) => observed.video.delete(el)
    },
    observed
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${fn('releaseObservedImage')}
    ${fn('releaseObservedVideo')}
    ${fn('releaseObservedMedia')}
    globalThis.release = releaseObservedMedia;
  `, sandbox);
  return sandbox;
}

test('a released image is unobserved', () => {
  const s = harness();
  const img = fakeNode('IMG');
  s.imageObserver.observe(img);
  img.dataset.pblockerObserved = 'true';

  s.release(img);

  assert.equal(s.observed.img.size, 0,
    'the observer holds a strong reference; not unobserving is the leak');
});

test('a released image can be observed again when it comes back', () => {
  const s = harness();
  const img = fakeNode('IMG');
  img.dataset.pblockerObserved = 'true';
  img.dataset.pblockerObservedSrc = 'https://cdn.test/a.jpg';
  s.imageObserver.observe(img);

  s.release(img);

  // observeImage() returns early on this marker. Leaving it set would mean a
  // recycled row is never re-observed and never deeply checked again.
  assert.equal(img.dataset.pblockerObserved, undefined,
    'the marker must be cleared or the node is stranded unobserved');
  assert.equal(img.dataset.pblockerObservedSrc, undefined);
});

test('a released image that was blocked stays blocked', () => {
  const s = harness();
  const img = fakeNode('IMG');
  img.dataset.pblockerObserved = 'true';
  img.dataset.pblockerHidden = 'true';

  s.release(img);

  assert.equal(img.dataset.pblockerHidden, 'true',
    'recycling a node must not un-block content that was already blocked');
});

test('releasing a container releases the media inside it', () => {
  const s = harness();
  const row = fakeNode('DIV');
  const img = fakeNode('IMG');
  const video = fakeNode('VIDEO');
  row.appendChild(img);
  row.appendChild(video);
  s.imageObserver.observe(img);
  s.mediaObserver.observe(video);
  img.dataset.pblockerObserved = 'true';
  video.dataset.pblockerObserved = 'true';

  s.release(row);

  assert.equal(s.observed.img.size, 0, 'a discarded feed row takes its images with it');
  assert.equal(s.observed.video.size, 0);
  assert.equal(img.dataset.pblockerObserved, undefined);
  assert.equal(video.dataset.pblockerObserved, undefined);
});

test('releasing tolerates observers that do not exist yet', () => {
  const s = harness();
  vm.runInContext('imageObserver = null; mediaObserver = null;', s);
  const img = fakeNode('IMG');
  img.dataset.pblockerObserved = 'true';

  assert.doesNotThrow(() => s.release(img));
  assert.equal(img.dataset.pblockerObserved, undefined,
    'the marker is cleared even when there was no observer to unobserve from');
});

test('a feed that recycles 500 rows retains none of them', () => {
  const s = harness();

  for (let i = 0; i < 500; i++) {
    const row = fakeNode('DIV');
    const img = fakeNode('IMG');
    row.appendChild(img);
    s.imageObserver.observe(img);
    img.dataset.pblockerObserved = 'true';
    // The feed drops the row without it ever intersecting.
    row.isConnected = false;
    s.release(row);
  }

  assert.equal(s.observed.img.size, 0,
    'this is the unbounded retain that showed up as slowdown after hours');
});

test('the release is drained on idle, never inside the observer callback', () => {
  // Doing this work synchronously per removal measurably raised mutation p95:
  // a virtualised feed removes rows on every frame.
  assert.match(CONTENT, /function scheduleMediaRelease\(\)/);
  assert.match(CONTENT, /requestIdleCallback\(run, \{ timeout: 1000 \}\)/);
  assert.ok(!/removedNodes[\s\S]{0,200}releaseObservedMedia\(/.test(CONTENT),
    'the observer callback must queue removals, not process them');
});
