const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

// The detail normally arrives through session storage under a random key, so
// the address of the blocked site never enters this page's URL — and so never
// enters browser history, omnibox suggestions, or Chrome's history sync.
// content.js used to put it in the query string, which meant `location.replace`
// kept the adult URL out of history and then wrote a history entry containing
// it anyway. See stashBlockedDetail() in content.js.
//
// The query-string form is still read, for three cases that all still occur: a
// custom blocked page (someone else's document, which cannot read our
// storage), a browser without session storage, and a redirect already in
// flight when the extension updated.
const detailKey = getParam('k') || '';

let url = getParam('url') || 'Unknown URL';
let reason = getParam('reason') || '';
let matched = getParam('matched') || '';
let score = getParam('score') || '';
// `mode` is deliberately not read from the query string any more — see the
// plain-HTML branch at the bottom of this file. content.js still sends it, so
// older copies of the blocked page keep working during an update.

// The settings page's Preview button opens ?preview=<design>. It can only pick
// one of the registry's designs, and it shows a placeholder address, never a
// real one: this page is web-accessible, so any website can open that URL.
const PREVIEW_URL = 'https://example.com/';
const previewTheme = (() => {
  const themes = globalThis.BlockedThemes;
  const id = getParam('preview');
  return (themes && id && themes.get(id)) ? id : '';
})();

// What held the page, in four forms:
//  - `sourceLabel`: the name of the rule, for the held line and the records;
//  - `detail`: the phrase a custom template's {{reason}} receives, unchanged so
//    pages people have written keep reading the same;
//  - `message`: one plain sentence, what held it and what that means, which
//    says whether the page never loaded or closed as soon as it was read;
//  - `layer`: which of the six layers held it (LAYERS, below), for Classic's
//    drawing, or null when the reason doesn't say.
function getReasonMeta(reasonCode) {
  switch (reasonCode) {
    case 'custom_blocklist':
      return {
        sourceLabel: 'Your blocklist',
        detail: 'Blocked by your custom blocklist',
        message: 'You added this site to your own blocklist, on a calmer day. It never loaded.',
        layer: 1
      };
    case 'default_blocklist':
    case 'instant_host_match':
      return {
        sourceLabel: 'Built-in blocklist',
        detail: 'Blocked by the built-in blocklist',
        message: 'This site is on BlockNSFW’s list of adult sites. It never loaded.',
        layer: 2
      };
    case 'dns_blocked':
      return {
        sourceLabel: 'DNS protection',
        detail: 'Blocked by DNS Protection',
        message: 'Your safe DNS knows this site as adult. It never loaded.',
        layer: 3
      };
    case 'smart_filter':
    case 'instant_keyword_match':
      return {
        sourceLabel: 'Keyword filter',
        detail: 'Blocked by the smart keyword filter',
        message: 'The address itself spelled out adult content. It never loaded.',
        layer: 4
      };
    case 'search_query':
      return {
        sourceLabel: 'Search filter',
        detail: 'Blocked by search query filter',
        message: 'The search asked for adult content. The results never loaded.',
        layer: 4
      };
    case 'reddit_nsfw':
      return {
        sourceLabel: 'NSFW community filter',
        detail: 'Blocked due to NSFW subreddit detection',
        message: 'This page belongs to a Reddit community marked NSFW. It was held before it showed.',
        layer: 4
      };
    case 'metadata_scan':
      return {
        sourceLabel: 'Page details',
        detail: 'Blocked by metadata scan',
        message: 'The page’s title or description was explicit. It closed as soon as it was read.',
        layer: 5
      };
    case 'page_text_scan':
      return {
        sourceLabel: 'Page text',
        detail: 'Blocked by page text scan',
        message: 'The words on the page were explicit, again and again. It closed as soon as it was read.',
        layer: 5
      };
    case 'ai_text_scan':
      return {
        sourceLabel: 'On-device AI',
        detail: 'Blocked by AI text scan',
        message: 'The AI on your device read the page and judged it adult. It closed as soon as it was read, and nothing was sent anywhere.',
        layer: 6
      };
    case 'blocked':
    case 'content':
    case 'local_filter':
      return {
        sourceLabel: 'Local filter rules',
        detail: 'Blocked by local filter rules',
        message: 'This page matched BlockNSFW’s local filter rules. It was held before it showed.',
        layer: null
      };
    default:
      return {
        sourceLabel: 'Protection rules',
        detail: reasonCode ? reasonCode.replaceAll('_', ' ') : 'Blocked by protection rules',
        message: 'This page matched your protection settings. It was held before it showed.',
        layer: null
      };
  }
}

