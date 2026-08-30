// Tests for shared/access-code.js — the rules behind the optional second
// layer over the PIN. These moved out of options-pin-gate.test.js when the
// module was extracted for issue #29: the popup had its own PIN-only gate, so
// "unblock this site" never faced the code. One module, one set of rules, one
// place to test them.
const test = require('node:test');
const assert = require('node:assert/strict');

const AccessCode = require('../shared/access-code.js');

test('normalizeConfig: defaults to off at 64 characters', () => {
  const config = AccessCode.normalizeConfig(undefined);
  assert.equal(config.enabled, false);
  assert.equal(config.length, 64);
});

test('normalizeConfig: keeps every supported length', () => {
  for (const length of [32, 64, 128, 256]) {
    assert.equal(AccessCode.normalizeConfig({ length }).length, length);
  }
});

test('normalizeConfig: rejects an unsupported length', () => {
  // A stored "1" would otherwise turn the deterrent into a single keystroke.
  assert.equal(AccessCode.normalizeConfig({ length: 1 }).length, 64);
  assert.equal(AccessCode.normalizeConfig({ length: 'lots' }).length, 64);
});

test('normalizeConfig: only a real true enables it', () => {
  assert.equal(AccessCode.normalizeConfig({ enabled: 'yes' }).enabled, false);
  assert.equal(AccessCode.normalizeConfig({ enabled: 1 }).enabled, false);
  assert.equal(AccessCode.normalizeConfig({ enabled: true }).enabled, true);
});

test('normalizeConfig: defaults scope to critical', () => {
  assert.equal(AccessCode.normalizeConfig({}).scope, 'critical');
  assert.equal(AccessCode.normalizeConfig({ scope: 'nonsense' }).scope, 'critical');
  assert.equal(AccessCode.normalizeConfig({ scope: 'all' }).scope, 'all');
});

test('requiredFor: disabled never prompts', () => {
  assert.equal(AccessCode.requiredFor({ enabled: false, scope: 'all' }, true), false);
  assert.equal(AccessCode.requiredFor({ enabled: false, scope: 'all' }, false), false);
});

test('requiredFor: critical scope only prompts on master switches', () => {
  const config = { enabled: true, scope: 'critical' };
  assert.equal(AccessCode.requiredFor(config, true), true);
  // Editing a blocked word must NOT demand the code in this mode — that
  // friction is what drives people to switch the feature off entirely.
  assert.equal(AccessCode.requiredFor(config, false), false);
});

test('requiredFor: all scope prompts on every weakening change', () => {
  const config = { enabled: true, scope: 'all' };
  assert.equal(AccessCode.requiredFor(config, true), true);
  assert.equal(AccessCode.requiredFor(config, false), true);
});

test('requiredFor: a corrupted scope falls back to critical', () => {
  assert.equal(AccessCode.requiredFor({ enabled: true, scope: 'everything' }, false), false);
});

test('generate: returns exactly the requested length', () => {
  for (const length of [32, 64, 128, 256]) {
    assert.equal(AccessCode.generate(length).length, length);
  }
});

test('generate: uses only charset characters', () => {
  const allowed = new Set(AccessCode.CHARS);
  for (const char of AccessCode.generate(128)) {
    assert.ok(allowed.has(char), `unexpected character: ${char}`);
  }
});

test('generate: excludes visually ambiguous glyphs', () => {
  // Retyping should be an effort, not a guessing game. Each confusable group
  // is broken by dropping the clashing members: 0/O go, so lowercase "o" is
  // unambiguous and stays; 1/l/I go, so "i" is likewise safe to keep.
  for (const char of '0O1lI') {
    assert.ok(!AccessCode.CHARS.includes(char), `charset should not contain ${char}`);
  }
});

test('generate: charset has no duplicate characters', () => {
  // A repeated character would be twice as likely as the rest.
  assert.equal(new Set(AccessCode.CHARS).size, AccessCode.CHARS.length);
});

test('generate: does not repeat itself', () => {
  const codes = new Set(Array.from({ length: 20 }, () => AccessCode.generate(32)));
  assert.equal(codes.size, 20);
});

test('readConfig: normalizes whatever is in storage', async () => {
  // Storage is user-writable in principle, so a hand-edited "enabled" flag
  // must not become a length of 1 or an unknown scope.
  const storage = {
    get: () => Promise.resolve({ [AccessCode.KEY]: { enabled: true, length: 3, scope: 'none' } })
  };
  const config = await AccessCode.readConfig(storage);
  assert.deepEqual(config, { enabled: true, length: 64, scope: 'critical' });
});

test('readConfig: an empty store reads as off', async () => {
  const config = await AccessCode.readConfig({ get: () => Promise.resolve({}) });
  assert.equal(config.enabled, false);
});

test('writeConfig: stores the normalized shape under the shared key', async () => {
  let written = null;
  const storage = { set: (payload) => { written = payload; return Promise.resolve(); } };
  await AccessCode.writeConfig(storage, { enabled: true, length: 256, scope: 'all', junk: 1 });
  assert.deepEqual(written, {
    [AccessCode.KEY]: { enabled: true, length: 256, scope: 'all' }
  });
});

test('hardenEntry: refuses paste, drop and copy', () => {
  // Without this the whole deterrent is a two-second clipboard round-trip.
  const handlers = { input: {}, display: {} };
  const fake = (bucket) => ({
    addEventListener: (evt, fn) => { bucket[evt] = fn; }
  });
  const input = fake(handlers.input);
  const display = fake(handlers.display);
  AccessCode.hardenEntry(input, display);

  const prevented = (fn, event) => {
    let stopped = false;
    fn({ ...event, preventDefault: () => { stopped = true; } });
    return stopped;
  };

  for (const evt of ['paste', 'drop', 'dragover']) {
    assert.ok(handlers.input[evt], `input should refuse ${evt}`);
    assert.equal(prevented(handlers.input[evt], {}), true);
  }
  for (const evt of ['copy', 'cut', 'contextmenu']) {
    assert.ok(handlers.display[evt], `display should refuse ${evt}`);
    assert.equal(prevented(handlers.display[evt], {}), true);
  }

  // Ctrl+V / Cmd+V and undo are blocked; ordinary typing is not.
  const keydown = handlers.input.keydown;
  assert.equal(prevented(keydown, { key: 'v', ctrlKey: true }), true);
  assert.equal(prevented(keydown, { key: 'V', metaKey: true }), true);
  assert.equal(prevented(keydown, { key: 'z', ctrlKey: true }), true);
  assert.equal(prevented(keydown, { key: 'v' }), false);
  assert.equal(prevented(keydown, { key: 'a', ctrlKey: true }), false);
});

test('hardenEntry: tolerates a missing element', () => {
  assert.doesNotThrow(() => AccessCode.hardenEntry(null, null));
});
