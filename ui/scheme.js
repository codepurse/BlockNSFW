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

(function (root) {
  'use strict';

  const KEY = 'pblocker_color_scheme';
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

  function normalize(value) {
    return SCHEMES.indexOf(value) === -1 ? 'system' : value;
  }

  function current() {
    return normalize(html.getAttribute('data-scheme'));
  }

  function apply(value) {
    const scheme = normalize(value);
    const changed = scheme !== current();
    if (scheme === 'system') html.removeAttribute('data-scheme');
    else html.setAttribute('data-scheme', scheme);
    try {
      localStorage.setItem(KEY, scheme);
    } catch (_) {}
    if (changed) {
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

  /** Call fn(scheme) whenever the choice changes, here or on another page. */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  let cached = null;
  try {
    cached = localStorage.getItem(KEY);
  } catch (_) {
    cached = null;
  }
  apply(cached);

  if (store) {
    try {
      Promise.resolve(store.local.get(KEY))
        .then(function (result) { apply(result && result[KEY]); })
        .catch(function () {});
    } catch (_) {}
    try {
      store.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue);
      });
    } catch (_) {}
  }

  root.UiScheme = { KEY: KEY, SCHEMES: SCHEMES.slice(), get: current, set: set, onChange: onChange };
})(typeof window !== 'undefined' ? window : this);
