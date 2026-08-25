// Firefox has no MV3 service worker: `background.scripts` runs in an event
// PAGE, where importScripts() does not exist. These tests pin the two things
// that made the AI image blocker silently dead on Firefox:
//   1. background.js must be able to load the TF.js / NSFW.js runtime without
//      importScripts (via <script> tags on the event page's DOM).
//   2. manifest.firefox.json must declare every shared helper that background.js
//      would otherwise have pulled in with importScripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBackgroundContext } = require('./setup.js');

// Stand in for the Firefox event page's DOM. Each appended <script> resolves
// asynchronously and installs the global that the real bundle would install.
function attachFakeEventPage(ctx, { failOn = null } = {}) {
  const appended = [];
  ctx.document = {
    createElement: () => ({}),
    head: {
      appendChild(el) {
        appended.push(el.src);
        setTimeout(() => {
          if (failOn && String(el.src).includes(failOn)) {
            el.onerror();
            return;
          }
          if (String(el.src).includes('tf.es2017')) {
            ctx.self.tf = { setBackend: async () => {}, ready: async () => {} };
          }
          if (String(el.src).includes('nsfwjs.runtime')) {
            ctx.self.nsfwjs = { load: async () => ({ classify: async () => [] }) };
          }
          el.onload();
        }, 0);
      }
    }
  };
  return appended;
}

test('ensureAiRuntimeLoaded loads the runtime via script tags when importScripts is absent', async () => {
  const ctx = loadBackgroundContext();
  assert.equal(typeof ctx.self.importScripts, 'undefined', 'event page has no importScripts');

  const appended = attachFakeEventPage(ctx);
  await ctx.ensureAiRuntimeLoaded();

  // tf must be injected before the nsfwjs shim, which captures `global.tf` at
  // execution time and would throw "TensorFlow runtime unavailable" otherwise.
  assert.deepEqual(appended, [
    'vendor/tfjs/tf.es2017.js',
    'vendor/nsfwjs/nsfwjs.runtime.js'
  ]);
  assert.equal(typeof ctx.self.nsfwjs.load, 'function');
});

test('ensureAiRuntimeLoaded shares one in-flight load across concurrent callers', async () => {
  const ctx = loadBackgroundContext();
  const appended = attachFakeEventPage(ctx);

  await Promise.all([
    ctx.ensureAiRuntimeLoaded(),
    ctx.ensureAiRuntimeLoaded(),
    ctx.ensureAiRuntimeLoaded()
  ]);

  assert.equal(appended.length, 2, 'each bundle is injected exactly once');
});

test('a failed runtime load is retryable and never re-runs an already-loaded bundle', async () => {
  const ctx = loadBackgroundContext();
  const appended = attachFakeEventPage(ctx, { failOn: 'nsfwjs.runtime' });

  await assert.rejects(
    ctx.ensureAiRuntimeLoaded(),
    /failed to load vendor\/nsfwjs\/nsfwjs\.runtime\.js/
  );

  // Second attempt: tf already executed, so only the failed bundle is retried.
  attachFakeEventPage(ctx);
  await ctx.ensureAiRuntimeLoaded();
  assert.equal(typeof ctx.self.nsfwjs.load, 'function');
  assert.deepEqual(appended, [
    'vendor/tfjs/tf.es2017.js',
    'vendor/nsfwjs/nsfwjs.runtime.js'
  ], 'the 4.5 MB TF.js bundle is not re-evaluated on retry');
});

test('ensureAiRuntimeLoaded reports a clear error where neither mechanism exists', async () => {
  const ctx = loadBackgroundContext();
  await assert.rejects(ctx.ensureAiRuntimeLoaded(), /no importScripts and no DOM/);
});

test('firefox manifest declares every helper background.js imports via importScripts', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8')
  );
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

  const imported = [...source.matchAll(/self\.importScripts\(([^)]*)\)/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(s => s[1]))
    .filter(p => p.startsWith('shared/'));
  assert.ok(imported.length > 0, 'expected shared/* importScripts calls to scan');

  const declared = manifest.background.scripts;
  for (const dep of imported) {
    assert.ok(declared.includes(dep),
      `${dep} is importScripts'd by background.js but missing from manifest.firefox.json background.scripts`);
  }
  assert.equal(declared[declared.length - 1], 'background.js',
    'background.js must load after its helpers');
});

test('firefox manifest CSP matches the chrome build for the AI runtime', () => {
  const csp = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'manifest.firefox.json'), 'utf8')
  ).content_security_policy?.extension_pages || '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /wasm-unsafe-eval/);
});