// The six layers between a reader and an adult page, in the order they meet
// it: four look at the address before anything loads, two read the page once
// it opens.
const LAYERS = ['your list', 'built-in list', 'DNS', 'address & search', 'page text', 'on-device AI'];
const BEFORE_LOAD = 4;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];

// The address is never shown, on this page or any other: eight bullets and the
// top-level domain, the same length whatever the site, so nothing about it can
// be read off the screen. An IP address or an unreadable value keeps no ending.
function redactedHost(address) {
  const mask = '••••••••';
  try {
    const host = new URL(address).hostname;
    const dot = host.lastIndexOf('.');
    const ending = dot > 0 ? host.slice(dot + 1).toLowerCase() : '';
    return /^[a-z][a-z0-9-]*$/.test(ending) ? `${mask}.${ending}` : mask;
  } catch (_) {
    return mask;
  }
}

function addRecord(list, label, value, valueClass) {
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'record';
  const term = document.createElement('dt');
  term.className = 'meta';
  term.textContent = label;
  const data = document.createElement('dd');
  data.className = valueClass || 'why-value';
  data.textContent = value;
  row.appendChild(term);
  row.appendChild(data);
  list.appendChild(row);
}

// The page title, its address, its favicon and the words it matched are all
// part of what was held, so none of them is written here. The reason is named,
// and the AI's confidence, which is a number, not the page's content.
function renderDetail() {
  const reasonMeta = getReasonMeta(reason);
  const shown = redactedHost(url);

  const urlEl = document.getElementById('target-url');
  if (urlEl) {
    urlEl.textContent = shown;
  }
  const addressEl = document.getElementById('held-address');
  if (addressEl) {
    addressEl.textContent = shown;
  }

  const messageEl = document.querySelector('.blocked-message');
  if (messageEl && reasonMeta.message) {
    messageEl.textContent = reasonMeta.message;
  }

  const subtitleEl = document.querySelector('.blocked-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = reasonMeta.message;
  }

  // The AI text scan reports a confidence score in [0,1]; show it as a percent.
  const scorePct = score ? Math.round(parseFloat(score) * 100) : NaN;
  const sure = Number.isNaN(scorePct) ? '' : `${scorePct}%`;

  if (reason) {
    const rows = document.getElementById('why-rows');
    addRecord(rows, 'reason', reasonMeta.sourceLabel);
    if (sure) addRecord(rows, 'ai confidence', sure, 'record-value tnum');
  }

  // Classic names the door and draws it; a design draws its own picture.
  if (document.documentElement.dataset.theme) return;
  const meta = document.getElementById('held-meta');
  const time = document.getElementById('held-time');
  const source = document.getElementById('held-source');
  if (meta && time && source) {
    try {
      time.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
      time.textContent = '';
    }
    source.textContent = sure ? `${reasonMeta.sourceLabel} · ${sure} sure` : reasonMeta.sourceLabel;
    meta.hidden = !time.textContent && !source.textContent;
  }
  if (!reasonMeta.layer) return;
  const title = document.getElementById('blocked-title');
  if (title) title.textContent = `Held at the ${ORDINALS[reasonMeta.layer - 1]} door.`;
  drawDoors(reasonMeta.layer, reasonMeta.sourceLabel);
}

// --- The six doors (Classic) ---------------------------------------------------
//
// A line comes in and stops at the door that held the page, ending in a brass
// square. The doors it passed stand open (a gap where it went through); the
// doors it never reached are faint. Two drawings of the same thing: across on
// wide screens, down on narrow ones. Built as SVG nodes, no markup strings.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs).forEach((k) => node.setAttribute(k, String(attrs[k])));
  if (text !== undefined) node.textContent = text;
  return node;
}

// Paths for the doors passed, ahead and the one that held, given each door's
// line as two half-segments either side of where the arrival crosses it.
function doorPaths(held, doorAt) {
  let passed = '';
  let ahead = '';
  for (let n = 1; n <= LAYERS.length; n++) {
    const d = doorAt(n);
    if (n < held) passed += `${d.open} `;
    else if (n > held) ahead += `${d.whole} `;
  }
  return { passed, ahead, held: doorAt(held).held };
}

