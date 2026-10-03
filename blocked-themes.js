// blocked-themes.js — the designs a user can choose for the blocked page.
//
// A registry. blocked.html renders the chosen entry, and options.html builds its
// design picker from the same list, so the two can never disagree about which
// designs exist. To add one: an entry here, its styles in blocked-themes.css,
// and a thumbnail in options.html.
//
// Each design starts from what it is for, not from a mood: Calm is a breathing
// exercise drawn as an ensō, Verse is scripture read in a moment of quiet,
// Motivation is the streak as a chain of days. The blocked page is seen at a
// hard moment, so none of the wording shames or lectures, and every page says
// plainly what happened in its first line.
//
// Everything is built with createElement and textContent. The content is
// static, but blocked.html is web-accessible, so nothing in this file should
// ever become an innerHTML sink.
(function (root) {
  'use strict';

  const CLASSIC = 'classic';

  // King James Version: public domain, so it can ship inside the extension.
  // Chosen for strength and mercy rather than condemnation.
  const VERSES = [
    { ref: '1 Corinthians 10:13', text: 'There hath no temptation taken you but such as is common to man: but God is faithful, who will not suffer you to be tempted above that ye are able; but will with the temptation also make a way to escape, that ye may be able to bear it.' },
    { ref: 'Philippians 4:13', text: 'I can do all things through Christ which strengtheneth me.' },
    { ref: 'Psalm 51:10', text: 'Create in me a clean heart, O God; and renew a right spirit within me.' },
    { ref: 'Isaiah 41:10', text: 'Fear thou not; for I am with thee: be not dismayed; for I am thy God: I will strengthen thee; yea, I will help thee; yea, I will uphold thee with the right hand of my righteousness.' },
    { ref: 'Psalm 46:1', text: 'God is our refuge and strength, a very present help in trouble.' },
    { ref: 'Lamentations 3:22–23', text: 'It is of the LORD’s mercies that we are not consumed, because his compassions fail not. They are new every morning: great is thy faithfulness.' },
    { ref: '1 John 1:9', text: 'If we confess our sins, he is faithful and just to forgive us our sins, and to cleanse us from all unrighteousness.' },
    { ref: 'Romans 8:1', text: 'There is therefore now no condemnation to them which are in Christ Jesus, who walk not after the flesh, but after the Spirit.' },
    { ref: 'Matthew 11:28', text: 'Come unto me, all ye that labour and are heavy laden, and I will give you rest.' },
    { ref: 'Isaiah 40:31', text: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.' },
    { ref: '2 Corinthians 12:9', text: 'My grace is sufficient for thee: for my strength is made perfect in weakness.' },
    { ref: 'Psalm 34:18', text: 'The LORD is nigh unto them that are of a broken heart; and saveth such as be of a contrite spirit.' },
    { ref: 'James 4:7', text: 'Submit yourselves therefore to God. Resist the devil, and he will flee from you.' },
    { ref: 'Matthew 26:41', text: 'Watch and pray, that ye enter not into temptation: the spirit indeed is willing, but the flesh is weak.' },
    { ref: 'Galatians 5:16', text: 'This I say then, Walk in the Spirit, and ye shall not fulfil the lust of the flesh.' },
    { ref: 'Psalm 119:11', text: 'Thy word have I hid in mine heart, that I might not sin against thee.' },
    { ref: 'Proverbs 3:5–6', text: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths.' },
    { ref: 'Joshua 1:9', text: 'Have not I commanded thee? Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.' }
  ];

  const MOTIVATION_ACTIONS = [
    'Walk around the block',
    'Drink a glass of water',
    'Text someone you trust',
    'Do twenty push-ups'
  ];

  // Calm is an ensō, the Zen circle drawn in one movement of the brush. It is
  // urge surfing given something for the hands to do: an urge builds, peaks
  // and falls away whether or not it is acted on, and a few slow breaths are a
  // way to sit through the start of one. Hold to breathe in and the brush
  // starts the circle; let go to breathe out and it closes. The out-breath is
  // the longer one, because a long exhale is what slows the heart.
  const ENSO_BREATHS = 5;
  const ENSO_IN_SECONDS = 4;
  const ENSO_OUT_SECONDS = 6;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Motivation is the chain: "don't break the chain", the habit trick of
  // crossing off a calendar day for every day kept, until the run of red X's
  // is something you would hate to break. Each X here is a day protection
  // stayed on. Milestones at 7 and 30 days (the Statistics page's goal) and
  // at 90, a common recovery milestone.
  const MILESTONES = [7, 30, 90];
  const CHAIN_WEEKS = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Today's X is the reader's own mark, kept in this browser for the day.
  const MARK_KEY = 'blocknsfw-chain-marked';

  // --- helpers ---------------------------------------------------------------

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function randomIndex(length, avoid) {
    if (length <= 1) return 0;
    let i = Math.floor(Math.random() * length);
    if (i === avoid) i = (i + 1) % length;
    return i;
  }

  // The first line of every design: what happened, in plain words.
  function context(doc, text) {
    return el(doc, 'p', 'theme-context', text);
  }

  // --- Calm: the ensō -----------------------------------------------------------

  function svg(doc, tag, attrs) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  // A small seeded random source, so a drawing can be repeated exactly: each
  // breath's circle is drawn again, small, in the tally from the same numbers.
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // No two circles from a brush are alike. Each breath's ensō starts low on
  // the left, near seven o'clock, leaves its own gap of 16 to 30 degrees,
  // leans a little out of round, and runs dry at its own point on the tail.
  function ensoVariant(random) {
    return {
      start: 108 + random() * 28,
      gap: 16 + random() * 14,
      sx: 0.97 + random() * 0.06,
      sy: 0.97 + random() * 0.06,
      dry: 0.58 + random() * 0.14,
      seed: Math.floor(random() * 2147483647)
    };
  }

  function variantTransform(v, centre) {
    return `rotate(${v.start.toFixed(1)} ${centre} ${centre}) translate(${centre} ${centre}) ` +
      `scale(${v.sx.toFixed(3)} ${v.sy.toFixed(3)}) translate(${-centre} ${-centre})`;
  }

  // The brush, as concentric strokes round a 200 radius in a 520 box: a full
  // body, an inner edge that lifts just before the end, an outer edge that
  // thins out sooner, and two stray bristles. Where the outer strokes stop,
  // the circle tapers to its tail.
  const ENSO_STROKES = [
    { r: 207, width: 7, share: 0.8 },
    { r: 200, width: 15, share: 1 },
    { r: 193, width: 9, share: 0.96 },
    { r: 185, width: 1.5, share: 0.7, bristle: true },
    { r: 214, width: 1.5, share: 0.45, bristle: true }
  ];

  // Kasure, the dry brush: streaks the colour of the paper, laid over the
  // last stretch of the stroke. On bare paper they cannot be seen; once ink
  // runs under them they show as the white of a brush running out.
  function dryStreaks(doc, v) {
    const random = seeded(v.seed);
    const arc = (360 - v.gap) / 360;
    return [190, 196.5, 200, 203.5].map((r) => {
      const c = 2 * Math.PI * r;
      let at = c * arc * (v.dry + random() * 0.08);
      const end = c * arc * 0.995;
      const parts = [0, at];
      while (at < end) {
        const dash = 6 + random() * 34;
        const gap = 4 + random() * 22;
        parts.push(dash, gap);
        at += dash + gap;
      }
      parts.push(0, c);
      return svg(doc, 'circle', {
        cx: 260, cy: 260, r,
        'stroke-width': (0.8 + random() * 0.9).toFixed(2),
        'stroke-dasharray': parts.map((n) => n.toFixed(1)).join(' ')
      });
    });
  }

  // Washi: long pale fibres in the paper and a few flecks of bark, drawn once
  // from a fixed seed and held behind the page.
  function drawPaper(doc) {
    const random = seeded(0x5eed);
    const paper = svg(doc, 'svg', {
      class: 'enso-paper',
      viewBox: '0 0 1200 800',
      preserveAspectRatio: 'xMidYMid slice',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    const n = (x) => x.toFixed(1);
    for (let i = 0; i < 90; i++) {
      const x = random() * 1200;
      const y = random() * 800;
      const angle = random() * Math.PI;
      const length = 18 + random() * 70;
      const bend = (random() - 0.5) * length * 0.5;
      const dx = Math.cos(angle) * length;
      const dy = Math.sin(angle) * length;
      paper.append(svg(doc, 'path', {
        class: random() < 0.7 ? 'enso-fibre' : 'enso-fibre enso-fibre-dark',
        d: `M${n(x)} ${n(y)}Q${n(x + dx / 2 - Math.sin(angle) * bend)} ${n(y + dy / 2 + Math.cos(angle) * bend)} ${n(x + dx)} ${n(y + dy)}`,
        'stroke-width': (0.4 + random() * 0.6).toFixed(2)
      }));
    }
    for (let i = 0; i < 16; i++) {
      const cx = random() * 1200;
      const cy = random() * 800;
      paper.append(svg(doc, 'ellipse', {
        class: 'enso-fleck',
        cx: n(cx), cy: n(cy),
        rx: (0.6 + random() * 1.4).toFixed(2),
        ry: (0.4 + random() * 0.6).toFixed(2),
        transform: `rotate(${Math.round(random() * 180)} ${n(cx)} ${n(cy)})`
      }));
    }
    return paper;
  }

  // The circle: a faint guide where the brush will go, and the ink, roughened
  // at its edges as sumi bleeds into paper. The brush lands with a little
  // pool of ink and a few drops thrown off at the start.
  function drawEnso(doc) {
    const ring = svg(doc, 'svg', {
      class: 'enso',
      viewBox: '0 0 520 520',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    const bleed = svg(doc, 'filter', { id: 'enso-bleed', x: '-10%', y: '-10%', width: '120%', height: '120%' });
    bleed.append(
      svg(doc, 'feTurbulence', { type: 'fractalNoise', baseFrequency: '0.045', numOctaves: '2', seed: '3', result: 'grain' }),
      svg(doc, 'feDisplacementMap', { in: 'SourceGraphic', in2: 'grain', scale: '5', xChannelSelector: 'R', yChannelSelector: 'G' })
    );
    const defs = svg(doc, 'defs', {});
    defs.append(bleed);

    const strokes = ENSO_STROKES.map((s) => svg(doc, 'circle', {
      class: s.bristle ? 'enso-stroke enso-bristle' : 'enso-stroke',
      cx: 260, cy: 260, r: s.r,
      'stroke-width': s.width
    }));
    const dry = svg(doc, 'g', { class: 'enso-dry' });
    const drops = svg(doc, 'g', { class: 'enso-drops' });
    drops.append(
      svg(doc, 'circle', { cx: 481, cy: 240, r: 2.2 }),
      svg(doc, 'circle', { cx: 489, cy: 256, r: 1.3 }),
      svg(doc, 'circle', { cx: 451, cy: 229, r: 1.6 })
    );
    const turn = svg(doc, 'g', {});
    turn.append(svg(doc, 'ellipse', { class: 'enso-pool', cx: 460, cy: 262, rx: 11, ry: 15 }), ...strokes, dry, drops);
    const ink = svg(doc, 'g', { class: 'enso-ink', filter: 'url(#enso-bleed)' });
    ink.append(turn);

    ring.append(defs, svg(doc, 'circle', { class: 'enso-path', cx: 260, cy: 260, r: 200 }), ink);
    return { ring, turn, strokes, dry };
  }

  // A seal, as a painter signs a scroll: a red stone with a small ensō and a
  // border cut into it.
  function drawSeal(doc) {
    const seal = svg(doc, 'svg', { class: 'enso-seal', viewBox: '0 0 40 40', 'aria-hidden': 'true', focusable: 'false' });
    seal.append(
      svg(doc, 'path', {
        class: 'enso-seal-stone',
        d: 'M3 4.6Q3 3 4.6 3L35.2 2.6Q37 2.6 37 4.4L37.4 35.2Q37.4 37 35.6 37L4.6 37.4Q2.8 37.4 2.8 35.6Z'
      }),
      svg(doc, 'rect', { class: 'enso-seal-cut enso-seal-border', x: 6.5, y: 6.5, width: 27, height: 27, rx: 1 }),
      svg(doc, 'circle', {
        class: 'enso-seal-cut', cx: 20, cy: 20, r: 8,
        'stroke-dasharray': '45 51', transform: 'rotate(120 20 20)'
      })
    );
    return seal;
  }

  // One finished breath, small: the same circle the brush drew, in the same
  // place, without the dry streaks.
  function drawTallyCircle(doc, group, v) {
    const arc = (360 - v.gap) / 360;
    group.setAttribute('transform', variantTransform(v, 20));
    group.replaceChildren(...[[14, 3.2, 1], [15.5, 1.3, 0.8], [12.6, 1.4, 0.96]].map(([r, width, share]) => {
      const c = 2 * Math.PI * r;
      return svg(doc, 'circle', {
        class: 'enso-slot-ink', cx: 20, cy: 20, r,
        'stroke-width': width,
        'stroke-dasharray': `${(c * arc * share).toFixed(2)} ${c.toFixed(2)}`
      });
    }));
  }

  function renderCalm(ctx) {
    const { doc, hero, reducedMotion } = ctx;

    let random = seeded(Math.floor(Math.random() * 2147483647));
    let variants = Array.from({ length: ENSO_BREATHS }, () => ensoVariant(random));
    let count = 0;
    let phase = 'idle';
    let breathTimer = 0;
    let holdTimer = 0;

    const { ring, turn, strokes, dry } = drawEnso(doc);
    const hold = el(doc, 'button', 'enso-hold');
    hold.type = 'button';
    hold.setAttribute('aria-label', 'Hold to breathe in, let go to breathe out');
    const cue = el(doc, 'span', 'enso-cue', 'Hold');
    cue.setAttribute('aria-hidden', 'true');
    const frame = el(doc, 'div', 'enso-frame');
    frame.append(ring, cue, hold);

    const inscription = el(doc, 'p', 'enso-inscription', 'let it rise · let it fall');
    inscription.setAttribute('aria-hidden', 'true');
    const signature = el(doc, 'div', 'enso-signature');
    signature.append(inscription, drawSeal(doc));

    const stage = el(doc, 'div', 'enso-stage');
    stage.dataset.phase = 'idle';
    if (reducedMotion) stage.classList.add('is-still');
    stage.append(frame, signature);

    const words = el(doc, 'div', 'enso-words');
    words.append(
      el(doc, 'h1', 'theme-title enso-title', 'One breath, one circle.'),
      el(doc, 'p', 'enso-guide',
        'Press and hold the circle while you breathe in. Let go, and breathe out as the brush closes it.')
    );

    const phaseLine = el(doc, 'p', 'enso-phase', '');
    phaseLine.setAttribute('aria-live', 'polite');
    const slots = Array.from({ length: ENSO_BREATHS }, () => {
      const slot = svg(doc, 'svg', { class: 'enso-slot', viewBox: '0 0 40 40', 'aria-hidden': 'true', focusable: 'false' });
      const drawn = svg(doc, 'g', {});
      slot.append(svg(doc, 'circle', { class: 'enso-slot-guide', cx: 20, cy: 20, r: 14 }), drawn);
      return { slot, drawn };
    });
    const slotRow = el(doc, 'div', 'enso-slots');
    slotRow.append(...slots.map((s) => s.slot));
    const countLine = el(doc, 'span', 'enso-count', '');
    const tally = el(doc, 'div', 'enso-tally');
    tally.append(slotRow, countLine);

    const again = el(doc, 'button', 'theme-link enso-again', 'Begin again');
    again.type = 'button';
    const done = el(doc, 'div', 'enso-done');
    done.hidden = true;
    done.append(el(doc, 'p', 'enso-done-line', 'Five breaths taken. Notice where the urge is now.'), again);

    const status = el(doc, 'div', 'enso-status');
    status.append(phaseLine, tally, done);

    const layout = el(doc, 'div', 'enso-layout');
    layout.append(words, stage, status);
    hero.append(
      context(doc, 'BlockNSFW blocked this page.'),
      layout,
      drawPaper(doc)
    );

    const say = () => {
      phaseLine.textContent = {
        idle: count === 0 ? 'Press and hold to breathe in' : 'Again, when you are ready',
        in: 'Breathe in',
        out: 'Breathe out',
        rest: 'Breathe out',
        done: 'Five breaths.'
      }[phase];
      cue.textContent = { idle: 'Hold', in: 'Breathe in', out: 'Breathe out', rest: 'Breathe out', done: '' }[phase];
      countLine.textContent = `${count} of ${ENSO_BREATHS} breaths`;
    };
    const setPhase = (next) => {
      phase = next;
      stage.dataset.phase = next;
      say();
    };

    // How far round the brush has gone: 0 is clean paper, 1 the whole circle.
    // The browser eases the strokes there over the length of the breath.
    const draw = (p) => {
      const v = variants[Math.min(count, ENSO_BREATHS - 1)];
      const arc = (360 - v.gap) / 360;
      ENSO_STROKES.forEach((s, i) => {
        const c = 2 * Math.PI * s.r;
        const len = c * arc * s.share;
        strokes[i].style.setProperty('stroke-dasharray', `${len.toFixed(1)} ${c.toFixed(1)}`);
        strokes[i].style.setProperty('stroke-dashoffset', (len * (1 - p) + 1).toFixed(1));
      });
    };
    // Ready the next breath's circle, out of sight.
    const prepare = () => {
      const v = variants[Math.min(count, ENSO_BREATHS - 1)];
      turn.setAttribute('transform', variantTransform(v, 260));
      dry.replaceChildren(...dryStreaks(doc, v));
      draw(0);
    };

    const press = () => {
      if (phase !== 'idle') return;
      setPhase('in');
      draw(0.5);
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        if (phase !== 'in') return;
        phaseLine.textContent = 'Hold, then let go';
        cue.textContent = 'Hold, then let go';
      }, ENSO_IN_SECONDS * 1000);
    };
    const finish = () => {
      drawTallyCircle(doc, slots[count].drawn, variants[count]);
      slots[count].slot.classList.add('is-drawn');
      count += 1;
      if (count >= ENSO_BREATHS) {
        done.hidden = false;
        setPhase('done');
        return;
      }
      // The circle fades, and the paper is ready for the next.
      setPhase('rest');
      breathTimer = setTimeout(() => {
        setPhase('idle');
        prepare();
      }, 900);
    };
    const release = () => {
      if (phase !== 'in') return;
      clearTimeout(holdTimer);
      setPhase('out');
      draw(1);
      clearTimeout(breathTimer);
      breathTimer = setTimeout(finish, ENSO_OUT_SECONDS * 1000);
    };

    const isKey = (e) => e.key === ' ' || e.key === 'Enter';
    hold.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      try { hold.setPointerCapture(e.pointerId); } catch (_) {}
      press();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
      hold.addEventListener(type, release);
    }
    // A long press on a phone would otherwise open a menu.
    hold.addEventListener('contextmenu', (e) => e.preventDefault());
    hold.addEventListener('keydown', (e) => {
      if (!isKey(e)) return;
      e.preventDefault();
      if (!e.repeat) press();
    });
    hold.addEventListener('keyup', (e) => {
      if (!isKey(e)) return;
      e.preventDefault();
      release();
    });
    again.addEventListener('click', () => {
      clearTimeout(breathTimer);
      random = seeded(Math.floor(Math.random() * 2147483647));
      variants = Array.from({ length: ENSO_BREATHS }, () => ensoVariant(random));
      count = 0;
      slots.forEach((s) => {
        s.drawn.replaceChildren();
        s.slot.classList.remove('is-drawn');
      });
      done.hidden = true;
      setPhase('idle');
      prepare();
    });

    prepare();
    say();
  }

  // --- Verse: the light --------------------------------------------------------
  //
  // After Tadao Ando's Church of the Light: a concrete wall in shadow with a
  // cross cut through it, and light coming in. The verse sits under the
  // cross's arm. 1 Corinthians 10:13 promises "a way to escape"; here it is
  // the light getting in.
  //
  // The wall is drawn as real formwork: panels twice as wide as they are tall,
  // six tie holes in each, and the cross cut along the joints. The joints are
  // laid out from the cross rather than the cross from the joints, so the
  // cross can go wherever the words leave room and still land on them. On a
  // wide screen it stands to the right of the words, its arm in the gap
  // between the first line and the verse; on a narrow one it is cut above the
  // verse.

  // Where the cross moves from beside the words to above them. The column in
  // blocked-themes.css switches at the same width.
  const LIGHT_WIDE = '(min-width: 720px)';

  // Panel width for a page this wide: 240px on a 1280px screen, between 112
  // and 300, so the tie holes stay in scale with the words. Always even, so a
  // panel's half-height row lands on whole pixels.
  function panelWidth(pageWidth) {
    return 2 * Math.round(Math.min(150, Math.max(56, pageWidth * 0.075 + 24)));
  }

  // Where the cross goes, from where the words are (page coordinates, px):
  //  - lineBottom: the foot of the first line, "BlockNSFW blocked this page."
  //  - verseTop: the top of the verse.
  //  - columnRight: the right edge of the column (wide pages).
  //  - wordsEnd: where the first line's words end (narrow pages).
  // Returns the centre of the upright (x) and of the arm (y), the width of the
  // slits, how far down the upright runs (null: the whole page), and the
  // formwork's panel and offset, which put a joint through the centre of both.
  function lightLayout({ pageWidth, wide, lineBottom, verseTop, columnRight, wordsEnd }) {
    const slit = wide ? 2 * Math.round(Math.min(8, Math.max(4, pageWidth * 0.00475))) : 8;
    let x;
    let y;
    let uprightBottom = null;
    if (wide) {
      y = Math.round((lineBottom + verseTop) / 2);
      const gap = Math.min(180, Math.max(48, pageWidth * 0.09));
      x = Math.round(Math.min(pageWidth - 2 * slit, columnRight + gap));
    } else {
      // The arm just under the first line; the upright clear of its words,
      // stopping short of the verse.
      y = Math.round(lineBottom + Math.min(48, (verseTop - lineBottom) * 0.22));
      x = Math.round(Math.min(pageWidth - 24 - slit,
        Math.max(pageWidth * 0.62, wordsEnd + 24 + slit / 2)));
      uprightBottom = Math.round(verseTop - 28);
    }
    const panel = panelWidth(pageWidth);
    const row = panel / 2;
    return {
      slit, x, y, uprightBottom, panel,
      x0: ((x % panel) + panel) % panel,
      y0: ((y % row) + row) % row
    };
  }

  // One panel of formwork as an SVG pattern tile whose corner sits at (x, y):
  // a joint along its top and left edges, and six tie holes, each a dark hole
  // with a faint rim.
  function drawPanel(doc, pattern, width, x, y) {
    const height = width / 2;
    const r = Math.max(1.6, width * 0.0134);
    pattern.replaceChildren(svg(doc, 'path', {
      class: 'light-joint',
      d: `M0.5 0V${height}M0 0.5H${width}`
    }));
    for (const fy of [0.25, 0.75]) {
      for (const fx of [1 / 6, 0.5, 5 / 6]) {
        const cx = (width * fx).toFixed(1);
        const cy = (height * fy).toFixed(1);
        pattern.append(
          svg(doc, 'circle', { class: 'light-tie', cx, cy, r: r.toFixed(2) }),
          svg(doc, 'circle', { class: 'light-tie-rim', cx, cy, r: (r + 1).toFixed(2) })
        );
      }
    }
    for (const [k, v] of Object.entries({ x, y, width, height })) pattern.setAttribute(k, String(v));
  }

  // Concrete is poured panel by panel and no two cure to quite the same grey,
  // so about one panel in five is a shade lighter or darker. Picked by a hash
  // of the panel's row and column rather than at random, so a redraw does not
  // reshuffle them.
  function tintPanels(doc, group, width, x0, y0, pageWidth, pageHeight) {
    const height = width / 2;
    group.replaceChildren();
    for (let y = y0 - height, row = 0; y < pageHeight; y += height, row++) {
      for (let x = x0 - width, col = 0; x < pageWidth; x += width, col++) {
        const shade = ((Math.imul(col + 11, 73856093) ^ Math.imul(row + 5, 19349663)) >>> 0) % 10;
        if (shade > 1) continue;
        group.append(svg(doc, 'rect', {
          class: shade ? 'light-shade' : 'light-pale', x, y, width, height
        }));
      }
    }
  }

  function renderVerse(ctx) {
    const { doc, hero } = ctx;

    let index = randomIndex(VERSES.length);
    const text = el(doc, 'p', 'light-verse');
    const ref = el(doc, 'span', 'light-ref-name');
    const show = () => {
      const verse = VERSES[index];
      text.textContent = verse.text;
      ref.textContent = verse.ref;
    };
    show();

    const cite = el(doc, 'p', 'light-ref');
    cite.append(ref, el(doc, 'span', 'light-ref-translation', 'King James Version'));

    const another = el(doc, 'button', 'theme-link light-another', 'Read another verse');
    another.type = 'button';
    another.addEventListener('click', () => {
      index = randomIndex(VERSES.length, index);
      show();
    });

    const line = context(doc, 'BlockNSFW blocked this page.');
    const passage = el(doc, 'div', 'light-passage');
    passage.append(text, cite, another);

    // The wall behind the page: the formwork, and the cross as two slits.
    const wall = el(doc, 'div', 'light-wall');
    wall.setAttribute('aria-hidden', 'true');
    const formwork = svg(doc, 'svg', { class: 'light-formwork', focusable: 'false' });
    const defs = svg(doc, 'defs', {});
    const pattern = svg(doc, 'pattern', { id: 'light-panel', patternUnits: 'userSpaceOnUse' });
    defs.append(pattern);
    const tints = svg(doc, 'g', {});
    formwork.append(defs, tints, svg(doc, 'rect', { width: '100%', height: '100%', fill: 'url(#light-panel)' }));
    const upright = el(doc, 'div', 'light-slit light-upright');
    const arm = el(doc, 'div', 'light-slit light-arm');
    wall.append(formwork, upright, arm);

    hero.append(line, passage, wall);

    // Measure where the words fell, place the cross, and lay the formwork out
    // from it. Skipped where there is no layout to measure.
    function place() {
      const body = doc.body;
      if (!body || typeof body.getBoundingClientRect !== 'function') return;
      const page = body.getBoundingClientRect();
      const view = doc.defaultView;
      const range = doc.createRange();
      range.selectNodeContents(line);
      const pageWidth = body.clientWidth;
      const at = lightLayout({
        pageWidth,
        wide: !!(view && view.matchMedia(LIGHT_WIDE).matches),
        lineBottom: line.getBoundingClientRect().bottom - page.top,
        verseTop: passage.getBoundingClientRect().top - page.top,
        columnRight: hero.getBoundingClientRect().right - page.left,
        wordsEnd: range.getBoundingClientRect().right - page.left
      });

      upright.style.left = `${at.x - at.slit / 2}px`;
      upright.style.width = `${at.slit}px`;
      upright.style.height = at.uprightBottom == null ? '' : `${Math.max(0, at.uprightBottom)}px`;
      upright.classList.toggle('is-full', at.uprightBottom == null);
      arm.style.top = `${at.y - at.slit / 2}px`;
      arm.style.height = `${at.slit}px`;
      drawPanel(doc, pattern, at.panel, at.x0, at.y0);
      tintPanels(doc, tints, at.panel, at.x0, at.y0, pageWidth, page.height);
    }

    let pending = 0;
    const schedule = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        place();
      });
    };
    place();
    // Anything that moves the words moves the cross: a new size, the reason
    // opening under "Why was this blocked?", a verse of a different length.
    if (typeof ResizeObserver === 'function' && doc.body) {
      new ResizeObserver(schedule).observe(doc.body);
    }
  }

  // --- Motivation: the chain ---------------------------------------------------

  // The weekday a calendar row starts on, as the reader's locale counts weeks
  // (0 is Sunday, 1 Monday), where the browser can say; Monday otherwise.
  function firstWeekday() {
    try {
      const locale = new Intl.Locale(navigator.language);
      const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
      if (info && info.firstDay) return info.firstDay % 7;
    } catch (_) {}
    return 1;
  }

  // CHAIN_WEEKS rows of a calendar, ending with the week that holds today.
  // Each day knows how many days before today it is (negative ahead of it),
  // and whether protection covered it: the streak's whole days are the days
  // before today, counting back from yesterday.
  function chainDays(today, streak, weekStart) {
    const intoWeek = (today.getDay() - weekStart + 7) % 7;
    const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - intoWeek - (CHAIN_WEEKS - 1) * 7);
    return Array.from({ length: CHAIN_WEEKS * 7 }, (_, i) => {
      const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      const before = Math.round((today - date) / DAY_MS);
      return { date, before, kept: before >= 1 && before <= streak, today: before === 0 };
    });
  }

  // A red marker X, a little different on every date but the same each time
  // that date is drawn, in an 80 x 80 box: low and right of centre, clear of
  // the date in the corner.
  function drawCross(doc, seed, className) {
    let s = (seed % 2147483646) + 1;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const j = (n) => (rnd() - 0.5) * n;
    const p = (x, y) => x.toFixed(1) + ' ' + y.toFixed(1);
    const cross = svg(doc, 'svg', { class: className, viewBox: '0 0 80 80', 'aria-hidden': 'true', focusable: 'false' });
    cross.append(
      svg(doc, 'path', { class: 'chain-stroke', d: 'M' + p(24 + j(5), 27 + j(5)) + 'Q' + p(44 + j(8), 45 + j(8)) + ' ' + p(64 + j(5), 64 + j(5)) }),
      svg(doc, 'path', { class: 'chain-stroke', d: 'M' + p(63 + j(5), 26 + j(5)) + 'Q' + p(44 + j(8), 46 + j(8)) + ' ' + p(25 + j(5), 65 + j(5)) })
    );
    return cross;
  }

  const dateSeed = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const dateKey = (d) => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();

  function renderMotivation(ctx) {
    const { doc, hero, reducedMotion, loadStreakDays } = ctx;
    const weekStart = firstWeekday();
    const format = (options) => {
      try {
        return new Intl.DateTimeFormat(undefined, options);
      } catch (_) {
        return { format: (d) => d.toDateString() };
      }
    };
    const monthYear = format({ month: 'long', year: 'numeric' });
    const monthDay = format({ month: 'short', day: 'numeric' });
    const weekday = format({ weekday: 'short' });

    let streak = 0;
    let marked = false;
    let today = new Date();
    try {
      marked = !!root.localStorage && root.localStorage.getItem(MARK_KEY) === dateKey(today);
    } catch (_) {}

    const count = el(doc, 'span', 'chain-count', '');
    const unit = el(doc, 'span', 'chain-unit', '');
    const tally = el(doc, 'p', 'chain-tally');
    tally.append(count, unit);
    const next = el(doc, 'p', 'chain-next', '');
    const words = el(doc, 'div', 'chain-words');
    words.append(
      el(doc, 'h1', 'theme-title chain-title', 'Don’t break the chain.'),
      el(doc, 'p', 'chain-guide',
        'Every red X is a day protection stayed on. Hold on through today, then give it its X.'),
      tally,
      next
    );

    const action = MOTIVATION_ACTIONS[randomIndex(MOTIVATION_ACTIONS.length)];
    const nudge = 'Right now: ' + action.charAt(0).toLowerCase() + action.slice(1) + '.';
    const status = el(doc, 'p', 'chain-status', nudge);
    status.setAttribute('aria-live', 'polite');

    const month = el(doc, 'p', 'chain-month', '');
    const weekdays = el(doc, 'div', 'chain-weekdays');
    weekdays.setAttribute('aria-hidden', 'true');
    // 4 January 2026 was a Sunday.
    for (let i = 0; i < 7; i++) {
      weekdays.append(el(doc, 'span', '', weekday.format(new Date(2026, 0, 4 + ((weekStart + i) % 7)))));
    }
    const grid = el(doc, 'div', 'chain-grid');
    const calendar = el(doc, 'div', 'chain-calendar');
    calendar.append(month, weekdays, grid);

    const layout = el(doc, 'div', 'chain-layout');
    layout.append(words, calendar, status);
    hero.append(context(doc, 'BlockNSFW blocked this page.'), layout);

    // Today's square: the reader marks it, and the X draws itself in.
    const mark = el(doc, 'button', 'chain-mark');
    mark.type = 'button';
    mark.setAttribute('aria-label', 'Mark today');
    if (reducedMotion) mark.classList.add('is-still');
    mark.append(drawCross(doc, dateSeed(today), 'chain-cross'), el(doc, 'span', 'chain-mark-label', 'Mark'));

    const shown = () => streak + (marked ? 1 : 0);
    const say = () => {
      const n = shown();
      if (n === 0) {
        count.textContent = 'Day 1';
        unit.textContent = 'Protection is on. Mark today to start the chain.';
      } else {
        count.textContent = String(n);
        unit.textContent = n === 1 ? 'day of protection in a row' : 'days of protection in a row';
      }
      const goal = MILESTONES.find((m) => m > n);
      next.textContent = goal === undefined
        ? n + ' days and counting. Keep the chain going.'
        : (goal - n) + ' more to ' + goal + ' days.';
      status.textContent = marked ? 'Marked. Now hold it until midnight.' : nudge;
      mark.classList.toggle('is-marked', marked);
      mark.setAttribute('aria-pressed', marked ? 'true' : 'false');
    };

    mark.addEventListener('click', () => {
      marked = !marked;
      try {
        if (marked) root.localStorage.setItem(MARK_KEY, dateKey(today));
        else root.localStorage.removeItem(MARK_KEY);
      } catch (_) {}
      say();
    });

    function drawCalendar() {
      today = new Date();
      today.setHours(0, 0, 0, 0);
      month.textContent = monthYear.format(today);
      const goal = MILESTONES.find((m) => m > shown());
      grid.replaceChildren(...chainDays(today, streak, weekStart).map((day, i) => {
        const cell = el(doc, 'div', 'chain-day');
        const first = i === 0 || day.date.getDate() === 1;
        cell.append(el(doc, 'span', 'chain-date', first ? monthDay.format(day.date) : String(day.date.getDate())));
        if (day.kept) {
          cell.classList.add('is-kept');
          cell.append(drawCross(doc, dateSeed(day.date), 'chain-cross'));
        } else if (day.today) {
          cell.classList.add('is-today');
          cell.append(mark);
        } else if (day.before < 0) {
          cell.classList.add('is-ahead');
          // The next milestone, if it falls this week, is ringed.
          if (goal !== undefined && -day.before === goal - shown()) cell.classList.add('is-goal');
        }
        return cell;
      }));
    }

    const show = (value) => {
      streak = (typeof value === 'number' && value >= 1) ? Math.floor(value) : 0;
      say();
      drawCalendar();
    };
    show(null);
    Promise.resolve()
      .then(() => (typeof loadStreakDays === 'function' ? loadStreakDays() : null))
      .then(show, () => show(null));
  }

  // --- registry --------------------------------------------------------------

  const THEMES = [
    {
      id: CLASSIC,
      name: 'Classic',
      blurb: 'What was blocked and why, plainly.'
    },
    {
      id: 'calm',
      name: 'Calm',
      blurb: 'Draw a Zen circle, one slow breath at a time, while the urge passes.',
      render: renderCalm
    },
    {
      id: 'verse',
      name: 'Verse',
      blurb: 'A Bible verse under a cross of light, from the King James Version.',
      render: renderVerse
    },
    {
      id: 'motivation',
      name: 'Motivation',
      blurb: 'A red X for every day of protection. Mark today, and don’t break the chain.',
      render: renderMotivation
    }
  ];

  function get(id) {
    return THEMES.find((t) => t.id === id) || null;
  }

  root.BlockedThemes = {
    DEFAULT_ID: CLASSIC,
    list: THEMES,
    get,
    normalize: (id) => (get(id) ? id : CLASSIC),
    VERSES,
    MOTIVATION_ACTIONS,
    ENSO_BREATHS,
    ENSO_IN_SECONDS,
    ENSO_OUT_SECONDS,
    MILESTONES,
    CHAIN_WEEKS,
    chainDays,
    panelWidth,
    lightLayout
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
