#!/usr/bin/env python3
"""Train the AI Text Blocker model (format v4) and export text-model.json.

The model is a hashed char-n-gram + word-token logistic regression that scores
~200-character WINDOWS of a page, plus a seven-weight page model that turns
the window scores into one calibrated page probability. Everything in the
"feature pipeline" section must stay identical to shared/text-classifier-core.js
(see the PARITY INVARIANT there); golden vectors pin it in both languages.

Data: pages built by tools/text_corpus/build_corpus.py from Common Crawl,
labelled by the blocklist (adult) and a curated benign list. Pages are split
by SITE, so validation and test only ever contain sites the model has never
seen -- the honest stand-in for "a site the blocklist does not know yet".

  train  70% of sites  -- window model; page model via 5-fold cross-fitting
  val    15% of sites  -- hyper-parameters and the shipped thresholds
  test   15% of sites  -- the graduation report; never used to choose anything

Trap categories (sex education, recovery, health, lingerie, ...) are split
50/25/25 instead, so the test set holds enough of them to mean something.

Usage:
  pip install -r tools/requirements.txt
  python tools/train_text_classifier.py                 # train, evaluate, export
  python tools/train_text_classifier.py --grid          # also search alpha/C on val
"""

import argparse
import base64
import hashlib
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict

import numpy as np
from scipy import sparse
from sklearn.linear_model import LogisticRegression

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "text_corpus"))
import build_corpus  # noqa: E402  (page_parts mirrors content.js)

DEFAULT_OUT = os.path.join(REPO, "text-model.json")
GOLDEN_PATH = os.path.join(HERE, "seed_data", "golden_vectors.json")
PAGES_PATH = os.path.join(HERE, "text_corpus", "cache", "pages.jsonl")
REPORT_PATH = os.path.join(HERE, "text_corpus", "EVAL.md")

FORMAT = "fnv1a-token-ngram-window-v4"
DIM = 1 << 18
NGRAM_MIN = 3
NGRAM_MAX = 5
MAX_TOKEN_LEN = 24
FNV_OFFSET = 0x811C9DC5
FNV_PRIME = 0x01000193
Z_CLIP = 12.0
Z_CONFIDENT = 2.2
PAGE_FEATURES = ["head_max", "has_head", "body_top1", "body_top3_mean",
                 "body_frac_pos", "body_frac_confident", "log_body_windows"]

# Strictness -> the false-positive rate on held-out benign pages each level is
# allowed. `block` acts on text alone; `fuse` needs the image filter to have
# flagged something on the same page as well, so it can afford to be looser.
FPR_TARGETS = {
    "relaxed": {"block": 0.002, "fuse": 0.02},
    "balanced": {"block": 0.005, "fuse": 0.04},
    "strict": {"block": 0.015, "fuse": 0.08},
}


# --------------------------------------------------------------------------
# Feature pipeline -- mirrors shared/text-classifier-core.js exactly.
# --------------------------------------------------------------------------
# JS \s: WhiteSpace + LineTerminator. Python's \s differs (it matches
# \x1c-\x1f and not \ufeff), so spell the JS set out.
_JS_WS = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def normalize(text):
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text).lower()
    s = "".join(" " if unicodedata.category(ch)[0] in "PS" else ch for ch in s)
    return _JS_WS.sub(" ", s).strip(" ")


def tokenize(norm, max_len=MAX_TOKEN_LEN):
    out = []
    if not norm:
        return out
    for w in norm.split(" "):
        if not w:
            continue
        if len(w) <= max_len:
            out.append(w)
        else:
            out.extend(w[j:j + max_len] for j in range(0, len(w), max_len))
    return out


def fnv1a32(data):
    h = FNV_OFFSET
    for byte in data:
        h ^= byte
        h = (h * FNV_PRIME) & 0xFFFFFFFF
    return h


def hash_feature(feature_str, dim=DIM):
    return fnv1a32(feature_str.encode("utf-8")) % dim


def is_dense_script(c):
    """Scripts written without spaces between words (see isDenseScript)."""
    return (0x0E00 <= c <= 0x0E7F or 0x3040 <= c <= 0x30FF or 0x3400 <= c <= 0x4DBF
            or 0x4E00 <= c <= 0x9FFF or 0xAC00 <= c <= 0xD7AF or 0xF900 <= c <= 0xFAFF)


def token_feature_strings(token, nmin=NGRAM_MIN, nmax=NGRAM_MAX):
    feats = []
    cps = " " + token + " "  # Python str indexes code points, like Array.from
    start = 2 if (nmin > 2 and any(is_dense_script(ord(ch)) for ch in token)) else nmin
    for n in range(start, nmax + 1):
        if len(cps) < n:
            break
        for i in range(0, len(cps) - n + 1):
            feats.append("#" + cps[i:i + n])
    feats.append("$" + token)
    return feats


def window_spans(tokens, chars, stride):
    n = len(tokens)
    spans = []
    if not n:
        return spans
    lens = [len(t) for t in tokens]
    off, o = [], 0
    for ln in lens:
        off.append(o)
        o += ln + 1
    a = 0
    while True:
        b = a + 1
        while b < n and off[b] + lens[b] - off[a] <= chars:
            b += 1
        spans.append((a, b))
        if b >= n:
            break
        nxt = a + 1
        while nxt < b and off[nxt] < off[a] + stride:
            nxt += 1
        a = nxt
    return spans


