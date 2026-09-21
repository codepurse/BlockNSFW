import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'artifacts/privacy');
mkdirSync(output, { recursive: true });

// Hosted Windows runners include Chrome. An explicit override also supports
// Chrome for Testing and local runs without adding a browser-download dependency.
const candidates = [
  process.env.BLOCKNSFW_CHROME_PATH,
  ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'Google/Chrome/Application/chrome.exe')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executable = candidates.find((candidate) => existsSync(candidate));
if (!executable)
  throw new Error(
    'Chrome not found. Set BLOCKNSFW_CHROME_PATH; the browser test is never silently skipped.',
  );
if (!existsSync(path.join(root, 'dist/chrome/manifest.json'))) {
  throw new Error('Build dist/chrome first with build-chrome.ps1.');
}

const profile = mkdtempSync(path.join(tmpdir(), 'blocknsfw-privacy-'));
const browserLog = createWriteStream(path.join(output, 'chrome.log'));
let browser;
let tester;

async function stop(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('close', resolve));
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  let timer;
  await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 5000);
    }),
  ]);
  clearTimeout(timer);
}

try {
  browser = spawn(
    executable,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--no-proxy-server',
      // Synthetic network probes must not leave the runner even if the guard regresses.
      // CDP fulfills the expected page and download requests without DNS/network access.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      'about:blank',
    ],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error('Chrome did not expose CDP within 20 seconds')),
      20000,
    );
    browser.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    browser.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before CDP was ready: ${code}`));
    });
    browser.stdout.on('data', (chunk) => browserLog.write(chunk));
    browser.stderr.on('data', (chunk) => {
      browserLog.write(chunk);
      stderr = (stderr + chunk).slice(-16384);
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });

  console.log(
    'Running privacy smoke tests with an isolated Chrome profile and external DNS disabled.',
  );
  const testLog = createWriteStream(path.join(output, 'browser-test.log'));
  try {
    tester = spawn(process.execPath, ['tests/browser/privacy-smoke.mjs'], {
      cwd: root,
      env: { ...process.env, BLOCKNSFW_CDP_URL: endpoint },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser test exceeded 60 seconds')), 60000);
      tester.stdout.on('data', (chunk) => {
        testLog.write(chunk);
        process.stdout.write(chunk);
      });
      tester.stderr.on('data', (chunk) => {
        testLog.write(chunk);
        process.stderr.write(chunk);
      });
      tester.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      tester.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (code !== 0)
      throw new Error(
        `Browser privacy test failed (exit ${code}); see artifacts/privacy/browser-test.log`,
      );
  } finally {
    await stop(tester);
    await new Promise((resolve) => testLog.end(resolve));
  }
} finally {
  await stop(browser);
  await new Promise((resolve) => browserLog.end(resolve));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
