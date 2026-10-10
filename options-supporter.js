// options-supporter.js
// Settings › Supporter: the author's note and the price, what it opens, and
// the code. shared/supporter.js checks codes; nothing here touches blocking.

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

  // The comparison's cells: a check where it's included, a dash where it
  // isn't, each with words for screen readers.
  function fillCompare() {
    const NS = 'http://www.w3.org/2000/svg';
    const said = (text) => {
      const s = document.createElement('span');
      s.className = 'visually-hidden';
      s.textContent = text;
      return s;
    };
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

  // The sidebar's Supporter plate: what support opens, or a thank-you.
  function renderNav(s) {
    const sub = $('nav-supporter-sub');
    const mark = $('nav-supporter-mark');
    if (!sub || !mark) return;
    const since = s.supporter && s.since ? formatShort(s.since) : '';
    sub.textContent = s.supporter
      ? (since ? `Thank you · since ${since}` : 'Thank you')
      : 'The path, your month and more';
    mark.hidden = !s.supporter;
  }

  // The plans as radio rows; the button follows the chosen one.
  function renderPlans() {
    const box = $('supporter-plans');
    const btn = $('supporter-buy-btn');
    box.querySelectorAll('.supporter-plan').forEach((el) => el.remove());
    const pick = (plan) => {
      if (plan.url) btn.href = plan.url;
      btn.textContent = `Become a supporter · ${plan.price}`;
    };
    Supporter.offered().forEach((plan) => {
      const label = document.createElement('label');
      label.className = 'supporter-plan';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'supporter-plan';
      input.value = plan.id;
      input.checked = plan.chosen;
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
      price.textContent = plan.price;
      const per = document.createElement('span');
      per.className = 'supporter-plan-per';
      per.textContent = plan.per;
      price.appendChild(per);
      label.append(input, name, price);
      box.appendChild(label);
      if (plan.chosen) pick(plan);
    });

    const open = Supporter.buyable();
    btn.hidden = !open;
    $('supporter-buy-hint').textContent = open ? '' : 'Opens soon. Until then, the first week of the path is here for everyone.';
    $('supporter-buy-hint').hidden = open;
    const offer = Supporter.offerFor(Date.now());
    $('supporter-offer').hidden = !offer || !open;
    $('supporter-offer').textContent = offer || '';
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
    if (answered && !s.supporter && scheme && scheme.getLook()) scheme.setLook(null).catch(() => {});
    renderNav(s);
    // The extras with a place in Settings (extras/looks.js, extras/photo.js)
    // follow the answer.
    document.dispatchEvent(new CustomEvent('supporter-status', { detail: { supporter: s.supporter === true } }));
    $('supporter-recheck-row').hidden = !((await isDev()) && s.kind === 'store');
    $('supporter-manage-hint').hidden = !(s.supporter && s.kind === 'store');
    $('supporter-code-form').hidden = s.supporter;
    $('supporter-thanks').hidden = !s.supporter;
    // The open-source build carries no extras (extras/README.md), so it
    // says so, and sells nothing it can't open.
    const openBuild = !self.SupporterExtras;
    $('supporter-open-build').hidden = !openBuild;
    $('supporter-buy').hidden = s.supporter || openBuild;
    // A plan bought through the store is managed (and cancelled) there; a
    // code given by hand has nothing to manage.
    $('supporter-manage-row').hidden = !(s.supporter && s.kind === 'store');
    if (s.supporter) {
      $('supporter-code-title').textContent = 'You’re a supporter';
      $('supporter-code-desc').textContent = 'Thank you. It keeps this going.';
      $('supporter-thanks').textContent = s.since ? `Thank you. Supporter since ${formatDay(s.since)}.` : 'Thank you.';
    } else if (s.ended) {
      $('supporter-code-title').textContent = 'Your plan has ended';
      $('supporter-code-desc').textContent = `It ended on ${formatDay(s.ended)}. Your check-ins and your book are still here. Renew any time, or enter a new code.`;
    } else {
      $('supporter-code-title').textContent = 'Already a supporter?';
      $('supporter-code-desc').textContent = 'Your code comes by email after you pay.';
    }
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
    $('supporter-thanks').setAttribute('tabindex', '-1');
    $('supporter-thanks').focus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof Supporter === 'undefined' || !$('section-supporter')) return;
    fillCompare();
    $('supporter-portal').href = Supporter.portalUrl();
    $('supporter-manage').href = Supporter.portalUrl();
    renderPlans();
    renderStatus();
    hidePlaceholders();
    $('supporter-recheck').addEventListener('click', async () => {
      $('supporter-recheck-result').textContent = 'Asking the store…';
      const s = await renderStatus({ force: true }).then(() => Supporter.status(browserAPI.storage.local));
      $('supporter-recheck-result').textContent = s.supporter ? 'Still active.' : 'The plan has ended.';
    });
    $('supporter-unlock').addEventListener('click', unlock);
    $('supporter-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlock();
    });
  });
})();
