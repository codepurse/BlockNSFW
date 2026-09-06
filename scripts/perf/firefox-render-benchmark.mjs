#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const fixturePath = join(scriptDir, 'fixtures/render-stress.html');

function parseArgs(argv) {
  const options = {
    runs: 5,
    durationMs: 4000,
    initialCards: 800,
    mutationsPerFrame: 12,
    maxCards: 1200,
    warmupMs: 3000,
    variant: 'both',
    extensionMode: 'full',
    firefox: process.env.FIREFOX_BIN || 'firefox',
    extensionSource: repoRoot,
    output: '',
    allowForcedPolicy: false,
    blockableEvery: 8
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${argument}`);
      return value;
    };
    if (argument === '--runs') options.runs = Number(next());
    else if (argument === '--duration-ms') options.durationMs = Number(next());
    else if (argument === '--initial-cards') options.initialCards = Number(next());
    else if (argument === '--mutations-per-frame') options.mutationsPerFrame = Number(next());
    else if (argument === '--max-cards') options.maxCards = Number(next());
    else if (argument === '--warmup-ms') options.warmupMs = Number(next());
    else if (argument === '--variant') options.variant = next();
    else if (argument === '--extension-mode') options.extensionMode = next();
    else if (argument === '--firefox') options.firefox = next();
    else if (argument === '--extension-source') options.extensionSource = resolve(next());
    else if (argument === '--output') options.output = resolve(next());
    else if (argument === '--allow-forced-policy') options.allowForcedPolicy = true;
    else if (argument === '--blockable-every') options.blockableEvery = Number(next());
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const key of ['runs', 'durationMs', 'initialCards', 'mutationsPerFrame', 'maxCards']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be positive`);
  }
  if (!Number.isFinite(options.warmupMs) || options.warmupMs < 0) {
    throw new Error('--warmup-ms must be zero or positive');
  }
  if (!['both', 'off', 'on'].includes(options.variant)) {
    throw new Error('--variant must be both, off, or on');
  }
  if (!['full', 'background-only', 'content-only'].includes(options.extensionMode)) {
    throw new Error('--extension-mode must be full, background-only, or content-only');
  }
  return options;
}

function usage() {
  return `Usage: npm run perf:firefox -- [options]

Runs the same deterministic rendering workload in fresh Firefox profiles with
the extension absent and installed, then reports frame-time deltas.

Options:
  --runs N                    samples per variant (default: 5)
  --duration-ms N             active workload per sample (default: 4000)
  --initial-cards N           feed size before measurement (default: 800)
  --mutations-per-frame N     cards added and updated each frame (default: 12)
  --max-cards N               virtualized feed cap (default: 1200)
  --warmup-ms N               browser/install settling time (default: 3000)
  --variant both|off|on       variants to run (default: both)
  --extension-mode MODE       full, background-only, or content-only diagnostic
  --firefox PATH              Firefox executable (or FIREFOX_BIN)
  --extension-source PATH     extension source tree (default: repository root)
  --output PATH               also write the full JSON report
  --blockable-every N         every Nth feed card carries content the extension
                              should block; 0 blocks nothing (default: 8)
  --allow-forced-policy       run even if an enterprise policy force-installs an
                              extension into every profile (numbers are then not
                              a clean off-vs-on comparison)
`;
}

// A force-install enterprise policy applies to EVERY profile on the machine,
// including the throwaway ones this harness creates — so the "off" variant
// silently runs the policy's copy of the extension and the measured delta
// becomes "released build vs working tree", not "absent vs present".
// BlockNSFW's own guard installs exactly such a policy, so a developer running
// this on their own machine is the likely case, not the exotic one.
async function detectForcedExtensionPolicy(firefoxPath) {
  const candidates = [];
  try {
    const installDir = dirname(firefoxPath);
    candidates.push(join(installDir, 'distribution', 'policies.json'));
  } catch (_) {}
  if (process.platform === 'win32') {
    for (const base of ['C:/Program Files/Mozilla Firefox', 'C:/Program Files (x86)/Mozilla Firefox']) {
      candidates.push(join(base, 'distribution', 'policies.json'));
    }
  } else {
    candidates.push('/etc/firefox/policies/policies.json');
    candidates.push('/usr/lib/firefox/distribution/policies.json');
  }
  for (const candidate of candidates) {
    try {
      const policy = JSON.parse(await readFile(candidate, 'utf8'));
      const settings = policy?.policies?.ExtensionSettings || {};
      const forced = Object.entries(settings)
        .filter(([, value]) => value && value.installation_mode === 'force_installed')
        .map(([id]) => id);
      if (forced.length > 0) return { path: candidate, forced };
    } catch (_) {}
  }
  return null;
}

