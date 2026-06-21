#!/usr/bin/env python3
"""Train the multilingual AI Text Blocker model (hashed char-n-gram logistic
regression) and export text-model.json for the browser extension.

The feature hashing here MUST stay byte-for-byte identical to
shared/text-classifier-core.js (see the HASHING INVARIANT comment there). The
golden-vector parity test (tests/text-classifier-core.test.js +
`--emit-golden`) guards this.

Pure standard library — no numpy/sklearn — so `--bootstrap` runs anywhere.

Usage:
  # Train the seed model from the bundled lexicon and write ../text-model.json
  python tools/train_text_classifier.py --bootstrap

  # Train on real labeled data (JSONL: {"text": "...", "label": 0|1, "lang": "xx"})
  python tools/train_text_classifier.py --data mydata.jsonl --out ../text-model.json

  # Regenerate the golden parity vectors consumed by the JS test
  python tools/train_text_classifier.py --emit-golden tools/seed_data/golden_vectors.json
"""

import argparse
import json
import math
import os
import random
import re
import sys
import unicodedata

DIM = 1 << 18          # 262144 — must equal DEFAULT_DIM in the JS core
NGRAM_MIN = 3
NGRAM_MAX = 5
FNV_OFFSET = 0x811c9dc5
FNV_PRIME = 0x01000193

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_DIR = os.path.join(HERE, "seed_data")
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "text-model.json"))

_WS_RE = re.compile(r"\s+")


# --------------------------------------------------------------------------
# Feature pipeline — mirrors shared/text-classifier-core.js exactly.
# --------------------------------------------------------------------------
def normalize(text):
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text).lower()
    s = _WS_RE.sub(" ", s).strip()
    return s


def fnv1a32(data):
    h = FNV_OFFSET
    for byte in data:
        h ^= byte
        h = (h * FNV_PRIME) & 0xFFFFFFFF
    return h


def hash_feature(feature_str, dim=DIM):
    return fnv1a32(feature_str.encode("utf-8")) % dim


def extract_features(norm, dim=DIM, nmin=NGRAM_MIN, nmax=NGRAM_MAX):
    """Return dict {bucket: count}. Char n-grams over code points of the
    space-padded string, plus word unigrams and adjacent bigrams."""
    feats = {}

    def add(fs):
        b = hash_feature(fs, dim)
        feats[b] = feats.get(b, 0) + 1

    if norm:
        cps = list(" " + norm + " ")  # code points, matches JS Array.from
        for n in range(nmin, nmax + 1):
            if len(cps) < n:
                break
            for i in range(0, len(cps) - n + 1):
                add("#" + "".join(cps[i:i + n]))
        words = norm.split(" ")
        for wi, w in enumerate(words):
            if not w:
                continue
            add("$" + w)
            if wi + 1 < len(words) and words[wi + 1]:
                add("$" + w + "_" + words[wi + 1])
    return feats


def features_for(text):
    return extract_features(normalize(text))


# --------------------------------------------------------------------------
# Seed corpus generation (--bootstrap)
# --------------------------------------------------------------------------
def read_sectioned(path):
    """Parse a seed_data file with '## lang' section headers. Returns list of
    (text, lang)."""
    out = []
    lang = "xx"
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            if line.startswith("## "):
                lang = line[3:].strip() or "xx"
                continue
            if line.startswith("#"):
                continue
            out.append((line, lang))
    return out


# Templates intentionally carry NO generic boilerplate: wrapping adult phrases
# in words like "watch/free/online/hd/download" would teach the model that
# ordinary video/English words are adult and cause false positives on benign
# sites. The adult signal lives in the phrases themselves (adult_phrases.txt
# already contains "free porn", "watch porn online", etc.), so we just repeat
# the inserted text to emphasize its own n-grams. Positives and negatives use
# symmetric templates so only the inserted content differs.
POSITIVE_TEMPLATES = [
    "{p}",
    "{p} {p}",
    "{p} {p} {p}",
]

