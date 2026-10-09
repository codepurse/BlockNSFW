// options-layout.js — the settings page's own layout behaviour: the
// full-width toggle, the welcome cards folding to one line once read, the
// Warden banner's countdown, and the sidebar, which shows one section at a
// time.
//
// Loaded from <head>, not the end of <body>, so a saved full-width choice is
// on <html> before the first paint. Applied any later, the page would visibly
// jump wider once everything else had loaded. That is also why the choice is
// kept in localStorage rather than browserAPI.storage: it has to be read
// synchronously. It is a preference about this screen, not a setting. The
// same holds for which welcome cards have been read.
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

  // Settings shows one section at a time, named in the address
  // (options.html#security; the older #section-security still works). Set
  // here, before the page is parsed, so the first paint shows only that
  // section. An address that names something inside a section
  // (#own-words-group) opens on Welcome for a moment, until the page exists
  // and the section holding it can be found.
  var SECTIONS = ['welcome', 'protection', 'customization', 'security', 'community', 'about'];
  function sectionFromHash(hash) {
    var name = String(hash || '').replace(/^#/, '').replace(/^section-/, '');
    return SECTIONS.indexOf(name) >= 0 ? name : null;
  }
  try {
    root.setAttribute('data-section', sectionFromHash(location.hash) || 'welcome');
  } catch (_) {}

  // The two cards at the top of Settings. What's New remembers the version it
  // was showing when "Got it" was pressed, and opens in full again by itself on
  // the next one. The developer's banner remembers nothing: it opens on every
  // visit, and its × folds it for that visit only.
  function manifestVersion() {
    try {
      var api = typeof browser !== 'undefined' ? browser : chrome;
      return api.runtime.getManifest().version || '';
    } catch (_) {
      return '';
    }
  }

  var WELCOME_CARDS = [
    // No key, so nothing is kept.
    { card: 'dev-message-card', attr: 'data-dev-message-read' },
    {
      card: 'whats-new-card',
      attr: 'data-whats-new-read',
      key: 'pblocker_whats_new_read',
      shows: manifestVersion()
    }
  ];

  WELCOME_CARDS.forEach(function (w) {
    try {
      if (w.key && w.shows && localStorage.getItem(w.key) === w.shows) root.setAttribute(w.attr, '');
    } catch (_) {}
  });

  function initWelcomeCards() {
    WELCOME_CARDS.forEach(function (w) {
      var card = document.getElementById(w.card);
      if (!card) return;
      var strip = card.querySelector('[data-welcome="open"]');
      var ack = card.querySelector('[data-welcome="ack"]');
      var heading = card.querySelector('[data-welcome="heading"]');
      if (ack) {
        ack.addEventListener('click', function () {
          root.setAttribute(w.attr, '');
          try { if (w.key && w.shows) localStorage.setItem(w.key, w.shows); } catch (_) {}
          if (strip) strip.focus();
        });
      }
      // Opening What's New from its strip is for this visit only: it stays
      // put away.
      if (strip) {
        strip.addEventListener('click', function () {
          root.removeAttribute(w.attr);
          if (heading) heading.focus();
        });
      }
    });

    var meta = document.getElementById('whats-new-strip-meta');
    if (meta) {
      var count = document.querySelectorAll('#whats-new-card .wn-list > li').length;
      var parts = [];
      var version = manifestVersion();
      if (version) parts.push(version);
      if (count) parts.push(count + (count === 1 ? ' change' : ' changes'));
      meta.textContent = parts.join(' · ');
    }
  }

  // The Warden banner's dial counts a cool-down down, the way Warden makes a
  // change that loosens protection wait. It is an illustration: it starts from
  // the same time on every visit, ticks only while the page is in view, and
  // stands still for anyone who asked for reduced motion. The arc is the
  // seconds left in the current minute, so it steps one tick at a time.
  var COOLDOWN_START = 23 * 3600 + 59 * 60 + 41; // 23:59:41
  var COOLDOWN_TOTAL = 24 * 3600;

  function initWardenCooldown() {
    var times = document.querySelectorAll('[data-cooldown]');
    var arc = document.querySelector('.warden-dial-arc');
    if (!times.length && !arc) return;
    var length = arc ? Number(arc.getAttribute('stroke-dasharray')) : 0;
    var left = COOLDOWN_START;
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    function draw() {
      var text = pad(Math.floor(left / 3600)) + ':' + pad(Math.floor((left % 3600) / 60)) + ':' + pad(left % 60);
      for (var i = 0; i < times.length; i++) times[i].textContent = text;
      if (arc) arc.setAttribute('stroke-dashoffset', (length * (1 - (left % 60) / 60)).toFixed(2));
    }
    draw();
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) return;
    setInterval(function () {
      if (document.hidden) return;
      left = left > 0 ? left - 1 : COOLDOWN_TOTAL - 1;
      draw();
    }, 1000);
  }

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

  // The sidebar opens one section at a time. Each is a page of its own in
  // the history, so Back returns to the section before.
  function initNav() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.nav-link[data-target]'));
    if (!links.length) return;
    function nameOf(link) { return String(link.dataset.target).replace(/^section-/, ''); }
    function heading(name) {
      return document.querySelector('#section-' + name + ' .section-head');
    }
    function show(name, keepScroll) {
      root.setAttribute('data-section', name);
      links.forEach(function (l) {
        var on = nameOf(l) === name;
        l.classList.toggle('active', on);
        if (on) l.setAttribute('aria-current', 'page');
        else l.removeAttribute('aria-current');
      });
      if (!keepScroll) window.scrollTo(0, 0);
    }
    // Moves keyboard and screen-reader focus to the new section's title, so
    // the change is announced and Tab starts from the top of it.
    function focusHeading(name) {
      var h = heading(name);
      if (!h) return;
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
    // Something inside a section: open that section, then bring it into view.
    function reveal(el) {
      var section = el && el.closest ? el.closest('.main > .section') : null;
      if (!section) return false;
      var name = section.id.replace(/^section-/, '');
      if (SECTIONS.indexOf(name) < 0) return false;
      show(name, true);
      el.scrollIntoView({ block: 'start' });
      return true;
    }
    function route() {
      var hash = location.hash;
      var name = sectionFromHash(hash);
      if (name) { show(name); return; }
      var target = null;
      try { target = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null; } catch (_) {}
      if (target && reveal(target)) return;
      show(root.getAttribute('data-section') || SECTIONS[0], true);
    }
    links.forEach(function (l) {
      var name = nameOf(l);
      l.setAttribute('href', '#' + name);
      l.addEventListener('click', function (e) {
        // A new tab or window opens the section there, as a link would.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (location.hash !== '#' + name) history.pushState(null, '', '#' + name);
        show(name);
        focusHeading(name);
      });
    });
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);
    // For options.js: open the section holding a control before focusing it.
    window.BlockNSFWSettings = { reveal: reveal };
    route();
  }

  function init() {
    initWidthToggle();
    initWelcomeCards();
    initWardenCooldown();
    initNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