function drawAcross(svg, held) {
  const xs = [140, 290, 440, 590, 840, 990];
  const at = (n) => {
    const x = xs[n - 1];
    return { open: `M${x} 40V96M${x} 126V182`, whole: `M${x} 40V182`, held: `M${x} 32V190` };
  };
  const p = doorPaths(held, at);
  const sx = xs[held - 1];
  svg.appendChild(svgNode('text', { class: 'door-group', x: 110, y: 16 }, 'BEFORE THE PAGE LOADS'));
  svg.appendChild(svgNode('text', { class: 'door-group', x: 800, y: 16 }, 'AFTER IT OPENS'));
  svg.appendChild(svgNode('path', { class: 'door-split', d: 'M715 28V196' }));
  if (p.ahead) svg.appendChild(svgNode('path', { class: 'door-ahead', d: p.ahead }));
  if (p.passed) svg.appendChild(svgNode('path', { class: 'door-passed', d: p.passed }));
  svg.appendChild(svgNode('path', { class: 'door-arrival', d: `M0 111H${sx - 10}` }));
  svg.appendChild(svgNode('path', { class: 'door-held', d: p.held }));
  svg.appendChild(svgNode('rect', { class: 'door-square', x: sx - 12, y: 106, width: 10, height: 10 }));
  xs.forEach((x, i) => {
    const n = i + 1;
    const state = n === held ? ' is-held' : (n > held ? ' is-ahead' : '');
    svg.appendChild(svgNode('text', { class: `door-label${state}`, x, y: 210, 'text-anchor': 'middle' }, LAYERS[i].toUpperCase()));
  });
}

function drawDown(svg, held) {
  const ys = [42, 84, 126, 168, 248, 290];
  const at = (n) => {
    const y = ys[n - 1];
    return { open: `M24 ${y}H66M94 ${y}H136`, whole: `M24 ${y}H136`, held: `M16 ${y}H144` };
  };
  const p = doorPaths(held, at);
  const sy = ys[held - 1];
  svg.appendChild(svgNode('text', { class: 'door-group', x: 152, y: 14 }, 'BEFORE THE PAGE LOADS'));
  svg.appendChild(svgNode('text', { class: 'door-group', x: 152, y: 220 }, 'AFTER IT OPENS'));
  svg.appendChild(svgNode('path', { class: 'door-split', d: 'M8 204H336' }));
  if (p.ahead) svg.appendChild(svgNode('path', { class: 'door-ahead', d: p.ahead }));
  if (p.passed) svg.appendChild(svgNode('path', { class: 'door-passed', d: p.passed }));
  svg.appendChild(svgNode('path', { class: 'door-arrival', d: `M80 0V${sy - 10}` }));
  svg.appendChild(svgNode('path', { class: 'door-held', d: p.held }));
  svg.appendChild(svgNode('rect', { class: 'door-square', x: 75, y: sy - 12, width: 10, height: 10 }));
  ys.forEach((y, i) => {
    const n = i + 1;
    const state = n === held ? ' is-held' : (n > held ? ' is-ahead' : '');
    svg.appendChild(svgNode('text', { class: `door-label${state}`, x: 152, y: y + 4 }, LAYERS[i].toUpperCase()));
  });
}

function doorsCaption(held) {
  const ord = ORDINALS[held - 1];
  if (held > BEFORE_LOAD) {
    return `Six layers stand between you and an adult page. The first four check the address before it loads; this page got past them, and the ${ord} closed it as soon as it was read.`;
  }
  const rest = LAYERS.length - held;
  return `Six layers stand between you and an adult page. This one was held at the ${ord}, before anything loaded, so the other ${NUMBER_WORDS[rest]} weren’t needed.`;
}

function drawDoors(held, label) {
  const figure = document.getElementById('doors');
  const across = document.getElementById('doors-across');
  const down = document.getElementById('doors-down');
  const caption = document.getElementById('doors-caption');
  const title = document.getElementById('doors-title');
  if (!figure || !across || !down) return;
  drawAcross(across, held);
  drawDown(down, held);
  if (title) {
    title.textContent = held === 1
      ? `Six layers of protection. This page was held at the first: ${label}.`
      : `Six layers of protection. This page passed ${NUMBER_WORDS[held - 1]} and was held at the ${ORDINALS[held - 1]}: ${label}.`;
  }
  if (caption) caption.textContent = doorsCaption(held);
  figure.hidden = false;
}

