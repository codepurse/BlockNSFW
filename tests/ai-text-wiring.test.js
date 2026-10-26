// How content.js drives the AI Text Blocker: runs the real gatherTextForModel,
// getAiTextThresholds and checkPageTextWithModel from content.js against the
// real shipped model, with the page and the rest of the extension stubbed.
//
// text-classifier-core.test.js proves the model scores text correctly; this
// proves content.js hands it the right text, uses the model's own thresholds,
// and acts on the verdict. Two things here guard real regressions:
//
//  - Text alone blocks. Until model v4, a temporary catch downgraded every
//    text-only block to "allow" because the v3 model could not be trusted on
//    its own. The catch is gone; if it comes back, the detector silently
//    stops doing anything without the image filter.
//  - The model's thresholds win over the constants in content.js. A threshold
//    only means something for the model it was measured on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const TC = require('../shared/text-classifier-core.js');
const MODEL = TC.loadModel(JSON.parse(fs.readFileSync(path.join(ROOT, 'text-model.json'), 'utf8')));

function contentFunctionSource(name) {
  const start = CONTENT_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in content.js`);
  let depth = 0;
  for (let index = CONTENT_SOURCE.indexOf('{', start); index < CONTENT_SOURCE.length; index++) {
    if (CONTENT_SOURCE[index] === '{') depth++;
    if (CONTENT_SOURCE[index] === '}') depth--;
    if (depth === 0) return CONTENT_SOURCE.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

function contentConst(name) {
  const m = CONTENT_SOURCE.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\r?\\n`));
  assert.ok(m, `${name} should exist in content.js`);
  return m[1];
}

