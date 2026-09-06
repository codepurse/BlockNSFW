#!/usr/bin/env node
//
// Count the storage and IPC work the background does, for two revisions of
// background.js, and print the difference.
//
// Why this exists: the rendering benchmark measures frame timings, which drift
// ~35% between sessions on a working machine and need non-overlapping ranges
// before they mean anything. The numbers this prints do not drift at all. They
// are counts, not timings, so they are the same on a busy laptop and on idle
// CI, and they measure the thing the users actually complained about — bursts
// of disk transactions.
//
// Two phases:
//
//   blocks    what one page costs while it is blocking things. Drives N
//             image_filtered notifications through the real message listener.
//
//   startup   what one background wake-up costs. Both browsers suspend an idle
//             MV3 background, so this runs on essentially every navigation
//             after a pause — and a settings write during it is broadcast to
//             every content script in every open tab.
//
// Usage:
//   node scripts/perf/count-storage-ops.mjs [--phase blocks|startup|both]
//                                           [--blocks N] [--baseline PATH]

import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const { loadBackgroundContext } = require(join(repoRoot, 'tests/setup.js'));

const SETTINGS_KEY = 'pblocker_settings';

function parseArgs(argv) {
  const options = { blocks: 150, baseline: '', phase: 'blocks' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--blocks') options.blocks = Number(argv[++i]);
    else if (argv[i] === '--baseline') options.baseline = resolve(argv[++i]);
    else if (argv[i] === '--phase') options.phase = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(options.blocks) || options.blocks <= 0) {
    throw new Error('--blocks must be a positive number');
  }
  if (!['blocks', 'startup', 'both'].includes(options.phase)) {
    throw new Error('--phase must be blocks, startup, or both');
  }
  return options;
}

// Silences console for the duration of `run`, awaiting it when it is async.
// The extension logs on every init and the stub has no network, so a run prints
// several screens of expected failures that bury the table.
async function silenced(run) {
  const log = console.log, warn = console.warn, error = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
}

// A storage.local stub over a plain object, so a "disk" can persist across two
// context loads and the second load behaves like a wake-up rather than a fresh
// install.
function instrumentStorage(context, disk, counts) {
  context.chrome.storage.local.get = (keys) => {
    counts.reads++;
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in disk) out[key] = disk[key];
    return Promise.resolve(out);
  };
  context.chrome.storage.local.set = (items) => {
    counts.writes++;
    for (const key of Object.keys(items)) {
      if (key === SETTINGS_KEY) counts.settingsWrites++;
    }
    Object.assign(disk, items);
    return Promise.resolve();
  };
  context.chrome.storage.local.remove = (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) delete disk[key];
    return Promise.resolve();
  };
}

function instrumentBadge(context, counts) {
  for (const name of ['getBadgeText', 'setBadgeText', 'setBadgeBackgroundColor']) {
    const original = context.chrome.action[name];
    context.chrome.action[name] = (...args) => { counts.badgeCalls++; return original(...args); };
  }
}

function emptyCounts() {
  return { reads: 0, writes: 0, badgeCalls: 0, settingsWrites: 0, bundledFetches: 0, bytesParsed: 0 };
}

// ---------------------------------------------------------------------------
// Phase: blocks
// ---------------------------------------------------------------------------
async function measureBlocks(sourcePath, blocks) {
  // Load and let init settle inside one silenced scope: loadBackgroundContext
  // is synchronous but the init it kicks off is not, so silencing only the call
  // lets the init's logging escape.
  const context = await silenced(async () => {
    const ctx = loadBackgroundContext(sourcePath);
    await ctx.backgroundInitializationPromise;
    await new Promise(done => setTimeout(done, 20));
    return ctx;
  });

  // Counting starts AFTER init, so this is the cost of blocking alone.
  const counts = emptyCounts();
  instrumentStorage(context, {}, counts);
  instrumentBadge(context, counts);

  const listener = context.chrome.runtime.onMessage.listeners[0];
  const sender = { tab: { id: 1 }, url: 'https://example.test/gallery' };
  await silenced(async () => {
    for (let i = 0; i < blocks; i++) {
      listener({ type: 'image_filtered', url: `https://cdn.example.test/img-${i}.jpg` },
               sender, () => {});
    }
    await new Promise(done => setTimeout(done, 50));
    if (typeof context.flushBlockEvents === 'function') await context.flushBlockEvents();
    if (typeof context.flushBadges === 'function') await context.flushBadges();
    await new Promise(done => setTimeout(done, 50));
  });

  return counts;
}

// ---------------------------------------------------------------------------
// Phase: startup
// ---------------------------------------------------------------------------
const BUNDLED_BLOCKLIST = readFileSync(join(repoRoot, 'blocklist.json'), 'utf8');

// Serves the packaged blocklist and refuses everything remote, which is what an
// offline wake-up looks like. Counts how often the 4.1 MB file is re-read: that
// is the difference H9 is about.
function makeFetch(counts) {
  return (url) => {
    const target = String(url);
    if (target.includes('blocklist.json')) {
      counts.bundledFetches++;
      counts.bytesParsed += BUNDLED_BLOCKLIST.length;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(JSON.parse(BUNDLED_BLOCKLIST)),
        text: () => Promise.resolve(BUNDLED_BLOCKLIST)
      });
    }
    return Promise.reject(new Error('offline'));
  };
}

