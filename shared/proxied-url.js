// shared/proxied-url.js
// The real address behind a page shown through Google Translate or the
// Wayback Machine.
//
// Both serve someone else's site from their own host, so a listed site opened
// through them arrives under a host the blocklist has never heard of:
//
//   www-example-com.translate.goog/path        (Translate's proxy)
//   translate.google.com/translate?u=URL       (Translate's older page)
//   web.archive.org/web/20240101000000/https://example.com/
//
// The keyword filter still caught a host with an adult word in its name, but a
// listed site with a plain name went straight through. unwrap() gives back the
// address being shown, so it can be checked like the site itself.
//
// In a content script this file is loaded before content.js via manifest.json;
// the background loads it too; in Node it exports the same helpers for tests.

(function (root) {
  'use strict';

  // Translate writes the site's host into one label: each "." becomes "-" and
  // each "-" becomes "--" (my-site.example.com -> my--site-example-com).
  var TRANSLATE_PROXY = /^(.+)\.translate\.goog$/;
  var TRANSLATE_PAGE = /^translate\.(google\.[a-z.]+|googleusercontent\.com)$/;
  // Translate's own parameters on a proxied page; they are not the site's.
  var TRANSLATE_PARAM = /^_x_tr_/;
  var WAYBACK = /^(web|wayback|web-beta)\.archive\.org$/;
  // A Wayback timestamp with its optional modifier (im_, id_, if_), or the
  // wildcard of a calendar page: 20240101000000, 20240101000000im_, 2024*, *
  var WAYBACK_STAMP = /^[0-9]{0,14}\*?([a-z]{2}_)?$/;
  var HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  // Translate can show the Wayback Machine, which can show Translate. Three
  // layers is more than any real address has.
  var MAX_DEPTH = 3;

  function toUrl(urlLike) {
    if (!urlLike) return null;
    if (typeof urlLike === 'object' && typeof urlLike.hostname === 'string') return urlLike;
    try {
      return new URL(String(urlLike));
    } catch (_) {
      return null;
    }
  }

  // www-example-com -> www.example.com, my--site-com -> my-site.com,
  // xn----p1ai -> xn--p1ai
  function decodeTranslateHost(label) {
    var out = '';
    for (var i = 0; i < label.length; i++) {
      var ch = label.charAt(i);
      if (ch !== '-') {
        out += ch;
      } else if (label.charAt(i + 1) === '-') {
        out += '-';
        i++;
      } else {
        out += '.';
      }
    }
    return HOST.test(out) ? out : null;
  }

  // An address as Translate or the Wayback Machine carries it, which may have
  // lost its scheme (example.com/page), a slash (https:/example.com) or been
  // percent-encoded whole.
  function toAddress(text) {
    var t = String(text || '').trim();
    if (/^https?%3a/i.test(t)) {
      try { t = decodeURIComponent(t); } catch (_) { return null; }
    }
    if (!t) return null;
    var m = /^(https?):\/*(.*)$/i.exec(t);
    var candidate = m ? m[1].toLowerCase() + '://' + m[2] : 'http://' + t;
    try {
      var u = new URL(candidate);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!HOST.test(u.hostname)) return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function unwrapOnce(u) {
    var host = String(u.hostname || '').toLowerCase();

    var proxied = TRANSLATE_PROXY.exec(host);
    if (proxied) {
      var real = decodeTranslateHost(proxied[1]);
      if (!real) return null;
      var kept = [];
      new URLSearchParams(u.search || '').forEach(function (value, key) {
        if (!TRANSLATE_PARAM.test(key)) kept.push([key, value]);
      });
      var search = kept.length ? '?' + new URLSearchParams(kept).toString() : '';
      return 'https://' + real + (u.pathname || '/') + search;
    }

    if (TRANSLATE_PAGE.test(host)) {
      return toAddress(new URLSearchParams(u.search || '').get('u'));
    }

    if (WAYBACK.test(host)) {
      var path = u.pathname || '';
      if (path.indexOf('/web/') !== 0) return null;
      var rest = path.slice('/web/'.length);
      var slash = rest.indexOf('/');
      if (slash !== -1 && WAYBACK_STAMP.test(rest.slice(0, slash).toLowerCase())) {
        rest = rest.slice(slash + 1);
      }
      // A calendar search ends in a wildcard: example.com*
      rest = rest.replace(/\*+$/, '');
      return toAddress(rest + (u.search || ''));
    }

    return null;
  }

  /**
   * The address a Translate or Wayback Machine page is showing, or null when
   * the address is not one of theirs.
   *
   * @param {string|URL|Location} urlLike
   * @returns {string|null}
   */
  function unwrap(urlLike) {
    var u = toUrl(urlLike);
    var found = null;
    for (var depth = 0; u && depth < MAX_DEPTH; depth++) {
      var next = unwrapOnce(u);
      if (!next) break;
      found = next;
      u = toUrl(next);
    }
    return found;
  }

  var exported = {
    unwrap: unwrap,
    decodeTranslateHost: decodeTranslateHost
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.ProxiedUrl = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
