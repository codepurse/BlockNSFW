// shared/dns-providers.js
// Registry of the filtering DNS resolvers BlockNSFW can consult, plus a small
// DNS-over-HTTPS client that speaks to all of them.
//
// Why more than one provider:
//
//   1. A single hardcoded resolver is a single point of failure. When it is
//      unreachable or rate-limiting us, checkDnsFilter() fails open and the
//      user is silently unprotected — the worst failure mode this extension
//      has. Two providers means one has to actually be down to lose the layer.
//   2. Users care who sees their browsing. Someone using a porn blocker is,
//      almost by definition, privacy-sensitive; "which company answers my DNS"
//      is a real choice to offer rather than one we make for them.
//
// Only resolvers whose terms are silent on programmatic use are listed here.
// Providers whose terms forbid "providing the functionality of the service to
// a third party" (Cisco/OpenDNS) or transferring the service without written
// authorization (Control D) are deliberately absent — those are fine for a
// user to set on their own device, and we point at them in onboarding instead,
// but the extension must not query them on the user's behalf.
//
// The safe-harbour argument for the ones we do query: the request leaves the
// user's own browser, over the user's own IP, at household volume, gated behind
// the local blocklist and a cache. That is indistinguishable from the user
// configuring the resolver themselves, which is what these services are for.
// It stops being true the moment queries are proxied through our own server or
// used to bulk-build a list, so don't do either.