// One background start against a given disk. Returns the counts for that start
// and leaves the disk in whatever state the revision put it in, so the caller
// can run a second start on top and observe a wake rather than an install.
async function measureOneStart(sourcePath, disk) {
  const counts = emptyCounts();
  // Let the module's own load-time init run to completion against the stock
  // stub FIRST. It is already in flight when loadBackgroundContext returns, so
  // instrumenting before it settles counts its writes as ours — which is how
  // this harness first reported a settings write on every wake that the
  // extension was not actually making.
  const context = await silenced(async () => {
    const ctx = loadBackgroundContext(sourcePath);
    await ctx.backgroundInitializationPromise;
    await new Promise(done => setTimeout(done, 20));
    return ctx;
  });

  instrumentStorage(context, disk, counts);
  instrumentBadge(context, counts);
  context.fetch = makeFetch(counts);
  try { context.self.fetch = context.fetch; } catch (_) {}

  await silenced(async () => {
    // Drop the in-memory caches that load-time init populated, so the measured
    // run genuinely re-derives its state from `disk` the way a fresh background
    // process would. These are top-level `let`s, not context properties.
    // All top-level `let`s, so they are lexical bindings rather than properties
    // of the context — assigning context.backgroundInitializationPromise leaves
    // the module's own binding untouched and initializeBackground() returns the
    // already-resolved promise without doing anything.
    vm.runInContext(
      'backgroundInitializationPromise = null;' +
      'blocklistMeta = null; defaultBlocklist = []; defaultBlocklistSet = new Set();',
      context
    );
    await context.initializeBackground();
    await new Promise(done => setTimeout(done, 100));
  });

  return counts;
}

async function measureStartup(sourcePath) {
  const disk = {};
  const cold = await measureOneStart(sourcePath, disk);   // fresh install
  const warm = await measureOneStart(sourcePath, disk);   // a wake-up
  return { cold, warm };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = (cells) => cells
    .map((c, i) => i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))
    .join('  ');
  console.log('  ' + line(headers));
  console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log('  ' + line(r));
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node scripts/perf/count-storage-ops.mjs ' +
              '[--phase blocks|startup|both] [--blocks N] [--baseline PATH]');
  process.exit(0);
}

const total = c => c.reads + c.writes + c.badgeCalls;
const mb = n => (n / 1048576).toFixed(1) + ' MB';

if (options.phase === 'blocks' || options.phase === 'both') {
  console.log(`\nPHASE: blocks — background work for ${options.blocks} blocked images on one page\n`);
  const rows = [];
  if (options.baseline) {
    const b = await measureBlocks(join(options.baseline, 'background.js'), options.blocks);
    rows.push(['baseline', b.reads, b.writes, b.badgeCalls, total(b), (total(b) / options.blocks).toFixed(2)]);
  }
  const c = await measureBlocks(join(repoRoot, 'background.js'), options.blocks);
  rows.push(['current', c.reads, c.writes, c.badgeCalls, total(c), (total(c) / options.blocks).toFixed(2)]);
  table(['revision', 'reads', 'writes', 'badge', 'total', 'per block'], rows);
  if (rows.length === 2) {
    console.log(`\n  ${rows[0][4]} operations -> ${rows[1][4]}. The old cost scales with how`);
    console.log('  much the page blocks; the new one does not.\n');
  }
}

if (options.phase === 'startup' || options.phase === 'both') {
  console.log('\nPHASE: startup — what one background start costs\n');
  const rows = [];
  if (options.baseline) {
    const b = await measureStartup(join(options.baseline, 'background.js'));
    rows.push(['baseline  install', b.cold.reads, b.cold.writes, b.cold.settingsWrites,
               b.cold.bundledFetches, mb(b.cold.bytesParsed)]);
    rows.push(['baseline  wake', b.warm.reads, b.warm.writes, b.warm.settingsWrites,
               b.warm.bundledFetches, mb(b.warm.bytesParsed)]);
  }
  const c = await measureStartup(join(repoRoot, 'background.js'));
  rows.push(['current   install', c.cold.reads, c.cold.writes, c.cold.settingsWrites,
             c.cold.bundledFetches, mb(c.cold.bytesParsed)]);
  rows.push(['current   wake', c.warm.reads, c.warm.writes, c.warm.settingsWrites,
             c.warm.bundledFetches, mb(c.warm.bytesParsed)]);
  table(['revision', 'reads', 'writes', 'settings writes', 'blocklist.json reads', 'parsed'], rows);
  console.log('\n  "settings writes" on a wake is C2: storage.local.set fires storage.onChanged');
  console.log('  whether or not the value changed, and that event makes every content script');
  console.log('  in every open tab re-run a full processContent(). One wake, N tabs.');
  console.log('\n  "blocklist.json reads" on a wake is H9: a chunk cache that was never');
  console.log('  populated sends every wake back through the whole packaged file.\n');
}
