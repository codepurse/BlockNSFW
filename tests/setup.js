// Test setup: load background.js into a sandboxed Node context with browser-API
// stubs so the pure helper functions become reachable for testing without
// refactoring the source file.
//
// The functions we test are declared at the top level of background.js. They
// reference each other and a small number of in-script globals (patternCache,
// cacheVersion, MAX_CACHE_SIZE, etc.). Loading the whole file in a vm context
// with mocked browser globals is the smallest change that gives test access
// to those functions while keeping the production source untouched.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '..', 'background.js');
const SHARED_HOSTNAME_PATH = path.join(__dirname, '..', 'shared', 'hostname.js');
const SHARED_HOST_KEYWORDS_PATH = path.join(__dirname, '..', 'shared', 'host-keywords.js');

function noop() {}

function makeChromeStub() {
  const stub = {
    runtime: {
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      onMessage: { addListener: noop },
      sendMessage: (...args) => Promise.resolve(),
      getURL: (p) => p,
      getManifest: () => ({ version: '1.6.0' })
    },
    storage: {
      local: {
        get: (keys) => Promise.resolve({}),
        set: (items) => Promise.resolve(),
        remove: (keys) => Promise.resolve()
      }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: () => Promise.resolve()
    },
    tabs: {
      update: () => Promise.resolve(),
      query: () => Promise.resolve([])
    },
    action: {
      setIcon: () => Promise.resolve(),
      setBadgeText: () => Promise.resolve()
    },
    alarms: {
      create: noop,
      onAlarm: { addListener: noop },
      clear: () => Promise.resolve()
    }
  };
  return stub;
}

function loadBackgroundContext() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const sharedHostnameSource = fs.readFileSync(SHARED_HOSTNAME_PATH, 'utf8');
  const sharedHostKeywordsSource = fs.readFileSync(SHARED_HOST_KEYWORDS_PATH, 'utf8');
  const sandbox = {
    chrome: makeChromeStub(),
    browser: undefined,
    self: undefined, // populated below
    console,
    fetch: () => Promise.reject(new Error('fetch is not available in tests')),
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Map,
    Set,
    RegExp,
    Promise,
    URL,
    URLSearchParams,
    Error,
    TypeError
  };
  sandbox.self = sandbox;
  // In service-worker context, `self` is the global. The source uses top-level
  // `let`/`const` which create lexical bindings, not properties of the global.
  // Tests need access to function declarations only, so we use runInContext.
  vm.createContext(sandbox);
  // Pre-load the shared hostname helper so background.js sees HostnameNormalize
  // on the global, just as it would in production via importScripts.
  for (const [file, label] of [[sharedHostnameSource, 'shared/hostname.js'], [sharedHostKeywordsSource, 'shared/host-keywords.js']]) {
    try {
      vm.runInContext(file, sandbox, { filename: label });
    } catch (err) {
      if (process.env.BLOCKNSFW_TEST_DEBUG) {
        console.warn(label + ' load error (ignored):', err.message);
      }
    }
  }
  try {
    vm.runInContext(source, sandbox, { filename: 'background.js' });
  } catch (err) {
    // Top-level side effects (e.g., chrome.* listener registration) may throw
    // if a stub is missing. The function declarations we want to test are
    // still attached to the context.
    if (process.env.BLOCKNSFW_TEST_DEBUG) {
      console.warn('background.js top-level error (ignored):', err.message);
    }
  }
  return sandbox;
}

module.exports = { loadBackgroundContext };
