// What turning protection off takes, and a switch for reading page text.
//
// A review: "the wall of text to turn this addon off is annoying too… at least
// let me decide if i want it or not at first setup. Also for people whose
// first language is not English requiring a long wall of text with no
// mistakes in spelling and grammar to disable is literally impossible… i had
// to uninstall the app to disable it", and "Annoying that text detection cant
// be turned off, i installed to get rid of suggestive images not text".
//
// Turning off was the same for everyone: the streak, a reason, and a 164-word
// English sentence typed back exactly. Many people want that, so it stays, as
// the default and for everyone who had BlockNSFW before. Now it's a choice
// (shared/off-lock.js): Simple, Pause first or Strict, and under Strict the
// full sentence, a short one or one of your own in any language, checked
// without counting capitals, punctuation or a few slips. And the scan of a
// page's own words has a switch of its own, offered at setup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OffLock = require('../shared/off-lock.js');
const { loadBackgroundContext } = require('./setup.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not parse ${name}`);
}

// --- The choices ----------------------------------------------------------------

test('Strict and the full sentence are where everyone starts, and stays', () => {
  assert.equal(OffLock.normalizeLevel(undefined), 'strict', 'someone who had BlockNSFW before');
  assert.equal(OffLock.normalizeLevel('nonsense'), 'strict');
  assert.equal(OffLock.normalizeLevel('pause'), 'pause');
  assert.deepEqual({ ...OffLock.normalizeSentence(undefined) }, { kind: 'full' });
  assert.equal(OffLock.sentenceFor(undefined), OffLock.FULL_SENTENCE);
});

test('the full sentence is word for word the one typed before', () => {
  // The exact text that was in options.js until this change.
  assert.equal(OffLock.wordCount(OffLock.FULL_SENTENCE), 164);
  assert.equal(OffLock.FULL_SENTENCE.length, 1056);
  assert.ok(OffLock.FULL_SENTENCE.startsWith('By typing this sentence, I acknowledge that I am consciously choosing'));
  assert.ok(OffLock.FULL_SENTENCE.endsWith('I take complete ownership of whatever follows as a result of this decision.'));
  assert.doesNotMatch(read('options.js'), /COMMITMENT_SENTENCE/, 'one copy only, in shared/off-lock.js');
});

test('your own sentence: long enough, in any language', () => {
  assert.match(OffLock.ownSentenceProblem('Too short to be a pause.'), /at least 30 words/);
  assert.equal(OffLock.ownSentenceProblem(Array(30).fill('palabra').join(' ')), null, '30 words');
  assert.match(OffLock.ownSentenceProblem(Array(29).fill('palabra').join(' ')), /30 words/);
  const chinese = '我选择关闭保护。这是我自己的决定，我会为接下来发生的一切负责。我知道我当初为什么安装它。';
  assert.ok(chinese.replace(/\s/g, '').length >= 40);
  assert.equal(OffLock.ownSentenceProblem(chinese.repeat(2)), null, 'a language written without spaces counts characters');
  assert.match(OffLock.ownSentenceProblem('字'.repeat(59)), /60 characters/);
  assert.match(OffLock.ownSentenceProblem('word '.repeat(400)), /more than 1500 characters/);
  // An unusable stored one is the full sentence, never no sentence.
  assert.deepEqual({ ...OffLock.normalizeSentence({ kind: 'own', text: 'short' }) }, { kind: 'full' });
  const mine = Array(30).fill('mía').join(' ');
  assert.equal(OffLock.sentenceFor({ kind: 'own', text: `  ${mine}  ` }), mine);
});