def clip_z(z):
    return Z_CLIP if z > Z_CLIP else (-Z_CLIP if z < -Z_CLIP else z)


def page_features(head_z, body_z):
    has_head = 1 if head_z else 0
    head_max = -Z_CLIP
    for z in head_z:
        head_max = max(head_max, clip_z(z))
    s = sorted((clip_z(z) for z in body_z), reverse=True)
    nb = len(s)
    top1 = s[0] if nb else -Z_CLIP
    k = min(3, nb)
    top3 = (sum(s[:k]) / k) if k else -Z_CLIP
    pos = sum(1 for z in s if z >= 0)
    conf = sum(1 for z in s if z >= Z_CONFIDENT)
    return [head_max if has_head else 0.0, float(has_head), top1, top3,
            pos / nb if nb else 0.0, conf / nb if nb else 0.0, math.log(1 + nb)]


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


class FeatureCache:
    """token -> bucket list, and bigram -> bucket. Pages repeat vocabulary."""

    def __init__(self, dim=DIM):
        self.dim = dim
        self.tok = {}
        self.big = {}

    def token(self, t):
        b = self.tok.get(t)
        if b is None:
            b = [hash_feature(f, self.dim) for f in token_feature_strings(t)]
            self.tok[t] = b
        return b

    def bigram(self, a, b):
        key = (a, b)
        h = self.big.get(key)
        if h is None:
            h = hash_feature("$" + a + "_" + b, self.dim)
            self.big[key] = h
        return h


# --------------------------------------------------------------------------
# Scoring (float or quantised weights) -- the Python twin of scoreSegment()
# --------------------------------------------------------------------------
class WindowModel:
    def __init__(self, weights, bias, alpha, chars, stride, scale=None):
        self.w = weights          # np.ndarray[DIM]; ints when quantised
        self.bias = bias
        self.alpha = alpha
        self.chars = chars
        self.stride = stride
        self.scale = scale        # None -> float weights

    def segment_z(self, text, fc):
        tokens = tokenize(normalize(text))
        n = len(tokens)
        if not n:
            return [], tokens, []
        w = self.w
        tq, tn = [], []
        for t in tokens:
            bs = fc.token(t)
            tq.append(sum(w[b] for b in bs))
            tn.append(len(bs))
        bq = [w[fc.bigram(tokens[i], tokens[i + 1])] for i in range(n - 1)]
        ps = [0] * (n + 1)
        pn = [0] * (n + 1)
        pb = [0] * n
        for i in range(n):
            ps[i + 1] = ps[i] + tq[i]
            pn[i + 1] = pn[i] + tn[i]
            if i + 1 < n:
                pb[i + 1] = pb[i] + bq[i]
        spans = window_spans(tokens, self.chars, self.stride)
        zs = []
        for a, b in spans:
            q = (ps[b] - ps[a]) + (pb[b - 1] - pb[a])
            cnt = (pn[b] - pn[a]) + (b - a - 1)
            if self.scale is not None:
                zs.append(self.bias + (self.scale * float(q)) / math.pow(cnt, self.alpha))
            else:
                zs.append(self.bias + float(q) / math.pow(cnt, self.alpha))
        return zs, tokens, spans

    def page_z(self, parts, fc):
        head, body = parts
        hz, _, _ = self.segment_z(head, fc)
        bz, _, _ = self.segment_z(body, fc)
        return hz, bz


def truncate_parts(head, body, head_max=1000, max_chars=8000):
    """Mirror scorePage(): JS slices by UTF-16 units; Python by code points.
    Identical for everything outside the astral planes (emoji are symbols and
    are stripped by normalisation anyway)."""
    head = head[:head_max]
    body = body[:max(0, max_chars - len(head))]
    return head, body


# --------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------
MIN_TEXT_TOKENS = 12  # content.js MIN_TEXT_TOKENS_FOR_BLOCK: shorter pages are never scored


def load_pages(path, stats=None):
    """Pages as the model will see them. Drops pages the runtime would never
    score (under MIN_TEXT_TOKENS) and hosts excluded after review
    (tools/text_corpus/label_overrides.tsv)."""
    overrides = build_corpus.load_overrides()
    stats = stats if stats is not None else Counter()
    pages = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "error" in p:
                continue
            if build_corpus.excluded_by(p["host"], overrides):
                stats["excluded: label override"] += 1
                continue
            head, body = build_corpus.page_parts(p)
            head, body = truncate_parts(head, body)
            norm = normalize(head + " " + body)
            if not norm or len(norm.split(" ")) < MIN_TEXT_TOKENS:
                stats["excluded: under 12 tokens"] += 1
                continue
            p["parts"] = (head, body)
            pages.append(p)
    # One capture per URL, and one copy of identical text per site: an age
    # gate or login wall served at many URLs would otherwise count many times.
    seen, out = set(), []
    for p in pages:
        key_url = p["url"]
        key_text = (p["site"], hashlib.sha256("\n".join(p["parts"]).encode("utf-8")).hexdigest())
        if key_url in seen or key_text in seen:
            stats["excluded: duplicate"] += 1
            continue
        seen.add(key_url)
        seen.add(key_text)
        out.append(p)
    return out


