const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

// X1: preloadAiRuntime imported 4.31 MB of TF.js into the MV3 service worker
// synchronously on EVERY start, unconditionally — the AI image blocker is
// opt-in and off by default, so almost nobody who paid that cost was using it.
// importScripts may only run during a worker's initial synchronous evaluation,
// so the decision is made at load time and cannot be observed afterwards: these
// tests shape the environment before background.js evaluates.

// Reproduces a Chrome MV3 service worker: importScripts exists, and
// chrome.offscreen is present from Chrome 109.
function serviceWorker({ offscreen }) {
  const imported = [];
  const context = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.importScripts = (...paths) => { imported.push(...paths); };
    if (offscreen) {
      sandbox.chrome.offscreen = {
        createDocument: () => Promise.resolve(),
        closeDocument: () => Promise.resolve(),
        hasDocument: () => Promise.resolve(false)
      };
    }
  });
  return { context, imported };
}

test('Chrome 109+: the worker does not import TF.js at all', () => {
  const { imported } = serviceWorker({ offscreen: true });

  assert.deepEqual(imported.filter(p => p.includes('tfjs') || p.includes('nsfwjs')), [],
    'the offscreen document owns classification, so the worker never needs the runtime');
});

test('older Chrome without chrome.offscreen keeps the worker fallback', () => {
  const { imported } = serviceWorker({ offscreen: false });

  const ai = imported.filter(p => p.includes('tfjs') || p.includes('nsfwjs'));
  assert.deepEqual(ai, ['vendor/tfjs/tf.es2017.js', 'vendor/nsfwjs/nsfwjs.runtime.js'],
    'no supported version may lose classification — the fallback must still load');
});

test('the shared modules still load in both cases', () => {
  for (const offscreen of [true, false]) {
    const { imported } = serviceWorker({ offscreen });
    assert.ok(imported.includes('shared/hostname.js'),
      'skipping the AI runtime must not skip the small shared modules');
    assert.ok(imported.includes('shared/ruleset.js'));
  }
});

test('Firefox event page imports nothing: importScripts does not exist there', () => {
  // background.scripts runs in a page, not a worker. preloadAiRuntime is a
  // no-op and loadAiRuntimeViaDom handles it lazily on first use instead.
  const context = loadBackgroundContext(undefined, (sandbox) => {
    delete sandbox.importScripts;
    sandbox.document = undefined;
  });
  assert.equal(typeof context.preloadAiRuntime, 'function');
  // Nothing to assert about imports — the point is that it must not throw when
  // importScripts is absent, which is what a Firefox load looks like.
  assert.doesNotThrow(() => context.preloadAiRuntime());
});

// X2: the offscreen document was created and never closed, holding a WebGL
// context and every model that had been initialised for the browser session.

test('X2: the offscreen document is closed when it goes idle', async () => {
  let closed = 0;
  let hasDoc = true;
  const { context } = (() => {
    const imported = [];
    const ctx = loadBackgroundContext(undefined, (sandbox) => {
      sandbox.importScripts = (...p) => { imported.push(...p); };
      sandbox.chrome.offscreen = {
        createDocument: () => Promise.resolve(),
        closeDocument: () => { closed++; hasDoc = false; return Promise.resolve(); },
        hasDocument: () => Promise.resolve(hasDoc)
      };
    });
    return { context: ctx };
  })();

  await context.closeOffscreenDocument();

  assert.equal(closed, 1, 'nothing released the WebGL context or the resident models');
});

test('X2: closing works on Chrome 109-115, where getContexts does not exist', async () => {
  // hasOffscreenDocument() reads chrome.runtime.getContexts, added in Chrome
  // 116. Gating the close on it meant that on 109-115 the document was never
  // released — the leak this is meant to fix, still present on the versions the
  // offscreen path was written for.
  let closed = 0;
  const context = loadBackgroundContext(undefined, (sandbox) => {
    delete sandbox.chrome.runtime.getContexts;
    sandbox.chrome.offscreen = {
      createDocument: () => Promise.resolve(),
      closeDocument: () => { closed++; return Promise.resolve(); }
    };
  });

  await context.closeOffscreenDocument();

  assert.equal(closed, 1, 'the close must not depend on a Chrome 116+ API');
});

test('X2: closing is safe when there is no document, and on Firefox', async () => {
  const noDoc = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.chrome.offscreen = {
      createDocument: () => Promise.resolve(),
      closeDocument: () => { throw new Error('no offscreen document'); },
      hasDocument: () => Promise.resolve(false)
    };
  });
  await assert.doesNotReject(() => noDoc.closeOffscreenDocument());

  // Firefox has no chrome.offscreen at all; a cosmetic teardown must never
  // break the classification path.
  const firefox = loadBackgroundContext(undefined, (sandbox) => {
    delete sandbox.chrome.offscreen;
  });
  await assert.doesNotReject(() => firefox.closeOffscreenDocument());
});

test('X1 guard is reachable: offscreenAvailable reflects the environment', () => {
  const withIt = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.chrome.offscreen = { createDocument: () => {}, closeDocument: () => {} };
  });
  const without = loadBackgroundContext(undefined, (sandbox) => {
    delete sandbox.chrome.offscreen;
  });

  assert.equal(withIt.offscreenAvailable(), true);
  assert.equal(without.offscreenAvailable(), false);
});