test('making it easier is loosening; making it harder never is', () => {
  assert.equal(OffLock.isEasierLevel('strict', 'pause'), true);
  assert.equal(OffLock.isEasierLevel('pause', 'simple'), true);
  assert.equal(OffLock.isEasierLevel('simple', 'strict'), false);
  assert.equal(OffLock.isEasierLevel(undefined, 'pause'), true, 'from the default, Strict');
  const own = { kind: 'own', text: Array(30).fill('mine').join(' ') };
  assert.equal(OffLock.sentenceChangeLoosens({ kind: 'full' }, { kind: 'short' }), true);
  assert.equal(OffLock.sentenceChangeLoosens({ kind: 'full' }, own), true);
  assert.equal(OffLock.sentenceChangeLoosens(own, { kind: 'own', text: own.text + ' more' }), true, 'rewriting your own');
  assert.equal(OffLock.sentenceChangeLoosens(own, own), false);
  assert.equal(OffLock.sentenceChangeLoosens({ kind: 'short' }, { kind: 'full' }), false, 'back to the full one is free');
});

// --- The check ------------------------------------------------------------------

test('the sentence is checked for being typed, not for spelling', () => {
  const full = OffLock.FULL_SENTENCE;
  assert.equal(OffLock.matches(full, full), true);
  assert.equal(OffLock.matches(full.toUpperCase().replace(/[,.'-]/g, ''), full), true, 'capitals and punctuation');
  assert.equal(OffLock.matches(full.replace(/ /g, '   '), full), true, 'spacing');
  const slips = (count, every) => {
    const chars = full.split('');
    for (let i = 0; i < count; i++) {
      const at = 40 + i * every;
      chars[at] = chars[at] === 'q' ? 'z' : 'q';
    }
    return chars.join('');
  };
  assert.equal(OffLock.matches(slips(15, 60), full), true, '15 slips in 1,056 characters');
  assert.equal(OffLock.matches(slips(40, 25), full), false, '40 is not typing it');
  assert.equal(OffLock.matches(full.slice(0, 900), full), false, 'every word has to be there');
  assert.equal(OffLock.matches('', full), false);
  assert.equal(OffLock.matches('I don’t want it on', 'I dont want it on.'), true, 'curly and straight apostrophes');
});

test('a sentence in another language is read the same way', () => {
  const spanish = 'Estoy eligiendo apagar la protección que puse para mí. Sé por qué la instalé, y esta decisión es mía.';
  assert.equal(OffLock.matches(spanish.toLowerCase().replace(/[.,]/g, ''), spanish), true);
  assert.equal(OffLock.matches(spanish.replace('protección', 'proteccion'), spanish), true, 'a missing accent is one slip');
  const russian = 'Я выбираю отключить защиту, которую сам установил. Это моё решение, и я за него отвечаю.';
  assert.equal(OffLock.matches(russian.toUpperCase(), russian), true);
  const chinese = '我选择关闭保护。这是我自己的决定，我会为接下来发生的一切负责。';
  assert.equal(OffLock.matches(chinese.replace(/[。，]/g, ' '), chinese), true);
  assert.equal(OffLock.matches('我选择关闭保护', chinese), false);
});

test('the line under the box says how the typing is going', () => {
  const full = OffLock.FULL_SENTENCE;
  assert.equal(OffLock.progress('', full), 'empty');
  assert.equal(OffLock.progress('By typing this', full), 'typing');
  assert.equal(OffLock.progress('by typng this sentnce', full), 'typing', 'a dropped letter is still on track');
  assert.equal(OffLock.progress('hello there', full), 'off', 'the first words aren’t waved through');
  assert.equal(OffLock.progress(full.slice(0, 500) + 'z'.repeat(30), full), 'off', 'more slips than the whole sentence allows');
  assert.equal(OffLock.progress(full, full), 'match');
});

// --- Turning off ----------------------------------------------------------------

test('turning off asks for the chosen steps, after the PIN and access code', () => {
  const options = read('options.js');
  const flow = functionSource(options, 'disableProtectionFlow');
  const pinAt = flow.indexOf("requirePINIfSet('disable blocking', { critical: true })");
  const levelAt = flow.indexOf('OffLock.normalizeLevel(chosen.offLock)');
  assert.ok(pinAt > 0 && levelAt > pinAt, 'the PIN and access code still come first');
  assert.match(flow, /if \(level !== 'simple'\) \{\s*const committed = await showCommitmentGate\(level, OffLock\.sentenceFor\(chosen\.offSentence\)\);/);
  assert.match(flow, /Pact\.isActive\(pact\)[\s\S]{0,200}guardWeakening\('turn protection off'/, 'a Pact’s wait still replaces it all');

  const gate = functionSource(options, 'showCommitmentGate');
  assert.match(gate, /const totalSteps = level === 'strict' \? 3 : 2;/);
  assert.match(gate, /if \(totalSteps === 2\) \{\s*cleanup\(\);\s*resolve\(true\);/, 'Pause first ends after the reason');
  assert.match(gate, /OffLock\.matches\(val, sentence\)/);
  assert.match(gate, /OffLock\.progress\(value, sentence\)/);
  assert.match(gate, /confirmInput\.onpaste = \(e\) => e\.preventDefault\(\);/, 'still typed by hand');
  assert.match(gate, /confirmInput\.ondrop = \(e\) => e\.preventDefault\(\);/);
  assert.match(read('options.html'), /<span class="commitment-total">03<\/span>/);
});

test('in Settings, making it easier asks; making it harder does not', () => {
  const setup = functionSource(read('options.js'), 'setupOffLock');
  assert.match(setup, /OffLock\.isEasierLevel\(from, to\) &&\s*!\(await guardWeakening\('make turning protection off easier', \{ critical: true \}, settingsChange\(\{ offLock: to \}\)\)\)/);
  assert.match(setup, /OffLock\.sentenceChangeLoosens\(settings\.offSentence, to\) &&\s*!\(await guardWeakening\('use a shorter sentence to turn protection off', \{ critical: true \}/);
  assert.match(setup, /OffLock\.ownSentenceProblem\(text\)/);
  assert.match(setup, /guardWeakening\('use your own sentence to turn protection off', \{ critical: true \}/);
  const html = read('options.html');
  const card = html.slice(html.indexOf('id="off-lock-card"'), html.indexOf('<h3 class="group-title">PIN</h3>'));
  for (const value of ['simple', 'pause', 'strict']) assert.match(card, new RegExp(`name="off-lock" value="${value}"`));
  for (const value of ['full', 'short', 'own']) assert.match(card, new RegExp(`name="off-sentence" value="${value}"`));
  assert.match(card, /data-lock="critical" data-lock-when="Making it easier"/);
  assert.match(card, /id="off-own-text"[^>]*maxlength="1500"/);
  assert.ok(html.indexOf('src="shared/off-lock.js"') < html.indexOf('src="options.js"'));
});

test('setup asks, with Strict and the full sentence chosen to start', () => {
  const html = read('onboarding.html');
  const step3 = html.slice(html.indexOf('data-step="3"'), html.indexOf('data-step="4"'));
  assert.match(step3, /Choose how turning it off works\./);
  assert.match(step3, /name="off-lock" value="strict" checked/);
  assert.match(step3, /name="off-sentence" value="full" checked/);
  assert.match(step3, /id="off-own"/);
  assert.match(step3, /id="pin"/, 'the PIN is still asked here');
  assert.ok(html.indexOf('src="shared/off-lock.js"') < html.indexOf('src="onboarding.js"'));

  const js = read('onboarding.js');
  const save = functionSource(js, 'saveOffLockStep');
  assert.match(save, /OffLock\.ownSentenceProblem\(text\)/);
  assert.match(save, /patchSettings\(\{ offLock: level, offSentence: level === 'strict' \? sentence : \{ kind: 'full' \} \}\)/);
  assert.match(functionSource(js, 'goNext'), /if \(!\(await saveOffLockStep\(\)\)\) return;/);
});

// --- Read page text -------------------------------------------------------------

test('the page-text scan has its own switch, not Smart detection\'s', () => {
  const content = read('content.js');
  assert.match(functionSource(content, 'checkPageMetadata'), /if \(!pageTextScanOn\) return false;/);
  assert.match(functionSource(content, 'checkPageBodyText'), /if \(!pageTextScanOn \|\| !document\.body\) return false;/);
  assert.doesNotMatch(functionSource(content, 'checkPageMetadata'), /useSmartBlocking/);
  assert.doesNotMatch(functionSource(content, 'checkPageBodyText'), /useSmartBlocking/);
  const load = functionSource(content, 'loadSettings');
  assert.match(load, /pageTextScanOn = settings\.pageTextScan !== false;/);
  assert.match(load, /anyTextFeatureOn = IS_TOP_FRAME && !!\(pageTextScanOn \|\| aiTextBlocker\);/, 'off means no text is read at all');
  // Smart detection keeps addresses and NSFW communities.
  assert.match(functionSource(content, 'matchesAdultKeywordHost'), /if \(!useSmartBlocking\) return false;/);
});

test('Read page text is on by default, in Settings and setup, guarded going off', () => {
  assert.match(read('background.js'), /\n  pageTextScan: true,/);
  assert.match(read('options.js'), /\n  pageTextScan: true,/);
  const Boost = require('../shared/boost.js');
  assert.equal(Boost.STORM_SETTINGS.pageTextScan, true);
  assert.equal(Boost.RISK_SETTINGS.pageTextScan, true);

  const html = read('options.html');
  const protection = html.slice(html.indexOf('id="section-protection"'), html.indexOf('id="section-customization"'));
  assert.match(protection, /id="page-text-scan"/, 'under Protection, where text detection is looked for');
  assert.match(html, /id="smart-desc">[^<]*Read page text/, 'Smart detection points to it');
  const options = read('options.js');
  const handler = options.slice(options.indexOf("const pageTextToggleEl = $('page-text-scan');"));
  assert.match(handler.slice(0, 700), /guardWeakening\('stop reading page text', \{\}, settingsChange\(\{ pageTextScan: false \}\)\)/);

  const onboarding = read('onboarding.html');
  const step2 = onboarding.slice(onboarding.indexOf('data-step="2"'), onboarding.indexOf('data-step="3"'));
  assert.match(step2, /id="page-text"/);
  assert.match(functionSource(read('onboarding.js'), 'saveAiStep'), /pageTextScan: !!els\.pageText\.checked/);
});

async function runCarry({ settings, previousVersion = '2.0.2', reason = 'update' }) {
  const context = loadBackgroundContext(undefined, (sandbox) => {
    sandbox.VersionCompare = require('../shared/version-compare.js');
  });
  await vm.runInContext('backgroundInitializationPromise', context);
  const writes = [];
  context.chrome.runtime.getManifest = () => ({ version: '2.0.3' });
  context.chrome.storage.local.get = () => Promise.resolve({ pblocker_settings: settings });
  context.chrome.storage.local.set = (items) => { writes.push(JSON.parse(JSON.stringify(items))); return Promise.resolve(); };
  const carried = await context.carryPageTextChoice({ reason, previousVersion });
  return { carried, writes };
}

test('someone who had Smart detection off keeps page text off after the update', async () => {
  const off = await runCarry({ settings: { useSmartBlocking: false } });
  assert.equal(off.carried, true);
  assert.equal(off.writes[0].pblocker_settings.pageTextScan, false);
  assert.equal(off.writes[0].pblocker_settings.useSmartBlocking, false);

  for (const run of [
    { settings: { useSmartBlocking: true } },
    { settings: { useSmartBlocking: false, pageTextScan: false } },
    { settings: { useSmartBlocking: false }, previousVersion: '2.0.3' },
    { settings: { useSmartBlocking: false }, reason: 'install' }
  ]) {
    const { carried, writes } = await runCarry(run);
    assert.equal(carried, false, JSON.stringify(run));
    assert.equal(writes.length, 0, JSON.stringify(run));
  }
});
