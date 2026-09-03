// Regression tests for issue #17 — "audit log page changing buttons also not
// working".
//
// The pagination buttons were rendered with inline `onclick="changePage(n)"`.
// Extension pages run under the MV3 content security policy declared in
// manifest.json (`script-src 'self'`), which blocks inline event handlers
// outright — so every page button was a silent no-op. They now carry the target
// page in `data-page` and are driven by a delegated listener.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const AUDIT_SOURCE = fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8');

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}
  };
}

function loadAudit({ blockedCount = 0 } = {}) {
  const els = new Map();
  const documentListeners = new Map();
  const now = Date.now();

  const blocked = Array.from({ length: blockedCount }, (_, i) => ({
    url: `https://example${i}.test/page`,
    reason: 'blocklist',
    timestamp: now - i * 1000
  }));

  const sandbox = {
    console,
    Map, Set, Date, Math, JSON, RegExp, Promise, URL, Error, Number, Array, String, Blob: class {},
    setTimeout, clearTimeout,
    alert() {},
    confirm: () => false,
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelectorAll: () => [],
      addEventListener: (type, fn) => {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(fn);
      }
    },
    chrome: {
      storage: {
        local: {
          get: () => Promise.resolve({ pblocker_audit_blocked: blocked, pblocker_audit_disabled: [] }),
          set: () => Promise.resolve()
        },
        onChanged: { addListener() {} }
      }
    }
  };
  sandbox.window = { scrollTo() {} };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(AUDIT_SOURCE, sandbox, { filename: 'audit.js' });

  return { ctx: sandbox, els, documentListeners };
}

// Fire the delegated handler as a real click on a pagination button would.
function clickPageButton(documentListeners, { page, disabled = false }) {
  const btn = { disabled, dataset: { page: String(page) } };
  const event = {
    target: { closest: (sel) => (sel === '.page-button[data-page]' ? btn : null) }
  };
  const handlers = documentListeners.get('click') || [];
  assert.ok(handlers.length > 0, 'a delegated click listener must be registered');
  handlers.forEach((fn) => fn(event));
}

// The active page is the one rendered with the `active` class.
function activePage(html) {
  const m = html.match(/<button class="page-button active" data-page="(\d+)"/);
  return m ? Number(m[1]) : null;
}

// ─── the CSP regression itself ───────────────────────────────────────────────

test('audit.js contains no inline event handlers (blocked by the extension CSP)', () => {
  assert.doesNotMatch(
    AUDIT_SOURCE, /\son[a-z]+\s*=\s*"/,
    'inline handlers are dead under script-src \'self\'; use a delegated listener'
  );
});

test('the extension-page CSP that makes inline handlers impossible is still declared', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
});

test('pagination buttons carry their target page in data-page', () => {
  const { ctx } = loadAudit();
  const el = makeEl('all-pagination');
  ctx.renderPagination(el, 2, 5, 100);

  assert.match(el.innerHTML, /data-page="1"/, 'first-page button');
  assert.match(el.innerHTML, /data-page="3"/, 'next-page button');
  assert.match(el.innerHTML, /data-page="5"/, 'last-page button');
  assert.doesNotMatch(el.innerHTML, /onclick/);
  assert.equal(activePage(el.innerHTML), 2);
});

// ─── the buttons actually change the page ────────────────────────────────────

test('clicking a page button re-renders that page', async () => {
  const { ctx, els, documentListeners } = loadAudit({ blockedCount: 100 }); // 5 pages
  await ctx.loadAuditData();
  ctx.setupEventListeners();
  ctx.renderCurrentView();

  assert.equal(activePage(els.get('all-pagination').innerHTML), 1, 'starts on page 1');

  clickPageButton(documentListeners, { page: 3 });
  assert.equal(activePage(els.get('all-pagination').innerHTML), 3, 'the button moved the view');

  const listed = els.get('all-list').innerHTML;
  assert.match(listed, /example40\.test/, 'page 3 shows items 41-60 (newest first)');
  assert.doesNotMatch(listed, /example0\.test<|example5\.test\//, 'page 1 items are gone');
});

test('a disabled page button does nothing', async () => {
  const { ctx, els, documentListeners } = loadAudit({ blockedCount: 100 });
  await ctx.loadAuditData();
  ctx.setupEventListeners();
  ctx.renderCurrentView();

  clickPageButton(documentListeners, { page: 0, disabled: true });
  assert.equal(activePage(els.get('all-pagination').innerHTML), 1, 'still on page 1');
});

test('changePage clamps to the available range', async () => {
  const { ctx, els } = loadAudit({ blockedCount: 100 }); // 5 pages
  await ctx.loadAuditData();
  ctx.renderCurrentView();

  ctx.changePage(99);
  assert.equal(activePage(els.get('all-pagination').innerHTML), 5, 'clamped to the last page');

  ctx.changePage(-4);
  assert.equal(activePage(els.get('all-pagination').innerHTML), 1, 'clamped to the first page');
});

test('a single page of results renders no pagination controls', () => {
  const { ctx } = loadAudit();
  const el = makeEl('all-pagination');
  el.innerHTML = 'stale';
  ctx.renderPagination(el, 1, 1, 12);
  assert.equal(el.innerHTML, '');
});
