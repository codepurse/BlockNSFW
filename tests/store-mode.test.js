// The store-package guard (scripts/check-store-mode.js): a package for the
// stores must sell through Polar's live store, never the sandbox, and both
// build scripts ask it before -Zip makes one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { problems, SANDBOX_ORGANIZATIONS } = require('../scripts/check-store-mode.js');

const ROOT = path.join(__dirname, '..');
const LIVE = {
  STORE: { mode: 'live', organizationId: '00000000-1111-2222-3333-444444444444' },
  PLANS: [
    { id: 'monthly', url: 'https://buy.polar.sh/polar_cl_aaa' },
    { id: 'yearly', url: 'https://api.polar.sh/v1/checkout-links/polar_cl_bbb/redirect' },
    { id: 'lifetime', url: 'https://buy.polar.sh/polar_cl_ccc' }
  ]
};
const withStore = (store) => ({ ...LIVE, STORE: { ...LIVE.STORE, ...store } });
const withPlan = (id, url) => ({ ...LIVE, PLANS: LIVE.PLANS.map((p) => (p.id === id ? { ...p, url } : p)) });

test('live mode, a live organization and live links: ready', () => {
  assert.deepEqual(problems(LIVE), []);
});

test('sandbox mode, the sandbox organization or an empty one: not ready', () => {
  assert.match(problems(withStore({ mode: 'sandbox' })).join(), /STORE\.mode is 'sandbox'/);
  assert.match(problems(withStore({ organizationId: SANDBOX_ORGANIZATIONS[0] })).join(), /still the sandbox organization/);
  assert.match(problems(withStore({ organizationId: '' })).join(), /organizationId is empty/);
});

test('a sandbox checkout link, a link off polar.sh, or no link: not ready', () => {
  assert.match(problems(withPlan('monthly', 'https://sandbox-api.polar.sh/v1/checkout-links/x/redirect')).join(), /monthly: its checkout link is a sandbox one/);
  assert.match(problems(withPlan('yearly', 'https://evilpolar.sh.example/x')).join(), /yearly: its checkout link isn't on polar\.sh/);
  assert.match(problems(withPlan('lifetime', '')).join(), /lifetime: no checkout link/);
  assert.match(problems({ ...LIVE, PLANS: LIVE.PLANS.map((p) => ({ ...p, url: '' })) }).join(), /nothing can be bought/);
});

test('the command answers for shared/supporter.js as it is now', () => {
  const expected = problems(require('../shared/supporter.js')).length ? 1 : 0;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-store-mode.js')], { encoding: 'utf8' });
  assert.equal(run.status, expected, run.stderr || run.stdout);
});

for (const build of ['build-chrome.ps1', 'build-firefox.ps1']) {
  test(`${build}: a store -Zip asks the guard first, and -Sandbox is the only way round it`, () => {
    const src = fs.readFileSync(path.join(ROOT, build), 'utf8');
    assert.match(src, /\[switch\]\$Sandbox/);
    const guard = src.indexOf('check-store-mode.js');
    assert.ok(guard > 0, 'the build runs the guard');
    assert.match(src.slice(Math.max(0, guard - 400), guard), /if \(\$Zip -and -not \$OpenSource -and -not \$Sandbox\)/);
    assert.ok(guard < src.indexOf('Remove-Item -Path $OutDir'), 'before dist is cleaned, so a refusal keeps the last build');
    assert.match(src, /TEST PACKAGE: Supporter uses Polar's sandbox\. Never upload it to a store\./);
  });
}
