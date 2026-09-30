// options-layout.js — the settings page's own layout behaviour: the
// full-width toggle, and the sidebar nav's smooth scroll and active section.
//
// Loaded from <head>, not the end of <body>, so a saved full-width choice is
// on <html> before the first paint. Applied any later, the page would visibly
// jump wider once everything else had loaded. That is also why the choice is
// kept in localStorage rather than browserAPI.storage: it has to be read
// synchronously. It is a preference about this screen, not a setting.
//
// The nav code used to be an inline <script> in options.html. The extension's
// CSP (script-src 'self') refuses to run inline scripts, so in the installed
// extension the links jumped without scrolling and no section was ever marked
// active. It only ever worked when the page was opened outside the extension.
(function () {
  'use strict';

  var FULL_WIDTH_KEY = 'pblocker_options_full_width';
  var root = document.documentElement;

  function isFullWidth() {
    return root.getAttribute('data-layout') === 'full';
  }

  function applyFullWidth(full) {
    if (full) root.setAttribute('data-layout', 'full');
    else root.removeAttribute('data-layout');
  }

  try {
    applyFullWidth(localStorage.getItem(FULL_WIDTH_KEY) === '1');
  } catch (_) {}

  function initWidthToggle() {
    var btn = document.getElementById('layout-toggle');
    if (!btn) return;
    function sync() {
      var full = isFullWidth();
      var label = full ? 'Return to standard width' : 'Expand content to full width';
      btn.setAttribute('aria-pressed', full ? 'true' : 'false');
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    btn.addEventListener('click', function () {
      var full = !isFullWidth();
      applyFullWidth(full);
      try { localStorage.setItem(FULL_WIDTH_KEY, full ? '1' : '0'); } catch (_) {}
      sync();
    });
    sync();
  }

  function initNav() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.nav-link[data-target]'));
    if (!links.length) return;
    var byId = {};
    links.forEach(function (l) { byId[l.dataset.target] = l; });
    links.forEach(function (l) {
      l.addEventListener('click', function (e) {
        e.preventDefault();
        var el = document.getElementById(l.dataset.target);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    var sections = links
      .map(function (l) { return document.getElementById(l.dataset.target); })
      .filter(Boolean);
    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            links.forEach(function (x) { x.classList.remove('active'); });
            if (byId[en.target.id]) byId[en.target.id].classList.add('active');
          }
        });
      }, { rootMargin: '-15% 0px -75% 0px', threshold: 0 });
      sections.forEach(function (s) { obs.observe(s); });
    }
    links[0].classList.add('active');
  }

  function init() {
    initWidthToggle();
    initNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
