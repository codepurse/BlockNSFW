// options-layout.js — the settings page's own layout behaviour: the
// full-width toggle, the welcome cards folding to one line once read, the
// Warden banner's countdown, and the sidebar nav's smooth scroll and active
// section.
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
    function activate(link) {
      links.forEach(function (x) { x.classList.remove('active'); });
      link.classList.add('active');
    }
    // With both welcome cards folded, the first section is too short to ever
    // reach the band below, and the second would be marked at the very top
    // of the page. At the top, the first link is the one marked.
    function atTop() { return window.scrollY < 8; }
    var current = links[0]; // the section in the band
    function sync() { activate(atTop() ? links[0] : current); }
    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && byId[en.target.id]) current = byId[en.target.id];
        });
        sync();
      }, { rootMargin: '-15% 0px -75% 0px', threshold: 0 });
      sections.forEach(function (s) { obs.observe(s); });
      var wasTop = atTop();
      window.addEventListener('scroll', function () {
        if (atTop() === wasTop) return;
        wasTop = atTop();
        sync();
      }, { passive: true });
    }
    activate(links[0]);
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