/**
 * Fetch the stashed detail, then render.
 *
 * content.js writes it fire-and-forget so the redirect is not delayed, which
 * leaves a small race: this page can load before the write lands. One short
 * retry covers it. If nothing arrives the page still renders — with a generic
 * message rather than a wrong one — because a blocked page that fails to
 * appear is far worse than one missing its reason line.
 *
 * The record is deleted after reading. It exists only to survive one
 * navigation.
 */
async function loadStashedDetail() {
  const area = browserAPI.storage && browserAPI.storage.session;
  if (!detailKey || !area) return false;

  for (const waitMs of [0, 60, 180]) {
    if (waitMs) await new Promise(done => setTimeout(done, waitMs));
    let record;
    try {
      const stored = await area.get(detailKey);
      record = stored && stored[detailKey];
    } catch (_) {
      return false;
    }
    if (!record) continue;
    try { area.remove(detailKey); } catch (_) {}

    url = typeof record.url === 'string' && record.url ? record.url : url;
    reason = typeof record.reason === 'string' ? record.reason : reason;
    matched = Array.isArray(record.matched) ? record.matched.join(', ') : (record.matched || '');
    score = (typeof record.score === 'number' && isFinite(record.score))
      ? record.score.toFixed(2) : '';
    return true;
  }
  return false;
}

/**
 * User-supplied HTML replaces the document outright.
 *
 * Which page type to render is read from settings, not from the `mode` query
 * parameter. content.js sets that parameter from the same setting, so
 * legitimate navigations are unaffected — but taking it from the URL let any
 * website choose this rendering path for a user who had never selected it.
 *
 * Only the substituted values are escaped. The template is the user's own
 * HTML and is meant to render as markup; that is the feature.
 *
 * @returns {boolean} whether it took over the document
 */
function renderPlainHtml(settings) {
  try {
    if (!settings || settings.blockedPageType !== 'plain_html') return false;
    const html = typeof settings.plainBlockedPageHtml === 'string' ? settings.plainBlockedPageHtml : '';
    if (!html || !html.trim()) return false;
    const rendered = html
      .replace(/\{\{\s*url\s*\}\}/g, escapeHtml(url))
      .replace(/\{\{\s*reason\s*\}\}/g, escapeHtml(getReasonMeta(reason).detail));
    document.open();
    document.write(rendered);
    document.close();
    return true;
  } catch (_) {
    return false;
  }
}

async function loadSettings() {
  try {
    const { pblocker_settings: settings } = await browserAPI.storage.local.get('pblocker_settings');
    return settings || null;
  } catch (_) {
    return null;
  }
}

// --- Design -----------------------------------------------------------------
//
// Classic is this document as written. Any other design (blocked-themes.js)
// renders a hero above the card and restyles the card through
// html[data-theme]; the card keeps the reason, the address and the buttons.

// Whole days protection has stayed on, the same streak the Statistics page
// shows. It resets when protection is switched off, so it is described as
// days of protection, never as days clean.
function streakDays() {
  return browserAPI.storage.local.get('pblocker_streak_start').then((stored) => {
    const start = stored && stored.pblocker_streak_start;
    if (typeof start !== 'number' || !isFinite(start)) return null;
    return Math.floor((Date.now() - start) / (24 * 60 * 60 * 1000));
  });
}

function applyTheme(settings) {
  const themes = globalThis.BlockedThemes;
  if (!themes) return;
  const id = previewTheme || themes.normalize(settings && settings.blockedPageTheme);
  const theme = themes.get(id);
  const hero = document.getElementById('theme-hero');
  if (!theme || typeof theme.render !== 'function' || !hero) return;

  const reducedMotion = typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.dataset.theme = id;
  hero.hidden = false;
  const why = document.getElementById('why');
  if (why) why.open = false;
  // A design's buttons are plain words; the emoji belong to Classic.
  const back = document.getElementById('back-button');
  if (back) back.textContent = 'Go back';
  const settingsLink = document.getElementById('settings');
  if (settingsLink) settingsLink.textContent = 'Settings';
  theme.render({ doc: document, hero, reducedMotion, loadStreakDays: streakDays });
}

function revealPage() {
  try {
    document.documentElement.classList.remove('theme-pending');
  } catch (_) {}
}

// Settles once the stashed detail has been read, or given up on. The popup's
// question below waits on it rather than answering with the placeholder.
let markDetailSettled;
const detailSettled = new Promise(done => { markDetailSettled = done; });