// A page: title, meta contents, visible lines, and what the AI image blocker
// found on it ({ checked, blocked }). Returns what the extension did.
function runScan({ title = '', metas = [], lines = [], strictness = 'balanced', images = { checked: 0, blocked: 0 }, model = MODEL }) {
  const redirects = [];
  const sandbox = {
    TextClassifier: TC,
    textModel: model,
    textModelReady: !!model,
    textScanPending: false,
    isEnabled: true,
    aiTextBlocker: true,
    blockedTriggered: false,
    aiTextStrictness: strictness,
    debugMode: false,
    document: {
      title,
      body: {},
      querySelectorAll: () => metas.map(content => ({ getAttribute: () => content })),
    },
    window: { AIImageBlocker: { pageEvidence: () => ({ ...images }) } },
    getSearchEngine: () => null,
    isExtensionStorePage: () => false,
    isLocalPage: () => false,
    ensureTextModelLoaded: () => {},
    getPageTextLinesForScan: () => lines.slice(),
    log: () => {},
    notifyBackground: () => {},
    redirectToBlockedPage: (reason, detail) => redirects.push({ reason, detail }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const MIN_TEXT_TOKENS_FOR_BLOCK = ${contentConst('MIN_TEXT_TOKENS_FOR_BLOCK')};
    const AI_TEXT_META_SELECTORS = ${contentConst('AI_TEXT_META_SELECTORS')};
    ${contentFunctionSource('getAiTextThresholds')}
    ${contentFunctionSource('gatherTextForModel')}
    ${contentFunctionSource('getAiImageEvidence')}
    ${contentFunctionSource('checkPageTextWithModel')}
    this.result = checkPageTextWithModel();
    this.thresholds = getAiTextThresholds(aiTextStrictness);
    this.parts = gatherTextForModel();
  `, sandbox);
  return { blocked: sandbox.result, redirects, thresholds: sandbox.thresholds, parts: sandbox.parts };
}

const ADULT = {
  title: 'Free XXX Porn Videos - Hardcore Sex Tube',
  metas: ['Watch free porn videos, hardcore sex and naked milf xxx clips updated daily.'],
  lines: [
    'Hot amateur porn videos and hardcore sex movies with naked girls',
    'Big tits milf fucked hard in this free xxx video, anal and blowjob clips',
    'Join now for full length HD porn and live sex cams, 18+ only',
  ],
};

test('title and meta tags travel separately from the visible text', () => {
  const { parts } = runScan(ADULT);
  assert.equal(parts.head, ADULT.title + ' ' + ADULT.metas[0]);
  assert.equal(parts.body, ADULT.lines.join(' '));
});

test('an explicit page is blocked on text alone, with no image flagged', () => {
  const { blocked, redirects } = runScan({ ...ADULT, images: { checked: 0, blocked: 0 } });
  assert.equal(blocked, true, 'text-only blocking must work: the v3 safety catch is gone');
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].reason, 'ai_text_scan');
  assert.ok(redirects[0].detail.score >= TC.thresholdsFor(MODEL, 'balanced').block);
  assert.ok(redirects[0].detail.matched.length > 0, 'the blocked page should be told which words drove it');
});

test('a porn-recovery page is not blocked, even at Strict', () => {
  const { blocked, redirects } = runScan({
    title: 'How to quit porn: a 90-day recovery plan',
    metas: ['Practical steps to beat porn addiction, rebuild trust and stay accountable.'],
    lines: [
      'Porn addiction is real, and recovery is possible. Here is what worked for thousands of our members.',
      'Install a blocker, find an accountability partner, and track your streak of porn-free days.',
      'When an urge hits, leave the room, call a friend, or go for a walk until it passes.',
      'Relapse is part of many recovery stories. What matters is what you do the day after.',
    ],
    strictness: 'strict',
  });
  assert.equal(blocked, false);
  assert.equal(redirects.length, 0);
});

test('a page that just talks about videos is not blocked, even at Strict', () => {
  const { blocked } = runScan({
    title: 'Easy Recipe Videos | Home Cooking',
    metas: ['Watch our cooking videos: quick dinners, baking videos and video tutorials.'],
    lines: [
      'New recipe videos every week from our test kitchen, with step by step video guides.',
      'Watch the most popular videos: pasta, curry, sourdough bread and birthday cakes.',
      'Subscribe to get new cooking videos and meal plans straight to your inbox.',
    ],
    strictness: 'strict',
  });
  assert.equal(blocked, false);
});

// The 2026-10 YouTube report: at Strict, Spanish music and anime videos were
// blocked outright. The page's text scores in the fuse zone (Spanish function
// words weigh too much), and the image model read two anime thumbnails in the
// related column as "Hentai". One blurred image was enough to fuse. This is
// that watch page, with the commenters' names left out.
const YOUTUBE_AMV_ES = {
  title: 'Still Worth Fighting For Sub Español - My Darkest Days [AMV] - YouTube',
  metas: [
    'Still Worth Fighting For Sub Español - My Darkest Days [AMV]',
    'Si te gustó el video dale ME GUSTA, COMENTA y SUSCRÍBETE!!! AMV sin subtitulos',
    'My Darkest Days, AMV, Anime, Anime Music Video, Sub, Esp, Español, Subtitulado, Still Worth Fighting For, Kyoukai no Kanata, Hard Rock, Rock Alternativo',
  ],
  lines: [
    'Skip navigation',
    'Still Worth Fighting For Sub Español - My Darkest Days [AMV]',
    '90.8K subscribers',
    '564K views 9y ago',
    'Si te gustó el video dale ME GUSTA, COMENTA y SUSCRÍBETE!!!',
    'AMV sin subtitulos: • Kyoukai no Kanata [AMV] - Still Worth Figh...',
    '110 Comments',
    'Add a comment...',
    '6 months ago',
    'Algun superviviente en 2026??',
    'Es tan difícil dejarte ir y todavía sigo escuchando el sonido de tu voz cantando en mi cabeza, no puedo rendirme porque la cuerda se rompe lentamente, pero aún cuelga de un hilo, así que mira mis ojos una última vez',
    'Like si estas escuchando este maravilloso amv en el 2020',
    'Este amv me ayudó a volver con mi novia y cuando tenemos problemas lo escuchamos juntos',
    '2:28 empieza la mejor parte',
    'Dediqué este video una vez y ahora tiene una carga emocional para mi. Aún así amo esta canción.',
    'No superó este video. Y la canción me encanta.',
    'STILL WORTH FIGHTING FOR | Dragon Ball Z | [MEP/AMV]',
    'Fallen Angel-Three Days Grace (sub español).',
    'Jujutsu Kaisen AMV | AIZO by King Gnu',
    'ANIME OPENINGS MIX FULL SONGS | MOST VIEWED OPENINGS',
    'My Darkest Days - Still Worth Fighting For (Lyrics)',
    'Start Again Sub Español - Red [AMV]',
    'Anime Openings You\'ll Never Skip',
    'My Darkest Days - Without You |ESPAÑOL|',
    'Asta & Yami Vs. Dante ~ Black Clover「AMV」- Centuries',
  ],
};

test('a YouTube watch page is not blocked over two misread thumbnails, even at Strict', () => {
  const { blocked, redirects } = runScan({
    ...YOUTUBE_AMV_ES,
    strictness: 'strict',
    images: { checked: 58, blocked: 2 },
  });
  assert.equal(blocked, false, 'two blurred thumbnails of other videos say nothing about this page');
  assert.equal(redirects.length, 0);
});

// A page whose text alone is borderline, so the images decide.
const BORDERLINE = {
  title: 'Sexy lingerie try on haul - hot models in lace',
  metas: ['Watch our hottest models try on sexy see-through lingerie and tiny bikinis.'],
  lines: [
    'Sexy lingerie try on haul with our hottest models',
    'See-through lace bodysuits, tiny thongs and sheer stockings',
    'Watch the full video for more hot try on clips',
    'Subscribe for new sexy try on hauls every week',
  ],
};

test('the borderline page sits in the Strict fuse zone, so the images decide', () => {
  // If a retrained model moves it out of the zone, the two tests below stop
  // testing the image rule: pick new text rather than delete them. (The YouTube
  // page above may leave the zone downwards once the Spanish bias is fixed;
  // its test still holds then.)
  const strict = TC.thresholdsFor(MODEL, 'strict');
  const prob = TC.scorePage({ head: [BORDERLINE.title, ...BORDERLINE.metas].join(' '), body: BORDERLINE.lines.join(' ') }, MODEL).prob;
  assert.ok(prob >= strict.fuse && prob < strict.block, prob.toFixed(3));
});

test('a borderline page is blocked when most of its own images are blurred', () => {
  const { blocked, redirects } = runScan({
    ...BORDERLINE,
    strictness: 'strict',
    images: { checked: 12, blocked: 9 },
  });
  assert.equal(blocked, true);
  assert.equal(redirects[0].reason, 'ai_text_scan');
});

test('a borderline page with only a stray blurred image or two is not', () => {
  for (const images of [{ checked: 40, blocked: 1 }, { checked: 40, blocked: 2 }, { checked: 2, blocked: 2 }]) {
    const { blocked } = runScan({ ...BORDERLINE, strictness: 'strict', images });
    assert.equal(blocked, false, JSON.stringify(images));
  }
});

test('without the AI image blocker there is no corroboration, and no error', () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(`${contentFunctionSource('getAiImageEvidence')}\nthis.ev = getAiImageEvidence();`, sandbox);
  assert.deepEqual({ ...sandbox.ev }, { checked: 0, blocked: 0 });
});

test('a page under the evidence floor is never scored, however explicit', () => {
  const { blocked } = runScan({ title: 'porn xxx sex', metas: [], lines: [] });
  assert.equal(blocked, false);
});

test('the model\'s own thresholds are used, for every level', () => {
  for (const level of ['relaxed', 'balanced', 'strict']) {
    const { thresholds } = runScan({ ...ADULT, strictness: level });
    const own = TC.thresholdsFor(MODEL, level);
    assert.equal(thresholds.block, own.block, `${level} block`);
    assert.equal(thresholds.fuse, own.fuse, `${level} fuse`);
  }
});

test('loading the shipped model succeeds cleanly and runs the scan that was waiting for it', async () => {
  // Its "ready" log line read v3's `m.weights.size`, which v4 does not have.
  // The model was already marked ready when that threw, so scanning still
  // worked -- but every page load threw and logged "model load failed".
  const modelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'text-model.json'), 'utf8'));
  const logs = [];
  let deferredRuns = 0;
  const sandbox = {
    TextClassifier: TC,
    textModel: null, textModelReady: false, textModelLoading: false, textModelFailed: false,
    textScanPending: true,
    browserAPI: { runtime: { getURL: p => 'chrome-extension://test/' + p } },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(modelJson) }),
    log: (...args) => logs.push(args.map(String).join(' ')),
    runDeferredTextScan: () => { deferredRuns++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${contentFunctionSource('ensureTextModelLoaded')}\nensureTextModelLoaded();`, sandbox);
  for (let i = 0; i < 20 && sandbox.textModelLoading; i++) await new Promise(r => setImmediate(r));
  assert.equal(sandbox.textModelReady, true);
  assert.equal(sandbox.textModelFailed, false);
  assert.ok(!logs.some(l => l.includes('load failed')), `unexpected: ${logs.join(' | ')}`);
  assert.equal(deferredRuns, 1, 'the scan requested before the model loaded must run once it has');
});

test('without a model the scan does nothing and the constants remain as a fallback', () => {
  const { blocked, thresholds } = runScan({ ...ADULT, model: null });
  assert.equal(blocked, false);
  assert.ok(thresholds.block > 0 && thresholds.block < 1);
});