async function unusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function startFixtureServer() {
  const fixture = await readFile(fixturePath);
  const server = createHttpServer((request, response) => {
    // Firefox resolves BENCH_HOST to loopback via network.dns.localDomains, so
    // requests arrive here in ordinary origin form.
    if (request.url.endsWith('/favicon.ico')) {
      response.writeHead(204).end();
      return;
    }
    if (request.url.endsWith('.jpg') || request.url.endsWith('.png')) {
      // 1x1 GIF body is fine; only the URL matters to the extension's filters.
      response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      response.end(TRANSPARENT_GIF);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': fixture.length
    });
    response.end(fixture);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  return {
    server,
    port,
    // NOT 127.0.0.1. content.js treats loopback, private ranges and the
    // reserved TLDs (.invalid/.test/.local/.example) as a local page, and
    // isLocalPage() disables checkPageMetadata, checkPageBodyText and the AI
    // text scan outright. Serving the fixture from 127.0.0.1 therefore measured
    // an extension with three of its scans switched off. network.dns.localDomains
    // maps this name to loopback inside Firefox, so nothing leaves the machine.
    url: `http://${BENCH_HOST}:${port}/benchmark`
  };
}

// Must not contain 'porn', 'xxx', 'nsfw' or 'hentai' as a SUBSTRING anywhere:
// isLikelyAdultHostEarly() matches with a bare String.includes(), so a host like
// "perf-fixture-blocknsfw.net" is redirected to blocked.html before the page
// script ever runs (reason=instant_keyword_match). Naming the fixture after the
// product is therefore enough to break the benchmark.
const BENCH_HOST = 'feed.render-bench-fixture.net';
// A separate registrable domain for the blockable thumbnails. isKnownSafeImageHost()
// allows any image on the page's own host (or a sub/parent of it) unconditionally,
// so first-party images can never be blocked and a same-origin fixture reports
// 0 blocked no matter what its paths say.
const BENCH_CDN_HOST = 'cdn.media-bench-fixture.net';
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');

const runtimeFolders = ['icons', 'shared', 'vendor', 'nsfwjs'];
// Files the manifest can reference. Kept as a superset across revisions so the
// harness can stage an older tree through --extension-source: a name that a
// given revision does not carry is skipped rather than failing the run.
// `classify.worker.js` is the example — it was removed in 85075eb, which broke
// every run from that commit onward until this was made tolerant.
const runtimeFiles = [
  'background.js', 'content.js', 'ai-image-blocker-core.js',
  'ai-image-blocker.js', 'classify.worker.js', 'popup.html', 'popup.js',
  'options.html', 'options.js', 'blocked.html', 'blocked.js',
  'onboarding.html', 'onboarding.js', 'audit.html', 'audit.js', 'stats.html',
  'stats.js', 'community.html', 'community.js', 'appwrite-client.js',
  'offscreen.html', 'offscreen.js',
  'blocklist.json', 'text-model.json', 'LICENSE'
];

// Every path the manifest actually needs. A missing one of these is a real
// staging failure, not an optional extra, so it must still throw.
const requiredRuntimeFiles = new Set(['background.js', 'content.js', 'blocklist.json']);

async function stageFirefoxExtension(root, mode, sourceRoot) {
  const destination = join(root, 'extension');
  await mkdir(destination, { recursive: true });
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.firefox.json'), 'utf8'));
  if (mode === 'background-only') delete manifest.content_scripts;
  if (mode === 'content-only') delete manifest.background;
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const folder of runtimeFolders) {
    try {
      await cp(join(sourceRoot, folder), join(destination, folder), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const skipped = [];
  for (const file of runtimeFiles) {
    try {
      await cp(join(sourceRoot, file), join(destination, file));
    } catch (error) {
      if (error.code !== 'ENOENT' || requiredRuntimeFiles.has(file)) throw error;
      skipped.push(file);
    }
  }
  if (skipped.length > 0) {
    console.log(`  (not present in this tree, skipped: ${skipped.join(', ')})`);
  }
  return destination;
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolveExit => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

// Xvfb only exists to give Firefox an X display, so it is Linux-only. On
// Windows and macOS we use Firefox's own -headless instead, which needs no
// display server at all. Keeping Xvfb on Linux preserves the exact environment
// the recorded baselines in README.md were measured in.
const NEEDS_XVFB = process.platform === 'linux';

async function startXvfb(display) {
  if (!NEEDS_XVFB) return null;
  const child = spawn('Xvfb', [display, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolveStart, reject) => {
    const timer = setTimeout(resolveStart, 250);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited with ${code}: ${stderr.trim()}`));
    });
  });
  return child;
}

async function connectWebSocket(url, timeoutMs = 15000) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolveSocket(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to ${url}`));
    }, { once: true });
  });
}

