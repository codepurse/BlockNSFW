# AI Text Blocker — training tools

These dev-only tools produce `../text-model.json`, the multilingual adult-text
classifier shipped with the extension. They are **not** bundled into the build.

## What the model is

A hashed character-n-gram + word-token **logistic regression** (FastText
family). It runs in the content script via `shared/text-classifier-core.js`
(pure JS, no TF.js, no `eval`) and scores each page's text for adult content.
Char n-grams make it language-agnostic and robust to morphology/obfuscation,
which is what catches non-English adult sites that keyword/blocklist filtering
misses.

## Quick start (seed model)

```bash
python tools/train_text_classifier.py --bootstrap
```

This builds a synthetic corpus from `seed_data/adult_phrases.txt` (positives)
and `seed_data/benign_snippets.txt` (negatives + hard negatives), trains, prints
held-out precision/recall (overall and per-language), and writes
`../text-model.json`.

> The seed model generalizes well beyond exact substrings, but its accuracy
> ceiling is the synthetic data. For production-grade accuracy, retrain on real
> labeled traffic (below). The runtime code path is identical either way.

## Retraining on real data

Provide JSONL where each line is `{"text": "...", "label": 0|1, "lang": "xx"}`
(`label` 1 = adult, 0 = safe; `lang` optional, used only for per-language
eval):

```bash
python tools/train_text_classifier.py --data adult.jsonl safe.jsonl --out ../text-model.json
```

Useful flags: `--epochs`, `--lr`, `--l2` (regularization), `--keep-top` (max
weights kept after magnitude pruning — controls file size), `--val-split`,
`--version` (bump when the model changes).

Pick the extension's `block` threshold from the printed "precision @
thresholds" table — choose the point with the precision you want (false-positive
budget). Wire it into `getAiTextThresholds()` in `content.js`.

## The hashing invariant (do not break)

`shared/text-classifier-core.js` and `train_text_classifier.py` MUST extract
features identically, or trained weights won't match inference. The contract:

1. Normalize: NFKC, lower-case, collapse whitespace, trim.
2. Char n-grams (n=3..5) over Unicode **code points** of the space-padded
   string, namespaced with `#`.
3. Word unigrams (`$word`) and adjacent bigrams (`$a_b`).
4. Hash = FNV-1a 32-bit over UTF-8 bytes; `bucket = hash % 2^18`.

Regenerate and verify the cross-language parity vectors after any change:

```bash
python tools/train_text_classifier.py --emit-golden tools/seed_data/golden_vectors.json
npm test   # tests/text-classifier-core.test.js asserts JS matches these
```

If you change the feature pipeline or `dim`, bump `--version` and update
`DEFAULT_DIM`/n-gram constants in the JS core to match.
