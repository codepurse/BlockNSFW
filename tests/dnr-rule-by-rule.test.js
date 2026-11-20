const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackgroundContext } = require('./setup.js');

// updateDynamicRules is all-or-nothing: one rule the browser can't take rejects
// the whole call. Safari turns DNR rules into WebKit content-blocker rules,
// whose regex has no alternation (`a|b`) and no `\d`, so it rejected rule 10002
// (Bing) and with it every SafeSearch, whitelist-allow and custom-image rule.
// Measured 2026-11-19 in Safari 17: dynamic rules 0. These tests pin the
// fallback: when the batch is refused, each rule is added on its own, so only
// the rules the browser can't take are missing.

// A browser that refuses any call carrying a rule it can't compile, the way
// Safari does, and keeps the rules of every call it accepts.
function safariLikeDnr() {
  const applied = new Map();
  const calls = [];
  const unsupported = (rule) => {
    const re = rule.condition && rule.condition.regexFilter;
    return typeof re === 'string' && (re.includes('|') || re.includes('\\d'));
  };
  return {
    applied,
    calls,
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
      calls.push({ removeRuleIds, addRules });
      const bad = addRules.findIndex(unsupported);
      if (bad !== -1) {
        throw new Error(`Error with rule at index ${bad}: Rule with id ${addRules[bad].id} is invalid. \`regexFilter\` is not a supported regular expression.`);
      }
      for (const id of removeRuleIds) applied.delete(id);
      for (const rule of addRules) applied.set(rule.id, rule);
    },
    getDynamicRules: async () => [...applied.values()]
  };
}

// The update startup kicks off is drained on the default stub before `dnr`
// goes in, so every call a test counts is one it made itself.
async function harness(dnr, { storage } = {}) {
  const context = loadBackgroundContext();
  await vm.runInContext('backgroundInitializationPromise', context);
  context.console = { ...console, log() {}, warn() {}, error() {} };
  await context.updateDnrRules();
  if (storage) {
    context.chrome.storage.local.get = async (keys) => {
      const list = keys == null ? [...storage.keys()] : [].concat(keys);
      const out = {};
      for (const key of list) if (storage.has(key)) out[key] = JSON.parse(JSON.stringify(storage.get(key)));
      return out;
    };
    context.chrome.storage.local.set = async (items) => {
      for (const [key, value] of Object.entries(items)) storage.set(key, JSON.parse(JSON.stringify(value)));
    };
  }
  context.chrome.declarativeNetRequest = dnr;
  return context;
}

// What Safari takes from the current SafeSearch set, by id. Spread into this
// realm's Array: deepStrictEqual tells the vm sandbox's arrays apart.
function acceptedIds(context) {
  return [...vm.runInContext('buildSafeSearchRules()', context)]
    .filter(r => !/\||\\d/.test(r.condition.regexFilter || ''))
    .map(r => r.id)
    .sort((a, b) => a - b);
}

function appliedIds(dnr) {
  return [...dnr.applied.keys()].sort((a, b) => a - b);
}

test('a rule the browser rejects no longer takes every other dynamic rule with it', async () => {
  const dnr = safariLikeDnr();
  const context = await harness(dnr);
  const built = vm.runInContext('buildSafeSearchRules()', context);
  const accepted = built.filter(r => !/\||\\d/.test(r.condition.regexFilter || ''));
  assert.ok(accepted.length > 0 && accepted.length < built.length,
    'the SafeSearch set should mix rules Safari takes and rules it refuses');

  await context.updateDnrRules();

  assert.ok(dnr.applied.has(10001), 'Google SafeSearch (no alternation) should apply');
  assert.ok(!dnr.applied.has(10002), 'Bing (alternation) is refused on its own');
  for (const rule of accepted) {
    assert.ok(dnr.applied.has(rule.id), `rule ${rule.id} should survive a refused neighbour`);
  }
});

test('the fallback clears the old rules, so a removed rule does not linger', async () => {
  const dnr = safariLikeDnr();
  dnr.applied.set(10050, { id: 10050 }); // left over from an earlier update
  const context = await harness(dnr);

  await context.updateDnrRules();

  assert.ok(!dnr.applied.has(10050), 'every managed id is removed before the rules go back one by one');
});

test('a browser that takes the whole batch gets one atomic call, as before', async () => {
  const applied = new Map();
  const calls = [];
  const dnr = {
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
      calls.push({ removeRuleIds, addRules });
      for (const id of removeRuleIds) applied.delete(id);
      for (const rule of addRules) applied.set(rule.id, rule);
    },
    getDynamicRules: async () => [...applied.values()]
  };
  const context = await harness(dnr);

  await context.updateDnrRules();

  assert.equal(calls.length, 1, 'Chrome and Firefox keep the single remove-and-add update');
  assert.ok(calls[0].removeRuleIds.length > 0 && calls[0].addRules.length > 0);
});

