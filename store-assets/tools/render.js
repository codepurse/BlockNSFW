// Renders every store image from store-assets/src/frames.html, at the exact
// size each store asks for, into store-assets/chrome, firefox and edge, and
// the extension's own icons into icons/.
//
// Usage: node store-assets/tools/render.js <chrome.exe>
// Then:  python store-assets/tools/flatten.py   (screenshots and tiles to
//        24-bit PNG: the Chrome Web Store refuses an alpha channel)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const exe = process.argv[2];
if (!exe) { console.error('usage: node render.js <chrome.exe>'); process.exit(2); }
const ASSETS = path.join(__dirname, '..');
const ROOT = path.join(ASSETS, '..');
const PAGE = pathToFileURL(path.join(ASSETS, 'src', 'frames.html')).href;

// frame id -> files it becomes (relative to the repository root).
const OUTPUTS = {
  'shot-1': ['store-assets/chrome/screenshot-1.png', 'store-assets/firefox/screenshot-1.png', 'store-assets/edge/screenshot-1.png'],
  'shot-2': ['store-assets/chrome/screenshot-2.png', 'store-assets/firefox/screenshot-2.png', 'store-assets/edge/screenshot-2.png'],
  'shot-3': ['store-assets/chrome/screenshot-3.png', 'store-assets/firefox/screenshot-3.png', 'store-assets/edge/screenshot-3.png'],
  'shot-4': ['store-assets/chrome/screenshot-4.png', 'store-assets/firefox/screenshot-4.png', 'store-assets/edge/screenshot-4.png'],
  'shot-5': ['store-assets/chrome/screenshot-5.png', 'store-assets/firefox/screenshot-5.png', 'store-assets/edge/screenshot-5.png'],
  'promo-small': ['store-assets/chrome/promo-small-440x280.png', 'store-assets/edge/promo-small-440x280.png'],
  'marquee': ['store-assets/chrome/promo-marquee-1400x560.png', 'store-assets/edge/promo-large-1400x560.png'],
  'icon-16': ['icons/icon-16.png'],
  'icon-32': ['icons/icon-32.png'],
  'icon-48': ['icons/icon-48.png'],
  'icon-64': ['icons/icon-64.png', 'store-assets/firefox/icon-64.png'],
  'icon-128': ['icons/icon-128.png', 'store-assets/chrome/icon-128.png', 'store-assets/firefox/icon-128.png'],
  'logo-300': ['store-assets/edge/logo-300x300.png']
};
const SIZES = {
  'shot-1': [1280, 800], 'shot-2': [1280, 800], 'shot-3': [1280, 800], 'shot-4': [1280, 800], 'shot-5': [1280, 800],
  'promo-small': [440, 280], 'marquee': [1400, 560],
  'icon-16': [16, 16], 'icon-32': [32, 32], 'icon-48': [48, 48], 'icon-64': [64, 64], 'icon-128': [128, 128], 'logo-300': [300, 300]
};

const profileDir = path.join(os.tmpdir(), 'bn-store-render');
fs.rmSync(profileDir, { recursive: true, force: true });
const browser = spawn(exe, [
  '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
const toBrowser = browser.stdio[3];
const fromBrowser = browser.stdio[4];
let buffer = '';
let nextId = 1;
const pending = new Map();
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 30000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(s, expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result.value;
}

(async () => {
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, s);
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, s);
    await send('Page.navigate', { url: PAGE + '?bare' }, s);
    await wait(800);
    await run(s, 'window.framesReady');
    await wait(400);

    for (const [id, files] of Object.entries(OUTPUTS)) {
      const box = await run(s, `(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()`);
      const [w, h] = SIZES[id];
      if (Math.round(box.width) !== w || Math.round(box.height) !== h) throw new Error(`${id} is ${box.width}x${box.height}, not ${w}x${h}`);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: box.x, y: box.y, width: w, height: h, scale: 1 } }, s);
      for (const f of files) {
        const out = path.join(ROOT, f);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(data, 'base64'));
      }
      console.log(`  ${id.padEnd(12)} ${w}x${h}  -> ${files.join(', ')}`);
    }

    // The contact sheet, for review.
    await send('Emulation.setDefaultBackgroundColorOverride', {}, s);
    await send('Page.navigate', { url: PAGE }, s);
    await wait(800);
    await run(s, 'window.framesReady');
    await wait(400);
    const full = await run(s, '({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })');
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.w, height: full.h, scale: 0.5 } }, s);
    fs.writeFileSync(path.join(ASSETS, 'contact-sheet.png'), Buffer.from(data, 'base64'));
    console.log('  contact-sheet.png');
  } catch (e) {
    console.log('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    try { browser.kill(); } catch (_) {}
    setTimeout(() => process.exit(), 500);
  }
})();
