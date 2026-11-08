// "Held by mistake? Report this site" on the held page.
//
// One tap sends the held site to the community reports backend as
// "incorrectly_blocked", the same endpoint and client as the form in Settings
// (appwrite-client.js). What is pinned here:
//   - it is offered only for a detail the extension stashed in session
//     storage, never for a ?url= any website can put in the address, since
//     blocked.html is web-accessible;
//   - not for the user's own rules or the two search holds;
//   - the address goes without its query or fragment, and the note names the
//     rule and the door, never the page's words;
//   - every outcome (sent, already reported, offline) ends in a plain line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const blockedSource = fs.readFileSync(path.join(ROOT, 'blocked.js'), 'utf8');
const blockedHtml = fs.readFileSync(path.join(ROOT, 'blocked.html'), 'utf8');
const themesCss = fs.readFileSync(path.join(ROOT, 'blocked-themes.css'), 'utf8');

function functionSource(source, name) {
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function constSource(source, name) {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} should exist`);
  return source.slice(start, source.indexOf(';', start) + 1);
}

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    hidden: true,
    disabled: false,
    textContent: '',
    classList: { add: (c) => classes.add(c), has: (c) => classes.has(c) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    click: () => listeners.click && listeners.click(),
    hasListener: (type) => Boolean(listeners[type])
  };
}

// The report code from blocked.js, with the page's state and a stand-in for
// PBlockerReports.
function load({ trusted = true, preview = '', reason = 'default_blocklist', url = 'https://www.example.test/a/b?q=private#frag', score = '', reports } = {}) {
  const ids = {
    report: element(),
    'report-idle': element(),
    'report-send': element(),
    'report-note': element(),
    'report-status': element(),
    'report-send-label': element()
  };
  ids['report-idle'].hidden = false;
  ids['report-note'].hidden = false;
  ids['report-send-label'].textContent = 'Report this site';
  const sandbox = {
    console, URL, Set, Number, Math, String, parseFloat, TypeError,
    document: { getElementById: (id) => ids[id] || null },
    PBlockerReports: reports,
    detailTrusted: trusted,
    previewTheme: preview,
    reason,
    url,
    score
  };
  vm.createContext(sandbox);
  vm.runInContext([
    "const LAYERS = ['your list', 'built-in list', 'DNS', 'address & search', 'page text', 'on-device AI'];",
    constSource(blockedSource, 'REPORT_SKIP_REASONS'),
    functionSource(blockedSource, 'getReasonMeta'),
    functionSource(blockedSource, 'reportTarget'),
    functionSource(blockedSource, 'reportNotes'),
    functionSource(blockedSource, 'reportsClient'),
    functionSource(blockedSource, 'renderReport'),
    'globalThis.api = { reportTarget, reportNotes, renderReport };'
  ].join('\n'), sandbox);
  return { api: sandbox.api, ids };
}

function fakeReports({ already = false, fail = null } = {}) {
  const calls = { submit: [], marked: [] };
  return {
    calls,
    isConfigured: () => true,
    buildReportKey: (type, domain) => `${type}:${domain}`,
    isReportKeyAlreadyReported: async () => already,
    markReportKeyReported: async (key) => { calls.marked.push(key); },
    submitReport: async (data) => {
      calls.submit.push(data);
      if (fail) throw fail;
      return { ok: true };
    }
  };
}

// The click handler is async and not returned; let it finish.
const settle = () => new Promise((done) => setTimeout(done, 0));

test('a site held by the extension can be reported: address without its query, site without www', () => {
  const { api } = load();
  const target = api.reportTarget();
  assert.equal(target.url, 'https://www.example.test/a/b');
  assert.equal(target.domain, 'example.test');
});

test('a ?url= from the address bar is never offered: any website can open this page', () => {
  const { api } = load({ trusted: false });
  assert.equal(api.reportTarget(), null);
});

test('not in a design preview', () => {
  const { api } = load({ preview: 'calm' });
  assert.equal(api.reportTarget(), null);
});

test('not for the user\'s own rules, nor for a held search', () => {
  for (const reason of ['custom_blocklist', 'custom_title_pattern', 'custom_keyword', 'search_query', 'unsafe_search']) {
    const { api } = load({ reason });
    assert.equal(api.reportTarget(), null, reason);
  }
  for (const reason of ['default_blocklist', 'instant_host_match', 'dns_blocked', 'smart_filter', 'reddit_nsfw', 'metadata_scan', 'page_text_scan', 'ai_text_scan', 'local_filter']) {
    const { api } = load({ reason });
    assert.ok(api.reportTarget(), reason);
  }
});

test('only web addresses: the "Unknown URL" placeholder and other schemes are not reported', () => {
  assert.equal(load({ url: 'Unknown URL' }).api.reportTarget(), null);
  assert.equal(load({ url: 'file:///C:/x.html' }).api.reportTarget(), null);
  assert.equal(load({ url: 'chrome-extension://abc/blocked.html' }).api.reportTarget(), null);
});

test('the note names the rule, the door and the AI\'s confidence, nothing from the page', () => {
  const ai = load({ reason: 'ai_text_scan', score: '0.87' }).api.reportNotes();
  assert.equal(ai, 'held page · reason=ai_text_scan · door=6 (on-device AI) · ai=87%');
  const list = load({ reason: 'default_blocklist' }).api.reportNotes();
  assert.equal(list, 'held page · reason=default_blocklist · door=2 (built-in list)');
  assert.ok(list.length <= 500, 'fits the backend\'s 500-character notes field');
});

test('nothing shows when the page has no stashed detail', async () => {
  const reports = fakeReports();
  const { api, ids } = load({ trusted: false, reports });
  await api.renderReport();
  assert.equal(ids.report.hidden, true);
  assert.equal(ids['report-send'].hasListener('click'), false);
});

test('one tap sends an incorrectly_blocked report and says it was sent', async () => {
  const reports = fakeReports();
  const { api, ids } = load({ reason: 'page_text_scan', reports });
  await api.renderReport();
  assert.equal(ids.report.hidden, false);
  ids['report-send'].click();
  await settle();
  assert.equal(reports.calls.submit.length, 1);
  const sent = reports.calls.submit[0];
  assert.equal(sent.reportType, 'incorrectly_blocked');
  assert.equal(sent.category, 'n/a');
  assert.equal(sent.url, 'https://www.example.test/a/b');
  assert.equal(sent.domain, 'example.test');
  assert.match(sent.notes, /reason=page_text_scan/);
  assert.equal(ids['report-idle'].hidden, true);
  assert.equal(ids['report-note'].hidden, true);
  assert.equal(ids['report-status'].hidden, false);
  assert.match(ids['report-status'].textContent, /^Reported\. Thank you\./);
  assert.ok(ids.report.classList.has('is-sent'));
});

test('a site this browser already reported says so, with no button', async () => {
  const reports = fakeReports({ already: true });
  const { api, ids } = load({ reports });
  await api.renderReport();
  assert.equal(ids.report.hidden, false);
  assert.equal(ids['report-idle'].hidden, true);
  assert.match(ids['report-status'].textContent, /has been reported/);
  assert.equal(ids['report-send'].hasListener('click'), false);
});

test('reported already by someone else: the same thanks, remembered for the next hold', async () => {
  const reports = fakeReports({ fail: new Error('This report was already submitted by the community. Thank you!') });
  const { api, ids } = load({ reports });
  await api.renderReport();
  ids['report-send'].click();
  await settle();
  assert.deepEqual(reports.calls.marked, ['incorrectly_blocked:example.test']);
  assert.match(ids['report-status'].textContent, /has been reported/);
});

test('offline: a plain line and the button back as Try again', async () => {
  const reports = fakeReports({ fail: new TypeError('Failed to fetch') });
  const { api, ids } = load({ reports });
  await api.renderReport();
  ids['report-send'].click();
  await settle();
  assert.equal(ids['report-send'].disabled, false);
  // Only the words change, so the button keeps its icon.
  assert.equal(ids['report-send-label'].textContent, 'Try again');
  assert.match(ids['report-status'].textContent, /didn’t send/);
  assert.doesNotMatch(ids['report-status'].textContent, /Failed to fetch/);
  assert.equal(ids['report-idle'].hidden, false);
});

test('a limit from the client (wait, daily cap) is said as it is', async () => {
  const reports = fakeReports({ fail: new Error('Please wait 90s before submitting another report.') });
  const { api, ids } = load({ reports });
  await api.renderReport();
  ids['report-send'].click();
  await settle();
  assert.equal(ids['report-status'].textContent, 'Please wait 90s before submitting another report.');
});

test('blocked.html loads the reports client before blocked.js, and every design places the line', () => {
  const order = ['shared/browser-key.js', 'appwrite-client.js', 'blocked.js']
    .map((src) => blockedHtml.indexOf(`<script src="${src}"></script>`));
  order.forEach((at) => assert.notEqual(at, -1));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'browser-key, then the client, then the page');
  assert.match(blockedHtml, /<section class="report" id="report" aria-labelledby="report-head" hidden>/);
  assert.match(blockedHtml, /<button type="button" class="btn btn-ghost report-send" id="report-send">/);
  assert.ok(blockedHtml.includes('<span id="report-send-label">Report this site</span>'), 'the label is its own span');
  assert.match(blockedHtml, /html:not\(\[data-theme\]\) \.report \{/);
  assert.match(themesCss, /html\[data-theme\] \.report \{/);
});
