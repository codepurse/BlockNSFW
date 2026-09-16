// Extension-initiated fetches only. This does not anonymize browser traffic.
(function (root) {
  'use strict';
  const api = root.browser || root.chrome;
  const base = 'https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/';
  const publicDownloads = new Set([
    base + 'HOSTS.txt',
    base + 'WHITELIST.txt',
    base + 'version.json',
  ]);

  function isPublicDownload(url) {
    return publicDownloads.has(url);
  }

  function createFetch(nativeFetch, readSettings, extensionBase) {
    return async function privacyFetch(input, init) {
      // A storage failure must not silently permit an external request.
      const settings = await readSettings();
      if (!settings || settings.privacyMode !== true) return nativeFetch(input, init);
      const raw = typeof input === 'string' ? input : input && (input.url || input.href);
      // Require an absolute URL: a relative URL passed through to a content
      // script's native fetch resolves against the website, not the extension.
      const url = new URL(raw);
      if (url.href.startsWith(extensionBase)) return nativeFetch(input, init);
      const method = String(
        (init && init.method) || (input && input.method) || 'GET',
      ).toUpperCase();
      if (method !== 'GET' || !isPublicDownload(url.href)) {
        throw new Error(
          'Privacy mode blocked an external request. Only public blocklist and version downloads are allowed.',
        );
      }
      // Reconstruct rather than forward a Request: headers, body, credentials,
      // referrer and redirects must not carry browsing data to the list host.
      return nativeFetch(url.href, {
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store',
        ...(init && init.signal ? { signal: init.signal } : {}),
      });
    };
  }

  root.PrivacyGuard = { createFetch, isPublicDownload };
  if (api && api.storage && api.runtime && typeof root.fetch === 'function') {
    root.fetch = createFetch(
      root.fetch.bind(root),
      async () => {
        const stored = await api.storage.local.get('pblocker_settings');
        return stored.pblocker_settings || {};
      },
      api.runtime.getURL(''),
    );
  }
})(globalThis);