async function connectBiDi(port, firefoxChild) {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    if (firefoxChild.exitCode !== null) {
      throw new Error(`Firefox exited before BiDi connected (code ${firefoxChild.exitCode})`);
    }
    try {
      return new BiDi(await connectWebSocket(`ws://127.0.0.1:${port}/session`, 1000));
    } catch (error) {
      lastError = error;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
  throw lastError || new Error('Firefox BiDi endpoint did not become ready');
}

class BiDi {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolveCommand, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === 'error') {
        reject(new Error(`${message.error}: ${message.message}`));
      } else {
        resolveCommand(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('BiDi connection closed'));
      this.pending.clear();
    });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function startFirefox(options, root, display, remotePort) {
  const profile = join(root, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("app.normandy.first_run", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    // Resolve the fixture's hostname to loopback inside Firefox itself. This is
    // what lets the page be served from a name the extension does not classify
    // as local, without DNS and without a proxy — no request leaves the machine.
    `user_pref("network.dns.localDomains", "${BENCH_HOST},${BENCH_CDN_HOST}");`,
    'user_pref("network.proxy.type", 0);',
    // The workload builds its feed in one synchronous burst and now issues real
    // image requests. Firefox's slow-script watchdog would terminate that mid
    // run and return null through BiDi, so the sample must not be interrupted.
    'user_pref("dom.max_script_run_time", 0);',
    'user_pref("dom.max_chrome_script_run_time", 0);',
    // A single Node server answers page and images; raise the per-host cap so
    // image loads are not serialised into the measurement window.
    'user_pref("network.http.max-persistent-connections-per-server", 24);',
    // The fixture is plain HTTP. HTTPS-First would upgrade the navigation, ask
    // the proxy for CONNECT, fail, and land the tab on about:neterror — which
    // surfaces as "cannot forward command to a privileged browsing context".
    'user_pref("dom.security.https_first", false);',
    'user_pref("dom.security.https_only_mode", false);',
    'user_pref("network.stricttransportsecurity.preloadlist", false);',
    // No captive-portal / safebrowsing traffic competing for the proxy.
    'user_pref("network.captive-portal-service.enabled", false);',
    'user_pref("browser.safebrowsing.malware.enabled", false);',
    'user_pref("browser.safebrowsing.phishing.enabled", false);'
  ].join('\n'));
  const child = spawn(options.firefox, [
    '--no-remote', '--profile', profile,
    // Without an X display, drive Firefox's own headless mode. rAF still runs
    // and frame timings are still reported, so the collected metrics are the
    // same ones the Xvfb path produces.
    ...(NEEDS_XVFB ? [] : ['-headless']),
    '--remote-debugging-port', String(remotePort),
    '--width', '1440', '--height', '1000', 'about:blank'
  ], {
    env: {
      ...process.env,
      ...(NEEDS_XVFB ? { DISPLAY: display } : {}),
      MOZ_CRASHREPORTER_DISABLE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (stderr.length > 10000) stderr = stderr.slice(-10000);
  });
  child.once('error', error => { child.launchError = error; });
  return { child, profile, getStderr: () => stderr };
}

function remoteValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.type === 'null') return null;
  if (value.type === 'undefined') return undefined;
  if (value.type === 'array') return (value.value || []).map(remoteValue);
  if (value.type === 'object') {
    return Object.fromEntries((value.value || []).map(([key, entry]) => [key, remoteValue(entry)]));
  }
  if (value.type === 'number' && typeof value.value === 'string') {
    if (value.value === 'NaN') return Number.NaN;
    if (value.value === 'Infinity') return Number.POSITIVE_INFINITY;
    if (value.value === '-Infinity') return Number.NEGATIVE_INFINITY;
    if (value.value === '-0') return -0;
  }
  if ('value' in value) return value.value;
  return undefined;
}