// One driver, so every rendering path sees the same detail. The stashed record
// has to be read before any runs, or they render the query string's values and
// the whole point of stashing it is lost.
(async () => {
  if (previewTheme) {
    url = PREVIEW_URL;
    reason = 'default_blocklist';
  } else {
    try {
      await loadStashedDetail();
    } catch (_) {
      // Fall through and render whatever the query string carried.
    }
  }
  markDetailSettled();
  // A preview shows the design it names, whatever page type is saved.
  const settings = previewTheme ? null : await loadSettings();
  try {
    if (renderPlainHtml(settings)) return;
  } catch (_) {}
  try {
    applyTheme(settings);
  } catch (error) {
    console.warn('BlockNSFW: could not apply the blocked-page design', error);
  }
  revealPage();
  try {
    renderDetail();
  } catch (error) {
    console.warn('BlockNSFW: could not render blocked-page detail', error);
  }
  // Not in the design previews in Settings: those show the design, not you.
  if (!previewTheme) {
    renderMoment().catch((error) => console.warn('BlockNSFW: could not render the moment', error));
  }
})();

// --- For this moment ------------------------------------------------------------
//
// The person's own words (shared/moments.js), written in a calm moment, come
// first: their plan, their note, someone to reach. Then one line to wait the
// urge out. Pressing "I'm OK now" counts a kept moment, on this device only.
async function renderMoment() {
  const Moments = globalThis.Moments;
  const Boost = globalThis.Boost;
  const section = document.getElementById('moment');
  if (!Moments || !section) return;
  const keys = [Moments.WORDS_KEY, Moments.PHOTO_KEY];
  if (Boost) keys.push(Boost.STATE_KEY);
  const store = await browserAPI.storage.local.get(keys);
  const words = Moments.normalizeWords(store[Moments.WORDS_KEY]);

  // A photo chosen for this moment, above the words: kept on the device as a
  // plain image (Moments.photoSrc turns away anything else).
  const photo = document.getElementById('moment-photo');
  const src = Moments.photoSrc(store[Moments.PHOTO_KEY]);
  if (photo) {
    if (src) photo.src = src;
    photo.hidden = !src;
  }

  const show = (id, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  };
  show('moment-plan', words.plan);
  show('moment-note', words.note);

  // Someone to reach: a call link only for a plain phone number.
  const person = document.getElementById('moment-person');
  if (person) {
    person.textContent = '';
    const { name, phone } = words.person;
    const href = Moments.telHref(phone);
    if (href) {
      const link = document.createElement('a');
      link.className = 'link';
      link.href = href;
      link.textContent = name ? `Call ${name}` : `Call ${phone}`;
      person.appendChild(link);
    } else if (name || phone) {
      person.textContent = name && phone ? `Reach out to ${name}: ${phone}` : `Reach out to ${name || phone}`;
    }
    person.hidden = !person.textContent;
  }
  const hasWords = Moments.hasWords(words);
  document.getElementById('moment-words').hidden = !hasWords;

  const add = document.getElementById('moment-add');
  if (add) {
    add.hidden = hasWords;
    add.href = browserAPI.runtime.getURL('options.html#own-words-group');
  }

  const state = Boost ? Boost.normalizeState(store[Boost.STATE_KEY]) : null;
  if (state) {
    show('moment-boost', state.active === 'storm'
      ? `Storm Mode is on until ${Boost.formatUntil(state.until, Date.now())}.`
      : `Your risk hours run until ${Boost.formatUntil(state.until, Date.now())}.`);
  }

  wireWaitTimer(Moments);
  section.hidden = false;
}

