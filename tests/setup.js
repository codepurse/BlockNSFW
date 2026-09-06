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
const SHARED_BROWSER_KEY_PATH = path.join(__dirname, '..', 'shared', 'browser-key.js');
const SHARED_HOSTNAME_PATH = path.join(__dirname, '..', 'shared', 'hostname.js');
const SHARED_HOST_KEYWORDS_PATH = path.join(__dirname, '..', 'shared', 'host-keywords.js');
const SHARED_VALIDATE_DOMAIN_PATH = path.join(__dirname, '..', 'shared', 'validate-domain.js');
const SHARED_KEYWORD_PATTERN_PATH = path.join(__dirname, '..', 'shared', 'keyword-pattern.js');
const SHARED_DNS_PROVIDERS_PATH = path.join(__dirname, '..', 'shared', 'dns-providers.js');
const SHARED_AI_IMAGE_MODELS_PATH = path.join(__dirname, '..', 'shared', 'ai-image-models.js');
const SHARED_VIT_CLASSIFIER_PATH = path.join(__dirname, '..', 'shared', 'vit-classifier.js');

function noop() {}

function makeChromeStub() {
  const messageListeners = [];
  const tabUpdatedListeners = [];
  const badges = new Map();
  const stub = {
    runtime: {
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      onMessage: {
        addListener: listener => { messageListeners.push(listener); },
        listeners: messageListeners
      },
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
      query: () => Promise.resolve([]),
      onUpdated: { addListener: listener => { tabUpdatedListeners.push(listener); }, listeners: tabUpdatedListeners }
    },
    action: {
      setIcon: () => Promise.resolve(),
      // Badge text is stored per tab so bumpTabBadge's read-back-then-add can be
      // exercised: it reads the badge rather than keeping a tally, because the
      // MV3 worker is torn down while the badge text survives.
      _badges: badges,
      getBadgeText: ({ tabId }) => Promise.resolve(badges.get(tabId) || ''),
      setBadgeText: ({ tabId, text }) => {
        if (text === '') badges.delete(tabId);
        else badges.set(tabId, text);
        return Promise.resolve();
      },
      setBadgeBackgroundColor: () => Promise.resolve()
    },
    alarms: {
      create: noop,
      onAlarm: { addListener: noop },
      clear: () => Promise.resolve()
    }
  };
  return stub;
}

// `sourcePath` lets a caller load a background.js from somewhere other than the
// working tree — a git worktree at an older commit, say — so two revisions can
// be driven through the identical stub and compared. Defaults to this tree.
function loadBackgroundContext(sourcePath = SOURCE_PATH) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sharedBrowserKeySource = fs.readFileSync(SHARED_BROWSER_KEY_PATH, 'utf8');
  const sharedHostnameSource = fs.readFileSync(SHARED_HOSTNAME_PATH, 'utf8');
  const sharedHostKeywordsSource = fs.readFileSync(SHARED_HOST_KEYWORDS_PATH, 'utf8');
  const sharedValidateDomainSource = fs.readFileSync(SHARED_VALIDATE_DOMAIN_PATH, 'utf8');
  const sharedKeywordPatternSource = fs.readFileSync(SHARED_KEYWORD_PATTERN_PATH, 'utf8');
  const sharedDnsProvidersSource = fs.readFileSync(SHARED_DNS_PROVIDERS_PATH, 'utf8');
  const sharedAiImageModelsSource = fs.readFileSync(SHARED_AI_IMAGE_MODELS_PATH, 'utf8');
  const sharedVitClassifierSource = fs.readFileSync(SHARED_VIT_CLASSIFIER_PATH, 'utf8');
  const sandbox = {
    chrome: makeChromeStub(),
    browser: undefined,
    self: undefined, // populated below
    console,
    fetch: () => Promise.reject(new Error('fetch is not available in tests')),
    // The DoH client aborts its own requests on a timeout, so the resolver
    // path is unreachable without this.
    AbortController,
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
  for (const [file, label] of [[sharedBrowserKeySource, 'shared/browser-key.js'], [sharedHostnameSource, 'shared/hostname.js'], [sharedHostKeywordsSource, 'shared/host-keywords.js'], [sharedValidateDomainSource, 'shared/validate-domain.js'], [sharedKeywordPatternSource, 'shared/keyword-pattern.js'], [sharedDnsProvidersSource, 'shared/dns-providers.js'], [sharedAiImageModelsSource, 'shared/ai-image-models.js'], [sharedVitClassifierSource, 'shared/vit-classifier.js']]) {
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
