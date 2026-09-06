#!/usr/bin/env node
//
// Count the storage and IPC work the background does for a given number of
// blocked elements, for two revisions of background.js, and print the
// difference.
//
// Why this exists: the rendering benchmark measures frame timings, which drift
// ~35% between sessions on a working machine and need non-overlapping ranges
// before they mean anything. The number this prints does not drift at all. It
// is a count, not a timing, so it is the same on a busy laptop and on idle CI,
// and it measures the thing the users actually complained about — a burst of
// disk transactions per page.
//
// Usage:
//   node scripts/perf/count-storage-ops.mjs [--blocks N] [--baseline PATH]
//
//   --baseline PATH   a checkout (or git worktree) to compare against.
//                     Omit to report only the current tree.

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const { loadBackgroundContext } = require(join(repoRoot, 'tests/setup.js'));

function parseArgs(argv) {
  const options = { blocks: 150, baseline: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--blocks') options.blocks = Number(argv[++i]);
    else if (argv[i] === '--baseline') options.baseline = resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(options.blocks) || options.blocks <= 0) {
    throw new Error('--blocks must be a positive number');
  }
  return options;
}

// Drive `blocks` image-block notifications through one revision's real message
// listener and count what it asks the browser to do.
async function measure(sourcePath, blocks) {
  // The stub has no fetch, so startup logs a handful of expected failures for
  // the remote blocklist, whitelist and update check. None of them affect the
  // counts; silence them so the table is readable.
  const realLog = console.log, realWarn = console.warn, realError = console.error;
  console.log = console.warn = console.error = () => {};
  let context;
  try {
    context = loadBackgroundContext(sourcePath);
    // Let the module's own startup settle so its writes are not counted as work
    // caused by blocking.
    await context.backgroundInitializationPromise;
    await new Promise(done => setTimeout(done, 0));
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realError;
  }

  const counts = { reads: 0, writes: 0, badgeCalls: 0 };
  const disk = {};

  context.chrome.storage.local.get = (keys) => {
    counts.reads++;
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in disk) out[key] = disk[key];
    return Promise.resolve(out);
  };
  context.chrome.storage.local.set = (items) => {
    counts.writes++;
    Object.assign(disk, items);
    return Promise.resolve();
  };
  for (const name of ['getBadgeText', 'setBadgeText', 'setBadgeBackgroundColor']) {
    const original = context.chrome.action[name];
    context.chrome.action[name] = (...args) => { counts.badgeCalls++; return original(...args); };
  }

  const listener = context.chrome.runtime.onMessage.listeners[0];
  const sender = { tab: { id: 1 }, url: 'https://example.test/gallery' };
  const quiet = console.log; console.log = () => {};
  try {
    for (let i = 0; i < blocks; i++) {
      listener({ type: 'image_filtered', url: `https://cdn.example.test/img-${i}.jpg` },
               sender, () => {});
    }
    // Settle both the batched flush and anything the old path left in flight.
    await new Promise(done => setTimeout(done, 50));
    if (typeof context.flushBlockEvents === 'function') await context.flushBlockEvents();
    if (typeof context.flushBadges === 'function') await context.flushBadges();
    await new Promise(done => setTimeout(done, 50));
  } finally {
    console.log = quiet;
  }

  return counts;
}

function row(label, counts, blocks) {
  const total = counts.reads + counts.writes + counts.badgeCalls;
  return [
    label.padEnd(22),
    String(counts.reads).padStart(7),
    String(counts.writes).padStart(7),
    String(counts.badgeCalls).padStart(7),
    String(total).padStart(8),
    (total / blocks).toFixed(1).padStart(11)
  ].join('');
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node scripts/perf/count-storage-ops.mjs [--blocks N] [--baseline PATH]');
  process.exit(0);
}

console.log(`\nBackground work for ${options.blocks} blocked images on one page\n`);
console.log(['revision'.padEnd(22), 'reads'.padStart(7), 'writes'.padStart(7),
             'badge'.padStart(7), 'total'.padStart(8), 'per block'.padStart(11)].join(''));
console.log('-'.repeat(62));

const current = await measure(join(repoRoot, 'background.js'), options.blocks);
let baseline = null;
if (options.baseline) {
  baseline = await measure(join(options.baseline, 'background.js'), options.blocks);
  console.log(row('baseline', baseline, options.blocks));
}
console.log(row(options.baseline ? 'current' : 'current tree', current, options.blocks));

if (baseline) {
  const b = baseline.reads + baseline.writes + baseline.badgeCalls;
  const c = current.reads + current.writes + current.badgeCalls;
  console.log('-'.repeat(62));
  const factor = c > 0 ? (b / c) : Infinity;
  console.log(`\n  ${b} operations -> ${c}, a ${factor.toFixed(1)}x reduction`);
  console.log('  Every one of those is an IndexedDB transaction on Firefox, on the');
  console.log('  same disk the page is loading from.\n');
}
