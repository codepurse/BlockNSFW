// options-supporter.js
// Settings › Supporter: the author's note and the price, what it opens, and
// the code; for a supporter, a thank-you in place of the price. shared/
// supporter.js checks codes; nothing here touches blocking.

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  const $ = (id) => document.getElementById(id);

  // A development install (loaded unpacked) is the author's test copy.
  let devInstall = null;
  async function isDev() {
    if (devInstall === null) {
      try {
        devInstall = (await browserAPI.management.getSelf()).installType === 'development';
      } catch (_) {
        devInstall = false;
      }
    }
    return devInstall;
  }

  // The author's own words aren't written yet. In a development install the
  // brackets show where they go; in a store build the lines stay out.
  async function hidePlaceholders() {
    if (await isDev()) return;
    document.querySelectorAll('#section-supporter [data-placeholder]').forEach((el) => {
      if (/^\W*\[/.test(el.textContent.trim())) el.hidden = true;
    });
  }

  // Words only a screen reader hears.
  function said(text) {
    const s = document.createElement('span');
    s.className = 'visually-hidden';
    s.textContent = text;
    return s;
  }

  // The comparison's cells: a check where it's included, a dash where it
  // isn't, each with words for screen readers.
  function fillCompare() {
    const NS = 'http://www.w3.org/2000/svg';
    document.querySelectorAll('#supporter-compare td[data-yes]').forEach((td) => {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'compare-check');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M3 8.5l3.2 3.2L13 4.8');
      svg.appendChild(path);
      td.replaceChildren(svg, said('Included'));
    });
    document.querySelectorAll('#supporter-compare td[data-no]').forEach((td) => {
      const dash = document.createElement('span');
      dash.className = 'compare-none';
      dash.setAttribute('aria-hidden', 'true');
      dash.textContent = '—';
      td.replaceChildren(dash, said('Not included'));
    });
  }

  // The heart beside the thank-you: rows of stitches cut to a heart, and
  // across its middle the reader's own thread, unbroken and gold, with a
  // spark that runs along it. Each row opens from the middle, top to
  // bottom, then drifts the other way from the row above it (options.html
  // has the motion).
  const HEART = 'M120 200C60 160 22 122 22 80C22 50 44 30 72 30C94 30 110 44 120 60C130 44 146 30 168 30C196 30 218 50 218 80C218 122 180 160 120 200Z';
  const HEART_GOLD = 112;
  function weaveHeart() {
    const box = $('thanks-heart');
    if (!box || box.firstChild) return;
    const NS = 'http://www.w3.org/2000/svg';
    const make = (name, attrs) => {
      const el = document.createElementNS(NS, name);
      Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
      return el;
    };
    const svg = make('svg', { viewBox: '0 0 240 230', 'aria-hidden': 'true', focusable: 'false' });
    const defs = make('defs', {});
    const clip = make('clipPath', { id: 'thanks-heart-clip' });
    clip.appendChild(make('path', { d: HEART }));
    defs.appendChild(clip);
    const rows = make('g', { 'clip-path': 'url(#thanks-heart-clip)' });
    let n = 0;
    for (let y = 34; y <= 196; y += 6) {
      if (y === HEART_GOLD) continue;
      const row = make('line', {
        class: `heart-row stitch-${(n % 3) + 1}${n % 2 ? ' drift-back' : ''}`,
        x1: 0, x2: 240, y1: y, y2: y
      });
      row.style.animationDelay = `${900 + ((y - 34) / 6) * 40}ms, 0ms`;
      rows.appendChild(row);
      n++;
    }
    const thread = make('g', { 'clip-path': 'url(#thanks-heart-clip)' });
    thread.append(
      make('line', { class: 'heart-you', x1: 0, x2: 240, y1: HEART_GOLD, y2: HEART_GOLD }),
      make('line', { class: 'heart-spark', x1: 0, x2: 240, y1: HEART_GOLD, y2: HEART_GOLD })
    );
    svg.append(defs, rows, thread, make('path', { class: 'heart-edge', d: HEART }));
    box.appendChild(svg);
  }

  function formatDay(ms) {
    try {
      return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  // Short enough for the sidebar: "Oct 10" this year, "Oct 2025" before it.
  function formatShort(ms) {
    try {
      const d = new Date(ms);
      const thisYear = d.getFullYear() === new Date().getFullYear();
      return d.toLocaleDateString([], thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  // The sidebar's Supporter plate: what support opens, the offer while there
  // is one, or a thank-you. Drawn again when either answer comes in.
  let lastStatus = { supporter: false };
  let liveOffer = null;
  function renderNav(s = lastStatus) {
    lastStatus = s;
    const sub = $('nav-supporter-sub');
    const mark = $('nav-supporter-mark');
    if (!sub || !mark) return;
    const since = s.supporter && s.since ? formatShort(s.since) : '';
    const offer = liveOffer && Supporter.buyable() && self.SupporterExtras
      ? `${liveOffer.name || 'An offer'} · ${Supporter.offerEnds(liveOffer, Date.now())}`
      : '';
    sub.textContent = s.supporter
      ? (since ? `Thank you · since ${since}` : 'Thank you')
      : (offer || 'The path, your month and more');
    mark.hidden = !s.supporter;
  }

  // The section line for everyone who hasn't supported, as options.html has it.
  let salesDesc = '';

  // The door that led here (Supporter.door): a page outside Settings says so
  // in the address (options.html?from=release#section-supporter); a "See
  // Supporter" link inside Settings carries data-door. Set on load.
  let door = 'settings';
  let chosen = null;

  function pointButton() {
    const url = Supporter.checkoutUrl(chosen, door);
    if (url) $('supporter-buy-btn').href = url;
  }

  // The offer from version.json, kept by the background's update check.
  async function remoteOffer() {
    try {
      const { pblocker_update_info: info } = await browserAPI.storage.local.get('pblocker_update_info');
      return info && info.offer;
    } catch (_) {
      return null;
    }
  }

  // The plans as radio rows; the button follows the chosen one. Drawn again
  // when an offer arrives or ends, keeping the plan already picked.
  async function renderPlans() {
    const box = $('supporter-plans');
    const btn = $('supporter-buy-btn');
    const offer = Supporter.activeOffer(Date.now(), await remoteOffer());
    liveOffer = offer;
    renderNav();
    const kept = chosen && chosen.id;
    box.querySelectorAll('.supporter-plan').forEach((el) => el.remove());
    const pick = (plan) => {
      chosen = plan;
      pointButton();
      btn.textContent = `Become a supporter · ${plan.price}`;
    };
    const plans = Supporter.offered(offer);
    const first = plans.find((p) => p.id === kept) || plans.find((p) => p.chosen);
    plans.forEach((plan) => {
      const label = document.createElement('label');
      label.className = 'supporter-plan';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'supporter-plan';
      input.value = plan.id;
      input.checked = plan === first;
      input.addEventListener('change', () => pick(plan));
      const name = document.createElement('span');
      name.className = 'supporter-plan-name';
      name.textContent = plan.name;
      if (plan.note) {
        const note = document.createElement('span');
        note.className = 'supporter-plan-note';
        note.textContent = plan.note;
        name.appendChild(note);
      }
      const price = document.createElement('span');
      price.className = 'supporter-plan-price';
      if (plan.was) {
        // Struck through for the eye; said in words for a screen reader,
        // which reads <s> as plain text.
        const was = document.createElement('s');
        was.className = 'supporter-plan-was';
        was.textContent = plan.was;
        price.append(said('Was '), was, said(', now '));
      }
      price.append(plan.price);
      const per = document.createElement('span');
      per.className = 'supporter-plan-per';
      per.textContent = plan.per;
      price.appendChild(per);
      label.append(input, name, price);
      box.appendChild(label);
      if (plan === first) pick(plan);
    });

    const open = Supporter.buyable();
    btn.hidden = !open;
    $('supporter-buy-hint').textContent = open ? '' : 'Opens soon. Until then, the first week of the path is here for everyone.';
    $('supporter-buy-hint').hidden = open;
    $('supporter-offer').hidden = !offer || !open;
    if (offer) {
      $('supporter-offer-when').textContent = [offer.name, Supporter.offerEnds(offer, Date.now())].filter(Boolean).join(' · ');
      $('supporter-offer-title').textContent = offer.title;
      $('supporter-offer-title').hidden = !offer.title;
      $('supporter-offer-text').textContent = offer.text;
    }
  }

  // A blocked-page design other than Classic goes back to Classic when the
  // plan behind it ends, in builds that sell the designs. Nothing else in
  // the settings changes.
  async function endDesign() {
    if (!self.SupporterExtras) return;
    try {
      const { pblocker_settings: settings } = await browserAPI.storage.local.get('pblocker_settings');
      if (!settings || !settings.blockedPageTheme || settings.blockedPageTheme === 'classic') return;
      await browserAPI.storage.local.set({ pblocker_settings: { ...settings, blockedPageTheme: 'classic' } });
    } catch (_) {}
  }

  // Proof it passes (extras/proof.js) comes on with the plan, unless it was
  // turned off by hand, and goes off when the plan ends. The blocked page
  // reads only this switch, never the plan.
  async function followProof(supporter) {
    const Moments = self.Moments;
    if (!self.SupporterExtras || !self.SupporterExtras.proof || !Moments) return;
    try {
      const { [Moments.PROOF_KEY]: raw } = await browserAPI.storage.local.get(Moments.PROOF_KEY);
      const next = Moments.proofForPlan(raw, supporter, Date.now());
      if (next) await browserAPI.storage.local.set({ [Moments.PROOF_KEY]: next });
    } catch (_) {}
  }

  async function renderStatus(opts) {
    let s = { supporter: false };
    let answered = false;
    try {
      s = await Supporter.status(browserAPI.storage.local, opts);
      answered = true;
    } catch (_) {}
    // A Supporter look (ui/scheme.js) ends with the plan; only on a clear answer.
    const scheme = self.UiScheme;
    if (answered && !s.supporter && !s.unchecked && scheme && scheme.getLook()) scheme.setLook(null).catch(() => {});
    // So does a Supporter design for the blocked page (options.js designLocked).
    if (answered && !s.supporter && !s.unchecked) endDesign();
    if (answered && (s.supporter || !s.unchecked)) followProof(s.supporter === true);
    renderNav(s);
    // The extras with a place in Settings (extras/looks.js, extras/photo.js)
    // and the design picker hear the answer from Supporter itself (onStatus).
    $('supporter-recheck-row').hidden = !((await isDev()) && s.kind === 'store');
    $('supporter-manage-hint').hidden = !(s.supporter && s.kind === 'store');
    $('supporter-code-form').hidden = s.supporter;
    $('supporter-thanks').hidden = !s.supporter;
    // A supporter is thanked, not sold to: the letter and the heart take the
    // band's place, and the section line says what the page is for now.
    const thanked = s.supporter === true;
    if (thanked) weaveHeart();
    $('supporter-band').hidden = thanked;
    $('supporter-thanks-band').hidden = !thanked;
    $('supporter-desc').textContent = thanked ? 'Your extras, and what your support keeps going.' : salesDesc;
    // The open-source build carries no extras (extras/README.md), so it
    // says so, and sells nothing it can't open.
    const openBuild = !self.SupporterExtras;
    $('supporter-open-build').hidden = !openBuild;
    $('supporter-buy').hidden = s.supporter || openBuild;
    // A plan bought through the store is managed (and cancelled) there; a
    // code given by hand has nothing to manage.
    $('supporter-manage-row').hidden = !(s.supporter && s.kind === 'store');
    // With Polar's limit, a plan holds a place on each browser it's on; this
    // gives the place here back, so the plan can move.
    const places = s.supporter && s.kind === 'store' && s.limit;
    $('supporter-release-row').hidden = !places;
    $('supporter-release-hint').hidden = !places;
    if (places) {
      $('supporter-release-hint').textContent = `Your plan works on ${s.limit === 1 ? 'one browser' : `up to ${s.limit} browsers`} at once. To move it, remove it here first, then enter your code on the other one.`;
    }
    releaseArmed = 0;
    $('supporter-release').textContent = 'Remove it from this browser';
    $('supporter-release-result').textContent = '';
    if (s.supporter) {
      // The band says thank you; this group is the plan itself.
      const since = s.since ? `, since ${formatDay(s.since)}` : '';
      $('supporter-code-title').textContent = 'Your plan';
      $('supporter-code-desc').textContent = s.kind === 'store' ? `From the store${since}.` : `From a supporter code${since}.`;
      $('supporter-thanks').textContent = s.since ? `Thank you. Supporter since ${formatDay(s.since)}.` : 'Thank you.';
    } else if (s.unchecked) {
      $('supporter-code-title').textContent = 'Your plan is waiting for a check';
      $('supporter-code-desc').textContent = 'BlockNSFW hasn’t been able to reach the store for two weeks, so the extras are paused. They come back as soon as it can check, with nothing lost.';
    } else if (s.removed) {
      $('supporter-code-title').textContent = 'This browser was removed from your plan';
      $('supporter-code-desc').textContent = 'Your plan goes on, on your other browsers. Enter your code to add this one back, if the plan has a free place.';
    } else if (s.ended) {
      $('supporter-code-title').textContent = 'Your plan has ended';
      $('supporter-code-desc').textContent = `It ended on ${formatDay(s.ended)}. Your check-ins and your book are still here. Renew any time, or enter a new code.`;
    } else {
      $('supporter-code-title').textContent = 'Already a supporter?';
      $('supporter-code-desc').textContent = 'Your code comes by email after you pay.';
    }
  }

  // Asks once, then removes: the code is needed to add it back.
  let releaseArmed = 0;
  async function releaseHere() {
    const button = $('supporter-release');
    const result = $('supporter-release-result');
    if (Date.now() - releaseArmed > 10000) {
      releaseArmed = Date.now();
      button.textContent = 'Yes, remove it';
      result.textContent = 'You’ll need your code to add it back.';
      return;
    }
    releaseArmed = 0;
    button.disabled = true;
    result.textContent = 'Asking the store…';
    let r;
    try {
      r = await Supporter.release(browserAPI.storage.local);
    } catch (_) {
      r = { ok: false, reason: 'something went wrong. Try again' };
    }
    button.disabled = false;
    button.textContent = 'Remove it from this browser';
    if (!r.ok) {
      const reason = r.reason || 'something went wrong. Try again';
      result.textContent = reason.charAt(0).toUpperCase() + reason.slice(1) + '.';
      return;
    }
    await renderStatus();
    $('supporter-code-desc').textContent = 'Removed from this browser. Your plan has a free place for another one.';
  }

  async function unlock() {
    const input = $('supporter-code');
    const error = $('supporter-code-error');
    const button = $('supporter-unlock');
    const code = input.value;
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    if (!code.trim()) {
      error.textContent = 'Paste your code first.';
      input.focus();
      return;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Checking…';
    let r;
    try {
      r = await Supporter.unlock(browserAPI.storage.local, code, Date.now());
    } catch (_) {
      r = { ok: false, reason: 'something went wrong. Try again' };
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Unlock';
    if (!r.ok) {
      const reason = r.reason || 'that code doesn’t match';
      error.textContent = reason.charAt(0).toUpperCase() + reason.slice(1) + '.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    input.value = '';
    await renderStatus();
    // The thank-you plays as it appears; the reader is taken to it.
    $('thanks-head').focus({ preventScroll: true });
    $('supporter-thanks-band').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof Supporter === 'undefined' || !$('section-supporter')) return;
    salesDesc = $('supporter-desc').textContent;
    fillCompare();
    $('supporter-portal').href = Supporter.portalUrl();
    $('supporter-manage').href = Supporter.portalUrl();
    door = Supporter.door(new URLSearchParams(location.search).get('from'));
    document.addEventListener('click', (e) => {
      const link = e.target.closest && e.target.closest('a[data-door]');
      if (!link) return;
      door = Supporter.door(link.dataset.door);
      pointButton();
    });
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.pblocker_update_info) renderPlans();
    });
    renderPlans();
    renderStatus();
    hidePlaceholders();
    $('supporter-recheck').addEventListener('click', async () => {
      $('supporter-recheck-result').textContent = 'Asking the store…';
      const s = await renderStatus({ force: true }).then(() => Supporter.status(browserAPI.storage.local));
      $('supporter-recheck-result').textContent = s.supporter ? 'Still active.' : 'The plan has ended.';
    });
    $('supporter-release').addEventListener('click', releaseHere);
    $('supporter-unlock').addEventListener('click', unlock);
    $('supporter-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlock();
    });
  });
})();