// ---- What the fallback costs, measured in Safari 17 (2026-11-19) ------------
//
// Safari recompiles its whole content-blocker list, static ruleset included,
// on every updateDynamicRules call it accepts. The fallback made ~23 calls, and
// startup awaited them: ready at 16-28 s, so onboarding opened that late and
// every wake left that long a window where the full list didn't answer.

function never() {
  return new Promise(() => {});
}

function settlesWithin(promise, ms) {
  return Promise.race([
    promise.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('pending'), ms))
  ]);
}

test('readiness does not wait on dynamic rules', async () => {
  const context = loadBackgroundContext(undefined, sandbox => {
    sandbox.chrome.declarativeNetRequest.updateDynamicRules = never;
  });
  context.console = { ...console, log() {}, warn() {}, error() {} };

  assert.equal(await settlesWithin(vm.runInContext('initReady', context), 1000), 'settled',
    'verdicts never read the dynamic rules, so they must not wait for them');
  assert.equal(await settlesWithin(vm.runInContext('backgroundInitializationPromise', context), 1000), 'settled',
    'onInstalled awaits initialisation before it opens onboarding');
});

// Real browsers refuse a rule id that's already there. Two fallbacks running
// at once each clear the rules and re-add them, so one's adds collide with the
// other's and good rules get counted as refused.
function strictSafariLikeDnr() {
  const dnr = safariLikeDnr();
  const inner = dnr.updateDynamicRules;
  dnr.inFlight = 0;
  dnr.maxInFlight = 0;
  dnr.updateDynamicRules = async (options = {}) => {
    dnr.inFlight++;
    dnr.maxInFlight = Math.max(dnr.maxInFlight, dnr.inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      for (const rule of options.addRules || []) {
        const removed = (options.removeRuleIds || []).includes(rule.id);
        if (dnr.applied.has(rule.id) && !removed) {
          dnr.calls.push(options);
          throw new Error(`Rule with id ${rule.id} already exists.`);
        }
      }
      return await inner(options);
    } finally {
      dnr.inFlight--;
    }
  };
  return dnr;
}

test('updates that overlap run one after the other and leave the right rules', async () => {
  const dnr = strictSafariLikeDnr();
  const context = await harness(dnr, { storage: new Map() });

  await Promise.all([context.updateDnrRules(), context.updateDnrRules(), context.updateDnrRules()]);

  assert.equal(dnr.maxInFlight, 1, 'never two DNR calls at once');
  assert.deepEqual(appliedIds(dnr), acceptedIds(context));
});

test('a wake with nothing to change makes no DNR call', async () => {
  const dnr = safariLikeDnr();
  const storage = new Map();
  const context = await harness(dnr, { storage });

  await context.updateDnrRules();
  const before = dnr.calls.length;
  await context.updateDnrRules();

  assert.equal(dnr.calls.length, before, 'each accepted call costs Safari a full recompile');
  assert.deepEqual(appliedIds(dnr), acceptedIds(context));
});

test('a later change goes in one call, without the rules the browser refused', async () => {
  const dnr = safariLikeDnr();
  const storage = new Map();
  const context = await harness(dnr, { storage });

  await context.updateDnrRules();
  storage.set('pblocker_whitelist', [{ domain: 'example.com', type: 'permanent' }]);
  const before = dnr.calls.length;
  await context.updateDnrRules();

  const made = dnr.calls.slice(before);
  assert.equal(made.length, 1, 'one batch, not the fallback again');
  assert.ok(!made[0].addRules.some(r => r.id === 10002), 'a remembered refusal is left out');
  assert.ok(appliedIds(dnr).length > acceptedIds(context).length, 'the whitelist allow rule went in');
});

test('rules the browser lost are put back', async () => {
  const dnr = safariLikeDnr();
  const context = await harness(dnr, { storage: new Map() });

  await context.updateDnrRules();
  dnr.applied.clear();
  await context.updateDnrRules();

  assert.deepEqual(appliedIds(dnr), acceptedIds(context));
});

test('a new extension version forgets the refusals and asks again', async () => {
  const dnr = safariLikeDnr();
  const storage = new Map();
  const context = await harness(dnr, { storage });

  await context.updateDnrRules();
  context.chrome.runtime.getManifest = () => ({ version: '9.9.9' });
  const before = dnr.calls.length;
  await context.updateDnrRules();

  const made = dnr.calls.slice(before);
  assert.ok(made[0].addRules.some(r => r.id === 10002),
    'a release can fix a refused rule, so its first update offers every rule again');
  assert.deepEqual(appliedIds(dnr), acceptedIds(context));
});
