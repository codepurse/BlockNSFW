// morning.js: the page after a slip.
//
// It records the slip as one day, with what was going on (shared/moments.js),
// shows Days Kept so the number survives the day, and offers at most a few
// things that would make next time easier, each matched to what the person
// said: Risk Hours around the time it happened, a longer pact wait, someone to
// reach, or Storm Mode if it's still hard right now. Everything stays on the
// device.

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  const Moments = globalThis.Moments;
  const Boost = globalThis.Boost;
  const Pact = globalThis.Pact;
  const $ = (id) => document.getElementById(id);

  function chips(container, items) {
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = item.id;
      button.textContent = item.label;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        const on = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      container.appendChild(button);
    });
  }

  function chosen(container) {
    return [...container.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.dataset.id);
  }

  function fillHours(select) {
    const now = new Date();
    for (let h = 0; h < 24; h++) {
      const option = document.createElement('option');
      option.value = String(h);
      option.textContent = 'Around ' + Boost.formatMinutes(h * 60);
      select.appendChild(option);
    }
    select.value = String(now.getHours());
  }

  // One offer: a sentence and a button that does it, or a link.
  function offer(text, action) {
    const row = document.createElement('div');
    row.className = 'offer';
    const words = document.createElement('p');
    words.className = 'offer-text';
    words.textContent = text;
    row.appendChild(words);
    if (action.href) {
      const link = document.createElement('a');
      link.className = 'btn btn-ghost btn-sm';
      link.href = action.href;
      link.textContent = action.label;
      if (action.newTab) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      row.appendChild(link);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm';
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        const said = await action.run();
        const done = document.createElement('span');
        done.className = 'offer-done';
        done.setAttribute('role', 'status');
        done.textContent = said || 'Done.';
        button.replaceWith(done);
      });
      row.appendChild(button);
    }
    $('offers').appendChild(row);
  }

  async function renderOffers(slip) {
    const store = await browserAPI.storage.local.get([Boost.RISK_KEY, Moments.WORDS_KEY]);
    const risk = Boost.normalizeRisk(store[Boost.RISK_KEY]);
    const words = Moments.normalizeWords(store[Moments.WORDS_KEY]);
    const pact = Pact ? await Pact.readPact(browserAPI.storage.local) : null;
    const late = slip.hour >= 21 || slip.hour < 5;

    // Risk hours around the time it happened.
    if (!risk.enabled && (late || slip.tags.includes('late') || slip.tags.includes('tired') || slip.helped.includes('stronger'))) {
      const suggested = Moments.suggestedRiskHours(slip.hour);
      offer(`Make ${Boost.formatMinutes(suggested.start)} to ${Boost.formatMinutes(suggested.end)} your risk hours: stronger protection every day around the time this happened.`, {
        label: 'Set risk hours',
        run: async () => {
          await browserAPI.storage.local.set({ [Boost.RISK_KEY]: suggested });
          if (Pact) await Pact.ask({ type: 'boost_reconcile' });
          return 'Risk hours are set.';
        }
      });
    }

    // A longer wait, or a pact at all.
    if (pact) {
      const longer = Pact.DELAYS.find((ms) => ms > pact.delayMs);
      if (longer && (slip.helped.includes('wait') || slip.helped.length === 0)) {
        offer(`Make your pact’s wait longer: ${Pact.formatDelay(longer)} instead of ${Pact.formatDelay(pact.delayMs)}.`, {
          label: 'Make it longer',
          run: async () => {
            await browserAPI.storage.local.set({ [Pact.PACT_KEY]: { ...pact, delayMs: longer } });
            return `Changes now wait ${Pact.formatDelay(longer)}.`;
          }
        });
      }
    } else {
      offer('Make a pact, so that turning protection off or whitelisting a site has to wait out a delay you choose now.', {
        label: 'Open Settings',
        href: 'options.html#pact-group'
      });
    }

    // Someone to talk to.
    if (slip.helped.includes('person') || slip.tags.includes('lonely')) {
      const href = Moments.telHref(words.person.phone);
      if (words.person.name && href) {
        offer(`${words.person.name} is the person you chose to reach.`, { label: `Call ${words.person.name}`, href });
      } else if (!words.person.name) {
        offer('Add someone to reach to your own words, so their name is the first thing on a held page.', {
          label: 'Open Settings',
          href: 'options.html#own-words-group'
        });
      }
    }

    offer('Still hard right now? Storm Mode keeps everything at its strongest for the next 4 hours. It can’t be stopped early.', {
      label: 'Start Storm Mode',
      run: async () => {
        const reply = Pact ? await Pact.ask({ type: 'boost_storm_start', hours: 4 }) : null;
        return reply && reply.ok
          ? `Storm Mode is on until ${Boost.formatUntil(reply.until, Date.now())}.`
          : 'Storm Mode didn’t start. Try it from the toolbar popup.';
      }
    });
  }

  async function renderKept() {
    const store = await browserAPI.storage.local.get([
      Moments.SLIPS_KEY, Moments.FIRST_SEEN_KEY, 'pblocker_audit_disabled', 'pblocker_settings'
    ]);
    const settings = store.pblocker_settings || {};
    const result = Moments.daysKept({
      now: Date.now(),
      firstSeen: store[Moments.FIRST_SEEN_KEY],
      slips: store[Moments.SLIPS_KEY],
      disabledLog: store.pblocker_audit_disabled,
      currentlyEnabled: settings.enabled !== false
    });
    $('kept-figure').textContent = `${result.kept} of ${result.counted}`;
    $('kept-words').textContent = result.counted >= 30
      ? 'days kept in the last 30. Tomorrow is a new one.'
      : 'days kept so far. Tomorrow is a new one.';
  }

  async function record(event) {
    event.preventDefault();
    const button = $('record');
    button.disabled = true;
    const daysAgo = Number($('slip-day').value) || 0;
    const hour = Number($('slip-hour').value);
    const when = new Date();
    when.setDate(when.getDate() - daysAgo);
    when.setHours(hour, 0, 0, 0);
    // A time later than now on "today" is read as the day before.
    if (when.getTime() > Date.now()) when.setDate(when.getDate() - 1);

    const slip = { tags: chosen($('tags')), helped: chosen($('helps')), hour, at: when.getTime() };
    const { [Moments.SLIPS_KEY]: raw } = await browserAPI.storage.local.get(Moments.SLIPS_KEY);
    await browserAPI.storage.local.set({ [Moments.SLIPS_KEY]: Moments.addSlip(raw, slip, Date.now()) });

    $('slip-form').hidden = true;
    await renderKept();
    await renderOffers(slip);
    $('result').hidden = false;
    $('result-head').focus();
  }

  function init() {
    if (!Moments || !Boost) return;
    chips($('tags'), Moments.SLIP_TAGS);
    chips($('helps'), Moments.SLIP_HELPS);
    fillHours($('slip-hour'));
    $('slip-form').addEventListener('submit', record);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
