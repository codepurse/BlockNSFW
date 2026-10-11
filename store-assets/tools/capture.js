// Photographs the real extension pages for the store screenshots.
//
// Loads a built extension into headless Chrome with a throwaway profile,
// fills it with a believable month (blocks, own words, a voice note, the
// Supporter history), and saves each page the store images show as a 2x PNG
// in store-assets/captures/. render.js then sets those captures as plates.
//
// Usage:
//   node store-assets/tools/capture.js <chrome.exe> <dist/chrome> <code-file> [only]
// <code-file> holds a sandbox Supporter code (name<TAB>code). It is written
// into the throwaway profile as an already-checked plan, so no browser place
// on the plan is used up.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [exe, extDirArg, codeFile, only] = process.argv.slice(2);
if (!exe || !extDirArg || !codeFile) {
  console.error('usage: node capture.js <chrome.exe> <dist/chrome> <code-file> [only]');
  process.exit(2);
}
const extDir = path.resolve(extDirArg);
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'captures');
const CODE = fs.readFileSync(codeFile, 'utf8').trim().split('\t').pop();
const SEED = fs.readFileSync(path.join(ROOT, '.verify', 'seed-test-history.js'), 'utf8');
const profileDir = path.join(os.tmpdir(), 'bn-store-shots');
fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = spawn(exe, [
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-sync', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

const toBrowser = browser.stdio[3];
const fromBrowser = browser.stdio[4];
let buffer = '';
let nextId = 1;
const pending = new Map();
const errors = [];
fromBrowser.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  toBrowser.write(JSON.stringify(payload) + '\0');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, 30000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  return { targetId, sessionId };
}
async function size(t, width, height, dpr) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false }, t.sessionId);
}
async function go(t, url, ms) {
  await send('Target.activateTarget', { targetId: t.targetId });
  await send('Page.navigate', { url: 'about:blank' }, t.sessionId);
  await wait(200);
  await send('Page.navigate', { url }, t.sessionId);
  await wait(ms);
}
async function run(t, expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, t.sessionId);
  if (res.exceptionDetails) throw new Error('evaluate: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  return res.result.value;
}
// The whole viewport, or one element's box (plus `pad`), at the tab's scale.
async function snap(t, file, selector, pad = 0) {
  let clip;
  if (selector) {
    const r = await run(t, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.max(0, b.x - ${pad}), y: Math.max(0, b.y - ${pad}) + scrollY, width: b.width + ${pad * 2}, height: b.height + ${pad * 2} }; })()`);
    if (!r) throw new Error(`${file}: no ${selector}`);
    clip = { ...r, scale: 1 };
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) }, t.sessionId);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  console.log('  saved', file);
}

// A short tone as a WAV, so the voice line has a real sound behind it.
const TONE = (() => {
  const rate = 8000, seconds = 38, n = rate * seconds;
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(128 + 40 * Math.sin((2 * Math.PI * 220 * i) / rate));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]).toString('base64');
})();

const SEED_SHOTS = `(async () => {
  const day = 864e5, now = Date.now();
  const iso = (n) => new Date(now - n * day).toISOString().slice(0, 10);
  const history = {};
  const per = [31, 18, 22, 9, 14, 27, 12, 8, 19, 11, 6, 15, 10, 7, 13, 5, 9, 12, 4, 8, 6, 11, 3, 7, 5, 9, 4, 6, 8, 23];
  per.forEach((n, i) => { history[iso(per.length - 1 - i)] = n; });
  const code = ${JSON.stringify(CODE)};
  const plan = Supporter.kindOf(code) === 'store'
    ? { kind: 'store', code, since: now - 41 * day, checkedAt: now, activationId: 'store-shots', limit: 3 }
    : { kind: 'signed', code, since: now - 41 * day };
  await chrome.storage.local.set({
    pblocker_supporter: plan,
    pblocker_stats: { blockedCount: 1284, websiteBlockedCount: 412, imageBlockedCount: 655, aiImageBlockedCount: 96, searchResultBlockedCount: 121, videoBlockedCount: 0, iframeBlockedCount: 0 },
    pblocker_daily_stats: { date: new Date().toDateString(), blockedToday: 23, websiteBlocked: 4, imageBlocked: 15, imageAiBlocked: 2, searchResultBlocked: 2, videoBlocked: 0, iframeBlocked: 0, socialPostBlocked: 0 },
    pblocker_daily_history: history,
    pblocker_streak_start: now - 41 * day,
    pblocker_first_seen: now - 64 * day,
    pblocker_own_words: {
      plan: 'Stand up. Get a glass of water. Walk to the end of the street and back.',
      note: 'You were tired, not weak. Ten minutes from now you will be glad you closed this tab.',
      person: { name: 'Sam', phone: '' }
    },
    pblocker_update_dismissed: '9.9.9'
  });
  const bytes = Uint8Array.from(atob(${JSON.stringify(TONE)}), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/wav' });
  await SoundStore.put(blob);
  await chrome.storage.local.set({ pblocker_moment_voice: { store: 'idb', type: 'audio/wav', size: blob.size, at: now - 9 * day, ms: 38000, auto: false } });
  return true;
})()`;

// A pact with a one-day wait, and SafeSearch asked off, so Security shows a
// change waiting out its cool-down.
async function makePact(t, base) {
  const modal = `[...document.querySelectorAll('.modal-overlay')].pop()`;
  await size(t, 1000, 900, 1);
  await go(t, base + 'options.html#security', 2200);
  await run(t, `window.BlockNSFWSettings.reveal(document.getElementById('pact-group')); document.getElementById('pact-start').click(); 1`);
  await wait(600);
  await run(t, `(() => { const m = ${modal}; const r = [...m.querySelectorAll('input[name="pact-delay-choice"]')]; (r.find((i) => i.value === '86400000') || r[r.length - 1]).click(); m.querySelector('.modal-button-primary').click(); return 1; })()`);
  await wait(900);
  await run(t, `window.BlockNSFWSettings.reveal(document.getElementById('safe-search-enabled')); document.getElementById('safe-search-enabled').click(); 1`);
  await wait(700);
  await run(t, `${modal}.querySelector('.modal-button-primary').click(); 1`);
  await wait(6000);
  const q = await run(t, `chrome.storage.local.get(['pblocker_pact', 'pblocker_pact_queue']).then((s) => ({ pact: !!(s.pblocker_pact && s.pblocker_pact.active), delay: s.pblocker_pact && s.pblocker_pact.delayMs, queued: (s.pblocker_pact_queue || []).length }))`);
  if (!q.pact || !q.queued) throw new Error('the pact setup did not take: ' + JSON.stringify(q));
}

const SHOTS = [
  // name, url (relative to the extension), viewport, scale, wait, element
  { name: 'blocked', url: 'blocked.html?url=' + encodeURIComponent('https://www.example-adult.test/video/4471') + '&reason=default_blocklist', w: 680, h: 860, dpr: 2, ms: 2600 },
  { name: 'popup', url: 'popup.html', w: 360, h: 640, dpr: 2, ms: 2600, prep: 'document.activeElement && document.activeElement.blur()' },
  { name: 'gateway', url: 'gateway.html?url=' + encodeURIComponent('https://www.reddit.com/') + '&key=reddit', w: 760, h: 860, dpr: 2, ms: 2600 },
  { name: 'security', url: 'options.html#security', w: 640, h: 1400, dpr: 2, ms: 2600, setup: makePact },
  { name: 'month', url: 'month.html', w: 1000, h: 860, dpr: 2, ms: 2800 }
];

(async () => {
  try {
    const { id } = await send('Extensions.loadUnpacked', { path: extDir });
    await wait(2500);
    const base = `chrome-extension://${id}/`;
    const t = await tab();
    await size(t, 1180, 900, 1);
    await go(t, base + 'options.html', 2200);
    await run(t, SEED);
    await wait(500);
    await run(t, SEED_SHOTS);
    await wait(500);
    const sup = await run(t, `Promise.all([Supporter.status(chrome.storage.local), chrome.storage.local.get('pblocker_supporter')]).then(([s, r]) => ({ s, kind: Supporter.kindOf ? Supporter.kindOf(r.pblocker_supporter.code) : '?', rec: Object.keys(r.pblocker_supporter || {}) }))`);
    if (!sup.s.supporter) throw new Error('the profile is not a supporter: ' + JSON.stringify(sup));
    for (const s of SHOTS) {
      if (only && !only.split(',').includes(s.name)) continue;
      if (s.setup) await s.setup(t, base);
      await size(t, s.w, s.h, s.dpr);
      await go(t, base + s.url, s.ms);
      if (s.prep) await run(t, s.prep);
      await snap(t, s.name + '.png', s.el, s.pad || 0);
    }
    if (errors.length) console.log('page errors:\n  ' + errors.slice(0, 8).join('\n  '));
  } catch (e) {
    console.log('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    try { browser.kill(); } catch (_) {}
    setTimeout(() => process.exit(), 500);
  }
})();