NEGATIVE_TEMPLATES = [
    "{s}",
    "{s} {s}",
]

LEET = str.maketrans({"o": "0", "i": "1", "e": "3", "a": "@", "s": "$"})


def obfuscate(phrase):
    """Generate a couple of obfuscated variants of an ASCII phrase to teach
    robustness (spaced letters, leetspeak). Non-ASCII phrases are returned
    unchanged."""
    variants = []
    if phrase.isascii():
        variants.append(" ".join(list(phrase.replace(" ", ""))))  # p o r n o
        variants.append(phrase.translate(LEET))                   # p0rn0
    return variants


# Synthetic hard negatives. The seed lexicon has no numbers, dates, prices,
# navigation/UI boilerplate, or short fragments, so any page made mostly of
# those used to fall back to the (high) bias and be flagged as adult — the
# "nsfw april 16 español" false-positive class. These teach the model that such
# content is neutral so it stops leaning on the bias.
NUMERIC_NEGATIVES = [
    "16", "42", "7", "100", "365", "1999", "2024", "2025",
    "1 2 3 4 5", "12 34 56 78", "0 1 2 3 4 5 6 7 8 9",
    "april 16", "april 16 2024", "16 april 2024", "january 1 2025",
    "31 december 2023", "monday 5 may", "friday the 13th",
    "page 16", "page 16 of 32", "chapter 7", "section 3 2 1",
    "12 30 pm", "10 00 am", "9 99", "19 99", "1 299 00",
    "version 2 1 0", "no 7", "step 1 step 2 step 3",
    "january february march april may june july august",
    "september october november december",
    "monday tuesday wednesday thursday friday saturday sunday",
]
NAV_NEGATIVES = [
    "home about contact", "sign in sign up", "log in register",
    "next previous page", "read more", "click here to continue",
    "terms of service privacy policy", "menu search login",
    "page not found error 404", "loading please wait",
    "subscribe to our newsletter", "share tweet like follow",
    "back to top", "view all results", "add to cart checkout",
    "search results for your query", "filter sort by relevance",
    "copyright all rights reserved", "cookie settings accept decline",
    "download the app on your phone", "create an account today",
    "forgot your password reset it", "edit profile settings logout",
    "comments replies sort newest", "show more show less",
]
SHORT_NEGATIVES = [
    "hello", "welcome", "thank you", "good morning", "okay", "yes no maybe",
    "hello world", "about us", "contact us", "frequently asked questions",
    "how to get started", "learn more today", "join the community",
]


def synthetic_hard_negatives():
    out = []
    for t in NUMERIC_NEGATIVES:
        out.append((t, "num"))
    for t in NAV_NEGATIVES:
        out.append((t, "nav"))
    for t in SHORT_NEGATIVES:
        out.append((t, "short"))
    return out


def build_bootstrap_corpus(seed=1234):
    rng = random.Random(seed)
    samples = []  # (text, label, lang)

    phrases = read_sectioned(os.path.join(SEED_DIR, "adult_phrases.txt"))
    snippets = read_sectioned(os.path.join(SEED_DIR, "benign_snippets.txt"))

    for phrase, lang in phrases:
        for tpl in POSITIVE_TEMPLATES:
            samples.append((tpl.format(p=phrase), 1, lang))
        for ob in obfuscate(phrase):
            samples.append((ob, 1, lang))

    for snippet, lang in snippets:
        for tpl in NEGATIVE_TEMPLATES:
            samples.append((tpl.format(s=snippet), 0, lang))

    # Hard negatives (numbers/dates/nav/short) — see comment above.
    for text, lang in synthetic_hard_negatives():
        for tpl in NEGATIVE_TEMPLATES:
            samples.append((tpl.format(s=text), 0, lang))

    # Short benign fragments cut from real snippets: the positives are short
    # phrases, so without short negatives the model learns "short text -> adult".
    for snippet, lang in snippets:
        words = snippet.split()
        if len(words) >= 4:
            samples.append((" ".join(words[:3]), 0, lang))
            samples.append((" ".join(words[-3:]), 0, lang))

    # Mix benign snippets into longer "pages" to resemble real negative pages.
    benign_texts = [s for s, _ in snippets]
    for _ in range(len(phrases) * 3):
        chunk = " ".join(rng.sample(benign_texts, min(4, len(benign_texts))))
        samples.append((chunk, 0, "mix"))

    rng.shuffle(samples)
    return samples


