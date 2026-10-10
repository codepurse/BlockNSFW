// BlockNSFW — the colour scheme: follow the system, or keep light or dark.
//
// Loaded first in <head> on every extension page, before the stylesheets, so
// the choice is on <html> at the first paint. ui/tokens.css reads it as
// data-scheme="light" | "dark"; with no attribute a page follows the system.
// (data-theme is taken: the blocked page names its design with it.)
//
// browserAPI.storage holds the choice, and content.js reads it there for the
// UI it puts on web pages. storage answers only after the first paint, so
// localStorage keeps a copy this file can read at once. The two agree again
// as soon as storage answers, and every open page follows a change.
//
// A Supporter look (true black, an accent) is kept the same way. The looks
// themselves are a Supporter extra (extras/looks.js in store builds); this
// file only lays what is kept over ui/tokens.css: colour tokens for light and
// for dark, as --color-* names with plain colour values, and nothing else.

(function (root) {
  'use strict';

  const KEY = 'pblocker_color_scheme';
  const LOOK_KEY = 'pblocker_look';
  const SCHEMES = ['system', 'light', 'dark'];
  const html = document.documentElement;
  const listeners = [];

  let api = null;
  try {
    api = typeof browser !== 'undefined' ? browser : chrome;
  } catch (_) {
    api = null;
  }
  const store = api && api.storage && api.storage.local ? api.storage : null;
  let darkQuery = null;
  try {
    darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  } catch (_) {
    darkQuery = null;
  }

  function normalize(value) {
    return SCHEMES.indexOf(value) === -1 ? 'system' : value;
  }

  function current() {
    return normalize(html.getAttribute('data-scheme'));
  }

  function isDark() {
    const scheme = current();
    return scheme === 'dark' || (scheme === 'system' && !!(darkQuery && darkQuery.matches));
  }

  // --- The look ------------------------------------------------------------------

  const TOKEN = /^--color-[a-z0-9-]{1,40}$/;
  const COLOUR = /^(#[0-9a-fA-F]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
  let look = null;
  let painted = [];

  // { choice: { accent?, black? }, light: { token: colour }, dark: { … } },
  // or null for the plain look.
  function normalizeLook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = { choice: {}, light: {}, dark: {} };
    ['light', 'dark'].forEach(function (side) {
      const src = raw[side];
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach(function (name) {
        const value = String(src[name]).trim();
        if (TOKEN.test(name) && COLOUR.test(value)) out[side][name] = value;
      });
    });
    const choice = raw.choice && typeof raw.choice === 'object' ? raw.choice : {};
    if (typeof choice.accent === 'string' && /^[a-z]{1,20}$/.test(choice.accent)) out.choice.accent = choice.accent;
    if (choice.black === true) out.choice.black = true;
    return Object.keys(out.light).length || Object.keys(out.dark).length ? out : null;
  }

  function paintLook() {
    painted.forEach(function (name) { html.style.removeProperty(name); });
    painted = [];
    if (!look) return;
    const tokens = look[isDark() ? 'dark' : 'light'];
    Object.keys(tokens).forEach(function (name) {
      html.style.setProperty(name, tokens[name]);
      painted.push(name);
    });
  }

  function applyLook(raw) {
    look = normalizeLook(raw);
    try {
      if (look) localStorage.setItem(LOOK_KEY, JSON.stringify(look));
      else localStorage.removeItem(LOOK_KEY);
    } catch (_) {}
    paintLook();
    return look;
  }

  // --- The scheme ----------------------------------------------------------------

  function apply(value) {
    const scheme = normalize(value);
    const changed = scheme !== current();
    if (scheme === 'system') html.removeAttribute('data-scheme');
    else html.setAttribute('data-scheme', scheme);
    try {
      localStorage.setItem(KEY, scheme);
    } catch (_) {}
    if (changed) {
      paintLook();
      listeners.forEach(function (fn) {
        try { fn(scheme); } catch (_) {}
      });
    }
    return scheme;
  }

  /** Keep the choice, and show it on this page at once. */
  function set(value) {
    const scheme = apply(value);
    if (!store) return Promise.resolve(scheme);
    return Promise.resolve(store.local.set({ [KEY]: scheme })).then(function () {
      return scheme;
    });
  }

  /** Keep a look (or null for the plain one), and show it on this page at once. */
  function setLook(raw) {
    const kept = applyLook(raw);
    if (!store) return Promise.resolve(kept);
    const write = kept ? store.local.set({ [LOOK_KEY]: kept }) : store.local.remove(LOOK_KEY);
    return Promise.resolve(write).then(function () { return kept; });
  }

  /** Call fn(scheme) whenever the choice changes, here or on another page. */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  let cached = null;
  let cachedLook = null;
  try {
    cached = localStorage.getItem(KEY);
    cachedLook = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null');
  } catch (_) {
    cachedLook = null;
  }
  look = normalizeLook(cachedLook);
  apply(cached);
  paintLook();

  if (darkQuery) {
    try {
      const repaint = function () { paintLook(); };
      if (typeof darkQuery.addEventListener === 'function') darkQuery.addEventListener('change', repaint);
      else if (typeof darkQuery.addListener === 'function') darkQuery.addListener(repaint);
    } catch (_) {}
  }

  if (store) {
    try {
      Promise.resolve(store.local.get([KEY, LOOK_KEY]))
        .then(function (result) {
          apply(result && result[KEY]);
          applyLook(result && result[LOOK_KEY]);
        })
        .catch(function () {});
    } catch (_) {}
    try {
      store.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes[KEY]) apply(changes[KEY].newValue);
        if (changes[LOOK_KEY]) applyLook(changes[LOOK_KEY].newValue);
      });
    } catch (_) {}
  }

  root.UiScheme = {
    KEY: KEY,
    LOOK_KEY: LOOK_KEY,
    SCHEMES: SCHEMES.slice(),
    get: current,
    set: set,
    onChange: onChange,
    getLook: function () { return look; },
    setLook: setLook,
    normalizeLook: normalizeLook
  };
})(typeof window !== 'undefined' ? window : this);