def split_of(page):
    h = int(hashlib.sha256(page["site"].encode("utf-8")).hexdigest()[:8], 16) % 100
    if page["category"].startswith("trap-"):
        return "train" if h < 50 else ("val" if h < 75 else "test")
    return "train" if h < 70 else ("val" if h < 85 else "test")


def fold_of(site, k):
    return int(hashlib.sha256(("fold:" + site).encode("utf-8")).hexdigest()[:8], 16) % k


TRAP_WEIGHT = 1.0  # set from --trap-weight in main()
CF_WEIGHT = 0.0    # set from --counterfactual-weight in main()
EXPLICIT_PATH = os.path.join(HERE, "text_corpus", "explicit_terms.txt")
_LEXICON = None
_EXPLICIT_CACHE = {}


def load_explicit(path=EXPLICIT_PATH):
    """(exact, prefixes, infixes) from explicit_terms.txt, normalised like tokens."""
    exact, prefix, infix = set(), [], []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            left, right = s.startswith("*"), s.endswith("*")
            core = normalize(s.strip("*"))
            if not core or " " in core:
                continue
            if left and right:
                infix.append(core)
            elif right:
                prefix.append(core)
            else:
                exact.add(core)
    return exact, tuple(prefix), tuple(infix)


def is_explicit(tok):
    hit = _EXPLICIT_CACHE.get(tok)
    if hit is None:
        exact, prefix, infix = _LEXICON
        hit = tok in exact or tok.startswith(prefix) or any(i in tok for i in infix)
        _EXPLICIT_CACHE[tok] = hit
    return hit


def latin_or_cyrillic(tokens):
    """Counterfactual copies need reliable word boundaries, so only windows
    written mostly in Latin or Cyrillic script get them."""
    good = other = 0
    for t in tokens:
        for ch in t:
            if not ch.isalpha():
                continue
            c = ord(ch)
            if c < 0x250 or 0x400 <= c <= 0x4FF:
                good += 1
            else:
                other += 1
    return good > 0 and good >= 4 * other


def build_matrix(pages, fc, alpha, chars, max_windows, seed):
    """Training rows: non-overlapping windows (stride == chars), at most
    `max_windows` per page. Window shape is what train/serve symmetry needs;
    overlap only matters at inference. Each page gets equal total weight so a
    tube site's 80-line category list cannot outvote a short article.

    Classes are also balanced WITHIN each language (capped at 4x either way).
    The blocklist is multilingual and the curated benign list less so, and the
    first corpus showed the model learning the language instead of the
    content: Polish news scored adult while Japanese adult pages scored safe.

    Trap pages weigh TRAP_WEIGHT times more: blocking a recovery forum costs
    far more than missing one adult page.

    Counterfactual copies (CF_WEIGHT > 0): each adult window is also added
    with its explicit words (explicit_terms.txt) removed, labelled BENIGN.
    Adult pages share their furniture -- "watch", "videos", "hot", "episodes",
    "updated daily" -- with cooking-video and cat-video pages, and without
    these copies the model learned the furniture: those pages scored 0.99.
    The copies teach that only the sexual vocabulary makes a window adult."""
    rng = random.Random(seed)
    per_lang = defaultdict(Counter)
    for p in pages:
        per_lang[lang_of(p)][p["label"]] += 1
    lang_mult = {}
    for lg, c in per_lang.items():
        n = c[0] + c[1]
        for cls in (0, 1):
            lang_mult[(lg, cls)] = (min(4.0, max(0.25, n / (2.0 * c[cls])))
                                    if c[0] and c[1] else 1.0)
    indptr, indices, data, y, sw = [0], [], [], [], []
    for p in pages:
        wins = []
        for text in p["parts"]:
            tokens = tokenize(normalize(text))
            for a, b in window_spans(tokens, chars, chars):
                wins.append((tokens, a, b))
        if not wins:
            continue
        if len(wins) > max_windows:
            head_wins = wins[:1]  # always keep the first (title/meta) window
            wins = head_wins + rng.sample(wins[1:], max_windows - 1)
        per = lang_mult[(lang_of(p), p["label"])] / len(wins)
        if p["label"] == 0 and p["category"].startswith("trap-"):
            per *= TRAP_WEIGHT
        for tokens, a, b in wins:
            counts = Counter()
            for i in range(a, b):
                counts.update(fc.token(tokens[i]))
                if i + 1 < b:
                    counts[fc.bigram(tokens[i], tokens[i + 1])] += 1
            total = sum(counts.values())
            norm = math.pow(total, alpha)
            for bkt, c in counts.items():
                indices.append(bkt)
                data.append(c / norm)
            indptr.append(len(indices))
            y.append(p["label"])
            sw.append(per)
            if p["label"] == 1 and CF_WEIGHT > 0:
                span = tokens[a:b]
                mask = [is_explicit(t) for t in span]
                kept = len(span) - sum(mask)
                if any(mask) and kept >= 8 and latin_or_cyrillic(span):
                    cf = Counter()
                    for i in range(a, b):
                        if mask[i - a]:
                            continue
                        cf.update(fc.token(tokens[i]))
                        if i + 1 < b and not mask[i + 1 - a]:
                            cf[fc.bigram(tokens[i], tokens[i + 1])] += 1
                    norm_cf = math.pow(sum(cf.values()), alpha)
                    for bkt, c in cf.items():
                        indices.append(bkt)
                        data.append(c / norm_cf)
                    indptr.append(len(indices))
                    y.append(0)
                    sw.append(CF_WEIGHT / len(wins))
    X = sparse.csr_matrix((np.asarray(data, dtype=np.float32), np.asarray(indices, dtype=np.int32),
                           np.asarray(indptr, dtype=np.int64)), shape=(len(y), DIM))
    y = np.asarray(y, dtype=np.int8)
    sw = np.asarray(sw, dtype=np.float64)
    # Balance the classes by total weight.
    for cls in (0, 1):
        m = y == cls
        if m.any():
            sw[m] *= (len(y) / 2.0) / sw[m].sum()
    return X, y, sw


