// Extension-initiated fetches only. This does not anonymize browser traffic.
//
// With privacyMode on, nothing about the user's browsing may reach a third
// party except a DNS lookup sent to the resolver they chose. What still works:
//   - packaged extension files (and data:/blob: URLs, which never hit the wire)
//   - the fixed public blocklist, whitelist, version and model-weight downloads
//   - DNS-over-HTTPS queries to a built-in resolver or the user's own endpoint
//   - AI image re-fetches, but only through PrivacyGuard.fetchImage(), which
//     re-requests an image the page just loaded, from the host that served it
// Everything else (Appwrite reports and community, Reddit lookups, subscribed
// list downloads, external blocked pages) is refused.
(function (root) {
  'use strict';
  const api = root.browser || root.chrome;
  const base = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/';
  const publicDownloads = new Set([
    base + 'HOSTS.txt',
    base + 'WHITELIST.txt',
    base + 'version.json',
  ]);
  const modelBase = base + 'models/';
  const dohAccept = new Set(['application/dns-json', 'application/dns-message']);
  // The only query shapes shared/dns-providers.js sends.
  const dohQuery = /^[?&](?:dns=[A-Za-z0-9_-]+|name=[A-Za-z0-9._%-]+&type=A)$/;

  function blocked() {
    return new Error(
      'Privacy mode blocked an external request. Only public downloads and DNS lookups are allowed.',
    );
  }

  function isPublicDownload(url) {
    if (publicDownloads.has(url)) return true;
    // Weight shards and their manifest: a fixed path, no query, no fragment.
    if (!url.startsWith(modelBase)) return false;
    const parsed = new URL(url);
    return parsed.href === url && !parsed.search && !parsed.hash;
  }

  function dohEndpoints(settings) {
    const dns = root.DnsProviders;
    if (!dns) return [];
    const endpoints = dns.DNS_PROVIDERS.map((p) => p.doh);
    const custom = settings.dnsCustomUrl && dns.makeCustomProvider(settings.dnsCustomUrl);
    if (custom) endpoints.push(custom.doh);
    return endpoints;
  }

  function isDohQuery(url, settings) {
    return dohEndpoints(settings).some(
      (doh) => url.startsWith(doh) && dohQuery.test(url.slice(doh.length)),
    );
  }

  function headerValue(init, name) {
    const headers = init && init.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key]) : '';
  }

  // Rebuild rather than forward a Request: caller headers, body, credentials
  // and referrer must not carry browsing data along with an allowed request.
  function clean(init, extra) {
    return {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(init && init.signal ? { signal: init.signal } : {}),
      ...extra,
    };
  }

  function createFetch(nativeFetch, readSettings, extensionBase) {
    function urlOf(input) {
      const raw = typeof input === 'string' ? input : input && (input.url || input.href);
      // Require an absolute URL: a relative URL passed through to a content
      // script's native fetch resolves against the website, not the extension.
      return new URL(raw);
    }

    function isLocal(url) {
      return url.href.startsWith(extensionBase) || url.protocol === 'data:' || url.protocol === 'blob:';
    }

    function methodOf(input, init) {
      return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    }

    async function privacyFetch(input, init) {
      // A storage failure must not silently permit an external request.
      const settings = await readSettings();
      if (!settings || settings.privacyMode !== true) return nativeFetch(input, init);
      const url = urlOf(input);
      if (isLocal(url)) return nativeFetch(input, init);
      if (methodOf(input, init) !== 'GET') throw blocked();

      if (isPublicDownload(url.href)) {
        // The URL is fixed and nothing personal rides along, so following a
        // redirect (GitHub moving raw content) reveals nothing new.
        return nativeFetch(url.href, clean(init, { redirect: 'follow', cache: 'no-store' }));
      }
      if (isDohQuery(url.href, settings)) {
        const accept = headerValue(init, 'Accept');
        // A resolver answers itself; a redirect would hand the query to someone else.
        return nativeFetch(url.href, clean(init, {
          redirect: 'error',
          cache: 'no-store',
          ...(dohAccept.has(accept) ? { headers: { Accept: accept } } : {}),
        }));
      }
      throw blocked();
    }

    // The AI classifier re-requests an image the page already loaded so it
    // can read its pixels. The image's own host already saw that request, so
    // repeating it bare (no cookies, no referrer, from cache) discloses nothing.
    async function fetchImage(src, init) {
      const url = urlOf(src);
      if (isLocal(url)) return nativeFetch(url.href, init);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw blocked();
      const settings = await readSettings();
      if (!settings || settings.privacyMode !== true) return nativeFetch(url.href, init);
      return nativeFetch(url.href, clean(init, { redirect: 'follow', cache: 'force-cache' }));
    }

    privacyFetch.fetchImage = fetchImage;
    return privacyFetch;
  }

  // Settings are cached and refreshed by storage.onChanged, so a fetch with the
  // mode off costs nothing. A failed read is not cached: it rejects (fails
  // closed) and the next fetch tries again.
  function createSettingsReader(storage) {
    let current = null;
    const reader = () => {
      if (!current) {
        current = storage.local.get('pblocker_settings').then(
          (stored) => stored.pblocker_settings || {},
          (error) => {
            current = null;
            throw error;
          },
        );
      }
      return current;
    };
    if (storage.onChanged && typeof storage.onChanged.addListener === 'function') {
      storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.pblocker_settings) {
          current = Promise.resolve(changes.pblocker_settings.newValue || {});
        }
      });
    }
    return reader;
  }

  const guard = { createFetch, createSettingsReader, isPublicDownload, fetchImage: null };
  root.PrivacyGuard = guard;
  if (api && api.storage && api.runtime && typeof root.fetch === 'function') {
    const guarded = createFetch(
      root.fetch.bind(root),
      createSettingsReader(api.storage),
      api.runtime.getURL(''),
    );
    root.fetch = guarded;
    guard.fetchImage = guarded.fetchImage;
  }
})(globalThis);
