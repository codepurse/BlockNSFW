// BlockNSFW — Christmas, from 1 December to 1 January.
//
// Snow falls over the popup and the held page and settles on what a real
// ledge would hold: the hairlines, the tops of switches and buttons, the tops
// of the letters in the big words. Past its angle of repose it slides off an
// edge, and it melts back slowly, so nothing is ever buried. A string of
// incandescent lights hangs along the top, and on the held page the line that
// arrives at the door is a string of lights as well, threaded through the
// doors it passed. The wire can be taken hold of and let go; a hand moving
// through the snow pushes the air.
//
// shared/season.js says when; Settings › Customization can turn it off. Only
// BlockNSFW's own pages load this: content.js never does, so no website ever
// runs a frame of it. On the held page it is Classic's alone; the other
// designs are pictures of their own.
//
// Loaded in <head> after ui/scheme.js, so <html> carries is-christmas in the
// first paint (from a localStorage copy, as the scheme does) and the page has
// made room for the lights before anything is drawn. Drawing waits until the
// page is laid out. With reduced motion it is a still picture.
//
// Devtools only: localStorage pblocker_christmas_preview = '1' shows it out of
// season, to check it in November.

(function () {
  'use strict';

  if (typeof Season === 'undefined') return;

  const html = document.documentElement;
  const PREVIEW = 'pblocker_christmas_preview';
  const TAU = Math.PI * 2;

  let api = null;
  try {
    api = typeof browser !== 'undefined' ? browser : chrome;
  } catch (_) {
    api = null;
  }
  const store = api && api.storage && api.storage.local ? api.storage : null;

  function readCopy() {
    try { return localStorage.getItem(Season.KEY); } catch (_) { return null; }
  }
  function keepCopy(value) {
    try { localStorage.setItem(Season.KEY, value ? '1' : '0'); } catch (_) {}
  }
  function previewing() {
    try { return localStorage.getItem(PREVIEW) === '1'; } catch (_) { return false; }
  }

  let wanted = readCopy() !== '0';
  let laidOut = false;
  let scene = null;

  function decide() {
    const on = wanted && (previewing() || Season.inSeason(new Date()));
    html.classList.toggle('is-christmas', on);
    const words = document.getElementById('season-line');
    if (words) {
      words.textContent = on ? Season.line(new Date()) : '';
      words.hidden = !on;
    }
    if (on && laidOut && !scene) scene = start();
    else if (!on && scene) { scene.stop(); scene = null; }
  }

  decide();

  if (store) {
    try {
      Promise.resolve(store.local.get(Season.KEY))
        .then(function (result) {
          wanted = Season.wanted(result && result[Season.KEY]);
          keepCopy(wanted);
          decide();
        })
        .catch(function () {});
      store.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[Season.KEY]) return;
        wanted = Season.wanted(changes[Season.KEY].newValue);
        keepCopy(wanted);
        decide();
      });
    } catch (_) {}
  }

  // The held page hides itself until its design is chosen; wait for that, but
  // not forever.
  function whenLaidOut() {
    const began = Date.now();
    const go = function () {
      if (html.classList.contains('theme-pending') && Date.now() - began < 3000) {
        setTimeout(go, 80);
        return;
      }
      laidOut = true;
      decide();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }
  whenLaidOut();
  // The season ends at midnight on 1 January even with the page left open.
  setInterval(decide, 60000);

  // --- Where it draws ----------------------------------------------------------

  function pageConfig() {
    const band = document.getElementById('popup-band');
    if (band) {
      return {
        text: '.popup-wordmark, #status',
        lines: '.popup-band .row, .pop-sec:not(.is-empty), .links',
        boxes: '.switch-track, .btn',
        festoon: { span: 92, top: 4, slack: 1.07, seg: 5, every: 4, scale: 0.68, drop: 18 },
        festoonLit: function (dark) { return dark || band.classList.contains('band-pine'); },
        arrival: false
      };
    }
    if (document.querySelector('.blocked-card') && !html.hasAttribute('data-theme')) {
      return {
        text: '#blocked-title',
        lines: '.doors',
        boxes: '.held-plate, .blocked-actions .btn',
        festoon: { span: 280, top: 2, slack: 1.045, seg: 7, every: 4, scale: 0.95, drop: 30 },
        festoonLit: function (dark) { return dark; },
        arrival: true
      };
    }
    return null;
  }

  // --- Snow, lights, and the frame that draws them ------------------------------

  function start() {
    const cfg = pageConfig();
    if (!cfg || !document.body) return null;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'christmas-sky';
    const cs = canvas.style;
    cs.position = 'fixed';
    cs.left = '0';
    cs.top = '0';
    cs.width = '100%';
    cs.height = '100%';
    cs.pointerEvents = 'none';
    cs.zIndex = '50';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let W = 1, H = 1, dpr = 1, t = 0, dark = false, scrollY = 0;
    let raf = 0, stopped = false, last = 0, measureAt = 0, measureQueued = false;
    const timers = [];

    function isDark() {
      try { return /dark/.test(getComputedStyle(html).colorScheme || ''); } catch (_) { return false; }
    }
    function resize() {
      const w = Math.max(1, html.clientWidth || window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      // Big windows draw at a lower density rather than fill a 4K canvas.
      const d = Math.min(2, window.devicePixelRatio || 1, Math.max(1, Math.sqrt(5e6 / (w * h))));
      if (w === W && h === H && d === dpr) return false;
      W = w; H = h; dpr = d;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      return true;
    }

    // --- Snow ---------------------------------------------------------------------

    // max depth, edge hold, angle of repose (px per px), chance to settle
    const KINDS = { line: [4.6, 1.8, 0.45, 0.3], text: [3.6, 1.3, 1.25, 0.55], box: [4.2, 1.8, 0.7, 0.45] };
    const memory = new WeakMap();   // element → the snow on it, kept across measures
    let ledges = [];
    let flakes = [];
    let clumps = [];
    let sprites = null;
    const air = { x: -9999, y: -9999, vx: 0, vy: 0, last: 0, in: false };
    const gust = { v: 0, t: 0, len: 6, amp: 0, wait: 3 + Math.random() * 5 };

    function sprite(size, paint, blur) {
      const S = 3, pad = Math.ceil(size * 0.35) + 3, full = size + pad * 2, px = Math.ceil(full * S);
      const a = document.createElement('canvas');
      a.width = a.height = px;
      const g = a.getContext('2d');
      g.setTransform(S, 0, 0, S, px / 2, px / 2);
      paint(g, size / 2);
      const c = document.createElement('canvas');
      c.width = c.height = px;
      const h = c.getContext('2d');
      if (blur) h.filter = 'blur(' + (blur * S) + 'px)';
      // On paper white needs a shadow to be seen at all.
      if (!dark) { h.shadowColor = 'rgba(24,34,44,0.42)'; h.shadowBlur = 2.4 * S; h.shadowOffsetY = 0.7 * S; }
      h.drawImage(a, 0, 0);
      return { c: c, size: size, full: full };
    }
    function hex(g, r) {
      g.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.closePath();
    }
    // A six-fold crystal: a dendrite most of the time, a sectored plate now and then.
    function crystal(g, R) {
      g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
      const lw = Math.max(0.55, R * 0.12);
      if (Math.random() < 0.28) {
        g.globalAlpha = 0.55; hex(g, R * 0.8); g.fill(); g.globalAlpha = 1;
        g.lineWidth = lw * 0.8;
        g.beginPath();
        for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g.moveTo(0, 0); g.lineTo(Math.cos(a) * R * 0.7, Math.sin(a) * R * 0.7); }
        g.stroke();
        return;
      }
      const branches = [];
      const nb = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < nb; i++) { const p = 0.3 + (i + Math.random() * 0.8) * (0.55 / nb); branches.push([p, (0.16 + Math.random() * 0.3) * (1.15 - p)]); }
      hex(g, R * (0.12 + Math.random() * 0.18)); g.fill();
      g.lineWidth = lw;
      for (let k = 0; k < 6; k++) {
        g.save(); g.rotate(k * Math.PI / 3);
        g.beginPath(); g.moveTo(0, 0); g.lineTo(R, 0);
        for (const br of branches) {
          const x = br[0] * R, l = br[1] * R;
          g.moveTo(x, 0); g.lineTo(x + l * 0.5, -l * 0.866);
          g.moveTo(x, 0); g.lineTo(x + l * 0.5, l * 0.866);
        }
        g.stroke();
        g.restore();
      }
    }
    // Rimed aggregates: what most snowflakes are by the time they fall.
    function fluff(g, R) {
      g.fillStyle = '#fff';
      const n = 6 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, d = Math.random() * R * 0.45, r = R * (0.3 + Math.random() * 0.32);
        g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, TAU); g.fill();
      }
    }
    function dot(g, R) {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, R);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
    }
    function buildSprites() {
      sprites = [[], [], [], []];
      for (let i = 0; i < 6; i++) sprites[0].push(sprite(14, crystal, 1.5));
      for (let i = 0; i < 16; i++) sprites[1].push(sprite(12, crystal, 0));
      for (let i = 0; i < 10; i++) sprites[2].push(sprite(6, fluff, 0.25));
      sprites[3].push(sprite(4, dot, 0));
      flakes.forEach(pickSprite);
      clumps.forEach(pickSprite);
    }
    function pickSprite(f) { const set = sprites[f.kind]; f.spr = set[(Math.random() * set.length) | 0]; }

    function windNow(y) {
      const base = 10.5 * (0.62 + 0.28 * Math.sin(t * 0.13 + 0.7) + 0.16 * Math.sin(t * 0.047 + 2.1));
      return (base + gust.v) * (0.88 + 0.12 * Math.sin(y * 0.011 + t * 0.55));
    }
    function stepGust(dt) {
      if (gust.t > 0) {
        gust.t -= dt;
        const u = 1 - Math.max(0, gust.t) / gust.len;
        const e = u < 0.22 ? u / 0.22 : u < 0.38 ? 1 : 1 - (u - 0.38) / 0.62;
        gust.v = gust.amp * e * e * (3 - 2 * e);
      } else {
        gust.v *= Math.exp(-dt * 2);
        gust.wait -= dt;
        if (gust.wait <= 0) {
          gust.len = 4.5 + Math.random() * 3;
          gust.t = gust.len;
          gust.amp = (14 + Math.random() * 34) * 0.8 * (Math.random() < 0.18 ? -0.6 : 1);
          gust.wait = 7 + Math.random() * 11;
        }
      }
    }

    function reset(f, anywhere) {
      f.par = 0.3 + 0.8 * f.z;
      f.fall = 11 + 52 * f.z + Math.random() * 8;
      f.ph = Math.random() * TAU; f.om = 1.4 + Math.random() * 2.4; f.amp = 5 + Math.random() * 13;
      f.tum = Math.random() * TAU; f.tumV = (Math.random() - 0.5) * 3.4;
      f.rot = Math.random() * TAU; f.rotV = (Math.random() - 0.5) * 1.8;
      f.x = Math.random() * (W + 120) - 60 - windNow(0) * 2.2;
      f.y = anywhere ? Math.random() * H : -12 - Math.random() * 50;
      f.vx = windNow(f.y) * f.par;
      f.vy = f.fall;
    }
    function makeFlake(z) {
      const f = { z: z };
      f.kind = z > 0.88 ? 0 : z > 0.58 ? 1 : z > 0.3 ? 2 : 3;
      f.size = [11 + Math.random() * 7, 5.5 + Math.random() * 4.5, 3 + Math.random() * 2.6, 1.7 + Math.random() * 1.5][f.kind];
      f.alpha = [0.5, 0.95, 0.92, 0.8][f.kind];
      f.land = z < 0.58;   // the ones nearest the page are the ones that settle on it
      pickSprite(f);
      reset(f, true);
      return f;
    }
    function populate() {
      const n = Math.round(Math.max(90, Math.min(480, (W * H) / 1500)));
      if (Math.abs(flakes.length - n) < 12) return;
      const zs = [];
      for (let i = 0; i < n; i++) zs.push(Math.pow(Math.random(), 1.55));
      zs.sort(function (a, b) { return a - b; });
      flakes = zs.map(makeFlake);
    }
    // A clump carries exactly the snow it took, so one that lands again adds nothing.
    function spill(x, y, dir, vol, from) {
      if (clumps.length > 260) return null;
      const c = { z: 0.3, kind: 2, size: 1.8 + Math.sqrt(vol) * 1.4 + Math.random() * 0.6, vol: vol, alpha: 0.95, land: true, clump: true, from: from || null };
      pickSprite(c);
      c.par = 0.6; c.fall = 70 + Math.random() * 30; c.ph = Math.random() * TAU; c.om = 2; c.amp = 3;
      c.tum = Math.random() * TAU; c.tumV = (Math.random() - 0.5) * 6; c.rot = 0; c.rotV = (Math.random() - 0.5) * 4;
      c.x = x; c.y = y; c.vx = dir * (4 + Math.random() * 8); c.vy = 0;
      clumps.push(c);
      return c;
    }

    // Where the page broke the words into lines: each line's text and where
    // its first letter starts, from the layout itself.
    function textLines(el, box) {
      const out = [];
      const range = document.createRange();
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node, line = null;
      while ((node = walk.nextNode())) {
        const s = node.textContent;
        for (let i = 0; i < s.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          if (!r.width) { if (line) line.text += s[i]; continue; }
          if (!line || Math.abs(r.top - line.top) > 2) {
            line = { text: '', x: r.left - box.left, top: r.top, y: r.top - box.top };
            out.push(line);
          }
          line.text += s[i];
        }
      }
      return out;
    }
    // The tops of the letters, column by column, as offsets from the box's top.
    function skyline(el, style, font, text, w, hgt) {
      const S = 2;
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * S) + 4;
      c.height = Math.ceil(hgt * S) + 4;
      const g = c.getContext('2d');
      g.scale(S, S);
      g.font = font;
      if ('letterSpacing' in g && style.letterSpacing && style.letterSpacing !== 'normal') g.letterSpacing = style.letterSpacing;
      const m = g.measureText(text);
      const asc = m.fontBoundingBoxAscent || parseFloat(style.fontSize) * 0.9;
      g.fillStyle = '#000';
      // A letter's own box runs from the font's ascent above the baseline.
      textLines(el, el.getBoundingClientRect()).forEach(function (line) {
        g.fillText(line.text.replace(/\s+$/, ''), line.x, line.y + asc);
      });
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const out = new Float32Array(w).fill(NaN);
      let any = false;
      for (let x = 0; x < w; x++) {
        let top = Infinity;
        for (let sx = 0; sx < S; sx++) {
          const px = x * S + sx;
          for (let y = 0; y < c.height && y < top; y++) if (d[(y * c.width + px) * 4 + 3] > 110) { top = y; break; }
        }
        if (top !== Infinity) { out[x] = top / S; any = true; }
      }
      return any ? out : null;
    }
    function settle(L, dt, quiet) {
      const b = L.b, h = L.h, n = L.n, R = L.repose;
      for (let it = 0; it < 2; it++) {
        for (let i = 0; i < n - 1; i++) {
          const bi = b[i], bj = b[i + 1];
          if (bi !== bi || bj !== bj || Math.abs(bi - bj) > 2) continue;
          const d = (bj - h[i + 1]) - (bi - h[i]);
          // past the angle of repose it slides; below it, it only settles a little
          let m = d > R ? (d - R) * 0.3 : d < -R ? (d + R) * 0.3 : 0;
          m += d * 0.025;
          if (m > 0) m = Math.min(m, h[i]); else m = Math.max(m, -h[i + 1]);
          h[i] -= m;
          h[i + 1] += m;
        }
      }
      const melt = 0.012 * dt;
      for (let i = 0; i < n; i++) {
        const bi = b[i];
        if (bi !== bi) continue;
        let hv = h[i];
        if (!(hv > 0)) { h[i] = 0; continue; }
        hv -= melt * (0.3 + hv / L.max);
        const left = i === 0 || b[i - 1] !== b[i - 1] || b[i - 1] - bi > 2;
        const right = i === n - 1 || b[i + 1] !== b[i + 1] || b[i + 1] - bi > 2;
        if ((left || right) && hv > L.hold) {
          if (quiet) hv = L.hold;
          else if (hv - L.hold > 0.8) { hv -= 0.8; spill(L.x0 + i + (right ? 1.5 : -1.5), bi - hv, right ? 1 : -1, 0.8, null); }
        }
        if (hv > L.max) hv = L.max;
        h[i] = hv > 0 ? hv : 0;
      }
    }
    function seed(L, frac) {
      const ph = Math.random() * 10;
      for (let i = 0; i < L.n; i++) {
        if (L.b[i] === L.b[i]) L.h[i] = L.max * frac * (0.72 + 0.28 * Math.sin(i * 0.05 + ph) * Math.sin(i * 0.013 + 1.7) + 0.12 * Math.random());
      }
      for (let k = 0; k < 60; k++) settle(L, 0, true);
    }
    function ledge(el, kind, side, rect, style) {
      const w = Math.round(rect.width);
      const x0 = Math.round(rect.left);
      const K = KINDS[kind];
      let rec = memory.get(el);
      if (!rec) { rec = {}; memory.set(el, rec); }
      let key = String(w), rel = null, font = '', text = '';
      if (kind === 'text') {
        font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
        text = el.textContent.trim();
        if (!text) return null;
        key = w + '|' + font + '|' + style.letterSpacing + '|' + text;
      }
      let st = rec[side];
      const fresh = !st || st.key !== key;
      if (fresh) {
        if (kind === 'text') {
          rel = skyline(el, style, font, text, w, rect.height);
          if (!rel) return null;
        }
        st = { key: key, rel: rel, h: new Float32Array(w) };
        rec[side] = st;
      }
      const y = side === 'bottom' ? rect.bottom - (parseFloat(style.borderBottomWidth) || 1) : rect.top;
      const b = new Float32Array(w);
      let yMin = Infinity, yMax = -Infinity;
      for (let i = 0; i < w; i++) {
        const v = st.rel ? y + st.rel[i] : y;
        b[i] = v;
        if (v === v) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
      }
      if (yMin === Infinity) return null;
      const L = { el: el, x0: x0, x1: x0 + w, n: w, b: b, h: st.h, max: K[0], hold: K[1], repose: K[2], p: K[3], yMin: yMin, yMax: yMax };
      if (fresh) seed(L, still ? 0.9 : 0.55);
      return L;
    }
    function measureLedges() {
      const next = [];
      const visible = function (el, r) {
        return r.width >= 3 && r.bottom > -60 && r.top < H + 60 && el.getClientRects().length > 0;
      };
      document.querySelectorAll(cfg.text).forEach(function (el) {
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) return;
        const L = ledge(el, 'text', 'text', r, getComputedStyle(el));
        if (L) next.push(L);
      });
      // A hairline holds snow whether it is drawn along a box's top or its bottom.
      document.querySelectorAll(cfg.lines).forEach(function (el) {
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) return;
        const style = getComputedStyle(el);
        if (parseFloat(style.borderTopWidth) > 0) { const L = ledge(el, 'line', 'top', r, style); if (L) next.push(L); }
        if (parseFloat(style.borderBottomWidth) > 0) { const L = ledge(el, 'line', 'bottom', r, style); if (L) next.push(L); }
      });
      document.querySelectorAll(cfg.boxes).forEach(function (el) {
        const r = el.getBoundingClientRect();
        if (!visible(el, r) || r.height < 4) return;
        const L = ledge(el, 'box', 'box', r, getComputedStyle(el));
        if (L) next.push(L);
      });
      ledges = next;
    }

    function land(f, py) {
      for (const L of ledges) {
        if (L === f.from || f.x < L.x0 || f.x >= L.x1 || f.y < L.yMin - L.max - 1 || py > L.yMax + 1) continue;
        const i = (f.x - L.x0) | 0, bi = L.b[i];
        if (bi !== bi) continue;
        const top = bi - L.h[i];
        if (py <= top && f.y >= top && Math.random() < (f.clump ? 0.75 : L.p)) { deposit(L, i, f); return true; }
      }
      return false;
    }
    function deposit(L, i, f) {
      const vol = f.clump ? f.vol : (2.4 + f.size * 1.3) * 2;
      const K = Math.max(2, Math.round(f.size * 1.3));
      let sum = 0;
      for (let k = -K; k <= K; k++) sum += K + 1 - Math.abs(k);
      for (let k = -K; k <= K; k++) {
        const j = i + k;
        if (j < 0 || j >= L.n) continue;
        const bj = L.b[j];
        if (bj !== bj || Math.abs(bj - L.b[i]) > 2) continue;
        L.h[j] += vol * (K + 1 - Math.abs(k)) / sum;
      }
    }
    function move(f, dt) {
      const w = windNow(f.y);
      let tx = w * f.par + Math.cos(f.ph + t * f.om) * f.amp * (0.5 + 0.5 * f.z);
      let ty = f.fall * (0.86 + 0.14 * Math.sin(f.ph * 1.7 + t * f.om * 0.6));
      const sp2 = air.vx * air.vx + air.vy * air.vy;
      if (sp2 > 25) {
        // the air a passing hand pushes, and the eddy it leaves behind
        const dx = f.x - air.x, dy = f.y - air.y, d2 = dx * dx + dy * dy;
        if (d2 < 14400) {
          const d = Math.sqrt(d2) + 0.001, k = 1 - d / 120, k2 = k * k, sp = Math.min(700, Math.sqrt(sp2));
          const m = 0.55 + 0.45 * f.z, sg = (air.vx * dy - air.vy * dx) > 0 ? 1 : -1;
          tx += (air.vx * 0.75 + (-dy / d) * sp * 0.2 * sg) * k2 * m;
          ty += (air.vy * 0.75 + (dx / d) * sp * 0.2 * sg) * k2 * m;
        }
      }
      const a = Math.min(1, dt / (f.clump ? 0.3 : 0.5));
      f.vx += (tx - f.vx) * a;
      f.vy += (ty - f.vy) * a * (f.clump ? 1 : 0.8);
      const py = f.y;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.tum += f.tumV * dt;
      f.rot += f.rotV * dt;
      if (f.land && f.vy > 0 && land(f, py)) return false;
      if (f.clump) return f.y < H + 20 && f.x > -40 && f.x < W + 40;
      if (f.x < -60) f.x += W + 120; else if (f.x > W + 60) f.x -= W + 120;
      return f.y < H + 24 && f.y > -260;
    }
    function stepSnow(dt) {
      stepGust(dt);
      const decay = Math.exp(-dt * 5);
      air.vx *= decay;
      air.vy *= decay;
      for (const f of flakes) if (!move(f, dt)) reset(f, false);
      for (let i = clumps.length - 1; i >= 0; i--) if (!move(clumps[i], dt)) clumps.splice(i, 1);
      for (const L of ledges) settle(L, dt, false);
    }
    function drawLedges() {
      const P = dark
        ? { fill: '#e8edef', shade: 'rgba(120,140,155,0.35)', edge: 'rgba(255,255,255,0.9)' }
        : { fill: '#ffffff', shade: 'rgba(150,168,182,0.32)', edge: 'rgba(58,74,88,0.42)' };
      for (const L of ledges) {
        const b = L.b, h = L.h, n = L.n, x = L.x0;
        let i = 0;
        while (i < n) {
          if (!(h[i] > 0.15) || b[i] !== b[i]) { i++; continue; }
          const s = i;
          i++;
          while (i < n && h[i] > 0.15 && b[i] === b[i] && Math.abs(b[i] - b[i - 1]) <= 2) i++;
          const e = i;
          for (let pass = 0; pass < 2; pass++) {
            const f = pass === 0 ? 1 : 0.38;
            ctx.beginPath();
            ctx.moveTo(x + s, b[s] + 0.4);
            for (let k = s; k < e; k++) ctx.lineTo(x + k + 0.5, b[k] - h[k] * f);
            for (let k = e - 1; k >= s; k--) ctx.lineTo(x + k + 0.5, b[k] + 0.4);
            ctx.closePath();
            ctx.fillStyle = pass === 0 ? P.fill : P.shade;
            ctx.fill();
          }
          ctx.beginPath();
          ctx.moveTo(x + s, b[s] - h[s] + Math.min(h[s], 1));
          for (let k = s; k < e; k++) ctx.lineTo(x + k + 0.5, b[k] - h[k]);
          ctx.lineTo(x + e, b[e - 1] - h[e - 1] + Math.min(h[e - 1], 1));
          ctx.strokeStyle = P.edge;
          ctx.lineWidth = dark ? 0.6 : 0.75;
          ctx.stroke();
        }
      }
    }
    function drawFlake(f) {
      const sp = f.spr, w = sp.full * (f.size / sp.size);
      if (f.kind === 3) {
        ctx.globalAlpha = f.alpha;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(sp.c, f.x - w / 2, f.y - w / 2, w, w);
        return;
      }
      // a flat crystal tumbling: seen edge-on it all but vanishes
      const sx = Math.max(0.2, Math.abs(Math.cos(f.tum)));
      const c = Math.cos(f.rot), s = Math.sin(f.rot);
      ctx.globalAlpha = f.alpha * (0.75 + 0.25 * sx);
      ctx.setTransform(dpr * c * sx, dpr * s * sx, -dpr * s, dpr * c, dpr * f.x, dpr * f.y);
      ctx.drawImage(sp.c, -w / 2, -w / 2, w, w);
    }
    function drawFlakes(from, to) {
      for (let i = from; i < to; i++) drawFlake(flakes[i]);
    }

    // --- Lights ---------------------------------------------------------------------
    //
    // The wire is a verlet rope hung from brass eyes, in page coordinates so it
    // scrolls with the page. Each bulb is a short pendulum on its socket that
    // feels the wire move, and each filament warms and cools rather than
    // switching. Some are twinkle bulbs: lit for a few seconds, out for a beat.

    const G = 1400, SUB = 3;
    const COLOURS = ['#e0412f', '#2f9e5a', '#f29a2e', '#2f6fd6', '#ffd49a'];
    const bulbSprites = {};
    const pools = {};
    let festoon = null;
    let arrival = null;
    let arrivalKey = '';
    const hand = { x: 0, y: 0, grab: null, gx: 0, gy: 0 };

    function shade(hex6, k) {
      const n = parseInt(hex6.slice(1), 16);
      let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
      if (k >= 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; } else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
      return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
    }
    function rgba(hex6, a) {
      const n = parseInt(hex6.slice(1), 16);
      return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    function rrect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
    }
    // A C9 bulb: faceted glass with a pointed tip, the socket at the origin, axis down.
    function glassPath(g) {
      g.beginPath();
      g.moveTo(-3.6, 8);
      g.bezierCurveTo(-7.4, 11, -7.6, 18.5, -4.7, 25);
      g.quadraticCurveTo(-2.1, 31, 0, 33.2);
      g.quadraticCurveTo(2.1, 31, 4.7, 25);
      g.bezierCurveTo(7.6, 18.5, 7.4, 11, 3.6, 8);
      g.closePath();
    }
    function bulbSprite(colour, lit) {
      const S = 3, w = 44, h = 64, ox = 22, oy = 12;
      const c = document.createElement('canvas');
      c.width = w * S;
      c.height = h * S;
      const g = c.getContext('2d');
      g.setTransform(S, 0, 0, S, ox * S, oy * S);
      if (lit) {
        g.save();
        g.filter = 'blur(' + (4 * S) + 'px)';
        g.fillStyle = rgba(colour, 0.6);
        g.beginPath(); g.ellipse(0, 20, 9, 14, 0, 0, TAU); g.fill();
        g.restore();
      }
      glassPath(g);
      let gr;
      if (lit) {
        gr = g.createRadialGradient(-0.5, 16.5, 0.4, 0, 19, 12);
        gr.addColorStop(0, '#fffdf6'); gr.addColorStop(0.2, shade(colour, 0.72)); gr.addColorStop(0.62, shade(colour, 0.1)); gr.addColorStop(1, shade(colour, -0.3));
      } else {
        gr = g.createLinearGradient(-7, 0, 7, 0);
        gr.addColorStop(0, shade(colour, -0.74)); gr.addColorStop(0.35, shade(colour, -0.4)); gr.addColorStop(0.7, shade(colour, -0.55)); gr.addColorStop(1, shade(colour, -0.8));
      }
      g.fillStyle = gr;
      g.fill();
      g.save();
      glassPath(g);
      g.clip();
      g.strokeStyle = lit ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.09)';
      g.lineWidth = 0.5;
      [-4.6, -1.6, 1.6, 4.6].forEach(function (fx) { g.beginPath(); g.moveTo(fx, 8); g.quadraticCurveTo(fx * 1.25, 19, 0, 33); g.stroke(); });
      if (!lit) {
        g.strokeStyle = 'rgba(20,20,20,0.55)';
        g.beginPath(); g.moveTo(-1.4, 12.5); g.lineTo(-1.4, 16); g.lineTo(1.4, 16); g.lineTo(1.4, 12.5); g.stroke();
      }
      g.restore();
      g.fillStyle = lit ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.42)';
      g.beginPath(); g.ellipse(-3.6, 15.5, 0.9, 4.4, 0.16, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.beginPath(); g.ellipse(3, 12.5, 0.6, 1.6, -0.3, 0, TAU); g.fill();
      g.fillStyle = '#17291f'; rrect(g, -4.2, -1, 8.4, 9.6, 1.4); g.fill();
      g.fillStyle = '#1f3729'; rrect(g, -4.8, 6.4, 9.6, 2.6, 0.9); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.13)';
      g.lineWidth = 0.45;
      [1.6, 3.4, 5.2].forEach(function (y) { g.beginPath(); g.moveTo(-3.6, y); g.lineTo(3.6, y); g.stroke(); });
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.fillRect(-3, -0.4, 0.9, 8.4);
      return { c: c, w: w, h: h, ox: ox, oy: oy };
    }
    function poolSprite(colour) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, rgba(colour, 1)); gr.addColorStop(0.35, rgba(colour, 0.42)); gr.addColorStop(1, rgba(colour, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      return c;
    }
    function ensureColour(colour) {
      if (!bulbSprites[colour]) bulbSprites[colour] = { off: bulbSprite(colour, false), on: bulbSprite(colour, true) };
      if (!pools[colour]) pools[colour] = poolSprite(colour);
    }

    function makeRope(hooks, o, old) {
      const P = [];
      for (let k = 0; k < hooks.length - 1; k++) {
        const a = hooks[k], b = hooks[k + 1];
        const D = Math.hypot(b[0] - a[0], b[1] - a[1]), L = D * o.slack;
        const n = Math.max(2, Math.round(L / o.seg));
        const sag = Math.sqrt(Math.max(0, 3 * D * (L - D) / 8));
        for (let i = k === 0 ? 0 : 1; i <= n; i++) {
          const u = i / n;
          const lift = old ? 0 : (o.drop || 0) * 4 * u * (1 - u);
          const x = a[0] + (b[0] - a[0]) * u;
          const y = a[1] + (b[1] - a[1]) * u + 4 * sag * u * (1 - u) - lift;
          P.push({ x: x, y: y, px: x, py: y, pin: i === 0 || i === n, rest: L / n, a: 0, b: 0 });
        }
      }
      let pa = 0;
      P.forEach(function (p, i) { if (p.pin) pa = i; p.a = pa; });
      let pb = P.length - 1;
      for (let i = P.length - 1; i >= 0; i--) { if (P[i].pin) pb = i; P[i].b = pb; }
      const B = [];
      for (let i = 1; i < P.length - 1; i++) {
        if (P[i].pin || i % o.every !== (o.every >> 1)) continue;
        const k = B.length, prev = old && old.B[k];
        B.push({
          i: i, ord: k, th: prev ? prev.th : (Math.random() - 0.5) * 0.3, om: 0,
          rest: prev ? prev.rest : (Math.random() - 0.5) * 0.36, T: prev ? prev.T : (still ? 1 : 0),
          at: prev ? prev.at : (o.kind === 'arrival' ? 1.1 + k * 0.11 : 0.35 + k * 0.045),
          twink: prev ? prev.twink : Math.random() < 0.3, flick: false, next: 0,
          lvx: 0, lvy: 0, ax: 0, ay: 0, fresh: true, colour: COLOURS[k % COLOURS.length]
        });
        ensureColour(B[k].colour);
      }
      B.forEach(function (b) { b.next = b.at + 1 + Math.random() * 4; });
      const r = { P: P, B: B, o: o };
      if (o.kind === 'arrival') r.t0 = old ? old.t0 : 1.1 + B.length * 0.11 + 2.5;
      return r;
    }
    function festoonHooks() {
      const f = cfg.festoon;
      const spans = Math.max(2, Math.round((W + 16) / f.span));
      const hooks = [];
      for (let i = 0; i <= spans; i++) hooks.push([-8 + i * (W + 16) / spans, f.top + (i % 2 ? 4 : 0)]);
      return hooks;
    }
    function buildFestoon() {
      const f = cfg.festoon;
      festoon = makeRope(festoonHooks(), { kind: 'festoon', slack: f.slack, seg: f.seg, every: f.every, scale: f.scale, drop: f.drop, iters: 18 }, festoon);
      festoon.W = W;
    }
    // On the held page the line that arrives at the door is the wire, held up
    // at each door it went through and ending at the brass square.
    function arrivalHooks() {
      const svg = document.getElementById('doors-across');
      const line = svg && svg.querySelector('.door-arrival');
      if (!line || !svg.getClientRects().length || svg.getBoundingClientRect().width < 200) return null;
      const m = line.getScreenCTM && line.getScreenCTM();
      if (!m) return null;
      const box = line.getBBox();
      const y = box.y + box.height / 2;
      const at = function (x) {
        const p = svg.createSVGPoint();
        p.x = x; p.y = y;
        const q = p.matrixTransform(m);
        return [q.x, q.y + window.scrollY];
      };
      const xs = [box.x];
      const passed = svg.querySelector('.door-passed');
      if (passed) {
        const seen = {};
        (passed.getAttribute('d') || '').replace(/M\s*([\d.]+)/g, function (_, x) {
          const v = parseFloat(x);
          if (!seen[v] && v > box.x + 20 && v < box.x + box.width - 20) { seen[v] = true; xs.push(v); }
          return _;
        });
      }
      xs.push(box.x + box.width);
      xs.sort(function (a, b) { return a - b; });
      return xs.map(at);
    }
    function syncArrival() {
      if (!cfg.arrival) return;
      const hooks = arrivalHooks();
      const figure = document.getElementById('doors');
      const key = hooks ? hooks.map(function (h) { return h[0].toFixed(1) + ',' + h[1].toFixed(1); }).join(' ') : '';
      if (key === arrivalKey) return;
      arrivalKey = key;
      arrival = hooks ? makeRope(hooks, { kind: 'arrival', slack: 1.001, seg: 8, every: 3, scale: 0.56, drop: 0, iters: 24 }, arrival) : null;
      if (figure) figure.classList.toggle('has-christmas-line', !!arrival);
    }

    function stepRope(r, dt) {
      const P = r.P, h = dt / SUB, damp = 0.994;
      const g = hand.grab && hand.grab.r === r ? P[hand.grab.i] : null;
      for (let s = 0; s < SUB; s++) {
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          if (p.pin) continue;
          if (p === g) {
            p.px = p.x; p.py = p.y;
            p.x += (hand.x - p.x) * 0.5;
            p.y += (hand.y - p.y) * 0.5;
            continue;
          }
          const vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp;
          p.px = p.x; p.py = p.y;
          // a breath of air, so the string never hangs dead still
          p.x += vx + Math.sin(t * 0.8 + i * 0.21) * 0.0016;
          p.y += vy + G * h * h;
        }
        for (let it = 0; it < r.o.iters; it++) {
          for (let i = 1; i < P.length; i++) {
            const a = P[i - 1], b = P[i];
            const ia = a.pin || a === g, ib = b.pin || b === g;
            if (ia && ib) continue;
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.001;
            const diff = (d - b.rest) / d;
            const fa = ia ? 0 : ib ? 1 : 0.5, fb = ib ? 0 : ia ? 1 : 0.5;
            a.x += dx * diff * fa; a.y += dy * diff * fa;
            b.x -= dx * diff * fb; b.y -= dy * diff * fb;
          }
        }
        // wire doesn't stretch: no point may sit farther from either hook than
        // the wire between them is long
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          if (p.pin || p === g) continue;
          const A = P[p.a], B = P[p.b];
          let dx = p.x - A.x, dy = p.y - A.y, d = Math.sqrt(dx * dx + dy * dy), m = (i - p.a) * p.rest;
          if (d > m) { p.x = A.x + dx / d * m; p.y = A.y + dy / d * m; }
          dx = p.x - B.x; dy = p.y - B.y; d = Math.sqrt(dx * dx + dy * dy); m = (p.b - i) * p.rest;
          if (d > m) { p.x = B.x + dx / d * m; p.y = B.y + dy / d * m; }
        }
      }
    }
    function stepBulbs(r, dt) {
      if (!(dt > 0)) return;
      const P = r.P, L = 16 * r.o.scale, h = dt / SUB;
      for (const b of r.B) {
        if (!isFinite(b.th) || !isFinite(b.om)) { b.th = 0; b.om = 0; b.ax = 0; b.ay = 0; b.fresh = true; }
        const p = P[b.i], q0 = P[b.i - 1], q1 = P[b.i + 1];
        const vx = (p.x - p.px) / h, vy = (p.y - p.py) / h;
        if (b.fresh) { b.lvx = vx; b.lvy = vy; b.fresh = false; }
        const ax = Math.max(-9000, Math.min(9000, (vx - b.lvx) / dt));
        const ay = Math.max(-9000, Math.min(9000, (vy - b.lvy) / dt));
        b.lvx = vx; b.lvy = vy;
        b.ax += (ax - b.ax) * 0.5;
        b.ay += (ay - b.ay) * 0.5;
        // the socket clips on square to the wire; gravity pulls the glass down
        const target = -Math.atan2(q1.y - q0.y, q1.x - q0.x) * 0.8 + b.rest;
        const acc = (-b.ax * Math.cos(b.th) - (G - b.ay) * Math.sin(b.th)) / L - 70 * (b.th - target) - 4.2 * b.om;
        b.om += acc * dt;
        b.th = Math.max(-1.3, Math.min(1.3, b.th + b.om * dt));
      }
    }
    function stepLamps(r, dt) {
      for (const b of r.B) {
        let want = t >= b.at;
        if (want && b.twink && r.o.kind === 'festoon') {
          if (t >= b.next) { b.flick = !b.flick; b.next = t + (b.flick ? 0.22 + Math.random() * 0.6 : 1.6 + Math.random() * 5); }
          want = !b.flick;
        }
        if (want && r.o.kind === 'arrival' && t > r.t0) {
          // every few seconds the line arrives again, one bulb after another
          const k = ((t - r.t0) % 6.5) - b.ord * 0.075;
          if (k > 0 && k < 0.16) want = false;
        }
        const target = want ? 1 : 0;
        b.T += (target - b.T) * (1 - Math.exp(-dt / (target > b.T ? 0.07 : 0.17)));
      }
    }
    function ropes() {
      return arrival ? [festoon, arrival] : [festoon];
    }
    function stepLights(dt) {
      if (hand.grab && Math.hypot(hand.x - hand.gx, hand.y - hand.gy) > 90) hand.grab = null; // it slips out of the fingers
      const sp = Math.hypot(air.vx, air.vy);
      if (!hand.grab && air.in && sp > 60) {
        // brushing a hand through the string
        const hx = air.x, hy = air.y + scrollY;
        ropes().forEach(function (r) {
          for (const p of r.P) {
            if (p.pin) continue;
            const dx = p.x - hx, dy = p.y - hy, d2 = dx * dx + dy * dy;
            if (d2 < 484) { const k = (1 - Math.sqrt(d2) / 22) * 0.35; p.x += air.vx * dt * k; p.y += air.vy * dt * k; }
          }
          for (const b of r.B) {
            const c = centre(r, b), dx = c[0] - hx, dy = c[1] - hy;
            if (dx * dx + dy * dy < 400) b.om += air.vx * 0.012;
          }
        });
      }
      ropes().forEach(function (r) { stepRope(r, dt); stepBulbs(r, dt); stepLamps(r, dt); });
    }
    function centre(r, b) {
      const p = r.P[b.i], k = 20 * r.o.scale;
      return [p.x + Math.sin(b.th) * k, p.y + Math.cos(b.th) * k];
    }
    function drawRope(r, lit) {
      const P = r.P, s = r.o.scale;
      // the light each lit bulb throws on what is behind it
      const R = (lit ? 58 : 46) * s;
      ctx.globalCompositeOperation = lit ? 'lighter' : 'source-over';
      for (const b of r.B) {
        if (b.T < 0.02) continue;
        const c = centre(r, b);
        ctx.globalAlpha = Math.pow(b.T, 1.8) * (lit ? 0.3 : 0.12);
        ctx.drawImage(pools[b.colour], c[0] - R, c[1] - R, R * 2, R * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < P.length - 1; i++) ctx.quadraticCurveTo(P[i].x, P[i].y, (P[i].x + P[i + 1].x) / 2, (P[i].y + P[i + 1].y) / 2);
      ctx.lineTo(P[P.length - 1].x, P[P.length - 1].y);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = lit ? '#08140f' : '#1d3326';
      ctx.lineWidth = 1.9 * s + 0.4;
      ctx.stroke();
      // the twist of the two strands catching the light
      ctx.setLineDash([2.2, 2.6]);
      ctx.strokeStyle = lit ? 'rgba(170,210,190,0.26)' : 'rgba(210,230,215,0.5)';
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.setLineDash([]);
      for (const b of r.B) {
        const p = P[b.i], sp = bulbSprites[b.colour];
        const c = Math.cos(b.th), sn = -Math.sin(b.th);
        ctx.setTransform(dpr * c * s, dpr * sn * s, -dpr * sn * s, dpr * c * s, dpr * p.x, dpr * (p.y - scrollY));
        ctx.globalAlpha = 1;
        ctx.drawImage(sp.off.c, -sp.off.ox, -sp.off.oy, sp.off.w, sp.off.h);
        if (b.T > 0.01) {
          ctx.globalAlpha = Math.min(1, Math.pow(b.T, 1.3));
          ctx.drawImage(sp.on.c, -sp.on.ox, -sp.on.oy, sp.on.w, sp.on.h);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, -dpr * scrollY);
      ctx.globalAlpha = 1;
      if (r.o.kind === 'festoon') {
        for (const p of P) {
          if (!p.pin || p.x < 2 || p.x > W - 2) continue;
          ctx.strokeStyle = '#b8892f';
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(p.x, p.y - 2.2, 2.4, 0, TAU); ctx.stroke();
          ctx.fillStyle = '#8a6218';
          ctx.fillRect(p.x - 0.6, p.y - 8, 1.2, 3.6);
        }
      }
    }

    // --- Hands ----------------------------------------------------------------------

    function onMove(e) {
      const now = performance.now();
      if (air.in && now - air.last < 120) {
        const d = Math.max(0.008, (now - air.last) / 1000);
        air.vx = air.vx * 0.4 + ((e.clientX - air.x) / d) * 0.6;
        air.vy = air.vy * 0.4 + ((e.clientY - air.y) / d) * 0.6;
      }
      air.x = e.clientX;
      air.y = e.clientY;
      air.last = now;
      air.in = true;
      hand.x = e.clientX;
      hand.y = e.clientY + scrollY;
    }
    function onLeave(e) { if (!e.relatedTarget) air.in = false; }
    function onDown(e) {
      onMove(e);
      // A tap on a line knocks its snow off, the way a finger flicks a sill.
      for (const L of ledges) {
        if (air.x < L.x0 - 24 || air.x > L.x1 + 24 || air.y < L.yMin - 30 || air.y > L.yMax + 22) continue;
        const c = air.x - L.x0;
        const i0 = Math.max(0, Math.floor(c - 80)), i1 = Math.min(L.n, Math.ceil(c + 80));
        let acc = 0;
        for (let i = i0; i < i1; i++) {
          const hv = L.h[i];
          if (!(hv > 0.2) || L.b[i] !== L.b[i]) continue;
          const take = hv * (0.5 + 0.5 * (1 - Math.abs(c - i) / 80));
          L.h[i] = hv - take;
          acc += take;
          if (acc > 3) {
            const side = (i - c) / 80;
            const k = spill(L.x0 + i, L.b[i] - hv, side, acc, L);
            if (k) { k.vx = side * 50 + (Math.random() - 0.5) * 30; k.vy = -40 - Math.random() * 70; }
            acc = 0;
          }
        }
      }
      // Take hold of the wire, unless the press was meant for a control.
      if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('a, button, input, label, select, textarea, summary, [role="switch"]'))) return;
      let best = null, bd = 324;
      ropes().forEach(function (r) {
        r.P.forEach(function (p, i) {
          if (p.pin) return;
          const dx = p.x - hand.x, dy = p.y - hand.y, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = { r: r, i: i }; }
        });
        for (const b of r.B) {
          const c = centre(r, b), dx = c[0] - hand.x, dy = c[1] - hand.y, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = { r: r, i: b.i }; }
        }
      });
      if (!best) return;
      hand.grab = best;
      hand.gx = hand.x;
      hand.gy = hand.y;
      e.preventDefault();
    }
    function onUp() { hand.grab = null; }

    // --- The frame ------------------------------------------------------------------

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      drawLedges();
      let i = 0;
      while (i < flakes.length && flakes[i].z < 0.3) i++;
      drawFlakes(0, i);
      ctx.setTransform(dpr, 0, 0, dpr, 0, -dpr * scrollY);
      ropes().forEach(function (r) { drawRope(r, r === festoon ? cfg.festoonLit(dark) : dark); });
      for (const c of clumps) drawFlake(c);
      drawFlakes(i, flakes.length);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
    }
    function measure() {
      measureQueued = false;
      measureAt = performance.now();
      scrollY = window.scrollY || 0;
      const sized = resize();
      const d = isDark();
      if (d !== dark || !sprites) { dark = d; buildSprites(); }
      if (sized || !flakes.length) populate();
      if (!festoon || Math.abs(festoon.W - W) > 2) buildFestoon();
      syncArrival();
      measureLedges();
      if (still) draw();
    }
    function queueMeasure() {
      if (measureQueued || stopped) return;
      measureQueued = true;
      requestAnimationFrame(function () { if (!stopped) measure(); });
    }
    function frame(now) {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      // A frame can arrive stamped no later than the last one; nothing moves in it.
      if (document.hidden || !(dt > 0)) return;
      // The page moves under the snow: things open, text arrives, sections fold.
      if (now - measureAt > 1000) measure();
      t += dt;
      stepSnow(dt);
      stepLights(dt);
      draw();
    }

    measure();
    if (still) {
      // A still picture: the lights on and steady, the snow already lying.
      for (let k = 0; k < 240; k++) ropes().forEach(function (r) { stepRope(r, 1 / 60); stepBulbs(r, 1 / 60); });
      t = 1000;
      draw();
    } else {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('pointerout', onLeave);
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    window.addEventListener('scroll', queueMeasure, { passive: true });
    window.addEventListener('resize', queueMeasure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueMeasure);
    timers.push(setTimeout(queueMeasure, 600));

    return {
      stop: function () {
        stopped = true;
        cancelAnimationFrame(raf);
        timers.forEach(clearTimeout);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('pointerout', onLeave);
        window.removeEventListener('scroll', queueMeasure);
        window.removeEventListener('resize', queueMeasure);
        const figure = document.getElementById('doors');
        if (figure) figure.classList.remove('has-christmas-line');
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }
})();
