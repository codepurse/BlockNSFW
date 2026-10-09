// gateway.js: the pause in front of a site the user named as a gateway.
//
// content.js sends a tab here (gateway.html?g=<key>&to=<address>) when an
// address matches one of the user's gateways and no recent Go on covers it.
// On an ordinary day the page counts down the pause; Go on then opens the site
// for a while (shared/gateways.js PASS_MS) and Not tonight is counted. During
// Risk Hours and Storm Mode the site is closed: there is no Go on, only what
// helps instead.

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  const { Gateways, Moments, Boost } = globalThis;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  const key = params.get('g') || '';
  const target = safeTarget(params.get('to'));
  const name = Gateways.nameFor(key);
  const WAIT_MINUTES = 10;

  // Only a web address is ever opened from here: this page is reachable from
  // any site, and must not become a way to send a tab somewhere else.
  function safeTarget(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function shortAddress(href) {
    try {
      const url = new URL(href);
      const path = url.pathname === '/' ? '' : url.pathname;
      const text = url.hostname.replace(/^www\./, '') + path;
      return text.length > 60 ? text.slice(0, 59) + '…' : text;
    } catch (_) {
      return name;
    }
  }

  function show(id) {
    ['pause', 'stopped', 'closed'].forEach((section) => { $(section).hidden = section !== id; });
    document.querySelector('.gate').dataset.state = id;
    const head = $(`${id}-head`);
    if (head) head.focus({ preventScroll: true });
  }

  function placeWords(slot) {
    const words = $('words');
    if (!words.hidden) $(slot).appendChild(words);
  }

  function fillWords(words) {
    const set = (id, text) => {
      $(id).textContent = text || '';
      $(id).hidden = !text;
    };
    set('words-plan', words.plan);
    set('words-note', words.note);
    $('words').hidden = !(words.plan || words.note);
  }

  // A call link for the person they named, where there's a number to call.
  function callLink(link, words, primary) {
    const href = Moments.telHref(words.person.phone);
    if (!href) return;
    link.href = href;
    link.textContent = words.person.name ? `Call ${words.person.name}` : 'Call';
    link.hidden = false;
    if (!primary) link.className = 'btn btn-ghost';
  }

  async function closeTab() {
    try {
      const tab = await browserAPI.tabs.getCurrent();
      if (tab && typeof tab.id === 'number') {
        await browserAPI.tabs.remove(tab.id);
        return;
      }
    } catch (_) {}
    window.close();
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else closeTab();
  }

  // --- Waiting it out together ---------------------------------------------------

  let waitTimer = null;
  let waitEndsAt = 0;

  function placeWait(slot) {
    $(slot).appendChild($('wait'));
  }

  function tickWait() {
    const ms = Math.max(0, waitEndsAt - Date.now());
    const total = Math.ceil(ms / 1000);
    $('wait-time').textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    if (ms > 0) return;
    clearInterval(waitTimer);
    $('wait-text').textContent = 'The time is up. If the urge has passed, that’s one kept.';
  }

  function startWait(trigger) {
    waitEndsAt = Date.now() + WAIT_MINUTES * 60 * 1000;
    trigger.hidden = true;
    $('wait-running').hidden = false;
    tickWait();
    clearInterval(waitTimer);
    waitTimer = setInterval(tickWait, 1000);
    $('wait-ok').focus();
  }

  async function waitedOut() {
    clearInterval(waitTimer);
    $('wait-running').hidden = true;
    let count = 0;
    try {
      const { [Moments.KEPT_KEY]: raw } = await browserAPI.storage.local.get(Moments.KEPT_KEY);
      const kept = Moments.addKept(raw, Date.now());
      count = kept.count;
      await browserAPI.storage.local.set({ [Moments.KEPT_KEY]: kept });
    } catch (_) {}
    const done = $('wait-done');
    done.textContent = count > 1
      ? `That’s ${count} moments you’ve waited out.`
      : 'That’s one moment waited out.';
    done.hidden = false;
  }

  // --- After Not tonight ---------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((attr) => el.setAttribute(attr, attrs[attr]));
    if (text) el.textContent = text;
    return el;
  }

  // Evening and night ask for "tomorrow morning"; the day for "tonight".
  function isEvening(at) {
    const hour = new Date(at).getHours();
    return hour >= 17 || hour < 5;
  }

  function clockTime(at) {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // An earlier stop: its time if it was today, else its date.
  function stopLabel(at, now) {
    const day = new Date(at);
    if (day.toDateString() === new Date(now).toDateString()) return clockTime(at);
    return day.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // The door on the right, and a line for each of the last few times someone
  // came to it and turned back, oldest at the top. Each comes a little closer
  // than the one before; tonight's comes closest and ends in a brass square.
  function drawTurns(svg, recent, at) {
    const WIDTH = 540;
    const DOOR = 360;
    const BOTTOM = 440;
    const STEP = 90;
    const NOW_Y = 306;
    const past = recent.slice(0, -1).slice(-3);
    const firstY = NOW_Y - past.length * STEP;
    const top = firstY - 36;
    svg.setAttribute('viewBox', `0 ${top} ${WIDTH} ${BOTTOM - top}`);

    svg.appendChild(svgEl('path', { class: 'kept-door', d: `M${DOOR} ${top + 12} V${BOTTOM - 24}` }));
    const where = svg.appendChild(svgEl('text', { class: 'kept-label', x: DOOR + 14, y: top + 24 }, name.toUpperCase()));
    svg.appendChild(svgEl('text', { class: 'kept-label', x: DOOR + 14, y: BOTTOM - 30 }, 'THE DOOR'));
    // A long site name is cut to the room beyond the door.
    const room = WIDTH - (DOOR + 14);
    let text = where.textContent;
    while (text.length > 4 && where.getComputedTextLength() > room) {
      text = text.slice(0, -1);
      where.textContent = `${text.trimEnd()}…`;
    }

    past.forEach((stop, i) => {
      const y = firstY + i * STEP;
      const k = i + 3 - past.length;
      const reach = 302 + 10 * k;
      const back = 142 - 24 * k;
      svg.appendChild(svgEl('text', { class: 'kept-label', x: 24, y: y - 12 }, stopLabel(stop.at, at).toUpperCase()));
      svg.appendChild(svgEl('path', { class: 'kept-past', d: `M24 ${y} H${reach} A20 20 0 0 1 ${reach} ${y + 40} H${back}` }));
      svg.appendChild(svgEl('rect', { class: 'kept-past-end', x: back - 13.5, y: y + 34.5, width: 11, height: 11 }));
    });

    const when = `${isEvening(at) ? 'Tonight' : 'Today'} · ${clockTime(at)}`;
    svg.appendChild(svgEl('text', { class: 'kept-label kept-label-now', x: 24, y: NOW_Y - 12 }, when.toUpperCase()));
    svg.appendChild(svgEl('path', {
      class: 'kept-now',
      d: `M24 ${NOW_Y} H${DOOR - 36} A28 28 0 0 1 ${DOOR - 36} ${NOW_Y + 56} H76`,
      pathLength: 1
    }));
    svg.appendChild(svgEl('rect', { class: 'kept-held', x: 58, y: NOW_Y + 49, width: 14, height: 14 }));

    $('stopped-drawing-title').textContent = past.length
      ? `${past.length + 1} lines come to the door of ${name} and turn back. Tonight’s comes closest and ends in a brass square.`
      : `A line comes to the door of ${name} and turns back, ending in a brass square.`;
  }

  // stops is null when the count couldn't be saved: the page still says what
  // happened, without a number.
  function showStopped(stops, at) {
    const evening = isEvening(at);
    $('stopped-where').textContent = name;
    $('stopped-time').textContent = clockTime(at);
    $('stopped-lede').textContent =
      `It pulled, you waited, and you chose the ${evening ? 'night' : 'day'} you actually want. That’s the whole skill, and you just did it.`;
    $('stopped-glad').textContent = evening
      ? 'Tomorrow morning, you’ll be glad of this one.'
      : 'Tonight, you’ll be glad of this one.';
    if (stops) {
      $('stopped-number').textContent = stops.total.toLocaleString();
      $('stopped-count-label').textContent = stops.total === 1
        ? 'time you’ve stopped at the door'
        : 'times you’ve stopped at the door';
      $('stopped-count-note').textContent = stops.total === 1
        ? 'The first one. Statistics keeps every one.'
        : 'Statistics keeps every one.';
      $('stopped-count').hidden = false;
    }
    placeWait('stopped-wait');
    show('stopped');
    // Drawn once the section shows, so the gateway's name can be measured.
    drawTurns($('stopped-drawing'), stops ? stops.recent : [{ key, at }], at);
  }

  // --- The pause --------------------------------------------------------------

  function runPause(settings, words) {
    const seconds = settings.pause;
    let left = seconds;
    const goOn = $('go-on');
    const fill = $('pause-fill');
    const clock = $('pause-clock');

    $('pause-where').textContent = target ? shortAddress(target) : name;
    $('pause-lede').textContent =
      `You marked ${name} as one of the ways in. Take ${seconds === 60 ? 'a minute' : `${seconds} seconds`} before you decide.`;
    $('settings-link').href = browserAPI.runtime.getURL('options.html#gateways-group');
    placeWords('pause-words');
    callLink($('stopped-call'), words, false);

    const draw = () => {
      fill.style.width = `${((seconds - left) / seconds) * 100}%`;
      clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (left > 0) {
        goOn.textContent = `Go on in ${left}`;
        goOn.setAttribute('aria-disabled', 'true');
      } else {
        goOn.textContent = 'Go on';
        goOn.setAttribute('aria-disabled', 'false');
      }
    };
    draw();
    const timer = setInterval(() => {
      left = Math.max(0, left - 1);
      draw();
      if (left === 0) clearInterval(timer);
    }, 1000);

    goOn.addEventListener('click', async () => {
      if (goOn.getAttribute('aria-disabled') === 'true') return;
      goOn.setAttribute('aria-disabled', 'true');
      try {
        const { [Gateways.PASS_KEY]: raw } = await browserAPI.storage.local.get(Gateways.PASS_KEY);
        await browserAPI.storage.local.set({ [Gateways.PASS_KEY]: Gateways.addPass(raw, key, Date.now()) });
      } catch (_) {}
      if (target) window.location.replace(target);
      else goBack();
    });

    const notTonight = $('not-tonight');
    notTonight.addEventListener('click', async () => {
      if (notTonight.getAttribute('aria-busy') === 'true') return;
      notTonight.setAttribute('aria-busy', 'true');
      clearInterval(timer);
      const at = Date.now();
      let stops = null;
      try {
        const { [Gateways.STOPS_KEY]: raw } = await browserAPI.storage.local.get(Gateways.STOPS_KEY);
        const next = Gateways.addStop(raw, key, at);
        await browserAPI.storage.local.set({ [Gateways.STOPS_KEY]: next });
        stops = next;
      } catch (_) {}
      showStopped(stops, at);
    });

    $('close-tab').addEventListener('click', closeTab);
    $('stopped-wait-start').addEventListener('click', () => startWait($('stopped-wait-start')));
    show('pause');
  }

  // --- Closed in the hard hours ----------------------------------------------

  function runClosed(state, settings, words) {
    const until = Boost.formatUntil(state.until, Date.now());
    $('closed-until').textContent = until;
    if (state.active === 'storm') {
      $('closed-head').textContent = 'Not while the storm is on.';
      $('closed-lede').textContent =
        `You started Storm Mode until ${until}. Every gateway stays closed until it ends, and nothing that loosens protection can be changed before then.`;
    } else {
      $('closed-head').textContent = 'Not during your hard hours.';
      $('closed-lede').textContent =
        `${name} is one of your gateways. Until ${until}, in your risk hours, it stays closed, and nothing that loosens protection can be changed before then.`;
    }
    $('closed-foot').textContent =
      `Outside these hours, this site opens after a ${settings.pause === 60 ? 'one-minute' : `${settings.pause}-second`} pause.`;
    placeWords('closed-words');
    placeWait('closed-wait');
    callLink($('closed-call'), words, true);
    if ($('closed-call').hidden) $('wait-start').className = 'btn btn-primary';

    $('wait-start').addEventListener('click', () => startWait($('wait-start')));
    $('go-back').addEventListener('click', goBack);
    show('closed');
  }

  async function init() {
    let store = {};
    try {
      store = await browserAPI.storage.local.get(['pblocker_settings', Moments.WORDS_KEY, Boost.STATE_KEY]);
    } catch (_) {}
    const settings = Gateways.normalizeSettings(store.pblocker_settings);
    const words = Moments.normalizeWords(store[Moments.WORDS_KEY]);
    fillWords(words);
    $('wait-ok').addEventListener('click', waitedOut);
    const state = Boost.normalizeState(store[Boost.STATE_KEY]);
    if (state && (!state.until || state.until > Date.now())) runClosed(state, settings, words);
    else runPause(settings, words);
  }

  init();
})();
