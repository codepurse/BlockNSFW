# AI Text Blocker — training tools

These dev-only tools produce `../text-model.json`, the multilingual adult-text
classifier shipped with the extension. They are **not** bundled into the build.

## What the model is (format v4)

A hashed character-n-gram + word-token **logistic regression** (FastText
family), run in the content script by `shared/text-classifier-core.js` — pure
JS, no TF.js, no `eval`.

It does not score a page as one bag of words. It scores **~200-character
windows**, each normalised by its own feature count, and a seven-weight **page
model** turns the window scores into one calibrated page probability. The title
and meta tags (`head`) are windowed separately from the visible text (`body`).

Why: v3 summed weights over the whole page, so its score grew with page length.
Every real page scored exactly 0 or 1, the strictness presets did nothing, and
one explicit sentence inside a long ordinary page scored 0. Its vocabulary was
also inverted ("videos" outranked "nude") because it was trained on 1.7-word
adult phrases against 8-word benign sentences.

The model file carries its own thresholds for Relaxed / Balanced / Strict,
chosen on held-out pages. A threshold only means something for the model it
was measured on, so `content.js` uses the model's thresholds over any constant.

## Rebuilding it

```bash
pip install -r tools/requirements.txt

# 1. Build the corpus from Common Crawl (resumable; ~300 MB of downloads).
python tools/text_corpus/build_corpus.py index --index-source cluster
python tools/text_corpus/build_corpus.py fetch
python tools/text_corpus/build_corpus.py stats

# 2. Train, evaluate, export text-model.json, golden vectors and EVAL.md.
python tools/train_text_classifier.py

# 3. Check the JS core still matches the trainer exactly.
npm test
```

### The corpus

`tools/text_corpus/build_corpus.py` collects real page text from Common
Crawl's public archive. Nobody visits any site from your machine: it reads
the archive's index, then range-requests single archived records.

- **Adult** pages come from sites on `data/HOSTS.txt`. A page is only labelled
  adult if its own host is listed.
- **Benign** pages come from `tools/text_corpus/benign_domains.tsv`, a curated
  list weighted toward **trap** categories — sites that share vocabulary with
  adult content but must never be blocked: porn-addiction recovery, sex
  education, sexual health, lingerie, dating, LGBTQ, art, parenting, anatomy.
  Plus a small random sample of the ordinary web.
- Text is extracted the way `content.js` reads a live page: the title, the
  seven meta tags in `AI_TEXT_META_SELECTORS`, and the first 48
  `innerText` lines of at least 12 characters (`page_parts()` mirrors
  `gatherTextForModel()` — change one, change both).

Two index sources: `--index-source server` asks index.commoncrawl.org (about
1 KB per site, but that host is often overloaded and stalls busy clients);
`--index-source cluster` reads the same index from the published files on the
data CDN (a one-off ~100 MB download, then ~0.1 MB per site), with a hard byte
cap.

The corpus lives in `tools/text_corpus/cache/`, which is git-ignored and must
stay that way: it holds adult text and third-party content.

### Splits and the evaluation report

Pages are split by **site**, so the validation and test sets only contain
sites the model never saw — the honest stand-in for "a site the blocklist does
not know yet". Train 70% / validation 15% / test 15% (trap categories
50 / 25 / 25, so the test set holds enough of them to mean something).

- The window model trains on train; the page model is fitted on train through
  5-fold cross-fitting, so each page it learns from was scored by a window
  model that never saw that site.
- Thresholds are chosen on **validation** for a target benign false-positive
  rate per level, and never below the highest-scoring validation trap page.
- `tools/text_corpus/EVAL.md` reports the **test** split only: recall,
  false-positive rate, every benign page blocked at Balanced, per-category
  and per-language results, the dilution case, and the v3 regressions.
  Nothing in it was used to choose anything.

## The parity invariant (do not break)

`shared/text-classifier-core.js` and `train_text_classifier.py` MUST extract
features and score windows identically, or trained weights won't match
inference. The contract is written out at the top of the JS core. The trainer
writes `tools/seed_data/golden_vectors.json` from the model it exports —
normalisation, tokens, window spans, and final page probabilities — and
`tests/text-classifier-core.test.js` asserts the JS reproduces them to 1e-9.

If you change the feature pipeline, the window rules or the page features,
change both files, retrain, and bump `--version`.

## Gotcha: writing escapes into these files

Some editing tools decode `\uXXXX` escapes into the literal characters when
they write a file. The whitespace class in the trainer (`_JS_WS`) must stay
written as escapes; check it with `grep -n "_JS_WS" tools/train_text_classifier.py`
after editing.