def fit_window_model(pages, fc, alpha, C, chars, max_windows, seed):
    X, y, sw = build_matrix(pages, fc, alpha, chars, max_windows, seed)
    clf = LogisticRegression(C=C, solver="liblinear", max_iter=200)
    clf.fit(X, y, sample_weight=sw)
    return np.asarray(clf.coef_[0], dtype=np.float64), float(clf.intercept_[0]), X.shape[0]


def quantize(weights, keep_top, min_abs=1e-4):
    w = weights.copy()
    w[np.abs(w) < min_abs] = 0.0
    nz = np.flatnonzero(w)
    if keep_top and nz.size > keep_top:
        order = np.argsort(-np.abs(w[nz]))
        drop = nz[order[keep_top:]]
        w[drop] = 0.0
    max_abs = float(np.max(np.abs(w))) if np.any(w) else 1.0
    scale = max_abs / 127.0
    q = np.clip(np.rint(w / scale), -127, 127).astype(np.int64)
    return q, scale


def fit_page_model(feats, labels, C=1.0):
    X = np.asarray(feats, dtype=np.float64)
    y = np.asarray(labels, dtype=np.int8)
    clf = LogisticRegression(C=C, solver="lbfgs", max_iter=1000, class_weight="balanced")
    clf.fit(X, y)
    return float(clf.intercept_[0]), [float(v) for v in clf.coef_[0]]


def page_prob(feat, pbias, pweights):
    return sigmoid(pbias + sum(w * f for w, f in zip(pweights, feat)))


# --------------------------------------------------------------------------
# Evaluation helpers
# --------------------------------------------------------------------------
def roc_points(scores, labels):
    pos = sorted((s for s, y in zip(scores, labels) if y == 1), reverse=True)
    neg = sorted((s for s, y in zip(scores, labels) if y == 0), reverse=True)
    return pos, neg


def recall_at_fpr(scores, labels, fpr):
    pos, neg = roc_points(scores, labels)
    if not pos or not neg:
        return 0.0, 1.0
    k = int(math.floor(fpr * len(neg)))
    thr = neg[k] if k < len(neg) else -1e9  # strictly above the k-th negative
    rec = sum(1 for s in pos if s > thr) / len(pos)
    return rec, thr


def quantile_bar(scored, fpr):
    """Smallest probability that lets at most `fpr` of the SITES in `scored`
    ([(prob, site)]) reach it. Each site carries a total weight of 1 however
    many pages it has, so one site's twenty translated pages cannot set the
    bar for everyone. With one page per site this is the plain quantile."""
    pages_per_site = Counter(site for _, site in scored)
    allowed = fpr * len(pages_per_site)
    cum = 0.0
    for prob, site in sorted(scored, reverse=True):
        cum += 1.0 / pages_per_site[site]
        if cum > allowed + 1e-12:
            return prob
    return 0.0


def pick_threshold(benign_probs, trap_probs, fpr):
    """Block bar for one strictness level: benign pages may reach it at rate
    `fpr`, trap pages at half that. Traps get the tighter budget because each
    one is a page this extension's users need (a recovery forum, a sex-ed
    article) -- but a budget rather than a veto, so a single odd page cannot
    drag every level up to the same bar."""
    thr = quantile_bar(benign_probs, fpr)
    if trap_probs:
        thr = max(thr, quantile_bar(trap_probs, fpr / 2.0))
    return min(0.999, float(np.nextafter(thr, 1.0)))


def lang_of(p):
    return (p.get("languages") or "?").split(",")[0] or "?"


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------
def encode_weights(q):
    buckets = np.flatnonzero(q)
    out = bytearray()
    prev = 0
    for b in buckets:
        d = int(b) - prev
        prev = int(b)
        while True:
            byte = d & 0x7F
            d >>= 7
            if d:
                out.append(byte | 0x80)
            else:
                out.append(byte)
                break
    qbytes = bytes((int(v) & 0xFF) for v in q[buckets])
    return len(buckets), base64.b64encode(bytes(out)).decode("ascii"), base64.b64encode(qbytes).decode("ascii")


def write_model(path, cfg, q, scale, bias, pbias, pweights, thresholds, summary, version):
    count, b64_buckets, b64_q = encode_weights(q)
    model = {
        "version": version,
        "format": FORMAT,
        "dim": DIM,
        "ngramMin": NGRAM_MIN,
        "ngramMax": NGRAM_MAX,
        "maxTokenLen": MAX_TOKEN_LEN,
        "windowChars": cfg["chars"],
        "windowStride": cfg["stride"],
        "alpha": cfg["alpha"],
        "bias": bias,
        "scale": scale,
        "count": count,
        "buckets": b64_buckets,
        "q": b64_q,
        "headMaxChars": 1000,
        "maxChars": 8000,
        "page": {"features": PAGE_FEATURES, "bias": pbias, "weights": pweights},
        "thresholds": thresholds,
        "eval": summary,
        "note": "Generated by tools/train_text_classifier.py from tools/text_corpus. Do not hand-edit.",
    }
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(model, fh, ensure_ascii=False, separators=(",", ":"))
    return model