def read_jsonl(paths):
    samples = []
    for path in paths:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                text = obj.get("text", "")
                label = int(obj.get("label", 0))
                lang = obj.get("lang", "xx")
                if text:
                    samples.append((text, label, lang))
    return samples


# --------------------------------------------------------------------------
# Logistic regression (plain SGD with L2)
# --------------------------------------------------------------------------
def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def train(samples, epochs=12, lr=0.25, l2=1e-6, seed=42, verbose=True):
    rng = random.Random(seed)
    feats_cache = [(features_for(t), y) for (t, y, _lang) in samples]

    # Class weights so a pos/neg count imbalance does not bias the model (and
    # the bias term) toward the majority class — the main false-positive lever.
    n_pos = sum(1 for _, y in feats_cache if y == 1) or 1
    n_neg = sum(1 for _, y in feats_cache if y == 0) or 1
    total = n_pos + n_neg
    cw = {1: total / (2.0 * n_pos), 0: total / (2.0 * n_neg)}

    weights = {}
    bias = 0.0
    order = list(range(len(feats_cache)))
    for epoch in range(epochs):
        rng.shuffle(order)
        cur_lr = lr / (1.0 + 0.3 * epoch)  # simple decay
        loss = 0.0
        for idx in order:
            feats, y = feats_cache[idx]
            sw = cw[y]
            z = bias
            for b, c in feats.items():
                w = weights.get(b)
                if w:
                    z += w * c
            p = sigmoid(z)
            g = (p - y) * sw
            loss += sw * -(y * math.log(p + 1e-12) + (1 - y) * math.log(1 - p + 1e-12))
            bias -= cur_lr * g
            for b, c in feats.items():
                grad = g * c + l2 * weights.get(b, 0.0)
                weights[b] = weights.get(b, 0.0) - cur_lr * grad
        if verbose:
            print(f"  epoch {epoch + 1}/{epochs}  avg_loss={loss / len(feats_cache):.4f}  "
                  f"nz_weights={len(weights)}", file=sys.stderr)
    return weights, bias


# --------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------
def predict_z(text, weights, bias):
    feats = features_for(text)
    z = bias
    for b, c in feats.items():
        w = weights.get(b)
        if w:
            z += w * c
    return z


def calibrate_bias(samples, weights, bias, target_prob=0.5, neg_percentile=0.98):
    """Recenter the bias so that `neg_percentile` of NEGATIVE samples score below
    `target_prob`. SGD with a short, length-asymmetric corpus tends to park a
    large positive bias (so anything without learned benign features defaults to
    'adult'). This is a Platt-style shift of the decision boundary only — it does
    not touch feature weights, so relative ranking is unchanged; it just fixes
    where the global threshold sits. Returns the adjusted bias."""
    neg_z = sorted(predict_z(t, weights, bias) for (t, y, _l) in samples if y == 0)
    if not neg_z:
        return bias
    idx = min(len(neg_z) - 1, max(0, int(neg_percentile * len(neg_z))))
    z_at_p = neg_z[idx]
    # want sigmoid(z_at_p + delta) = target_prob
    logit_target = math.log(target_prob / (1.0 - target_prob))
    delta = logit_target - z_at_p
    return bias + delta