(function (root) {
  'use strict';

  // 'json' providers speak Google/Cloudflare's application/dns-json dialect.
  // 'wire' providers speak RFC 8484 wireformat only, which is why the codec
  // below exists.
  var DNS_PROVIDERS = [
    {
      id: 'cloudflare',
      label: 'Cloudflare for Families',
      doh: 'https://family.cloudflare-dns.com/dns-query',
      mode: 'json',
      blocks: 'Adult content + malware',
      note: 'Largest network of the four, usually the fastest. Recommended default.'
    },
    {
      id: 'adguard',
      label: 'AdGuard DNS Family',
      doh: 'https://dns-family.adguard.com/dns-query',
      mode: 'wire',
      blocks: 'Adult content + ads + trackers',
      note: 'Also forces SafeSearch on major search engines.',
      // AdGuard does not sinkhole to 0.0.0.0 — it answers with the address of
      // its own block page, so a blocked domain arrives as NOERROR + a real
      // looking IP. Without this the filter reads as "nothing is blocked".
      // Verified against pornhub.com / xvideos.com / xhamster.com, all of which
      // return exactly this address while benign domains resolve normally.
      blockedIps: ['94.140.14.35']
    },
    {
      id: 'mullvad',
      label: 'Mullvad DNS Family',
      doh: 'https://family.dns.mullvad.net/dns-query',
      mode: 'wire',
      blocks: 'Adult content + gambling',
      note: 'No-logging independently audited, servers run entirely in RAM. Best privacy of the four.'
    },
    {
      id: 'cleanbrowsing',
      label: 'CleanBrowsing Adult Filter',
      doh: 'https://doh.cleanbrowsing.org/doh/adult-filter/',
      mode: 'wire',
      blocks: 'Adult content only',
      note: 'Narrowest filter — leaves ads, trackers and social media untouched.'
    }
  ];

  var DEFAULT_PROVIDER_ID = 'cloudflare';
  // Chosen so the fallback is never the same network as the primary: if
  // Cloudflare is the primary we fall back to AdGuard, otherwise to Cloudflare.
  var FALLBACK_PROVIDER_ID = 'adguard';
  var CUSTOM_PROVIDER_ID = 'custom';

  function getProvider(id) {
    for (var i = 0; i < DNS_PROVIDERS.length; i++) {
      if (DNS_PROVIDERS[i].id === id) return DNS_PROVIDERS[i];
    }
    return null;
  }

  function getProviderOrDefault(id) {
    return getProvider(id) || getProvider(DEFAULT_PROVIDER_ID);
  }

  // --- Custom resolvers ------------------------------------------------------
  // A typed-in DoH endpoint, which is how someone uses their own NextDNS config
  // ID, a Control D profile, or a resolver they run themselves — all of which
  // are perfectly fine for a *user* to point us at even where we could not ship
  // them as a preset, because the choice is theirs rather than ours.
  //
  // Custom endpoints are always spoken to in RFC 8484 wireformat. That is the
  // actual standard and every DoH server implements it; the JSON dialect is a
  // Cloudflare/Google extra that most do not. Guessing wrong would look exactly
  // like "your resolver is broken", so we don't guess.

  function validateCustomDohUrl(raw) {
    var text = String(raw || '').trim();
    if (!text) return { ok: false, error: 'Enter a DNS-over-HTTPS address.' };

    var parsed;
    try {
      parsed = new URL(text);
    } catch (_) {
      return { ok: false, error: 'That is not a valid web address.' };
    }
    // https only. A plaintext endpoint would put the user's browsing history on
    // the wire in clear, which is worse than not running this check at all.
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'The address must start with https://' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: 'Remove the username or password from the address.' };
    }
    if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) {
      return { ok: false, error: 'That address has no domain name in it.' };
    }
    return { ok: true, url: parsed.toString() };
  }

  function makeCustomProvider(url) {
    var check = validateCustomDohUrl(url);
    if (!check.ok) return null;
    return {
      id: CUSTOM_PROVIDER_ID,
      label: 'Custom resolver',
      doh: check.url,
      mode: 'wire',
      custom: true,
      blocks: 'Whatever your resolver filters',
      note: 'A DNS-over-HTTPS endpoint you provide.'
    };
  }

  /**
   * Turn the stored settings pair (id + custom URL) into a provider object.
   * Falls back to the default preset when 'custom' is selected but the stored
   * URL is missing or malformed, so a bad value degrades to a working resolver
   * rather than to no DNS layer at all.
   */
  function resolveProvider(id, customUrl) {
    if (id === CUSTOM_PROVIDER_ID) {
      return makeCustomProvider(customUrl) || getProvider(DEFAULT_PROVIDER_ID);
    }
    return getProviderOrDefault(id);
  }

  /**
   * The partner to ask when the primary does not answer.
   *
   * Returns null for a custom resolver, deliberately. Someone who typed in
   * their own endpoint chose who gets to see their browsing; quietly handing
   * those queries to Cloudflare the moment their resolver hiccuped would
   * override that choice without telling them. A custom resolver that fails
   * simply yields no DNS opinion, and the local blocklist carries on as before.
   */
  function getFallbackProvider(primaryId) {
    if (primaryId === CUSTOM_PROVIDER_ID) return null;
    var wanted = primaryId === FALLBACK_PROVIDER_ID
      ? DEFAULT_PROVIDER_ID
      : FALLBACK_PROVIDER_ID;
    if (wanted === primaryId) return null;
    return getProvider(wanted);
  }

  // --- RFC 8484 wireformat ---------------------------------------------------
  // Only Cloudflare exposes the JSON dialect; the rest require us to build a
  // real DNS packet. We only ever ask one question (an A record), so this is a
  // deliberately minimal codec rather than a general-purpose DNS library.

  function encodeQuery(hostname) {
    var labels = String(hostname).replace(/\.$/, '').split('.');
    var size = 12; // header
    var i;
    for (i = 0; i < labels.length; i++) size += 1 + labels[i].length;
    size += 1 + 4; // root label + QTYPE + QCLASS

    var buf = new Uint8Array(size);
    // ID stays 0: RFC 8484 recommends it for GET so identical questions share
    // an HTTP cache entry instead of each getting a unique URL.
    buf[2] = 0x01; // RD (recursion desired)
    buf[5] = 0x01; // QDCOUNT = 1

    var off = 12;
    for (i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (label.length > 63) throw new Error('DNS label too long');
      buf[off++] = label.length;
      for (var c = 0; c < label.length; c++) {
        buf[off++] = label.charCodeAt(c) & 0xff;
      }
    }
    buf[off++] = 0x00; // root
    buf[off++] = 0x00;
    buf[off++] = 0x01; // QTYPE = A
    buf[off++] = 0x00;
    buf[off++] = 0x01; // QCLASS = IN
    return buf;
  }

  function toBase64Url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Walks a (possibly compressed) name and returns the offset just past it.
  // We never need the name itself, only how many bytes to skip.
  function skipName(view, offset) {
    while (offset < view.byteLength) {
      var len = view.getUint8(offset);
      if (len === 0) return offset + 1;
      if ((len & 0xc0) === 0xc0) return offset + 2; // compression pointer
      offset += 1 + len;
    }
    return offset;
  }

  // Returns { rcode, addresses } — addresses are dotted-quad strings from A
  // records. Throws on a malformed packet so the caller treats it as a failed
  // lookup rather than as "not blocked".
  function decodeResponse(arrayBuffer) {
    var view = new DataView(arrayBuffer);
    if (view.byteLength < 12) throw new Error('DNS response too short');

    var rcode = view.getUint8(3) & 0x0f;
    var qdcount = view.getUint16(4);
    var ancount = view.getUint16(6);

    var offset = 12;
    for (var q = 0; q < qdcount; q++) {
      offset = skipName(view, offset);
      offset += 4; // QTYPE + QCLASS
    }

    var addresses = [];
    for (var a = 0; a < ancount; a++) {
      if (offset + 10 > view.byteLength) break;
      offset = skipName(view, offset);
      var type = view.getUint16(offset);
      var rdlength = view.getUint16(offset + 8);
      offset += 10;
      if (type === 1 && rdlength === 4 && offset + 4 <= view.byteLength) {
        addresses.push(
          view.getUint8(offset) + '.' +
          view.getUint8(offset + 1) + '.' +
          view.getUint8(offset + 2) + '.' +
          view.getUint8(offset + 3)
        );
      }
      offset += rdlength;
    }

    return { rcode: rcode, addresses: addresses };
  }

  // --- Block detection -------------------------------------------------------
  // The three ways a filtering resolver says "no", all of which occur in the
  // roster above and were confirmed against each live service:
  //
  //   NXDOMAIN            Mullvad, and Cloudflare for some domains
  //   sinkhole address    Cloudflare (0.0.0.0), CleanBrowsing
  //   block-page address  AdGuard (94.140.14.35) — looks like a normal answer
  //
  // The third is the trap: it is NOERROR with a routable-looking IP, so a
  // naive "did it resolve?" check reports the filter as working while passing
  // every adult domain straight through. Per-provider blockedIps covers it.
  var SINKHOLE_IPS = ['0.0.0.0', '127.0.0.1'];

  function looksBlocked(addresses, extraBlockedIps) {
    for (var i = 0; i < addresses.length; i++) {
      var ip = addresses[i];
      if (SINKHOLE_IPS.indexOf(ip) !== -1) return true;
      if (extraBlockedIps && extraBlockedIps.indexOf(ip) !== -1) return true;
    }
    return false;
  }

  function interpret(rcode, addresses, extraBlockedIps) {
    if (rcode === 3) return true; // NXDOMAIN
    if (rcode !== 0) return null; // SERVFAIL and friends: no opinion, not "safe"
    return looksBlocked(addresses, extraBlockedIps);
  }

  /**
   * Ask one provider whether a hostname is filtered.
   *
   * Returns true (blocked), false (resolved normally), or **null when the
   * lookup did not produce an answer** — timeout, HTTP error, malformed
   * response, SERVFAIL. Callers must treat null as "unknown" and never cache
   * it as "not blocked"; that distinction is the whole reason this returns a
   * tri-state instead of a boolean. Conflating them is how a rate-limited
   * resolver silently turns the DNS layer off.
   */
  // A typed-in endpoint may already carry a query string, so the separator has
  // to be chosen rather than assumed — `?dns=` appended to a URL that already
  // has a `?` produces a second question mark and a request the server rejects.
  function withQuery(doh, params) {
    var joiner = doh.indexOf('?') === -1 ? '?' : '&';
    return doh + joiner + params;
  }

  async function queryProvider(provider, hostname, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 3000);
    try {
      if (provider.mode === 'json') {
        var jsonRes = await fetch(
          withQuery(provider.doh, 'name=' + encodeURIComponent(hostname) + '&type=A'),
          { headers: { Accept: 'application/dns-json' }, signal: controller.signal }
        );
        if (!jsonRes.ok) return null;
        var data = await jsonRes.json();
        if (typeof data.Status !== 'number') return null;
        var jsonAddresses = Array.isArray(data.Answer)
          ? data.Answer.filter(function (r) { return r.type === 1; })
              .map(function (r) { return r.data; })
          : [];
        return interpret(data.Status, jsonAddresses, provider.blockedIps);
      }

      var query = toBase64Url(encodeQuery(hostname));
      var wireRes = await fetch(withQuery(provider.doh, 'dns=' + query), {
        headers: { Accept: 'application/dns-message' },
        signal: controller.signal
      });
      if (!wireRes.ok) return null;
      var decoded = decodeResponse(await wireRes.arrayBuffer());
      return interpret(decoded.rcode, decoded.addresses, provider.blockedIps);
    } catch (_) {
      return null; // network error, abort, or malformed packet — no opinion
    } finally {
      clearTimeout(timer);
    }
  }

  var exported = {
    DNS_PROVIDERS: DNS_PROVIDERS,
    DEFAULT_PROVIDER_ID: DEFAULT_PROVIDER_ID,
    FALLBACK_PROVIDER_ID: FALLBACK_PROVIDER_ID,
    CUSTOM_PROVIDER_ID: CUSTOM_PROVIDER_ID,
    getProvider: getProvider,
    getProviderOrDefault: getProviderOrDefault,
    resolveProvider: resolveProvider,
    makeCustomProvider: makeCustomProvider,
    validateCustomDohUrl: validateCustomDohUrl,
    withQuery: withQuery,
    getFallbackProvider: getFallbackProvider,
    queryProvider: queryProvider,
    // exported for tests
    encodeQuery: encodeQuery,
    decodeResponse: decodeResponse,
    toBase64Url: toBase64Url,
    interpret: interpret
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.DnsProviders = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