async function evaluate(bidi, context, expression) {
  const result = await bidi.command('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
    serializationOptions: { maxObjectDepth: 8 }
  });
  if (result.type === 'exception') {
    throw new Error(result.exceptionDetails?.text || 'Evaluation failed');
  }
  return remoteValue(result.result);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  const keys = [
    'fps', 'frameMeanMs', 'frameP95Ms', 'frameP99Ms', 'frameMaxMs',
    'framesOver20Ms', 'framesOver50Ms', 'mutationMeanMs', 'mutationP95Ms',
    'mutationMaxMs', 'domContentLoadedMs', 'loadMs',
    'blockedElements', 'blockedPlaceholders', 'observedImages'
  ];
  return Object.fromEntries(keys.map(key => [key, median(samples.map(sample => sample[key]))]));
}

async function runVariant(name, options, fixtureUrl) {
  const root = await mkdtemp(join(tmpdir(), `blocknsfw-firefox-${name}-`));
  const displayNumber = 100 + Math.floor(Math.random() * 500);
  const display = `:${displayNumber}`;
  const remotePort = await unusedPort();
  let xvfb;
  let firefox;
  let bidi;
  try {
    if (name === 'on') {
      await stageFirefoxExtension(root, options.extensionMode, options.extensionSource);
    }
    xvfb = await startXvfb(display);
    firefox = await startFirefox(options, root, display, remotePort);
    bidi = await connectBiDi(remotePort, firefox.child);
    const session = await bidi.command('session.new', {
      capabilities: { alwaysMatch: { acceptInsecureCerts: true } }
    });
    if (name === 'on') {
      await bidi.command('webExtension.install', {
        extensionData: { type: 'path', path: join(root, 'extension') }
      });
    }

    // Exclude one-time add-on verification/background initialization from the
    // steady-state rendering sample and allow fresh-install onboarding to open
    // before we create the dedicated benchmark tab.
    if (options.warmupMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.warmupMs));
    }

    // A fresh BlockNSFW install opens onboarding and focuses it. Measuring the
    // original about:blank tab after that would benchmark Firefox's background
    // tab rAF throttling (1–4 second frames), not extension rendering cost.
    const created = await bidi.command('browsingContext.create', {
      type: 'tab',
      background: false
    });
    const context = created.context;
    await bidi.command('browsingContext.activate', { context });
    const tree = await bidi.command('browsingContext.getTree', { maxDepth: 0 });
    for (const entry of tree.contexts) {
      if (entry.context !== context) {
        try { await bidi.command('browsingContext.close', { context: entry.context }); } catch {}
      }
    }
    const samples = [];
    for (let run = 0; run < options.runs; run++) {
      process.stdout.write(`  ${name} run ${run + 1}/${options.runs} ... `);
      await bidi.command('browsingContext.activate', { context });
      await bidi.command('browsingContext.navigate', {
        context,
        url: `${fixtureUrl}?variant=${name}&run=${run}&nonce=${Date.now()}` +
          `&cdn=${encodeURIComponent(BENCH_CDN_HOST)}&blockableEvery=${options.blockableEvery}`,
        wait: 'complete'
      });
      const expression = `window.runRenderBenchmark(${JSON.stringify({
        durationMs: options.durationMs,
        initialCards: options.initialCards,
        mutationsPerFrame: options.mutationsPerFrame,
        maxCards: options.maxCards
      })}).then(result => {
        const nav = performance.getEntriesByType('navigation')[0];
        result.domContentLoadedMs = nav ? nav.domContentLoadedEventEnd : 0;
        result.loadMs = nav ? nav.loadEventEnd : 0;
        return result;
      })`;
      let sample;
      try {
        sample = await evaluate(bidi, context, expression);
      } catch (error) {
        // The commonest cause is that the tab is no longer on the fixture: the
        // extension decided the page was adult content and redirected it. Say so
        // instead of reporting a bare "not a function".
        let where = '(unknown)';
        try {
          // getTree reports the URL even for a privileged context, which is what
          // the tab becomes when the extension redirects it to blocked.html.
          const tree = await bidi.command('browsingContext.getTree', {});
          const entry = (tree.contexts || []).find(item => item.context === context);
          where = entry ? entry.url : JSON.stringify(tree.contexts?.map(c => c.url));
        } catch (_) {}
        throw new Error(`${error.message} | tab is at ${where}`);
      }
      samples.push(sample);
      console.log(`${sample.fps.toFixed(1)} fps, p95 ${sample.frameP95Ms.toFixed(1)} ms, ${sample.framesOver20Ms} janky frames, ${sample.blockedElements} blocked`);
    }
    return {
      name,
      browserVersion: session.capabilities.browserVersion,
      samples,
      median: summarize(samples)
    };
  } catch (error) {
    const details = firefox?.getStderr().trim();
    if (details) error.message += `\nFirefox stderr:\n${details}`;
    throw error;
  } finally {
    try { bidi?.close(); } catch {}
    if (firefox?.child && firefox.child.exitCode === null) {
      firefox.child.kill('SIGTERM');
      await waitForExit(firefox.child);
    }
    if (xvfb && xvfb.exitCode === null) {
      xvfb.kill('SIGTERM');
      await waitForExit(xvfb);
    }
    await removeProfileTree(root);
  }
}

