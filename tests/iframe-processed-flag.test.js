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

// processIframe used to set pblockerProcessed only when it hid something, so a
// clean iframe never satisfied its own entry guard: every media-discovery pass
// re-ran a URL parse, three host matchers, a srcdoc keyword scan and another
// background round-trip for it. Marking clean iframes fixes that, but it has to
// not break two things — re-checking an iframe that is later re-pointed, and
// letting the async background verdict still hide a clean-looking one.

function fakeIframe(attrs = {}) {
  const data = {};
  return {
    dataset: data,
    isConnected: true,
    _attrs: { ...attrs },
    getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; },
    setAttribute(name, value) { this._attrs[name] = value; }
  };
}

function harness({ blockedHosts = [], backgroundBlocked = [] } = {}) {
  let resolveBackground;
  const sandbox = {
    console,
    URL,
    Promise,
    window: { location: { href: 'https://example.test/page' } },
    debugMode: false,
    calls: { hidden: [], notified: [], adultUrl: 0, backgroundChecks: [] },
    pendingBackground: [],
    log() {},
    isAdultURL(url) { return blockedHosts.some(h => String(url).includes(h)); },
    isHostInDefaultBlocklist(host) { return blockedHosts.includes(host); },
    matchesAdultKeywordHost() { return false; },
    containsAdultKeywords() { return false; },
    hideElement(el, type) { sandbox.calls.hidden.push(type); el.dataset.pblockerHidden = 'true'; },
    notifyBackground(type, data) { sandbox.calls.notified.push([type, data]); },
    isUrlBlockedByBackground(url) {
      sandbox.calls.backgroundChecks.push(url);
      return Promise.resolve(backgroundBlocked.includes(url));
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fn('processIframe')}; globalThis.processIframe = processIframe;`, sandbox);
  return sandbox;
}

test('a clean iframe is marked, so a second pass does no work', () => {
  const s = harness();
  const frame = fakeIframe({ src: 'https://cdn.example.test/widget' });

  s.processIframe(frame);
  assert.equal(frame.dataset.pblockerProcessed, 'true');
  assert.equal(frame.dataset.pblockerCheckedSrc, 'https://cdn.example.test/widget');
  assert.equal(s.calls.backgroundChecks.length, 1);

  for (let i = 0; i < 10; i++) s.processIframe(frame);
  assert.equal(s.calls.backgroundChecks.length, 1,
    'ten more discovery passes must not re-check an unchanged clean iframe');
});

test('an iframe re-pointed at a new src is re-checked', () => {
  const s = harness();
  const frame = fakeIframe({ src: 'https://cdn.example.test/one' });
  s.processIframe(frame);
  assert.equal(s.calls.backgroundChecks.length, 1);

  frame.setAttribute('src', 'https://cdn.example.test/two');
  s.processIframe(frame);

  assert.equal(s.calls.backgroundChecks.length, 2,
    'the guard is keyed on the src that was judged, not a bare flag');
  assert.equal(frame.dataset.pblockerCheckedSrc, 'https://cdn.example.test/two');
});

test('a blocklisted iframe is hidden synchronously', () => {
  const s = harness({ blockedHosts: ['adult.invalid'] });
  const frame = fakeIframe({ src: 'https://adult.invalid/embed' });

  s.processIframe(frame);

  assert.deepEqual(s.calls.hidden, ['iframe']);
  assert.equal(s.calls.notified[0][0], 'iframe_filtered');
  assert.equal(s.calls.backgroundChecks.length, 0, 'no round-trip needed once it is already hidden');
});

test('the async background verdict still hides a clean-looking iframe', async () => {
  const src = 'https://sneaky.invalid/embed';
  const s = harness({ backgroundBlocked: [src] });
  const frame = fakeIframe({ src });

  s.processIframe(frame);
  assert.deepEqual(s.calls.hidden, [], 'nothing hidden yet — the verdict is in flight');

  await new Promise(done => setTimeout(done, 0));

  // The bail must test pblockerHidden, not pblockerProcessed: the latter is now
  // set for clean iframes, so checking it here would swallow every late verdict.
  assert.deepEqual(s.calls.hidden, ['iframe'],
    'a late block verdict must still be applied');
});

test('a late verdict is dropped when the iframe has moved on', async () => {
  const src = 'https://sneaky.invalid/embed';
  const s = harness({ backgroundBlocked: [src] });
  const frame = fakeIframe({ src });

  s.processIframe(frame);
  frame.setAttribute('src', 'https://other.example.test/new');  // re-pointed mid-flight
  await new Promise(done => setTimeout(done, 0));

  assert.deepEqual(s.calls.hidden, [],
    'the verdict describes a src this frame no longer holds');
});

test('a late verdict is dropped when the iframe left the document', async () => {
  const src = 'https://sneaky.invalid/embed';
  const s = harness({ backgroundBlocked: [src] });
  const frame = fakeIframe({ src });

  s.processIframe(frame);
  frame.isConnected = false;
  await new Promise(done => setTimeout(done, 0));

  assert.deepEqual(s.calls.hidden, []);
});

test('a missing iframe is handled before any attribute is read', () => {
  const s = harness();
  assert.doesNotThrow(() => s.processIframe(null));
  assert.doesNotThrow(() => s.processIframe(undefined));
});
