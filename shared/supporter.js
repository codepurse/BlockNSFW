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
// so a plan that has ended closes the extras. Only the code and the store's
// organization id are sent, never anything about browsing. Offline, the
// answer it has stands.
//
// A signed code ("BN1-…") is one the author makes by hand with
// tools/supporter-codes.mjs: for Android supporters, gifts, and anyone who
// can't afford it. It is a short note (a version, a number, the day it was
// made) signed with the author's key, checked against PUBLIC_KEY on the
// device, and never sent anywhere.
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

  var KEY = 'pblocker_supporter';   // storage.local: { kind, code, number?, since }
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

  var PUBLIC_KEY = {
    kty: 'EC',
    crv: 'P-256',
    x: '-pyWnALMjKN7eHj2hWwdByIUcPf0tghRe15h3vdIghQ',
    y: 'zyIAVRNawSvJasHxfBqXLMdQR8zXeT_wqt6YjPGOhNE'
  };

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
        return good
          ? { ok: true, number: parsed.number, issued: parsed.issued }
          : { ok: false, reason: 'that code doesn’t match' };
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

  // Asks the store whether this is a real, paid code. One request to Polar,
  // carrying the code and the store's organization id.
  //   { ok: true, id } or { ok: false, reason, offline?, definite? }
  // `definite` means the store said no (unknown, turned off, run out), as
  // opposed to not answering or not being asked.
  function verifyStore(code, opts, now) {
    var key = String(code == null ? '' : code).replace(/\s+/g, '');
    var api = storeApi(opts);
    if (!api.organizationId) return Promise.resolve({ ok: false, reason: 'codes from the store aren’t switched on yet' });
    var doFetch = (opts && opts.fetch) || (typeof fetch === 'function' ? fetch.bind(root) : null);
    if (!doFetch) return Promise.resolve({ ok: false, reason: 'this browser can’t check it', offline: true });
    return doFetch(api.base + '/v1/customer-portal/license-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ key: key, organization_id: api.organizationId })
    }).then(function (res) {
      if (res.status === 404) return { ok: false, reason: 'that code doesn’t match', definite: true };
      if (res.status === 422) return { ok: false, reason: 'that code doesn’t match' };
      if (!res.ok) return { ok: false, reason: 'the store didn’t answer. Try again in a minute', offline: true };
      return res.json().then(function (body) {
        if (!body || body.status !== 'granted') return { ok: false, reason: 'that code has been turned off', definite: true };
        if (body.expires_at && Date.parse(body.expires_at) < now) return { ok: false, reason: 'that code has run out', definite: true };
        return { ok: true, id: String(body.id || '') };
      });
    }, function () {
      return { ok: false, reason: 'couldn’t reach the store. Check your connection and try again', offline: true };
    });
  }

  // --- Stored -----------------------------------------------------------------------

  function keep(storage, rec) {
    var write = {};
    write[KEY] = rec;
    return Promise.resolve(storage.set(write));
  }

  // { supporter, kind?, number?, since?, ended? }. `storage` is a
  // storage.local area. A signed code is checked again here, on the device.
  // A store code is asked about again once RECHECK_MS has passed since the
  // last answer (or at once with opts.force): still paid keeps it, a definite
  // no closes the extras (and says when), and no answer leaves it as it was.
  function status(storage, opts) {
    var now = (opts && opts.now) || Date.now();
    return Promise.resolve(storage.get(KEY)).then(function (got) {
      var rec = got && got[KEY];
      if (!rec || typeof rec.code !== 'string') return { supporter: false };
      var since = Number(rec.since) || 0;
      if (rec.kind === 'store') {
        if (kindOf(rec.code) !== 'store') return { supporter: false };
        if (Number(rec.ended) > 0) return { supporter: false, kind: 'store', ended: Number(rec.ended) };
        var yes = { supporter: true, kind: 'store', since: since };
        var checked = Number(rec.checkedAt) || since;
        if (!(opts && opts.force) && now - checked < RECHECK_MS) return yes;
        return verifyStore(rec.code, opts, now).then(function (r) {
          if (r.ok) return keep(storage, Object.assign({}, rec, { checkedAt: now })).then(function () { return yes; });
          if (r.definite) {
            return keep(storage, Object.assign({}, rec, { ended: now })).then(function () {
              return { supporter: false, kind: 'store', ended: now };
            });
          }
          return yes;
        });
      }
      return verify(rec.code, opts).then(function (r) {
        return r.ok
          ? { supporter: true, kind: 'signed', number: r.number, since: since }
          : { supporter: false };
      });
    }, function () { return { supporter: false }; });
  }

  // Checks a code of either kind and keeps it. Resolves to { ok, reason? }.
  function unlock(storage, code, now, opts) {
    var kind = kindOf(code);
    if (!kind) return Promise.resolve({ ok: false, reason: 'that isn’t a whole supporter code' });
    var check = kind === 'signed' ? verify(code, opts) : verifyStore(code, opts, now);
    return check.then(function (r) {
      if (!r.ok) return r;
      var rec = kind === 'signed'
        ? { kind: 'signed', code: PREFIX + clean(code), number: r.number, since: now }
        : { kind: 'store', code: String(code).replace(/\s+/g, ''), since: now, checkedAt: now };
      return keep(storage, rec).then(function () { return r; });
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
    PUBLIC_KEY: PUBLIC_KEY,
    buyable: buyable,
    offered: offered,
    portalUrl: portalUrl,
    offerFor: offerFor,
    kindOf: kindOf,
    verifyStore: verifyStore,
    dayNumber: dayNumber,
    payloadFor: payloadFor,
    encode: encode,
    clean: clean,
    parse: parse,
    verify: verify,
    status: status,
    unlock: unlock
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.Supporter = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