# --------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------
def predict_prob(text, weights, bias):
    return sigmoid(predict_z(text, weights, bias))


def evaluate(samples, weights, bias, threshold=0.5):
    tp = fp = tn = fn = 0
    per_lang = {}
    for text, y, lang in samples:
        p = predict_prob(text, weights, bias)
        pred = 1 if p >= threshold else 0
        if y == 1 and pred == 1:
            tp += 1
        elif y == 0 and pred == 1:
            fp += 1
        elif y == 0 and pred == 0:
            tn += 1
        else:
            fn += 1
        d = per_lang.setdefault(lang, [0, 0, 0, 0])  # tp, fp, tn, fn
        if y == 1 and pred == 1:
            d[0] += 1
        elif y == 0 and pred == 1:
            d[1] += 1
        elif y == 0 and pred == 0:
            d[2] += 1
        else:
            d[3] += 1
    return (tp, fp, tn, fn), per_lang


def prf(tp, fp, tn, fn):
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    acc = (tp + tn) / (tp + fp + tn + fn) if (tp + fp + tn + fn) else 0.0
    return prec, rec, f1, acc


# --------------------------------------------------------------------------
# Prune + quantize + write model
# --------------------------------------------------------------------------
def prune_and_quantize(weights, keep_top, min_abs=1e-4):
    items = [(b, w) for b, w in weights.items() if abs(w) >= min_abs]
    items.sort(key=lambda kv: abs(kv[1]), reverse=True)
    if keep_top and len(items) > keep_top:
        items = items[:keep_top]
    if not items:
        return 1.0, []
    max_abs = max(abs(w) for _, w in items)
    scale = max_abs / 127.0 if max_abs > 0 else 1.0
    quantized = []
    for b, w in items:
        q = int(round(w / scale))
        q = max(-127, min(127, q))
        if q != 0:
            quantized.append([b, q])
    quantized.sort(key=lambda kv: kv[0])
    return scale, quantized