// Windows keeps a lock on the profile's sqlite files for a moment after the
// process exits, so an immediate recursive unlink fails with EBUSY. Retry
// briefly, and never let a leftover temp directory fail a completed run — the
// measurement is the artifact, not the scratch profile.
async function removeProfileTree(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 9) {
        console.warn(`  (could not remove temp profile ${root}: ${error.code || error.message})`);
        return;
      }
      await new Promise(done => setTimeout(done, 300));
    }
  }
}

function deltaPercent(onValue, offValue) {
  if (!offValue) return 0;
  return (onValue - offValue) * 100 / offValue;
}

function printComparison(results) {
  const off = results.find(result => result.name === 'off');
  const on = results.find(result => result.name === 'on');
  if (!off || !on) return;
  console.log('\nMedian extension impact (on vs off)');
  console.log(`  FPS:             ${off.median.fps.toFixed(1)} -> ${on.median.fps.toFixed(1)} (${deltaPercent(on.median.fps, off.median.fps).toFixed(1)}%)`);
  console.log(`  frame p95:       ${off.median.frameP95Ms.toFixed(1)} -> ${on.median.frameP95Ms.toFixed(1)} ms (${deltaPercent(on.median.frameP95Ms, off.median.frameP95Ms).toFixed(1)}%)`);
  console.log(`  frames >20 ms:   ${off.median.framesOver20Ms.toFixed(0)} -> ${on.median.framesOver20Ms.toFixed(0)}`);
  console.log(`  mutation p95:    ${off.median.mutationP95Ms.toFixed(1)} -> ${on.median.mutationP95Ms.toFixed(1)} ms (${deltaPercent(on.median.mutationP95Ms, off.median.mutationP95Ms).toFixed(1)}%)`);
  console.log(`  page load:       ${off.median.loadMs.toFixed(1)} -> ${on.median.loadMs.toFixed(1)} ms (${deltaPercent(on.median.loadMs, off.median.loadMs).toFixed(1)}%)`);
  console.log(`  blocked elements:${off.median.blockedElements.toFixed(0)} -> ${on.median.blockedElements.toFixed(0)}`);
  if (!on.median.blockedElements) {
    console.log('');
    console.log('  WARNING: the extension blocked nothing in this run. The block path');
    console.log('  (hideElement -> notifyBackground -> background storage writes) was never');
    console.log('  exercised, so these numbers say nothing about it.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const policy = await detectForcedExtensionPolicy(options.firefox);
  if (policy && !options.allowForcedPolicy) {
    throw new Error([
      `Enterprise policy at ${policy.path} force-installs ${policy.forced.join(', ')}.`,
      'That policy applies to this harness’s throwaway profiles too, so the "off"',
      'variant would run the policy’s copy of the extension and every delta would',
      'be meaningless. Run on a machine or CI image without the policy, or pass',
      '--allow-forced-policy if you accept the numbers are not a clean off-vs-on.'
    ].join('\n'));
  }
  const fixture = await startFixtureServer();
  const variants = options.variant === 'both' ? ['off', 'on'] : [options.variant];
  const report = {
    generatedAt: new Date().toISOString(),
    config: { ...options, output: options.output || undefined },
    results: []
  };
  try {
    for (const variant of variants) {
      console.log(`\nFirefox benchmark: extension ${variant}`);
      report.results.push(await runVariant(variant, options, fixture.url));
    }
  } finally {
    await new Promise(resolveClose => fixture.server.close(resolveClose));
  }
  printComparison(report.results);
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nFull report: ${options.output}`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
