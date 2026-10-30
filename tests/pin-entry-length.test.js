// Every box a PIN is typed into takes the whole PIN.
//
// Setup took a PIN of any length, Settings stopped typing at 20 characters and
// the popup at 8, so a PIN set in setup was cut short where it was asked for
// and never matched: 9 to 20 characters failed in the popup only, longer ones
// in Settings too. Reported by email: "Pin longer than about 10 characters
// never work on the extension popup".
//
// The PIN is stored as a salted hash (shared/pin-hash.js), so its length costs
// nothing; no box should cap it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// Every password box is a PIN box: the access code and the Pact's codes are
// typed into plain text boxes.
function passwordInputs(source) {
  return source.match(/<input\b[^>]*\btype="password"[^>]*>/g) || [];
}

for (const file of ['popup.html', 'options.js', 'onboarding.html']) {
  test(`${file}: no PIN box caps how much can be typed`, () => {
    const inputs = passwordInputs(read(file));
    assert.ok(inputs.length > 0, `${file} should have a PIN box`);
    for (const input of inputs) {
      assert.doesNotMatch(input, /\bmaxlength\s*=/i, `capped PIN box in ${file}: ${input}`);
    }
  });
}

test('setup trims the PIN, as the popup and Settings trim what they check', () => {
  const source = read('onboarding.js');
  const save = source.slice(source.indexOf('async function trySavePin'));
  assert.ok(save.length > 0, 'onboarding.js should define trySavePin');
  assert.match(save, /const a = \(els\.pin\.value \|\| ''\)\.trim\(\);/);
  assert.match(save, /const b = \(els\.pin2\.value \|\| ''\)\.trim\(\);/);
});