# --------------------------------------------------------------------------
# Golden vectors for cross-language parity testing
# --------------------------------------------------------------------------
GOLDEN_FEATURE_STRINGS = ["#abc", "#por", "#orn", "$porno", "$free_porn",
                          "#色情", "#порн", "$секс", "#エロ動", "#야동"]
GOLDEN_NORMALIZE = [
    "Free  Porn\tVideo", "XVIDEOS.COM,x videos,porn", "Hello, World! (Test)",
    "Ｆｕｌｌ－ｗｉｄｔｈ", "don't stop—ever…", "naïve café ÉCOLE", "порно-онлайн!!",
    "无码视频，高清。", "emoji 😀 gone", "tab\u3000ideographic\ufeffspace",
]
GOLDEN_PAGES = [
    ("How to cook rice - Recipes", "Rinse the rice until the water runs clear. Use one and a half cups of water for every cup of rice, bring it to the boil, then cover and simmer for eighteen minutes."),
    ("Free Porn Videos", "Watch free porn videos, hardcore sex movies and xxx clips updated daily. Amateur, milf, teen 18+ and more categories."),
    ("", "Sex education helps teenagers understand puberty, consent, contraception and how to protect themselves from sexually transmitted infections."),
    ("YouTube", "Home Shorts Subscriptions Library History Watch later Trending videos Music videos Gaming videos News videos"),
    ("Порно онлайн", "Смотреть порно видео бесплатно в хорошем качестве"),
    ("無修正エロ動画", "人妻 熟女 巨乳 素人の無料エロ動画を毎日更新。"),
    ("東京の天気", "今日の東京は晴れのち曇り、最高気温は二十五度の予想です。"),
    ("", "a"),
]
GOLDEN_TOKENS = ["porn", "無修正", "야동", "ข่าว", "a"]


