'use strict';

// The 2.0 film, from YouTube, in a dialog on the 2.0 page.
//
// Nothing loads from YouTube until the film is opened: the page shows a
// local poster, and the player's frame is added when the dialog opens and
// removed when it closes (which also stops the sound).
//
// YouTube refuses to play inside an extension page ("Error 153, video player
// configuration error"): extension pages send no web referrer, and the embed
// needs one. So while the dialog is open, a session rule gives that one embed
// request, in this tab only, the referrer of our own site. The rule goes when
// the dialog closes. If the player still reports an error, the dialog says so
// and offers the film on YouTube instead. (Checked in headless Chrome on
// 2026-10-21: every variant fails with 153 without the rule, and plays with it.)
(function () {
  const VIDEO_ID = '-1p8cWhCV9w';
  const EMBED = 'https://www.youtube-nocookie.com/embed/' + VIDEO_ID;
  const WATCH = 'https://www.youtube.com/watch?v=' + VIDEO_ID;
  const REFERRER = 'https://monolab.dev/';
  const RULE_ID = 20001;
  const ext = typeof browser !== 'undefined' && browser.declarativeNetRequest ? browser
    : typeof chrome !== 'undefined' ? chrome : null;

  const opener = document.getElementById('film-open');
  const dialog = document.getElementById('film-dialog');
  const frame = document.getElementById('film-frame');
  const closeBtn = document.getElementById('film-close');
  const status = document.getElementById('film-status');
  const fallback = document.getElementById('film-fallback');
  if (!opener || !dialog || !frame || typeof dialog.showModal !== 'function') return;

  let player = null;
  let ready = false;
  let waitTimer = 0;

  async function addReferrerRule() {
    const dnr = ext && ext.declarativeNetRequest;
    if (!dnr || typeof dnr.updateSessionRules !== 'function') return;
    const condition = { urlFilter: '|' + EMBED, resourceTypes: ['sub_frame'] };
    try {
      const tab = ext.tabs && (await ext.tabs.getCurrent());
      if (tab && typeof tab.id === 'number' && tab.id >= 0) condition.tabIds = [tab.id];
    } catch (_) { /* no tab: the rule still only matches this one embed address */ }
    try {
      await dnr.updateSessionRules({
        removeRuleIds: [RULE_ID],
        addRules: [{
          id: RULE_ID,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: REFERRER }] },
          condition
        }]
      });
    } catch (_) { /* the player's own error message below covers it */ }
  }

  function removeReferrerRule() {
    const dnr = ext && ext.declarativeNetRequest;
    if (!dnr || typeof dnr.updateSessionRules !== 'function') return;
    dnr.updateSessionRules({ removeRuleIds: [RULE_ID] }).catch(() => {});
  }

  function showFallback(text) {
    if (player) { player.remove(); player = null; }
    if (status) status.textContent = text;
    if (fallback) fallback.hidden = false;
  }

  function onMessage(event) {
    if (!player || event.source !== player.contentWindow) return;
    let data = event.data;
    try { data = typeof data === 'string' ? JSON.parse(data) : data; } catch (_) { return; }
    if (!data || typeof data !== 'object') return;
    if (data.event === 'onReady') {
      ready = true;
      clearTimeout(waitTimer);
      if (status) status.textContent = 'Playing from YouTube.';
    }
    if (data.event === 'onError') {
      showFallback('The film can’t play inside the extension in this browser. It plays on YouTube.');
    }
  }

  async function open() {
    ready = false;
    if (status) status.textContent = 'Playing from YouTube.';
    if (fallback) fallback.hidden = true;
    dialog.showModal();
    closeBtn && closeBtn.focus();
    await addReferrerRule();
    if (!dialog.open) return;

    const params = new URLSearchParams({
      autoplay: '1', rel: '0', playsinline: '1', enablejsapi: '1', origin: location.origin
    });
    player = document.createElement('iframe');
    player.className = 'film-player';
    player.title = 'BlockNSFW 2.0, the film';
    player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    player.src = EMBED + '?' + params.toString();
    player.addEventListener('load', () => {
      // Ask the player to report its state, so an error can be caught.
      const hello = () => player && player.contentWindow &&
        player.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube-nocookie.com');
      hello();
      setTimeout(hello, 800);
    });
    frame.appendChild(player);
    // A slow first load (Edge took over 10 s in testing) only adds the
    // YouTube link beside the player; it never takes the player away.
    waitTimer = setTimeout(() => {
      if (ready || !player) return;
      if (status) status.textContent = 'Still loading. You can also watch it on YouTube.';
      if (fallback) fallback.hidden = false;
    }, 12000);
  }

  function close() {
    clearTimeout(waitTimer);
    if (player) { player.remove(); player = null; }
    removeReferrerRule();
    // Back to the poster, whichever way the dialog was opened or closed.
    if (!dialog.open && document.activeElement !== opener) opener.focus({ preventScroll: true });
  }

  window.addEventListener('message', onMessage);
  opener.addEventListener('click', open);
  closeBtn && closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', close);
  // The close event isn't always delivered (headless Chrome dropped it now and
  // then on Escape), so also watch the dialog's open state: however it closes,
  // the player and the referrer rule go. close() is safe to run twice.
  new MutationObserver(() => { if (!dialog.open) close(); })
    .observe(dialog, { attributes: true, attributeFilter: ['open'] });
  // A click on the dim area around the dialog closes it, like Escape.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.querySelectorAll('[data-film-watch]').forEach((a) => { a.href = WATCH; });

  // Settings › What's new links here with #film: open the film straight away.
  if (location.hash === '#film') open();
})();
