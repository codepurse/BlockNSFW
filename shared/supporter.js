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
// pays, for a monthly, yearly or lifetime plan. The extension asks
// monolab.dev whether it is a real, paid code when it is entered, then about
// once a day, so a plan that has ended closes the extras. monolab.dev asks
// Polar, and answers a yes with a receipt signed by a key only it holds
// (Portfolio repo, lib/blocknsfw-receipt.ts, has the layout); the extension
// checks it against RECEIPT_PUBLIC_KEY. A record typed into storage by hand
// has no receipt that checks, so it opens nothing, online or off. Offline,
// the receipt it has stands until it runs out (OFFLINE_GRACE_MS).
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

  var KEY = 'pblocker_supporter';   // storage.local: { kind, code, number?, since, checkedAt?, receipt?, activationId?, limit?, ended?, removed? }
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
    mode: 'live',
    organizationId: '354a2f6c-8ea7-46a7-87c5-f97645c12e29',
    api: { sandbox: 'https://sandbox-api.polar.sh', live: 'https://api.polar.sh' },
    // Where a code is asked about, for either mode (the mode goes with it).
    receipt: 'https://monolab.dev/api/blocknsfw/receipt',
    // Where buyers find their code and manage or cancel a plan.
    portal: { sandbox: 'https://sandbox.polar.sh/monolab/portal', live: 'https://polar.sh/monolab/portal' }
  };

  // The plans, in the order Settings shows them; `best` is the one chosen to
  // begin with. `url` is each plan's Polar checkout link. A plan without one
  // isn't offered; with none at all, Settings shows the prices and says
  // Supporter opens soon instead of showing a button.
  var PLANS = [
    { id: 'monthly', name: 'Monthly', price: '$4.99', per: 'a month', note: '',
      url: 'https://api.polar.sh/v1/checkout-links/polar_cl_3HoAfQuBk8UGkoMsCqXyFIgq2Gfh0uivZJOzf2U3TFG/redirect' },
    { id: 'yearly', name: 'Yearly', price: '$29.99', per: 'a year', note: '$2.50 a month', best: true,
      url: 'https://api.polar.sh/v1/checkout-links/polar_cl_K2iTFH90BwoBLA1Qrl8OrtvZs2i44EzVL23Hr0egjKt/redirect' },
    { id: 'lifetime', name: 'Lifetime', price: '$89.99', per: 'once', note: '',
      url: 'https://api.polar.sh/v1/checkout-links/polar_cl_31MDhvtZNNC3FmBUQ9b7ZTSc0dsMcrGypA4652KTs9F/redirect' }
  ];

  // An offer with an end, such as a founding price for the first month. It
  // has two halves, and both have to be set:
  //   - What buyers pay: a Polar discount, attached to the plans' checkout
  //     links as a preset, ending the same day. Without it, the prices
  //     Settings shows are a promise the checkout doesn't keep.
  //   - What Settings says: an `offer` in data/version.json, which the
  //     background fetches with the update check (about twice a day), so an
  //     offer starts and ends without a new release:
  //       "offer": { "name": "Founding offer",
  //                  "title": "30% off Yearly and Lifetime",
  //                  "text": "A yearly plan keeps this price for as long as you stay.",
  //                  "until": "2026-11-13",
  //                  "prices": { "yearly": "$20.99", "lifetime": "$62.99" } }
  //     Settings heads the plans with it: the name and the last day small,
  //     the title large, the text under it. The sidebar's Supporter entry
  //     says the name and the last day too. `name`, `title` and `prices` are
  //     optional; each price must be lower than the plan's own.
  // OFFER is the same thing built in, for an offer that ships with a release;
  // one from version.json wins. Settings drops either by itself once its
  // last day has passed. null for none.
  var OFFER = {
    name: 'Founding offer',
    title: '30% off Yearly and Lifetime',
    text: 'For our first supporters. A yearly plan keeps this price for as long as you stay.',
    until: '2026-11-13',
    prices: { yearly: '$20.99', lifetime: '$62.99' }
  };

  // A store code is asked about again once its receipt is this old, so a
  // monthly or yearly plan that has ended closes the extras. A cancelled plan
  // runs to the end of the period paid for; Polar turns the code off then,
  // and the extras close within this long after.
  var RECHECK_MS = 24 * 60 * 60 * 1000;

  // An answer that hasn't come in this long counts as no answer, so a page
  // waiting on it isn't held up by a slow connection.
  var ANSWER_MS = 6000;

  // Offline, a receipt stands, but not for ever: monolab.dev signs it to run
  // out this long after (sooner if the code does), and a receipt that claims
  // longer is held to this. Then the extras pause until an answer comes (they
  // come back with it, nothing lost).
  var OFFLINE_GRACE_MS = 14 * DAY;

  // The public half of monolab.dev's receipt key (EXTENSION_PUBLIC_KEY in
  // the Portfolio repo's lib/blocknsfw-receipt.ts). The private half is only
  // on the server.
  var RECEIPT_PREFIX = 'BNR1.';
  var RECEIPT_PUBLIC_KEY = {
    kty: 'EC',
    crv: 'P-256',
    x: 'mW_riN8pnLw6oOfXH857oUqRufcWuaz5oPWi7Mra_ms',
    y: 'TKhvTK3kvrbLOBHC1MOF9bG7oz2Ou88TccohDsSuo-M'
  };

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

  // One request, to the store or to monolab.dev. Resolves to { status, body }
  // (body null when there's none to read, `garbled` when there was one but it
  // wasn't JSON), or { offline, reason? } when the request never got an answer.
  function storeCall(url, payload, opts) {
    var doFetch = (opts && opts.fetch) || (typeof fetch === 'function' ? fetch.bind(root) : null);
    if (!doFetch) return Promise.resolve({ offline: true, reason: 'this browser can’t check it' });
    var call = doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 204) return { status: res.status, body: null };
      return Promise.resolve(res.json()).then(function (body) {
        return { status: res.status, body: body };
      }, function () {
        return { status: res.status, body: null, garbled: true };
      });
    }, function () {
      return { offline: true };
    });
    var timer = null;
    var late = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve({ offline: true }); }, (opts && opts.answerMs) || ANSWER_MS);
    });
    return Promise.race([call, late]).then(function (r) {
      clearTimeout(timer);
      return r;
    });
  }

  function unanswered(r) {
    return { ok: false, reason: r.reason || 'couldn’t reach the store. Check your connection and try again', offline: true };
  }

  // Why the store said no, in the words Settings shows.
  var ENDED = {
    unknown: 'that code doesn’t match',
    off: 'that code has been turned off',
    expired: 'that code has run out'
  };

  // Asks monolab.dev whether this is a real, paid code. It asks Polar, with
  // the code, the store's organization id, and this browser's place on the
  // plan when it has one, and answers a yes with a signed receipt (which the
  // caller checks with verifyReceipt before trusting it).
  //   { ok: true, limit, receipt } or { ok: false, reason, offline?, definite?, removed? }
  // `limit` is how many browsers the plan works on at once (0: no limit).
  // `definite` means the store said no (unknown, turned off, run out, or not
  // this browser's place), as opposed to not answering or not being asked;
  // `removed`, that the plan goes on but this browser's place was taken back.
  function askServer(code, opts, activationId) {
    var key = String(code == null ? '' : code).replace(/\s+/g, '');
    var store = (opts && opts.store) || STORE;
    if (!store.organizationId) return Promise.resolve({ ok: false, reason: 'codes from the store aren’t switched on yet' });
    var payload = { code: key, mode: store.mode, org: store.organizationId };
    if (activationId) payload.activation = activationId;
    return storeCall(store.receipt, payload, opts).then(function (r) {
      if (r.offline) return unanswered(r);
      var body = r.body || {};
      if (r.status === 200 && body.status === 'granted' && typeof body.receipt === 'string') {
        return { ok: true, limit: Math.max(0, Math.floor(Number(body.limit) || 0)), receipt: body.receipt };
      }
      if (r.status === 403 && body.status === 'removed') return { ok: false, reason: 'this browser was removed from the plan', definite: true, removed: true };
      if (r.status === 403 && body.status === 'ended') return { ok: false, reason: ENDED[body.reason] || ENDED.off, definite: true };
      if (r.status === 400) return { ok: false, reason: ENDED.unknown };
      return { ok: false, reason: 'the store didn’t answer. Try again in a minute', offline: true };
    });
  }

  // A receipt, checked here: signed with monolab.dev's key, for this store's
  // mode and this code, issued no later than a day from now (a clock a little
  // off is fine), and not yet run out.
  //   { ok: true, limit, issued, expires } or { ok: false }
  function verifyReceipt(receipt, code, opts, now) {
    var no = { ok: false };
    if (typeof receipt !== 'string' || receipt.slice(0, RECEIPT_PREFIX.length) !== RECEIPT_PREFIX) return Promise.resolve(no);
    var parts = receipt.slice(RECEIPT_PREFIX.length).split('.');
    var payload = parts.length === 2 ? fromB64url(parts[0]) : null;
    var sig = parts.length === 2 ? fromB64url(parts[1]) : null;
    var subtle = cryptoSubtle(opts);
    if (!payload || !sig || sig.length !== SIG_BYTES || !subtle) return Promise.resolve(no);
    var store = (opts && opts.store) || STORE;
    var jwk = (opts && opts.receiptKey) || RECEIPT_PUBLIC_KEY;
    var body = null;
    return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      .then(function (key) {
        return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, payload);
      })
      .then(function (good) {
        if (!good) return null;
        body = JSON.parse(new TextDecoder().decode(payload));
        return subtle.digest('SHA-256', new TextEncoder().encode(String(code)));
      })
      .then(function (digest) {
        if (!digest || !body || typeof body !== 'object') return no;
        var issued = Number(body.i) * 1000;
        var expires = Math.min(Number(body.e) * 1000, issued + OFFLINE_GRACE_MS);
        if (body.m !== store.mode) return no;
        if (body.h !== toB64url(new Uint8Array(digest).slice(0, 16))) return no;
        if (!(issued <= now + DAY) || !(expires > now)) return no;
        return { ok: true, limit: Math.max(0, Math.floor(Number(body.l) || 0)), issued: issued, expires: expires };
      })
      .catch(function () { return no; });
  }

  // askServer, with a yes held to its receipt: a yes whose receipt doesn't
  // check (another key, another code, run out) is no answer at all.
  //   { ok: true, limit, receipt } or askServer's { ok: false, … }
  function askChecked(code, opts, now, activationId) {
    var key = String(code == null ? '' : code).replace(/\s+/g, '');
    return askServer(key, opts, activationId).then(function (r) {
      if (!r.ok) return r;
      return verifyReceipt(r.receipt, key, opts, now).then(function (got) {
        return got.ok
          ? { ok: true, limit: got.limit, receipt: r.receipt }
          : { ok: false, reason: 'the store didn’t answer. Try again in a minute', offline: true };
      });
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
    return storeCall(api.base + '/v1/customer-portal/license-keys/activate', payload, opts).then(function (r) {
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
  // on the device. A store code stands on its receipt: one from the last
  // RECHECK_MS stands without asking (opts.force asks anyway). Otherwise
  // monolab.dev is asked: still paid brings a new receipt, a definite no
  // closes the extras (and says when), and no answer leaves the receipt it
  // has standing until it runs out; with none that checks, `unchecked` until
  // an answer comes. `removed` says this browser lost its place on the plan
  // (taken back on the purchases page, or every place taken by the time
  // Polar's limit came in) while the plan itself goes on: the code entered
  // again takes a place back if there's one free.
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
        return verifyReceipt(rec.receipt, rec.code, opts, now).then(function (kept) {
          // No answer: a receipt that hasn't run out stands; a record without
          // one (typed in by hand, or kept from before receipts) waits for one.
          var unanswered = function () {
            return kept.ok ? yes(kept.limit) : { supporter: false, kind: 'store', unchecked: true };
          };
          if (kept.ok && !(opts && opts.force) && now - kept.issued < RECHECK_MS) return yes(kept.limit);
          // monolab.dev tells a place taken back (removed) from a plan that's over.
          return askChecked(rec.code, opts, now, held).then(function (r) {
            if (r.removed) return removed();
            if (r.definite) return ended();
            if (!r.ok) return unanswered();
            var fresh = { checkedAt: now, receipt: r.receipt };
            if (r.limit) fresh.limit = r.limit;
            if (!r.limit || held) return save(fresh).then(function () { return yes(r.limit); });
            // Polar's limit came in after this code was entered here.
            return activateStore(rec.code, opts, r.limit).then(function (a) {
              if (a.ok) {
                fresh.activationId = a.activationId;
                return save(fresh).then(function () { return yes(r.limit); });
              }
              if (a.full) return removed();
              if (a.definite) return ended();
              return unanswered();
            });
          });
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
      var rec = { kind: 'store', code: key, since: now, checkedAt: now, receipt: r.receipt };
      if (activationId) rec.activationId = activationId;
      if (r.limit) rec.limit = r.limit;
      return keep(storage, rec).then(function () { return r; });
    };
    var old = Promise.resolve(storage.get(KEY)).then(function (got) { return got && got[KEY]; }, function () { return null; });
    return old.then(function (rec) {
      var held = rec && rec.kind === 'store' && rec.code === key && !rec.removed && typeof rec.activationId === 'string' ? rec.activationId : '';
      return (held ? askChecked(key, opts, now, held) : Promise.resolve(null)).then(function (h) {
        if (h && h.ok) return save(h, held);
        return askChecked(key, opts, now).then(function (r) {
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
      return storeCall(storeApi(opts).base + '/v1/customer-portal/license-keys/deactivate', payload, opts).then(function (r) {
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
  // or the first shown when the best has no link. With an offer, a plan it
  // lowers shows the offer's price, keeps its own as `was`, and a yearly
  // plan's "a month" note follows the new price.
  function offered(offer) {
    var list = buyable() ? PLANS.filter(function (p) { return !!p.url; }) : PLANS.slice();
    var best = list.filter(function (p) { return p.best; })[0] || list[0];
    var prices = (offer && offer.prices) || {};
    return list.map(function (p) {
      var shown = Object.assign({}, p, { chosen: p === best });
      if (prices[p.id]) {
        shown.was = p.price;
        shown.price = prices[p.id];
        if (p.per === 'a year' && p.note) shown.note = '$' + (amountOf(shown.price) / 12).toFixed(2) + ' a month';
      }
      return shown;
    });
  }

  // "$20.99" as 20.99; NaN for anything else.
  function amountOf(price) {
    var m = /^\$(\d{1,4}(?:\.\d{2})?)$/.exec(typeof price === 'string' ? price : '');
    return m ? Number(m[1]) : NaN;
  }

  // An offer as Settings may show it, or null: words, and a last day it can
  // read. Of its prices, only real reductions of plans that exist are kept.
  // An offer from version.json is data from the network, so it's never more
  // than text: Settings sets it with textContent.
  function cleanOffer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var words = function (value, max) {
      var s = typeof value === 'string' ? value.trim() : '';
      return s.length <= max ? s : null;
    };
    var text = words(raw.text, 200);
    var name = words(raw.name, 40);
    var title = words(raw.title, 80);
    if (!text || name === null || title === null) return null;
    if (typeof raw.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.until)) return null;
    var given = raw.prices && typeof raw.prices === 'object' ? raw.prices : {};
    var prices = {};
    PLANS.forEach(function (p) {
      var now = amountOf(given[p.id]);
      if (now > 0 && now < amountOf(p.price)) prices[p.id] = given[p.id];
    });
    return { name: name, title: title, text: text, until: raw.until, prices: prices };
  }

  // The offer to show now: the one from version.json, else the built-in
  // one, until the end of its last day, by this computer's calendar.
  function activeOffer(now, remote) {
    var offer = cleanOffer(remote) || cleanOffer(OFFER);
    if (!offer) return null;
    var d = offer.until.split('-').map(Number);
    return now < new Date(d[0], d[1] - 1, d[2] + 1).getTime() ? offer : null;
  }

  // When an offer ends, said short: "last day" on its last day, else the
  // day itself in this browser's language ("Nov 13").
  function offerEnds(offer, now) {
    var d = offer.until.split('-').map(Number);
    var last = new Date(d[0], d[1] - 1, d[2]);
    var today = new Date(now);
    if (last.getFullYear() === today.getFullYear() && last.getMonth() === today.getMonth() && last.getDate() === today.getDate()) {
      return 'last day';
    }
    try {
      return 'until ' + last.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (_) {
      return 'until ' + offer.until;
    }
  }

  // --- Where a buyer came from -----------------------------------------------------

  // The checkout link says which door led to it, as utm_source, so Polar's
  // checkouts show what people buy from: the 2.0 page, the popup, a page of
  // the path, or a place in Settings. Only one of these names is ever sent,
  // never an address or anything about browsing (PRIVACY_POLICY.md,
  // section 10). Anything else counts as Settings.
  var DOORS = ['settings', 'release', 'popup', 'path', 'gooddays', 'hardest', 'month', 'looks', 'designs', 'photo', 'voice', 'sync', 'proof', 'storm', 'face', 'sections'];

  function door(name) {
    return DOORS.indexOf(name) === -1 ? 'settings' : name;
  }

  function checkoutUrl(plan, from) {
    if (!plan || !plan.url) return '';
    var url = new URL(plan.url);
    url.searchParams.set('utm_source', door(from));
    url.searchParams.set('utm_medium', 'extension');
    return url.toString();
  }

  var exported = {
    KEY: KEY,
    PREFIX: PREFIX,
    STORE: STORE,
    PLANS: PLANS,
    RECHECK_MS: RECHECK_MS,
    ANSWER_MS: ANSWER_MS,
    OFFLINE_GRACE_MS: OFFLINE_GRACE_MS,
    PUBLIC_KEY: PUBLIC_KEY,
    RECEIPT_PUBLIC_KEY: RECEIPT_PUBLIC_KEY,
    buyable: buyable,
    offered: offered,
    portalUrl: portalUrl,
    cleanOffer: cleanOffer,
    activeOffer: activeOffer,
    offerEnds: offerEnds,
    DOORS: DOORS,
    door: door,
    checkoutUrl: checkoutUrl,
    kindOf: kindOf,
    REVOKED: REVOKED,
    askServer: askServer,
    verifyReceipt: verifyReceipt,
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
