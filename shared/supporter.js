// shared/supporter.js
// Supporter: pay once, and the extras are yours for good.
//
// Blocking is the same for everyone. Nothing that blocks, filters, waits or
// guards reads this file; it only opens the extras: the path past its first
// week, the evening check-in, and your good days.
//
// Two kinds of code open them.
//
// A store code comes from Polar, the payment site, by email after someone
// pays, for a monthly, yearly or lifetime plan. The extension asks Polar
// whether it is a real, paid code when it is entered, then about once a day,
// so a plan that has ended closes the extras. Offline, the answer it has
// stands.
//
// A plan works on a few browsers at once: Polar's activation limit on the
// license key, set in Polar (RELEASE_CHECKLIST.md, section 0). Entering the
// code takes one of its places, named for the browser ("BlockNSFW · Chrome on
// Windows"); Settings › Supporter gives it back, so the plan can move. With
// no limit set in Polar, a code simply works wherever it's entered. Only the
// code, the store's organization id and that name are sent, never anything
// about browsing.
//
// A signed code ("BN1-…") is one the author makes by hand with
// tools/supporter-codes.mjs: for Android supporters, gifts, and anyone who
// can't afford it. It is a short note (a version, a number, the day it was
// made) signed with the author's key, checked against PUBLIC_KEY on the
// device, and never sent anywhere. One that turns up shared is closed by
// adding its number to REVOKED.
//
// (The source is open, so anyone can change this file. That's fine: a code
// is a thank-you, not a lock.)
//
// Signed format: "BN1-" + base64url(payload + signature).
//   payload, 7 bytes: [0] version 1, [1..4] number (uint32, big-endian),
//                     [5..6] the day it was made, counted from 2026-01-01
//   signature: ECDSA P-256 with SHA-256 over the payload, raw r and s (64 bytes)
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var KEY = 'pblocker_supporter';   // storage.local: { kind, code, number?, since, checkedAt?, activationId?, limit?, ended?, removed? }
  var PREFIX = 'BN1-';
  var VERSION = 1;
  var PAYLOAD_BYTES = 7;
  var SIG_BYTES = 64;
  var EPOCH = Date.UTC(2026, 0, 1);
  var DAY = 24 * 60 * 60 * 1000;

  // The store. `mode` is 'sandbox' while testing with Polar's test store and
  // 'live' for real purchases; a code from one doesn't open the other.
  // Until organizationId is set, store codes say they aren't switched on yet.
  var STORE = {
    mode: 'sandbox',
    organizationId: '35c82b93-77a2-4b87-8478-39fc5dd4e666',
    api: { sandbox: 'https://sandbox-api.polar.sh', live: 'https://api.polar.sh' },
    // Where buyers find their code and manage or cancel a plan.
    portal: { sandbox: 'https://sandbox.polar.sh/monolab/portal', live: 'https://polar.sh/monolab/portal' }
  };

  // The plans, in the order Settings shows them; `best` is the one chosen to
  // begin with. `url` is each plan's Polar checkout link. A plan without one
  // isn't offered; with none at all, Settings shows the prices and says
  // Supporter opens soon instead of showing a button.
  var PLANS = [
    { id: 'monthly', name: 'Monthly', price: '$2.99', per: 'a month', note: '',
      url: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_zrWeqAon4KrGFiby4Mx0o898RAWPqz4tE8wxm3K3ceT/redirect' },
    { id: 'yearly', name: 'Yearly', price: '$24.99', per: 'a year', note: 'Save 30%', best: true,
      url: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_dEz1SAPFLH4HN3QthpFeMuu4Dcrq96vDQbroo1ucr83/redirect' },
    { id: 'lifetime', name: 'Lifetime', price: '$49.99', per: 'once', note: '', url: '' }
  ];

  // An offer with an end, such as a founding price for the first month: a
  // Polar discount code and the last day it works. Settings shows the line
  // until that day has passed, then drops it by itself. null for none.
  //   { text: 'Founding supporters: $10 off Lifetime with code FOUNDING.', until: '2026-11-30' }
  var OFFER = null;

  // A store code is asked about again after this long, so a monthly or yearly
  // plan that has ended closes the extras. A cancelled plan runs to the end
  // of the period paid for; Polar turns the code off then, and the extras
  // close within this long after. Offline, it stays as it was.
  var RECHECK_MS = 24 * 60 * 60 * 1000;

  // Offline, the last answer stands, but not for ever: a store code the store
  // hasn't confirmed for this long pauses the extras until it can (they come
  // back with the next answer, nothing lost). Otherwise a code no store ever
  // sold would stay open for as long as the store stayed out of reach.
  var OFFLINE_GRACE_MS = 14 * DAY;

  var PUBLIC_KEY = {
    kty: 'EC',
    crv: 'P-256',
    x: '-pyWnALMjKN7eHj2hWwdByIUcPf0tghRe15h3vdIghQ',
    y: 'zyIAVRNawSvJasHxfBqXLMdQR8zXeT_wqt6YjPGOhNE'
  };

  // Signed codes that turned up shared, by number (the note kept with
  // tools/supporter-codes.mjs says whose each was). A number added here
  // closes that code on every copy that takes the update; make the person a
  // new one.   e.g. [1042, 1077]
  var REVOKED = [];

  // --- Bytes -------------------------------------------------------------------

  function toB64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(text) {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
    var s = text.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin;
    try { bin = atob(s); } catch (_) { return null; }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function dayNumber(ms) {
    return Math.max(0, Math.min(0xffff, Math.floor((ms - EPOCH) / DAY)));
  }

  function payloadFor(number, day) {
    var p = new Uint8Array(PAYLOAD_BYTES);
    p[0] = VERSION;
    p[1] = (number >>> 24) & 0xff;
    p[2] = (number >>> 16) & 0xff;
    p[3] = (number >>> 8) & 0xff;
    p[4] = number & 0xff;
    p[5] = (day >>> 8) & 0xff;
    p[6] = day & 0xff;
    return p;
  }

  function encode(payload, sig) {
    var all = new Uint8Array(payload.length + sig.length);
    all.set(payload, 0);
    all.set(sig, payload.length);
    return PREFIX + toB64url(all);
  }

  // A pasted code may carry spaces, line breaks or a lower-case prefix from
  // an email; none of those are part of it.
  function clean(code) {
    var s = String(code == null ? '' : code).replace(/\s+/g, '');
    if (s.slice(0, PREFIX.length).toUpperCase() === PREFIX) s = s.slice(PREFIX.length);
    return s;
  }

  // { payload, sig, number, issued } or null when it isn't shaped like a code.
  function parse(code) {
    var bytes = fromB64url(clean(code));
    if (!bytes || bytes.length !== PAYLOAD_BYTES + SIG_BYTES || bytes[0] !== VERSION) return null;
    var number = ((bytes[1] << 24) >>> 0) + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4];
    var day = (bytes[5] << 8) + bytes[6];
    return {
      payload: bytes.slice(0, PAYLOAD_BYTES),
      sig: bytes.slice(PAYLOAD_BYTES),
      number: number,
      issued: EPOCH + day * DAY
    };
  }

  // --- Checking ------------------------------------------------------------------

  function cryptoSubtle(opts) {
    if (opts && opts.subtle) return opts.subtle;
    var c = typeof crypto !== 'undefined' ? crypto : (root && root.crypto);
    return c && c.subtle ? c.subtle : null;
  }

  // { ok: true, number, issued } or { ok: false, reason }.
  function verify(code, opts) {
    var parsed = parse(code);
    if (!parsed) return Promise.resolve({ ok: false, reason: 'that isn’t a whole supporter code' });
    var subtle = cryptoSubtle(opts);
    if (!subtle) return Promise.resolve({ ok: false, reason: 'this browser can’t check it' });
    var jwk = (opts && opts.publicKey) || PUBLIC_KEY;
    return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      .then(function (key) {
        return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, parsed.sig, parsed.payload);
      })
      .then(function (good) {
        if (!good) return { ok: false, reason: 'that code doesn’t match' };
        var revoked = (opts && opts.revoked) || REVOKED;
        if (revoked.indexOf(parsed.number) !== -1) return { ok: false, reason: 'that code has been turned off', revoked: true };
        return { ok: true, number: parsed.number, issued: parsed.issued };
      }, function () {
        return { ok: false, reason: 'that code doesn’t match' };
      });
  }

  // --- Store codes ------------------------------------------------------------------

  // 'signed' for a BN1- code, 'store' for anything else code-shaped, or null.
  function kindOf(code) {
    var s = String(code == null ? '' : code).replace(/\s+/g, '');
    if (!s) return null;
    if (s.slice(0, PREFIX.length).toUpperCase() === PREFIX) return 'signed';
    return /^[A-Za-z0-9_-]{8,128}$/.test(s) ? 'store' : null;
  }

  function storeApi(opts) {
    var store = (opts && opts.store) || STORE;
    return { base: store.api[store.mode] || store.api.live, organizationId: store.organizationId };
  }

  // One request to the store. Resolves to { status, body } (body null when
  // there's none to read, `garbled` when there was one but it wasn't JSON),
  // or { offline, reason? } when the request never got an answer.
  function storeCall(path, payload, opts) {
    var doFetch = (opts && opts.fetch) || (typeof fetch === 'function' ? fetch.bind(root) : null);
    if (!doFetch) return Promise.resolve({ offline: true, reason: 'this browser can’t check it' });
    return doFetch(storeApi(opts).base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok || res.status === 204) return { status: res.status, body: null };
      return Promise.resolve(res.json()).then(function (body) {
        return { status: res.status, body: body };
      }, function () {
        return { status: res.status, body: null, garbled: true };
      });
    }, function () {
      return { offline: true };
    });
  }

  function unanswered(r) {
    return { ok: false, reason: r.reason || 'couldn’t reach the store. Check your connection and try again', offline: true };
  }

  // Asks the store whether this is a real, paid code. One request to Polar,
  // carrying the code, the store's organization id, and this browser's place
  // on the plan when it has one.
  //   { ok: true, id, limit } or { ok: false, reason, offline?, definite? }
  // `limit` is how many browsers the plan works on at once (0: no limit).
  // `definite` means the store said no (unknown, turned off, run out, or not
  // this browser's place), as opposed to not answering or not being asked.
  function verifyStore(code, opts, now, activationId) {
    var key = String(code == null ? '' : code).replace(/\s+/g, '');
    var api = storeApi(opts);
    if (!api.organizationId) return Promise.resolve({ ok: false, reason: 'codes from the store aren’t switched on yet' });
    var payload = { key: key, organization_id: api.organizationId };
    if (activationId) payload.activation_id = activationId;
    return storeCall('/v1/customer-portal/license-keys/validate', payload, opts).then(function (r) {
      if (r.offline) return unanswered(r);
      if (r.status === 404) return { ok: false, reason: 'that code doesn’t match', definite: true };
      if (r.status === 422) return { ok: false, reason: 'that code doesn’t match' };
      if (r.status < 200 || r.status >= 300 || r.garbled) return { ok: false, reason: 'the store didn’t answer. Try again in a minute', offline: true };
      var body = r.body;
      if (!body || body.status !== 'granted') return { ok: false, reason: 'that code has been turned off', definite: true };
      if (body.expires_at && Date.parse(body.expires_at) < now) return { ok: false, reason: 'that code has run out', definite: true };
      return { ok: true, id: String(body.id || ''), limit: Math.max(0, Math.floor(Number(body.limit_activations) || 0)) };
    });
  }

  // What this browser is called on the purchases page, so a buyer can tell
  // their places apart: "BlockNSFW · Chrome on Windows". Nothing more.
  function deviceLabel(opts) {
    if (opts && opts.label) return opts.label;
    var ua = typeof navigator !== 'undefined' && navigator && navigator.userAgent ? navigator.userAgent : '';
    var browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /OPR\//.test(ua) ? 'Opera' : 'Chrome';
    var os = /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS'
      : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return 'BlockNSFW · ' + browser + (os ? ' on ' + os : '');
  }

  // Takes one of the plan's places for this browser.
  //   { ok: true, activationId } or { ok: false, reason, full?, definite?, offline? }
  // `full` means every place is taken.
  function activateStore(code, opts, limit) {
    var api = storeApi(opts);
    var payload = { key: code, organization_id: api.organizationId, label: deviceLabel(opts) };
    return storeCall('/v1/customer-portal/license-keys/activate', payload, opts).then(function (r) {
      if (r.offline) return unanswered(r);
      if (r.status === 403) {
        var where = limit === 1 ? 'one browser' : (limit || 'as many') + ' browsers';
        return { ok: false, full: true, reason: 'that code is already on ' + where + ', as many as a plan allows. Remove it from one of them first: in Settings › Supporter there, or on your purchases page' };
      }
      if (r.status === 404) return { ok: false, reason: 'that code doesn’t match', definite: true };
      if (r.status < 200 || r.status >= 300 || !r.body || !r.body.id) return { ok: false, reason: 'the store didn’t answer. Try again in a minute', offline: true };
      return { ok: true, activationId: String(r.body.id) };
    });
  }

  // --- Stored -----------------------------------------------------------------------

  function keep(storage, rec) {
    var write = {};
    write[KEY] = rec;
    return Promise.resolve(storage.set(write));
  }

  function forget(storage) {
    return Promise.resolve(typeof storage.remove === 'function' ? storage.remove(KEY) : keep(storage, null));
  }

  // { supporter, kind?, number?, since?, limit?, ended?, removed?, unchecked? }.
  // `storage` is a storage.local area. A signed code is checked again here,
  // on the device. A store code is asked about again once RECHECK_MS has
  // passed since the last answer (or at once with opts.force): still paid
  // keeps it, a definite no closes the extras (and says when), and no answer
  // leaves it as it was for up to OFFLINE_GRACE_MS since the last answer;
  // after that, `unchecked` until the store answers. `removed` says this
  // browser lost its place on the plan (taken
  // back on the purchases page, or every place taken by the time Polar's
  // limit came in) while the plan itself goes on: the code entered again
  // takes a place back if there's one free.
  function status(storage, opts) {
    var now = (opts && opts.now) || Date.now();
    return Promise.resolve(storage.get(KEY)).then(function (got) {
      var rec = got && got[KEY];
      if (!rec || typeof rec.code !== 'string') return { supporter: false };
      var since = Number(rec.since) || 0;
      if (rec.kind === 'store') {
        if (kindOf(rec.code) !== 'store') return { supporter: false };
        if (Number(rec.removed) > 0) return { supporter: false, kind: 'store', removed: Number(rec.removed) };
        if (Number(rec.ended) > 0) return { supporter: false, kind: 'store', ended: Number(rec.ended) };
        var held = typeof rec.activationId === 'string' ? rec.activationId : '';
        var yes = function (limit) {
          var s = { supporter: true, kind: 'store', since: since };
          if (limit) s.limit = limit;
          return s;
        };
        var save = function (more) { return keep(storage, Object.assign({}, rec, more)); };
        var ended = function () {
          return save({ ended: now }).then(function () { return { supporter: false, kind: 'store', ended: now }; });
        };
        var removed = function () {
          return save({ removed: now }).then(function () { return { supporter: false, kind: 'store', removed: now }; });
        };
        var checked = Number(rec.checkedAt) || since;
        // A check dated later than now is no check at all: ask now.
        var age = checked <= now ? now - checked : Infinity;
        // No answer: the last one stands, within the grace.
        var unanswered = function () {
          return age < OFFLINE_GRACE_MS ? yes(Number(rec.limit) || 0) : { supporter: false, kind: 'store', unchecked: true };
        };
        if (!(opts && opts.force) && age < RECHECK_MS) return yes(Number(rec.limit) || 0);
        return verifyStore(rec.code, opts, now, held).then(function (r) {
          if (r.ok && r.limit && !held) {
            // Polar's limit came in after this code was entered here.
            return activateStore(rec.code, opts, r.limit).then(function (a) {
              if (a.ok) return save({ checkedAt: now, activationId: a.activationId, limit: r.limit }).then(function () { return yes(r.limit); });
              if (a.full) return removed();
              if (a.definite) return ended();
              return unanswered();
            });
          }
          if (r.ok) {
            var more = { checkedAt: now };
            if (r.limit) more.limit = r.limit;
            return save(more).then(function () { return yes(r.limit); });
          }
          if (r.definite && held) {
            // Either the plan is over, or this browser's place was taken back.
            return verifyStore(rec.code, opts, now).then(function (plain) {
              if (plain.ok) return removed();
              if (plain.definite) return ended();
              return unanswered();
            });
          }
          if (r.definite) return ended();
          return unanswered();
        });
      }
      return verify(rec.code, opts).then(function (r) {
        return r.ok
          ? { supporter: true, kind: 'signed', number: r.number, since: since }
          : { supporter: false };
      });
    }, function () { return { supporter: false }; });
  }

  // A store code: asked about, then given one of the plan's places when the
  // plan has a limit. The same code entered again here keeps its place.
  function unlockStore(storage, code, now, opts) {
    var key = String(code).replace(/\s+/g, '');
    var save = function (r, activationId) {
      var rec = { kind: 'store', code: key, since: now, checkedAt: now };
      if (activationId) rec.activationId = activationId;
      if (r.limit) rec.limit = r.limit;
      return keep(storage, rec).then(function () { return r; });
    };
    var old = Promise.resolve(storage.get(KEY)).then(function (got) { return got && got[KEY]; }, function () { return null; });
    return old.then(function (rec) {
      var held = rec && rec.kind === 'store' && rec.code === key && !rec.removed && typeof rec.activationId === 'string' ? rec.activationId : '';
      return (held ? verifyStore(key, opts, now, held) : Promise.resolve(null)).then(function (h) {
        if (h && h.ok) return save(h, held);
        return verifyStore(key, opts, now).then(function (r) {
          if (!r.ok) return r;
          if (!r.limit) return save(r, '');
          return activateStore(key, opts, r.limit).then(function (a) {
            return a.ok ? save(r, a.activationId) : a;
          });
        });
      });
    });
  }

  // Checks a code of either kind and keeps it. Resolves to { ok, reason? }.
  function unlock(storage, code, now, opts) {
    var kind = kindOf(code);
    if (!kind) return Promise.resolve({ ok: false, reason: 'that isn’t a whole supporter code' });
    if (kind === 'store') return unlockStore(storage, code, now, opts);
    return verify(code, opts).then(function (r) {
      if (!r.ok) return r;
      return keep(storage, { kind: 'signed', code: PREFIX + clean(code), number: r.number, since: now }).then(function () { return r; });
    });
  }

  // Gives this browser's place on the plan back to the store, then forgets
  // the code here, so the plan can move to another browser. Resolves to
  // { ok, reason? }. Offline, nothing changes: forgetting the code without
  // telling the store would leave the place taken.
  function release(storage, opts) {
    return Promise.resolve(storage.get(KEY)).then(function (got) {
      var rec = got && got[KEY];
      var held = rec && rec.kind === 'store' && !rec.removed && !rec.ended && typeof rec.activationId === 'string' ? rec.activationId : '';
      var done = function () { return forget(storage).then(function () { return { ok: true }; }); };
      if (!held) return done();
      var payload = { key: rec.code, organization_id: storeApi(opts).organizationId, activation_id: held };
      return storeCall('/v1/customer-portal/license-keys/deactivate', payload, opts).then(function (r) {
        // 404: the store has no such place any more, which is what was asked.
        if (!r.offline && ((r.status >= 200 && r.status < 300) || r.status === 404)) return done();
        return { ok: false, reason: 'couldn’t reach the store, so this browser still holds its place. Try again when you’re online' };
      });
    });
  }

  // --- Plans ----------------------------------------------------------------------

  // The store's purchases page, for the store's mode.
  function portalUrl(opts) {
    var store = (opts && opts.store) || STORE;
    return store.portal[store.mode] || store.portal.live;
  }

  // Whether any plan can be bought yet.
  function buyable() {
    return PLANS.some(function (p) { return !!p.url; });
  }

  // The plans to show: those with a checkout link, or all of them (to show
  // the prices) while none has one. Exactly one is `chosen`: the best one,
  // or the first shown when the best has no link.
  function offered() {
    var list = buyable() ? PLANS.filter(function (p) { return !!p.url; }) : PLANS.slice();
    var best = list.filter(function (p) { return p.best; })[0] || list[0];
    return list.map(function (p) { return Object.assign({}, p, { chosen: p === best }); });
  }

  // The offer line, while its last day hasn't passed.
  function offerFor(now) {
    if (!OFFER || !OFFER.text) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(OFFER.until || '');
    if (!m) return null;
    var end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
    return now < end ? OFFER.text : null;
  }

  var exported = {
    KEY: KEY,
    PREFIX: PREFIX,
    STORE: STORE,
    PLANS: PLANS,
    RECHECK_MS: RECHECK_MS,
    OFFLINE_GRACE_MS: OFFLINE_GRACE_MS,
    PUBLIC_KEY: PUBLIC_KEY,
    buyable: buyable,
    offered: offered,
    portalUrl: portalUrl,
    offerFor: offerFor,
    kindOf: kindOf,
    REVOKED: REVOKED,
    verifyStore: verifyStore,
    deviceLabel: deviceLabel,
    dayNumber: dayNumber,
    payloadFor: payloadFor,
    encode: encode,
    clean: clean,
    parse: parse,
    verify: verify,
    status: status,
    unlock: unlock,
    release: release
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Supporter = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
