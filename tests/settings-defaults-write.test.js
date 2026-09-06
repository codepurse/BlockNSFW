const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

// A background start must be observationally silent.
//
// storage.local.set fires storage.onChanged whether or not the value changed,
// and that event costs a full rebuildCompiledPatterns + updateDnrRules here AND
// a loadSettings + full processContent in every content script in every open
// tab. Because both browsers suspend an idle MV3 background, an unconditional
// "save the defaults" on startup turned every wake-up into a page re-scan in
// every tab. These tests pin the two halves of the fix: write when something is
// genuinely missing, stay silent when nothing is.

// The module runs initializeBackground() on load, so its own startup writes must
// be allowed to settle before the recorder is installed — otherwise they land in
// the recorded list and every assertion below counts one write too many.
//
// DEFAULT_SETTINGS is read through runInContext because a top-level `const` in a
// vm context is not a property of the context object.
async function harness() {
  const context = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', context);

  const defaults = JSON.parse(vm.runInContext('JSON.stringify(DEFAULT_SETTINGS)', context));
  const writes = [];
  let stored;

  context.chrome.storage.local.get = (keys) => {
    const key = Array.isArray(keys) ? keys[0] : keys;
    if (key === 'pblocker_settings' && stored !== undefined) {
      return Promise.resolve({ pblocker_settings: stored });
    }
    return Promise.resolve({});
  };
  context.chrome.storage.local.set = (items) => {
    writes.push(items);
    return Promise.resolve();
  };

  return {
    context,
    defaults,
    setStored: (value) => { stored = value; },
    settingsWrites: () => writes.filter(item => 'pblocker_settings' in item)
  };
}

test('ensureSettingsDefaults does not write when stored settings already match defaults', async () => {
  const { context, defaults, setStored, settingsWrites } = await harness();
  setStored(defaults);

  await context.ensureSettingsDefaults();

  assert.deepEqual(settingsWrites(), [],
    'an identical rewrite still fires storage.onChanged and re-scans every tab');
});

test('ensureSettingsDefaults writes when a default key is missing from storage', async () => {
  const { context, defaults, setStored, settingsWrites } = await harness();
  const partial = { ...defaults };
  delete partial.aiTextBlocker; // a profile stored before the key existed
  setStored(partial);

  const merged = await context.ensureSettingsDefaults();

  assert.equal(settingsWrites().length, 1, 'a missing default must still be persisted');
  assert.equal(merged.aiTextBlocker, false);
  assert.equal(settingsWrites()[0].pblocker_settings.aiTextBlocker, false);
});

test('ensureSettingsDefaults writes when storage is empty', async () => {
  const { context, settingsWrites } = await harness();

  const merged = await context.ensureSettingsDefaults();

  assert.equal(settingsWrites().length, 1, 'a fresh profile must get its defaults');
  assert.equal(merged.enabled, true);
});

test('a stored non-default value is not treated as a missing default', async () => {
  const { context, defaults, setStored, settingsWrites } = await harness();
  setStored({ ...defaults, enabled: false });

  const merged = await context.ensureSettingsDefaults();

  assert.equal(merged.enabled, false, "the user's own value wins");
  assert.deepEqual(settingsWrites(), [], 'and needs no rewrite, because it is already stored');
});

test('settingsEqual compares array values, not identity', async () => {
  const { context, defaults } = await harness();

  assert.equal(
    context.settingsEqual({ ...defaults, customPatterns: ['a.example'] },
                          { ...defaults, customPatterns: ['a.example'] }),
    true,
    'equal-by-value arrays must not look like a change'
  );
  assert.equal(
    context.settingsEqual({ ...defaults, customPatterns: ['a.example'] },
                          { ...defaults, customPatterns: ['b.example'] }),
    false,
    'a genuinely different list must be written'
  );
});
