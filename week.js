// week.js: Your week, read back as one page (shared/weekly.js has the rules).
//
// week.html?w=YYYY-MM-DD shows the week starting that day; without it, the
// newest week that's ready, or this week so far for a new install. Opening a
// ready week clears the "new" mark in the popup.

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  const { Weekly, Moments, Gateways, Boost } = globalThis;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Narrower than this, the drawing scrolls sideways instead of shrinking.
  const MIN_DRAW = 560;

  const clock = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const weekdayShort = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short' });
  const weekdayLong = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'long' });
  const monthLong = (ms) => new Date(ms).toLocaleDateString([], { month: 'long' });
  const monthDay = (ms) => new Date(ms).toLocaleDateString([], { month: 'long', day: 'numeric' });

  // "Mon 5 – Sun 11 October", or "Mon 28 September – Sun 4 October".
  function rangeLabel(start) {
    const end = Weekly.addDays(start, 6);
    const sameMonth = new Date(start).getMonth() === new Date(end).getMonth();
    const left = `${weekdayShort(start)} ${new Date(start).getDate()}${sameMonth ? '' : ` ${monthLong(start)}`}`;
    return `${left} – ${weekdayShort(end)} ${new Date(end).getDate()} ${monthLong(end)}`;
  }

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((attr) => el.setAttribute(attr, attrs[attr]));
    if (text) el.textContent = text;
    return el;
  }

  // --- The drawing -------------------------------------------------------------

  const SAYS = {
    stop: (e) => `stopped at the door at ${clock(e.at)}`,
    kept: (e) => `waited it out at ${clock(e.at)}`,
    slip: (e) => `a slip around ${clock(e.at)}`
  };

  function describe(week) {
    return week.days.map((day) => {
      const said = day.events.map((e) => SAYS[e.type](e));
      const status = { kept: 'Kept.', broken: 'Not kept.', ahead: 'Still to come.', before: '' }[day.status];
      return `${weekdayLong(day.start)}: ${said.length ? `${said.join(', ')}. ` : ''}${status}`.trim();
    }).join(' ');
  }

  // Seven columns across the width the drawing is shown at, one pixel to one
  // unit, so labels and lines keep their size on any screen. Lines rise from
  // the day's foot toward the door along the top: a stop turns back just
  // short of it, a moment waited out lower, a slip goes through.
  function draw(svg, week, now) {
    const W = Math.max(MIN_DRAW, Math.floor($('week-scroll').clientWidth));
    const H = Math.round(Math.min(400, Math.max(300, W * 0.2)));
    const k = H / 300;
    const DOOR = 64 * k;
    const BASE = 248 * k;
    const FOOT = 240 * k;
    const TOPS = { stop: 96 * k, kept: 156 * k, slip: 30 * k };
    const colW = W / 7;
    const today = Weekly.dayKey(now);

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    [...svg.childNodes].forEach((node) => { if (node.nodeName !== 'title') node.remove(); });

    for (let i = 1; i < 7; i++) {
      svg.appendChild(svgEl('path', { class: 'wk-sep', d: `M${(colW * i).toFixed(1)} ${DOOR + 8} V${BASE}` }));
    }
    svg.appendChild(svgEl('path', { class: 'wk-door', d: `M0 ${DOOR} H${W}` }));
    svg.appendChild(svgEl('text', { class: 'wk-door-label', x: W, y: DOOR - 14, 'text-anchor': 'end' }, 'THE DOOR'));
    svg.appendChild(svgEl('path', { class: 'wk-base', d: `M0 ${BASE} H${W}` }));

    week.days.forEach((day, i) => {
      const cx = colW * (i + 0.5);
      // Lines 28 apart; 40 when each carries its time, so a label never
      // lands on the line before it.
      const room = (step) => Math.max(1, Math.floor((colW - 16 + step - 20) / step));
      const labelled = colW >= 100 && day.events.length <= Math.min(3, room(40));
      const step = labelled ? 40 : 28;
      const fits = room(step);
      const shown = day.events.slice(0, fits);
      const more = day.events.length - shown.length;
      const span = shown.length * 20 + (shown.length - 1) * (step - 20);

      shown.forEach((e, j) => {
        const x = Math.round(cx - span / 2 + j * step);
        if (e.type === 'slip') {
          svg.appendChild(svgEl('path', { class: 'wk-slip', d: `M${x + 10} ${FOOT} V${TOPS.slip}` }));
          svg.appendChild(svgEl('circle', { class: 'wk-slip-end', cx: x + 10, cy: TOPS.slip - 6, r: 3.5 }));
        } else {
          const top = TOPS[e.type];
          svg.appendChild(svgEl('path', {
            class: e.type === 'stop' ? 'wk-stop' : 'wk-kept',
            d: `M${x} ${FOOT} V${top} A10 10 0 0 1 ${x + 20} ${top} V${FOOT}`
          }));
        }
        if (labelled) {
          const lx = e.type === 'slip' ? x + 4 : x - 6;
          svg.appendChild(svgEl('text', { class: 'wk-time', transform: `translate(${lx} ${FOOT - 4}) rotate(-90)` }, clock(e.at).toUpperCase()));
        }
      });
      if (more > 0) {
        svg.appendChild(svgEl('text', { class: 'wk-more', x: Math.round(colW * (i + 1) - 6), y: DOOR + 22, 'text-anchor': 'end' }, `+${more}`));
      }

      if (day.status === 'kept') {
        svg.appendChild(svgEl('rect', { class: 'wk-day-kept', x: Math.round(cx - 4), y: BASE + 6, width: 8, height: 8 }));
      } else if (day.status === 'broken') {
        svg.appendChild(svgEl('rect', { class: 'wk-day-broken', x: Math.round(cx - 3.5) + 0.5, y: BASE + 6.5, width: 7, height: 7 }));
      }
      const isToday = Weekly.dayKey(day.start) === today;
      const label = `${weekdayShort(day.start)} ${new Date(day.start).getDate()}`.toUpperCase();
      const cls = isToday ? 'wk-label wk-label-today' : (day.status === 'ahead' ? 'wk-label wk-label-ahead' : 'wk-label');
      svg.appendChild(svgEl('text', { class: cls, x: Math.round(cx), y: H - 14, 'text-anchor': 'middle' }, label));
    });
  }

  // --- The words and numbers -----------------------------------------------------

  function setBefore(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
  }

  function fillNumbers(week, before) {
    $('week-stops').textContent = String(week.stops);
    $('week-kept').textContent = String(week.kept);
    $('week-days').textContent = String(week.daysKept);
    $('week-days-of').textContent = `of ${week.daysCounted}`;
    if (!before) return;
    setBefore('week-stops-before', `${before.stops} the week before`);
    setBefore('week-kept-before', `${before.kept} the week before`);
    setBefore('week-days-before', before.daysCounted === 7
      ? `${before.daysKept} the week before`
      : `${before.daysKept} of ${before.daysCounted} the week before`);
  }

  async function applySuggestion(suggestion) {
    if (suggestion.kind === 'risk') {
      const { [Boost.RISK_KEY]: stored } = await browserAPI.storage.local.get(Boost.RISK_KEY);
      const current = Boost.normalizeRisk(stored);
      // Only ever wider than what's set now, in case it changed meanwhile.
      if (!Weekly.covers(suggestion.risk, current)) return 'Your risk hours changed since this was written. See Settings › Protection.';
      await browserAPI.storage.local.set({ [Boost.RISK_KEY]: suggestion.risk });
      try { await browserAPI.runtime.sendMessage({ type: 'boost_reconcile' }); } catch (_) {}
      return `Done. Your risk hours are now ${Boost.formatMinutes(suggestion.risk.start)} to ${Boost.formatMinutes(suggestion.risk.end)}, every day.`;
    }
    if (suggestion.kind === 'gateway') {
      const { pblocker_settings: settings } = await browserAPI.storage.local.get('pblocker_settings');
      // Never write a settings object of one key: everything else would read
      // as unset. The background always stores the defaults first.
      if (!settings || typeof settings !== 'object') return 'Open Settings › Protection to add it.';
      const on = Gateways.normalizeSettings(settings).on;
      if (!on.includes(suggestion.id)) on.push(suggestion.id);
      await browserAPI.storage.local.set({ pblocker_settings: { ...settings, gateways: on } });
      return `Done. ${Gateways.nameFor(suggestion.id)} now asks you to pause first.`;
    }
    return '';
  }

  function fillSuggestion(suggestion) {
    if (!suggestion) return;
    $('week-try-text').textContent = suggestion.text;
    $('week-try-go').textContent = suggestion.label;
    $('week-try').hidden = false;
    $('week-try-go').addEventListener('click', async () => {
      const go = $('week-try-go');
      if (go.getAttribute('aria-busy') === 'true') return;
      go.setAttribute('aria-busy', 'true');
      let said = '';
      try { said = await applySuggestion(suggestion); } catch (_) { said = 'That didn’t save. Try again from Settings.'; }
      $('week-try-actions').hidden = true;
      $('week-try-done').textContent = said;
      $('week-try-done').hidden = false;
    });
    $('week-try-later').addEventListener('click', () => { $('week-try').hidden = true; });
  }

  function link(id, start) {
    const a = $(id);
    a.href = `week.html?w=${Weekly.dayKey(start)}`;
    a.hidden = false;
  }

  async function init() {
    const now = Date.now();
    const firstDay = Weekly.MONDAY;
    let store = {};
    try {
      store = await browserAPI.storage.local.get([
        'pblocker_settings', Gateways.STOPS_KEY, Moments.KEPT_KEY, Moments.SLIPS_KEY,
        Moments.FIRST_SEEN_KEY, 'pblocker_audit_disabled', Boost.RISK_KEY, Weekly.SEEN_KEY
      ]);
    } catch (_) {}
    const settings = store.pblocker_settings || {};
    const firstSeen = Number(store[Moments.FIRST_SEEN_KEY]) > 0 ? Number(store[Moments.FIRST_SEEN_KEY]) : now;
    const input = {
      now,
      firstSeen,
      stops: Gateways.normalizeStops(store[Gateways.STOPS_KEY]).recent,
      kept: Moments.normalizeKept(store[Moments.KEPT_KEY]).times,
      slips: Moments.normalizeSlips(store[Moments.SLIPS_KEY]),
      off: Moments.offIntervals(store.pblocker_audit_disabled, now, settings.enabled !== false)
    };

    // Which week: the one asked for, if it's one on offer; else the newest ready.
    const span = Weekly.range(now, firstDay, firstSeen);
    const latest = Weekly.latestReady(now, firstDay);
    let start = Weekly.parseKey(new URLSearchParams(window.location.search).get('w'));
    if (start !== null) start = Weekly.weekStart(start, firstDay);
    if (start === null || start < span.oldest || start > span.newest) start = Math.max(span.oldest, latest);
    const partial = now < Weekly.readyAt(start);

    const week = Weekly.collect(input, start);
    const prevStart = Weekly.addDays(start, -7);
    // The week before is only compared when its days were seen and its
    // times are still kept.
    const before = prevStart >= Weekly.addDays(span.newest, -7 * Weekly.WEEKS_BACK) && Weekly.collect(input, prevStart);
    const names = {};
    Gateways.BUILT_IN.forEach((g) => { names[g.id] = g.name; });
    const told = Weekly.tell(week, {
      partial,
      risk: Boost.normalizeRisk(store[Boost.RISK_KEY]),
      gatewaysOn: Gateways.normalizeSettings(settings).on,
      names,
      format: Boost.formatMinutes
    });

    $('week-kind').textContent = partial ? 'This week so far' : 'Your week';
    $('week-range').textContent = rangeLabel(start);
    $('week-head').textContent = told.headline;
    $('week-lede').textContent = told.lede;
    $('week-closing').textContent = told.closing;
    $('week-drawing-title').textContent = describe(week);
    fillNumbers(week, before && before.daysCounted > 0 ? before : null);
    fillSuggestion(told.suggestion);

    const nextReady = partial ? Weekly.readyAt(start) : Weekly.readyAt(Weekly.addDays(start, 7));
    $('week-next-note').textContent = partial
      ? `This week’s arrives ${weekdayLong(nextReady)} evening.`
      : (start === latest ? `Your next week arrives ${weekdayLong(nextReady)}, ${monthDay(nextReady)}.` : '');
    if (start > span.oldest) link('week-prev', prevStart);
    if (start < span.newest) link('week-next', Weekly.addDays(start, 7));

    const svg = $('week-drawing');
    draw(svg, week, now);
    if (typeof ResizeObserver === 'function') {
      let width = $('week-scroll').clientWidth;
      new ResizeObserver(() => {
        const next = $('week-scroll').clientWidth;
        if (next === width) return;
        width = next;
        draw(svg, week, now);
      }).observe($('week-scroll'));
    }

    // Opening the newest ready week is what clears "new" in the popup.
    if (!partial && start === latest) {
      const seen = Weekly.parseKey(store[Weekly.SEEN_KEY]);
      if (seen === null || seen < start) {
        try { await browserAPI.storage.local.set({ [Weekly.SEEN_KEY]: Weekly.dayKey(start) }); } catch (_) {}
      }
    }
  }

  init();
})();
