// access.html: where a page waits while BlockNSFW's site access is switched
// off and protection is locked (shared/site-access.js, background.js
// "Site access"). One button asks the browser to give access back; once it
// is back, from here or from the toolbar menu, the page goes on.
(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const SA = self.SiteAccess;
  const $ = (id) => document.getElementById(id);
  let target = null;
  let leaving = false;

  // The address travels in session storage (?k=), never in the URL, unless
  // the browser had none (?to=). Kept until the page goes on, so a reload
  // still knows where it was going.
  async function readTarget() {
    const params = new URLSearchParams(location.search);
    const key = params.get('k');
    const area = api.storage && api.storage.session;
    if (key && SA.isHoldKey(key) && area) {
      try {
        const stored = await area.get(key);
        const entry = stored && stored[key];
        if (entry && SA.isWebUrl(entry.url)) return entry.url;
      } catch (_) {}
    }
    const to = params.get('to');
    return SA.isWebUrl(to) ? to : null;
  }

  function goOn() {
    if (leaving) return;
    leaving = true;
    const key = new URLSearchParams(location.search).get('k');
    try { if (key && SA.isHoldKey(key)) api.storage.session.remove(key); } catch (_) {}
    if (target) {
      location.replace(target);
    } else {
      $('said').textContent = 'BlockNSFW can see pages again. You can close this tab.';
    }
  }

  function declined() {
    $('said').textContent = 'Your browser didn’t give access, so pages keep waiting here.';
  }

  async function closeTab() {
    try {
      const tab = await api.tabs.getCurrent();
      if (tab && typeof tab.id === 'number') {
        await api.tabs.remove(tab.id);
        return;
      }
    } catch (_) {}
    window.close();
  }

  async function init() {
    target = await readTarget();
    const host = target ? SA.hostOf(target) : '';
    if (host) {
      $('where').textContent = host;
      $('where-dot').hidden = false;
    }

    $('give').addEventListener('click', () => {
      // Asked straight from the click: Firefox shows the prompt only for a
      // call made inside the gesture, not after an await.
      SA.request(api.permissions).then((ok) => (ok ? goOn() : declined()));
    });
    $('close').addEventListener('click', closeTab);

    // Given back some other way, such as the toolbar menu.
    if (api.permissions && api.permissions.onAdded) {
      api.permissions.onAdded.addListener(async () => {
        if (await SA.contains(api.permissions)) goOn();
      });
    }

    if (await SA.contains(api.permissions)) {
      goOn();
      return;
    }
    $('head').focus();
  }

  init();
})();