function wireWaitTimer(Moments) {
  const idle = document.getElementById('moment-wait-idle');
  const running = document.getElementById('moment-wait-running');
  const done = document.getElementById('moment-wait-done');
  const time = document.getElementById('moment-wait-time');
  const text = document.getElementById('moment-wait-text');
  const ok = document.getElementById('moment-ok');
  if (!idle || !running || !done || !time || !ok) return;
  let timer = null;
  let endsAt = 0;

  const format = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const tick = () => {
    const left = endsAt - Date.now();
    time.textContent = format(left);
    if (left > 0) return;
    clearInterval(timer);
    timer = null;
    time.textContent = '0:00';
    if (text) text.textContent = 'The time is up. If the urge has passed, that’s one kept.';
  };

  idle.querySelectorAll('[data-wait]').forEach((button) => {
    button.addEventListener('click', () => {
      endsAt = Date.now() + Number(button.dataset.wait) * 60 * 1000;
      idle.hidden = true;
      running.hidden = false;
      if (text) text.textContent = 'left. Most urges pass if you wait them out.';
      tick();
      clearInterval(timer);
      timer = setInterval(tick, 1000);
      ok.focus();
    });
  });

  ok.addEventListener('click', async () => {
    clearInterval(timer);
    timer = null;
    running.hidden = true;
    done.hidden = false;
    let count = 0;
    try {
      const { [Moments.KEPT_KEY]: raw } = await browserAPI.storage.local.get(Moments.KEPT_KEY);
      const kept = Moments.addKept(raw, Date.now());
      count = kept.count;
      await browserAPI.storage.local.set({ [Moments.KEPT_KEY]: kept });
    } catch (_) {}
    done.textContent = count > 1
      ? `That’s ${count} moments you’ve waited out. You can go back now.`
      : 'That’s one moment waited out. You can go back now.';
  });
}

// --- Telling the popup which site this is -----------------------------------
//
// "Unblock this website" in the popup has to whitelist the site this page
// stands in for. It used to read that from ?url=, and still does for the
// fallback form. But the address is now kept out of this page's URL, and the
// record is deleted once read, so this page is the only thing that still
// knows. The popup found no url= parameter, fell back to the tab's own
// address, and whitelisted the extension's ID instead (issue #44, the same
// symptom as #26).
//
// So the popup asks, naming the key from the tab's address. Every blocked tab
// hears the question; only the one holding that key answers.
function blockedTargetUrl() {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
  } catch (_) {
    return null; // still the 'Unknown URL' placeholder
  }
}

function answerPopup(message, sender, sendResponse) {
  if (!message || message.type !== 'blocked_page_target') return false;
  if (!detailKey || message.key !== detailKey) return false;
  // Only our popup. Content scripts share this bus, and one tab's page has no
  // business learning what another tab blocked.
  const popupUrl = browserAPI.runtime.getURL('popup.html');
  if (!sender || sender.id !== browserAPI.runtime.id || sender.tab ||
      String(sender.url || '').split(/[?#]/)[0] !== popupUrl) {
    return false;
  }
  detailSettled.then(() => {
    const target = blockedTargetUrl();
    sendResponse(target ? { url: target } : null);
  });
  return true;
}

// Guarded: a throw here would stop the rest of this file, and the back button
// below would never be bound.
try {
  browserAPI.runtime.onMessage.addListener(answerPopup);
} catch (_) {}

// --- Page chrome ------------------------------------------------------------

function runtimeURL(path) {
  return browserAPI.runtime.getURL(path);
}

function openTab(target) {
  window.open(target, '_blank');
}

function goBack() {
  // content.js arrives here via location.replace(), so the blocked site is not
  // in history and stepping back lands on whatever preceded it. A tab opened
  // straight onto a blocked link has nothing behind it at all.
  if (history.length > 1) {
    history.back();
  } else {
    location.replace('about:blank');
  }
}

// Values substituted into the user's template. Everything on this page comes
// out of the query string, and blocked.html is a web-accessible resource — so
// any website can navigate to it, or frame it, with a `url` of its choosing.
// Written into the template unescaped, that is HTML injection into the
// extension's own origin.
//
// The extension CSP (script-src 'self') stops injected script from running,
// but it does not stop markup: an attacker could render a convincing
// "BlockNSFW — enter your PIN to continue" form at a genuine
// chrome-extension:// address, and img-src is unrestricted so the result can
// be sent somewhere. PIN phishing against this particular audience is not a
// theoretical concern.
//
// Only the substituted values are escaped. The template itself is the user's
// own HTML and is meant to render as HTML — that is the whole feature.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


document.addEventListener('DOMContentLoaded', () => {
  const settings = document.getElementById('settings');
  if (settings) {
    settings.addEventListener('click', (e) => {
      e.preventDefault();
      openTab(runtimeURL('options.html'));
    });
  }

  // Bound here rather than as an inline onclick: the extension CSP is
  // script-src 'self', which blocks inline handlers outright.
  const backButton = document.getElementById('back-button');
  if (backButton) {
    backButton.addEventListener('click', goBack);
  }
});
