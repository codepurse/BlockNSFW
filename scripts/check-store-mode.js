// scripts/check-store-mode.js
// Refuses a store package that would still sell through Polar's sandbox.
// build-chrome.ps1 and build-firefox.ps1 run it before -Zip makes a package
// with the Supporter extras; RELEASE_CHECKLIST.md section 0 is the list it
// backs up. Exits 1 and says what is left, or exits 0.
//
//   node scripts/check-store-mode.js

const path = require('path');

// The sandbox organization. A live build that still names it would check
// every real code against the test store, and refuse them all.
const SANDBOX_ORGANIZATIONS = ['35c82b93-77a2-4b87-8478-39fc5dd4e666'];

// What still stands between this shared/supporter.js and a store release.
function problems(Supporter) {
  const out = [];
  const store = Supporter.STORE || {};
  const plans = Array.isArray(Supporter.PLANS) ? Supporter.PLANS : [];
  if (store.mode !== 'live') out.push(`STORE.mode is '${store.mode}', not 'live'`);
  if (!store.organizationId) out.push('STORE.organizationId is empty');
  else if (SANDBOX_ORGANIZATIONS.includes(store.organizationId)) out.push('STORE.organizationId is still the sandbox organization');
  const linked = plans.filter((p) => p.url);
  if (!linked.length) out.push('no plan has a checkout link, so nothing can be bought');
  for (const p of linked) {
    let host = '';
    try { host = new URL(p.url).hostname; } catch (_) {}
    if (!host) out.push(`${p.id}: its url isn't a link`);
    else if (/sandbox/i.test(host)) out.push(`${p.id}: its checkout link is a sandbox one (${host})`);
    else if (!/(^|\.)polar\.sh$/.test(host)) out.push(`${p.id}: its checkout link isn't on polar.sh (${host})`);
  }
  for (const p of plans.filter((x) => !x.url)) out.push(`${p.id}: no checkout link, so it stays hidden`);
  return out;
}

if (require.main === module) {
  const Supporter = require(path.join(__dirname, '..', 'shared', 'supporter.js'));
  const left = problems(Supporter);
  if (left.length) {
    console.error('Supporter is not ready for a store package (RELEASE_CHECKLIST.md, section 0):');
    for (const p of left) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('Supporter: live store, live organization, live checkout links.');
}

module.exports = { problems, SANDBOX_ORGANIZATIONS };