def emit_golden(model_json, path):
    q = np.zeros(DIM, dtype=np.int64)
    counts_b64 = base64.b64decode(model_json["buckets"])
    qb = base64.b64decode(model_json["q"])
    pos, bucket = 0, 0
    for i in range(model_json["count"]):
        delta, shift = 0, 0
        while True:
            byte = counts_b64[pos]
            pos += 1
            delta |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        bucket += delta
        v = qb[i]
        q[bucket] = v - 256 if v > 127 else v
    wm = WindowModel(q, model_json["bias"], model_json["alpha"], model_json["windowChars"],
                     model_json["windowStride"], scale=model_json["scale"])
    fc = FeatureCache()
    pages = []
    for head, body in GOLDEN_PAGES:
        head, body = truncate_parts(head, body)
        hz, bz = wm.page_z((head, body), fc)
        feat = page_features(hz, bz) if (hz or bz) else None
        prob = page_prob(feat, model_json["page"]["bias"], model_json["page"]["weights"]) if feat else 0.0
        pages.append({"head": head, "body": body, "headZ": hz, "bodyZ": bz, "prob": prob})
    tok_text = "XVIDEOS.COM,x videos " + "a" * 30 + " Donaudampfschifffahrtsgesellschaft"
    span_tokens = tokenize(normalize(" ".join(GOLDEN_PAGES[0]) * 3))
    payload = {
        "dim": DIM,
        "hashes": [{"s": s, "bucket": hash_feature(s)} for s in GOLDEN_FEATURE_STRINGS],
        "normalize": [{"text": t, "norm": normalize(t)} for t in GOLDEN_NORMALIZE],
        "tokenize": {"text": tok_text, "tokens": tokenize(normalize(tok_text))},
        "tokenFeatures": [{"token": t, "features": token_feature_strings(t)} for t in GOLDEN_TOKENS],
        "spans": {"tokens": span_tokens, "chars": 200, "stride": 100,
                  "spans": [list(s) for s in window_spans(span_tokens, 200, 100)]},
        "modelVersion": model_json["version"],
        "pages": pages,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    print(f"Wrote golden vectors -> {path}", file=sys.stderr)


# --------------------------------------------------------------------------
# Main pipeline
# --------------------------------------------------------------------------
def score_pages(pages, wm, fc):
    feats = []
    for p in pages:
        hz, bz = wm.page_z(p["parts"], fc)
        p["_hz"], p["_bz"] = hz, bz
        feats.append(page_features(hz, bz))
    return feats


def quick_page_score(p):
    zs = list(p["_hz"]) + list(p["_bz"])
    return max(zs) if zs else -Z_CLIP


def grid_search(train, val, fc, args):
    print("\n=== grid search (val, page score = max window z) ===", file=sys.stderr)
    best = None
    for alpha in (0.5, 0.75, 1.0):
        for C in (0.3, 1.0, 3.0):
            w, b, rows = fit_window_model(train, fc, alpha, C, args.window_chars,
                                          args.max_windows, args.seed)
            wm = WindowModel(w, b, alpha, args.window_chars, args.window_chars // 2)
            score_pages(val, wm, fc)
            scores = [quick_page_score(p) for p in val]
            labels = [p["label"] for p in val]
            r1, _ = recall_at_fpr(scores, labels, 0.01)
            r05, _ = recall_at_fpr(scores, labels, 0.005)
            print(f"  alpha={alpha:<4} C={C:<4} rows={rows}  recall@1%FPR={r1:.3f}  "
                  f"recall@0.5%FPR={r05:.3f}", file=sys.stderr)
            key = (r05, r1)
            if best is None or key > best[0]:
                best = (key, alpha, C)
    print(f"  -> alpha={best[1]} C={best[2]}", file=sys.stderr)
    return best[1], best[2]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pages", default=PAGES_PATH)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--report", default=REPORT_PATH)
    ap.add_argument("--golden", default=GOLDEN_PATH)
    ap.add_argument("--grid", action="store_true")
    ap.add_argument("--trap-weight", type=float, default=8.0,
                    help="training weight of trap pages relative to other benign pages")
    ap.add_argument("--counterfactual-weight", type=float, default=0.25,
                    help="weight of explicit-words-removed copies of adult windows, "
                         "labelled benign (see explicit_terms.txt)")
    ap.add_argument("--dump", default=None,
                    help="write every page's score (train pages: out-of-fold) to this JSONL; "
                         "keep it in tools/text_corpus/cache/, it quotes page text")
    ap.add_argument("--alpha", type=float, default=0.5)
    ap.add_argument("--C", type=float, default=3.0)
    ap.add_argument("--window-chars", type=int, default=200)
    ap.add_argument("--max-windows", type=int, default=12)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--keep-top", type=int, default=60000)
    ap.add_argument("--version", type=int, default=4)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    global TRAP_WEIGHT, CF_WEIGHT, _LEXICON
    TRAP_WEIGHT = args.trap_weight
    CF_WEIGHT = args.counterfactual_weight
    _LEXICON = load_explicit()
    t0 = time.time()
    load_stats = Counter()
    pages = load_pages(args.pages, load_stats)
    for k, v in sorted(load_stats.items()):
        print(f"{k}: {v}", file=sys.stderr)
    for p in pages:
        p["split"] = split_of(p)
    train = [p for p in pages if p["split"] == "train"]
    val = [p for p in pages if p["split"] == "val"]
    test = [p for p in pages if p["split"] == "test"]

    def desc(ps):
        c = Counter(p["label"] for p in ps)
        return f"{len(ps)} pages ({c[1]} adult / {c[0]} benign, {len({p['site'] for p in ps})} sites)"
    print(f"train: {desc(train)}\nval:   {desc(val)}\ntest:  {desc(test)}", file=sys.stderr)

    fc = FeatureCache()
    alpha, C = args.alpha, args.C
    if args.grid:
        alpha, C = grid_search(train, val, fc, args)
    cfg = {"alpha": alpha, "C": C, "chars": args.window_chars, "stride": args.window_chars // 2}

    # ---- page model via cross-fitting on train: each page is scored by a
    # window model that never saw its site, as it will be in the wild.
    print(f"\ncross-fitting page model ({args.folds} folds) ...", file=sys.stderr)
    oof_feats, oof_labels = [], []
    for k in range(args.folds):
        fit_on = [p for p in train if fold_of(p["site"], args.folds) != k]
        held = [p for p in train if fold_of(p["site"], args.folds) == k]
        w, b, _ = fit_window_model(fit_on, fc, alpha, C, cfg["chars"], args.max_windows, args.seed)
        q, scale = quantize(w, args.keep_top)
        wm = WindowModel(q, b, alpha, cfg["chars"], cfg["stride"], scale=scale)
        oof_feats += score_pages(held, wm, fc)
        oof_labels += [p["label"] for p in held]
        print(f"  fold {k + 1}/{args.folds}: scored {len(held)} held-out pages", file=sys.stderr)
    pbias, pweights = fit_page_model(oof_feats, oof_labels)
    print("  page model: bias={:.3f} ".format(pbias) +
          " ".join(f"{n}={v:+.3f}" for n, v in zip(PAGE_FEATURES, pweights)), file=sys.stderr)
    oof_pages = []
    for k in range(args.folds):
        oof_pages += [p for p in train if fold_of(p["site"], args.folds) == k]
    for p, f in zip(oof_pages, oof_feats):
        p["_prob"] = page_prob(f, pbias, pweights)  # unseen-site score, like val/test

    # ---- final window model on all of train, quantised as it will ship.
    print("\nfitting final window model ...", file=sys.stderr)
    w, b, rows = fit_window_model(train, fc, alpha, C, cfg["chars"], args.max_windows, args.seed)
    q, scale = quantize(w, args.keep_top)
    wm = WindowModel(q, b, alpha, cfg["chars"], cfg["stride"], scale=scale)
    print(f"  {rows} training windows, {int(np.count_nonzero(q))} weights kept", file=sys.stderr)

    for ps in (val, test):
        feats = score_pages(ps, wm, fc)
        for p, f in zip(ps, feats):
            p["_prob"] = page_prob(f, pbias, pweights)

    # ---- thresholds from validation plus train's out-of-fold scores: every
    # one of those pages was scored by a model that never saw its site. Val
    # alone is too small to place a 0.2% false-positive bar. Test stays out.
    pool = val + oof_pages
    pool_benign = [(p["_prob"], p["site"]) for p in pool if p["label"] == 0]
    pool_traps = [(p["_prob"], p["site"]) for p in pool
                  if p["label"] == 0 and p["category"].startswith("trap-")]
    print(f"\nthreshold pool: {len(pool_benign)} benign pages / {len({s for _, s in pool_benign})} sites "
          f"({len(pool_traps)} trap pages / {len({s for _, s in pool_traps})} sites)", file=sys.stderr)
    thresholds = {}
    for level, t in FPR_TARGETS.items():
        thresholds[level] = {
            "block": round(pick_threshold(pool_benign, pool_traps, t["block"]), 6),
            "fuse": round(pick_threshold(pool_benign, [], t["fuse"]), 6),
        }
        thresholds[level]["fuse"] = min(thresholds[level]["fuse"], thresholds[level]["block"])
        print(f"  {level}: block {thresholds[level]['block']:.4f}  fuse {thresholds[level]['fuse']:.4f}",
              file=sys.stderr)

    if args.dump:
        with open(args.dump, "w", encoding="utf-8", newline="\n") as fh:
            for p in train + val + test:
                if "_prob" not in p:
                    continue
                zs, tokens, spans = wm.segment_z(p["parts"][1], fc)
                top = ""
                if zs:
                    a, bb = spans[int(np.argmax(zs))]
                    top = " ".join(tokens[a:bb])
                fh.write(json.dumps({
                    "split": p["split"], "label": p["label"], "category": p["category"],
                    "lang": lang_of(p), "site": p["site"], "url": p["url"],
                    "prob": round(p["_prob"], 5), "head": p["parts"][0][:160], "topWindow": top[:240],
                }, ensure_ascii=False) + "\n")
        print(f"Wrote per-page scores -> {args.dump}", file=sys.stderr)

    summary, report = evaluate(test, val, thresholds, wm, fc, pbias, pweights, cfg, args)
    write_model(args.out, cfg, q, scale, b, pbias, pweights, thresholds, summary, args.version)
    size_kb = os.path.getsize(args.out) / 1024.0
    print(f"\nWrote model -> {args.out} ({size_kb:.1f} KB)", file=sys.stderr)
    with open(args.out, "r", encoding="utf-8") as fh:
        emit_golden(json.load(fh), args.golden)
    report = report.replace("{MODEL_SIZE}", f"{size_kb:.0f} KB")
    with open(args.report, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(report)
    print(f"Wrote report -> {args.report}   ({time.time() - t0:.0f}s)", file=sys.stderr)
    return 0


def evaluate(test, val, thresholds, wm, fc, pbias, pweights, cfg, args):
    lines = []
    out = lines.append
    out("# AI Text Blocker -- evaluation report")
    out("")
    out("Generated by `tools/train_text_classifier.py`. Every number below is measured on")
    out("the **test** split: sites the model never saw in training, and never used to pick")
    out("a threshold or a hyper-parameter. Thresholds come from the validation split plus")
    out("the training pages' out-of-fold scores -- never from test.")
    out("")
    out(f"- Model: format v4, window {cfg['chars']} chars / stride {cfg['stride']}, "
        f"alpha {cfg['alpha']}, C {cfg['C']}, trap weight {TRAP_WEIGHT}, "
        f"counterfactual weight {CF_WEIGHT}, size {{MODEL_SIZE}}")
    tb = [p for p in test if p["label"] == 0]
    ta = [p for p in test if p["label"] == 1]
    out(f"- Test pages: {len(ta)} adult ({len({p['site'] for p in ta})} sites), "
        f"{len(tb)} benign ({len({p['site'] for p in tb})} sites)")
    out("")
    out("## Page-level results")
    out("")
    out("| Level | Block at | Adult pages caught | Benign pages blocked | Trap pages blocked |")
    out("|---|---|---|---|---|")
    summary = {"test": {}}
    for level in ("relaxed", "balanced", "strict"):
        thr = thresholds[level]["block"]
        caught = sum(1 for p in ta if p["_prob"] >= thr)
        fp = [p for p in tb if p["_prob"] >= thr]
        traps = [p for p in tb if p["category"].startswith("trap-")]
        trap_fp = [p for p in fp if p["category"].startswith("trap-")]
        out(f"| {level} | {thr:.4f} | {caught}/{len(ta)} ({caught / max(1, len(ta)):.1%}) | "
            f"{len(fp)}/{len(tb)} ({len(fp) / max(1, len(tb)):.2%}) | {len(trap_fp)}/{len(traps)} |")
        summary["test"][level] = {
            "recall": round(caught / max(1, len(ta)), 4),
            "fpr": round(len(fp) / max(1, len(tb)), 5),
            "trapFp": len(trap_fp), "traps": len(traps),
        }
    out("")
    bal = thresholds["balanced"]["block"]
    out("## Benign pages blocked at Balanced")
    out("")
    fps = sorted((p for p in tb if p["_prob"] >= bal), key=lambda p: -p["_prob"])
    if not fps:
        out("None.")
    for p in fps[:40]:
        out(f"- `{p['_prob']:.3f}` {p['category']} -- {p['url']}")
    out("")
    out("## Benign categories (test), highest page score")
    out("")
    out("| Category | Pages | Max score | Blocked at Balanced |")
    out("|---|---|---|---|")
    cats = defaultdict(list)
    for p in tb:
        cats[p["category"]].append(p["_prob"])
    for cat in sorted(cats):
        v = cats[cat]
        out(f"| {cat} | {len(v)} | {max(v):.3f} | {sum(1 for s in v if s >= bal)} |")
    out("")
    out("## Adult recall by language at Balanced (test)")
    out("")
    out("| Language | Pages | Caught |")
    out("|---|---|---|")
    langs = defaultdict(list)
    for p in ta:
        langs[lang_of(p)].append(p["_prob"] >= bal)
    for lg, v in sorted(langs.items(), key=lambda kv: -len(kv[1])):
        if len(v) >= 3:
            out(f"| {lg} | {len(v)} | {sum(v) / len(v):.0%} |")
    out("")

    # ---- dilution: one adult window dropped into an ordinary page.
    out("## Dilution: one explicit passage inside an ordinary page")
    out("")
    out("v3 scored an explicit sentence inside ~700 words of ordinary text at 0.0000.")
    out("Here each benign test page gets the single most explicit window of a random")
    out("adult test page inserted into the middle of its text.")
    out("")
    rng = random.Random(7)
    donors = []
    for p in ta:
        zs, tokens, spans = wm.segment_z(p["parts"][1], fc)
        if zs:
            i = int(np.argmax(zs))
            a, bb = spans[i]
            donors.append(" ".join(tokens[a:bb]))
    long_benign = [p for p in tb if len(p["parts"][1]) > 2000]
    hit_page = hit_window = 0
    for p in long_benign:
        head, body = p["parts"]
        mid = len(body) // 2
        donor = rng.choice(donors) if donors else ""
        mixed = truncate_parts(head, body[:mid] + " " + donor + " " + body[mid:])
        hz, bz = wm.page_z(mixed, fc)
        prob = page_prob(page_features(hz, bz), pbias, pweights)
        hit_page += prob >= bal
        hit_window += bool(bz) and max(bz) >= Z_CONFIDENT
    n = max(1, len(long_benign))
    out(f"- Pages tested: {len(long_benign)} (benign test pages over 2,000 characters)")
    out(f"- The inserted passage is found (its window scores p >= 0.9): "
        f"{hit_window}/{len(long_benign)} ({hit_window / n:.0%})")
    out(f"- The whole page crosses the Balanced block threshold: "
        f"{hit_page}/{len(long_benign)} ({hit_page / n:.0%})")
    out("")
    summary["dilution"] = {"pages": len(long_benign), "windowFound": round(hit_window / n, 3),
                           "pageBlocked": round(hit_page / n, 3)}

    # ---- the regressions that put v3 behind a safety catch.
    out("## Known regressions from v3")
    out("")
    out("| Text | Page score | Blocked at Balanced |")
    out("|---|---|---|")
    probes = [
        ("YouTube", "Home Shorts Subscriptions You History Playlists Your videos Watch later Liked videos Trending Music Gaming News Sports"),
        ("", "videos"),
        ("", "video tutorials cooking video recipes video guide videos channel"),
        ("Navix Health", "Revenue cycle management for hospitals and clinics. Patient portal, claims, billing and insurance verification."),
        ("Sex education", "Sex education teaches young people about puberty, consent, contraception, pregnancy and sexually transmitted infections."),
        ("Quit porn for good", "Our recovery program helps you stop watching pornography. Track your streak, find an accountability partner and beat porn addiction."),
        # Pages that simply talk about videos: the class that put v3 behind a
        # safety catch (m.youtube.com), and that an early v4 still blocked.
        ("Cooking Videos | Easy Recipes", "Watch our cooking videos and video recipes. Step by step video tutorials for beginners, quick weeknight dinners, baking videos and more new videos every week."),
        ("Funny Cat Videos", "The funniest cat videos and kitten videos on the internet. Watch cute animal videos, compilations and viral pet videos updated daily."),
        ("Stock Video Footage", "Download royalty free stock videos and HD video footage for your projects. Browse millions of video clips, 4K videos and motion graphics."),
        ("Hot Wheels Videos", "Watch Hot Wheels videos, car videos for kids, monster truck videos and toy unboxing videos. New episodes and videos every Friday."),
        ("Workout videos", "Free full body workout videos at home. Yoga videos, HIIT video workouts, pilates videos and stretching videos for all levels."),
        ("CNN Videos", "Latest news videos from around the world. Watch video reports on politics, business, health, entertainment, travel and sports. Live video and breaking news clips."),
    ]
    for head, body in probes:
        hz, bz = wm.page_z(truncate_parts(head, body), fc)
        prob = page_prob(page_features(hz, bz), pbias, pweights) if (hz or bz) else 0.0
        label = (head + " / " if head else "") + body
        out(f"| {label[:70]}{'...' if len(label) > 70 else ''} | {prob:.3f} | {'**yes**' if prob >= bal else 'no'} |")
    out("")
    out("## Thresholds shipped in the model (chosen on validation + out-of-fold train)")
    out("")
    out("| Level | Block (text alone) | Fuse (with an image flagged) | Target benign FPR |")
    out("|---|---|---|---|")
    for level in ("relaxed", "balanced", "strict"):
        t = thresholds[level]
        out(f"| {level} | {t['block']:.4f} | {t['fuse']:.4f} | {FPR_TARGETS[level]['block']:.1%} |")
    out("")
    vb = [p for p in val if p["label"] == 0]
    va = [p for p in val if p["label"] == 1]
    out(f"Validation: {len(va)} adult / {len(vb)} benign pages.")
    return summary, "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
