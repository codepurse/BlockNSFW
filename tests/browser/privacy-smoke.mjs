import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(
  readFileSync(new URL('../fixtures/privacy-contract.json', import.meta.url), 'utf8'),
);
// Run only against a disposable Chrome profile with --enable-unsafe-extension-debugging.
const endpoint = process.env.BLOCKNSFW_CDP_URL;
if (!endpoint)
  throw new Error('Set BLOCKNSFW_CDP_URL to the disposable browser WebSocket endpoint.');
const bundle = path.resolve(
  process.env.BLOCKNSFW_BUNDLE ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/chrome'),
);
const timeout = setTimeout(() => {
  console.error('Browser smoke test timed out');
  process.exit(1);
}, 30000);
const socket = new WebSocket(endpoint);
await new Promise((r) => socket.addEventListener('open', r, { once: true }));
let next = 0;
const pending = new Map(),
  requests = [],
  failures = [],
  contexts = [];
socket.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.executionContextCreated')
    contexts.push({ session: m.sessionId, ...m.params.context });
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(JSON.stringify(m.error)));
    else p?.resolve(m.result);
  }
  if (m.method === 'Fetch.requestPaused') {
    requests.push({
      url: m.params.request.url,
      method: m.params.request.method,
      body: m.params.request.postData,
      headers: m.params.request.headers,
      session: m.sessionId,
    });
    try {
      await send(
        'Fetch.fulfillRequest',
        {
          requestId: m.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from('{}').toString('base64'),
        },
        m.sessionId,
      );
    } catch (e) {
      failures.push(e.message);
    }
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] }, sessionId);
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
let id;
try {
  ({ id } = await send('Extensions.loadUnpacked', { path: bundle, enableInIncognito: true }));
  const { targetId } = await send('Target.createTarget', {
    url: `chrome-extension://${id}/options.html`,
  });
  const page = await attach(targetId);
  await evaluate(
    page,
    "new Promise(resolve => document.readyState === 'complete' ? resolve() : window.addEventListener('load', resolve, {once:true}))",
  );
  assert.equal(await evaluate(page, 'Boolean(globalThis.PrivacyGuard)'), true);
  await evaluate(
    page,
    'chrome.storage.local.set({pblocker_settings:{enabled:true,privacyMode:true,dnsFilterEnabled:true,aiImageBlocker:true,useSmartBlocking:true}})',
  );
  await evaluate(
    page,
    "chrome.runtime.sendMessage({type:'should_block_url',url:'https://example.test/'}).catch(()=>null)",
  );
  let workerInfo;
  for (let i = 0; i < 30; i++) {
    workerInfo = (await send('Target.getTargets')).targetInfos.find(
      (t) => t.url === `chrome-extension://${id}/background.js`,
    );
    if (workerInfo) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(workerInfo, 'extension worker started');
  const worker = await attach(workerInfo.targetId);
  const mark = requests.length;
  const probes = await evaluate(
    page,
    `(async()=>{
 const attempts=[
  ()=>fetch('https://private.example.com/path?PRIVATE_MARKER=1'),
  ()=>PBlockerReports.submitReport({url:'https://private.example.com/?PRIVATE_MARKER=1',domain:'private.example.com',reportType:'should_block',category:'adult',notes:'PRIVATE_MARKER'}),
  ()=>PBlockerStories.fetchStories(),
  ()=>PBlockerStories.likeStory('PRIVATE_MARKER',true),
  ()=>fetch('https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/HOSTS.txt?PRIVATE_MARKER=1')
 ];return Promise.all(attempts.map(async f=>{try{await f();return 'SENT';}catch(e){return e.message;}}));})()`,
  );
  assert.ok(
    probes.every((x) => x.includes('Privacy mode')),
    JSON.stringify(probes),
  );
  const dns = await evaluate(
    worker,
    "checkDnsFilter('private-marker.example.com','cloudflare','')",
  );
  assert.equal(dns, null);
  await evaluate(
    page,
    "fetch('https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/version.json', {headers:{'X-Private':'PRIVATE_MARKER'},referrer:'https://private.example.com/PRIVATE_MARKER'})",
  );
  const relevant = requests.slice(mark);
  // Startup refreshes can finish concurrently on slower CI machines. They must
  // satisfy the same contract; do not require a timing-dependent request count.
  assert.ok(relevant.some((request) => request.url.endsWith('/data/version.json')));
  for (const request of relevant) {
    assert.ok(contract.allowedDownloads.includes(request.url), JSON.stringify(request));
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
  }
  assert.ok(!JSON.stringify(relevant).includes('PRIVATE_MARKER'));
  const { browserContextId } = await send('Target.createBrowserContext');
  const privateTarget = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const privateSession = await attach(privateTarget.targetId);
  await send('Page.enable', {}, privateSession);
  await send('Page.navigate', { url: 'https://example.org/privacy-audit' }, privateSession);
  let world;
  for (let i = 0; i < 30; i++) {
    world = contexts.find(
      (c) => c.session === privateSession && c.origin === `chrome-extension://${id}`,
    );
    if (world) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(world, 'extension content script runs in incognito');
  const privateMark = requests.length;
  const privateProbe = await send(
    'Runtime.evaluate',
    {
      contextId: world.id,
      expression: `(async()=>{try{await fetch('https://third-party.example/PRIVATE_MARKER');return 'SENT';}catch(e){return e.message;}})()`,
      awaitPromise: true,
      returnByValue: true,
    },
    privateSession,
  );
  assert.match(privateProbe.result.value, /Privacy mode/);
  assert.equal(requests.length, privateMark, 'incognito probe must not reach network');
  await send('Target.disposeBrowserContext', { browserContextId });
  assert.deepEqual(failures, [], 'network interception must not fail silently');
  const result = {
    incognitoProbe: privateProbe.result.value,
    browser: 'isolated headless Chrome',
    extensionId: id,
    probes,
    dnsResult: dns,
    requests: relevant,
    errors: failures,
  };

  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  socket.close();
}