def write_model(path, weights, bias, scale, quantized, version):
    model = {
        "version": version,
        "format": "fnv1a-char-ngram-logreg-v1",
        "dim": DIM,
        "ngramMin": NGRAM_MIN,
        "ngramMax": NGRAM_MAX,
        "bias": bias,
        "scale": scale,
        "weights": quantized,
        "note": "Generated by tools/train_text_classifier.py. Do not hand-edit.",
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(model, fh, ensure_ascii=False, separators=(",", ":"))
    return model


# --------------------------------------------------------------------------
# Golden vectors for cross-language parity testing
# --------------------------------------------------------------------------
GOLDEN_FEATURE_STRINGS = [
    "#abc", "#por", "#orn", "$porno", "$free_porn",
    "#色情", "#порн", "$секс", "#エロ動", "#야동",
]
GOLDEN_TEXTS = [
    "Free Porn Video",
    "Sex education for teens",
    "порно онлайн",
    "无码视频 高清",
    "p o r n o",
]


def emit_golden(path):
    hashes = [{"s": s, "bucket": hash_feature(s, DIM)} for s in GOLDEN_FEATURE_STRINGS]
    extractions = []
    for t in GOLDEN_TEXTS:
        feats = features_for(t)
        extractions.append({
            "text": t,
            "norm": normalize(t),
            "buckets": {str(b): c for b, c in sorted(feats.items())},
        })
    payload = {
        "dim": DIM,
        "ngramMin": NGRAM_MIN,
        "ngramMax": NGRAM_MAX,
        "hashes": hashes,
        "extractions": extractions,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"Wrote golden vectors -> {path}", file=sys.stderr)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bootstrap", action="store_true",
                    help="Train the seed model from bundled seed_data lexicons.")
    ap.add_argument("--data", nargs="*", default=None,
                    help="JSONL file(s) of {text,label,lang} for real-data training.")
    ap.add_argument("--out", default=DEFAULT_OUT, help="Output model path.")
    ap.add_argument("--emit-golden", default=None,
                    help="Write golden parity vectors to this path and exit.")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--lr", type=float, default=0.25)
    ap.add_argument("--l2", type=float, default=1e-6)
    ap.add_argument("--no-calibrate", action="store_true",
                    help="Skip post-training bias calibration (not recommended).")
    ap.add_argument("--cal-neg-percentile", type=float, default=0.98,
                    help="Fraction of negatives to keep below --cal-target-prob.")
    ap.add_argument("--cal-target-prob", type=float, default=0.5,
                    help="Probability the calibrated negative percentile maps to.")
    ap.add_argument("--keep-top", type=int, default=60000,
                    help="Keep at most this many largest-magnitude weights.")
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    if args.emit_golden:
        emit_golden(args.emit_golden)
        return 0

    if args.bootstrap:
        print("Building bootstrap corpus from seed_data ...", file=sys.stderr)
        samples = build_bootstrap_corpus(seed=args.seed)
    elif args.data:
        print(f"Reading data from {args.data} ...", file=sys.stderr)
        samples = read_jsonl(args.data)
    else:
        ap.error("Provide --bootstrap or --data (or --emit-golden).")
        return 2

    if not samples:
        print("No samples to train on.", file=sys.stderr)
        return 1

    rng = random.Random(args.seed)
    rng.shuffle(samples)
    n_val = int(len(samples) * args.val_split)
    val = samples[:n_val]
    train_set = samples[n_val:] or samples
    pos = sum(1 for _, y, _ in train_set if y == 1)
    print(f"Samples: {len(samples)} total, {len(train_set)} train "
          f"({pos} pos / {len(train_set) - pos} neg), {len(val)} val", file=sys.stderr)

    weights, bias = train(train_set, epochs=args.epochs, lr=args.lr,
                          l2=args.l2, seed=args.seed)

    if not args.no_calibrate:
        raw_bias = bias
        # Calibrate on the held-out split when available, else the training set.
        cal_set = val or train_set
        bias = calibrate_bias(cal_set, weights, bias,
                              target_prob=args.cal_target_prob,
                              neg_percentile=args.cal_neg_percentile)
        print(f"Calibrated bias: {raw_bias:.3f} -> {bias:.3f} "
              f"(neg p{int(args.cal_neg_percentile * 100)} -> p={args.cal_target_prob})",
              file=sys.stderr)

    eval_set = val or train_set
    overall, per_lang = evaluate(eval_set, weights, bias, threshold=0.5)
    prec, rec, f1, acc = prf(*overall)
    print("\n=== Held-out evaluation (threshold 0.5) ===", file=sys.stderr)
    print(f"  precision={prec:.3f} recall={rec:.3f} f1={f1:.3f} acc={acc:.3f} "
          f"(tp={overall[0]} fp={overall[1]} tn={overall[2]} fn={overall[3]})",
          file=sys.stderr)
    print("  per-language (precision/recall):", file=sys.stderr)
    for lang in sorted(per_lang):
        p2, r2, _f, _a = prf(*per_lang[lang])
        print(f"    {lang:>8}: P={p2:.2f} R={r2:.2f}", file=sys.stderr)

    # Report precision at a few operating points to pick block thresholds.
    print("  precision @ thresholds:", file=sys.stderr)
    for thr in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
        ov, _ = evaluate(eval_set, weights, bias, threshold=thr)
        p3, r3, _f, _a = prf(*ov)
        print(f"    thr={thr:.2f}  P={p3:.3f} R={r3:.3f}", file=sys.stderr)

    scale, quantized = prune_and_quantize(weights, args.keep_top)
    write_model(args.out, weights, bias, scale, quantized, args.version)
    size_kb = os.path.getsize(args.out) / 1024.0
    print(f"\nWrote model -> {args.out}  ({len(quantized)} weights, {size_kb:.1f} KB)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
