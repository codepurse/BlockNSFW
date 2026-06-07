# ML Domain Curation Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python-based heuristic domain curation pipeline that scores candidate adult domains and auto-merges high-confidence ones into the blocklist, with zero client-side impact.

**Architecture:** A GitHub Actions workflow runs a Python pipeline weekly. The pipeline ingests external feeds, scores domains using weighted heuristics (keywords, TLD, structure, similarity, safety), and routes them based on thresholds. High-confidence domains are auto-merged into HOSTS.txt; medium-confidence ones go to a review queue.

**Tech Stack:** Python 3.12 (stdlib only), GitHub Actions

---

## File Structure

| File | Responsibility |
|------|--------------|
| `scripts/curation/__init__.py` | Package marker |
| `scripts/curation/config.py` | All configuration: keyword lists, TLD classifications, scoring weights, thresholds, feed URLs |
| `scripts/curation/ingest.py` | Fetch and parse external blocklist feeds; normalize and deduplicate domains |
| `scripts/curation/scorer.py` | Heuristic scoring engine: computes 0-1 score per domain using feature extraction |
| `scripts/curation/update_hosts.py` | Update HOSTS.txt, regenerate blocklist.json, manage review queue |
| `scripts/curation/pipeline.py` | Orchestrator: runs ingest → score → update in sequence |
| `scripts/curation/test_scorer.py` | Unit tests for the scorer with known good/bad domains |
| `.github/workflows/curation.yml` | GitHub Actions workflow definition |

---

## Task 1: Configuration Module

**Files:**
- Create: `scripts/curation/config.py`
- Create: `scripts/curation/__init__.py`

**Context:** This module holds all tunable parameters. Keywords are synced from `shared/host-keywords.js`.

- [ ] **Step 1: Create package marker**

```python
# scripts/curation/__init__.py
# Curation pipeline package
```

- [ ] **Step 2: Write config.py with all constants**

```python
"""Configuration for the domain curation pipeline.

All tunable parameters live here for easy adjustment.
"""

# =============================================================================
# Scoring thresholds
# =============================================================================
AUTO_MERGE_THRESHOLD = 0.85   # Auto-merge into HOSTS.txt
REVIEW_THRESHOLD = 0.60       # Add to review queue
# Below REVIEW_THRESHOLD: reject

# =============================================================================
# Feature weights (must sum to 1.0, excluding safety penalty)
# =============================================================================
WEIGHT_KEYWORD = 0.35
WEIGHT_TLD = 0.15
WEIGHT_STRUCTURE = 0.15
WEIGHT_SIMILARITY = 0.25
WEIGHT_SAFETY_PENALTY = 0.20  # Subtracted from total

# =============================================================================
# Adult keywords — synced from shared/host-keywords.js STRONG_HOST_KEYWORDS
# =============================================================================
STRONG_HOST_KEYWORDS = [
    # English / Western adult brand names
    'porn', 'porno', 'pornos', 'xxx', 'xvideos', 'xhamster', 'xnxx', 'redtube',
    'youporn', 'brazzers', 'chaturbate', 'bongacams', 'cam4', 'pornhub',
    'spankbang', 'tube8', 'youjizz', 'nudography', 'onlyfans', 'erome',
    'hentai', 'hentaihaven', 'rule34', 'pornoizle', 'tubeporn',
    # Foreign-language transliterations
    'seks', 'sikis', 'bokep', 'yadong',
    # CJK / non-Latin script tokens
    '色情', '야동', 'порно', 'سكس', 'หนังโป๊',
]

# Ambiguous keywords that should NOT trigger strong blocking
AMBIGUOUS_KEYWORDS = {
    'sex', 'jav', 'cam', 'tube', 'video', 'videos', 'live', 'hd',
    'red', 'pink', 'hot', 'free',
}

# =============================================================================
# Multilingual adult keywords for substring matching
# =============================================================================
MULTILINGUAL_KEYWORDS = [
    # Chinese
    '色情', '情色', '成人片', '成人影片', '成人视频', '成人視頻',
    '成人网站', '成人網站', '黄色片', '黃色片', '黄色网站', '黃色網站',
    '三级片', '三級片', '无码视频', '無碼視頻', '无码片', '無碼片',
    'av女优', 'av女優', '裸聊直播', '约炮平台', '約炮平台',
    # Japanese
    'エロ動画', 'エロ画像', 'アダルト動画', 'アダルトビデオ',
    'ポルノ動画', 'ポルノ画像', 'エッチ動画', 'セックス動画',
    'ハメ撮り', '無修正動画', 'AV女優',
    # Korean
    '야동', '야설', '성인사이트', '성인동영상', '성인비디오',
    '포륵', '한국야동', '일본야동', '떡방', '벗방', '조개모아',
    # Russian
    'порно', 'порнуха', 'порнушка', 'порнография',
    'порновидео', 'порнофильм', 'порно онлайн',
    'хентай', 'порево', 'секс видео', 'секс фото', 'секс чат',
    'анальный секс', 'анал порно',
    # Arabic
    'افلام سكس', 'افلام إباحية', 'سكس عربي',
    'مقاطع سكس', 'فيديو سكس',
    # Thai
    'หนังโป๊', 'หนังโป', 'คลิปโป๊', 'คลิปหลุด', 'โป๊เปลือย',
    'หนังเอ๊ก', 'หนังx',
    # Vietnamese
    'phim sex', 'phim nguoi lon', 'phim sex viet',
    'phim khiêu dâm',
    # Indonesian
    'video bokep', 'film bokep', 'bokep indo', 'bokep jepang', 'situs bokep',
    # Hindi
    'सेक्सी वीडियो', 'देसी सेक्स', 'सेक्स वीडियो',
    'पॉर्न वीडियो', 'अश्लील वीडियो',
    # Tagalog
    'kantot', 'kantutan', 'jakulan',
    # Turkish
    'porno izle', 'sikiş izle', 'türk porno', 'türk sikiş',
    # German
    'pornofilm', 'pornofilme', 'pornos kostenlos', 'porno kostenlos',
    'geile titten', 'nackte frauen', 'gratis porno',
    # French
    'porno gratuit', 'film porno', 'porno français', 'films pornos',
    # Italian
    'porno gratis', 'film porno', 'porno italiano', 'video porno',
    # Spanish
    'porno gratis', 'porno español', 'pornografía', 'videos porno',
    'peliculas porno',
    # Portuguese
    'pornô grátis', 'pornografia', 'porno brasileiro', 'videos porno',
    'filme pornô',
    # Polish
    'porno za darmo', 'ostre porno', 'darmowe porno', 'filmy porno',
    # Czech
    'porno zdarma', 'české porno', 'porno videa',
]

# =============================================================================
# Safety tokens — domains containing these are likely benign
# =============================================================================
SAFE_HOST_TOKENS = [
    'help', 'recovery', 'recover', 'quit', 'addiction', 'support',
    'therapy', 'counseling', 'counselling', 'treatment', 'awareness',
    'education', 'educate', 'protect', 'protection', 'accountability',
    'nofap', 'no-porn', 'stop-porn', 'antiporn', 'anti-porn',
    'safer', 'safe', 'healing', 'rehab', 'overcome', 'overcoming',
    'freedom', 'liberty', 'testimonial', 'testimony', 'research',
    'study', 'academic',
]

# =============================================================================
# TLD risk classification
# =============================================================================
HIGH_RISK_TLDS = {'xxx', 'adult', 'porn', 'sex'}
BENIGN_TLDS = {'edu', 'gov', 'ac', 'mil'}

# =============================================================================
# External feed sources
# =============================================================================
EXTERNAL_FEEDS = [
    {
        'url': 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
        'format': 'hosts',  # 0.0.0.0 domain
    },
    {
        'url': 'https://raw.githubusercontent.com/chadmayfield/pihole-blocklists/master/lists/porn.txt',
        'format': 'plain',  # one domain per line
    },
]

# =============================================================================
# File paths (relative to repo root)
# =============================================================================
HOSTS_FILE = 'data/HOSTS.txt'
WHITELIST_FILE = 'data/WHITELIST.txt'
BLOCKLIST_JSON = 'blocklist.json'
REVIEW_QUEUE_FILE = 'data/REVIEW_QUEUE.md'
REPORTS_DIR = 'data/reports'

# =============================================================================
# Typosquat detection
# =============================================================================
TOP_BRAND_DOMAINS = [
    'pornhub.com', 'xvideos.com', 'xhamster.com', 'youporn.com', 'redtube.com',
    'brazzers.com', 'chaturbate.com', 'xnxx.com', 'spankbang.com', 'tube8.com',
    'hentaihaven.com', 'rule34.com', 'onlyfans.com', 'pornmd.com', 'shemaletube.com',
]

# Levenshtein distance threshold for typosquat detection
TYPOSQUAT_MAX_DISTANCE = 2
TYPOSQUAT_BOOST = 0.30

# Minimum character n-gram overlap for similarity scoring
NGRAM_SIZE = 3
NGRAM_MIN_OVERLAP = 0.30
```

- [ ] **Step 3: Verify config.py imports without error**

Run: `cd scripts/curation && python -c "import config; print('OK')"`

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/curation/__init__.py scripts/curation/config.py
git commit -m "feat(curation): add config module with keyword lists and scoring weights"
```

---

## Task 2: Ingestion Module

**Files:**
- Create: `scripts/curation/ingest.py`

**Context:** Fetches and parses external feeds, normalizes domains, dedupes against existing blocklist/whitelist.

- [ ] **Step 1: Write ingest.py**

```python
"""Ingest candidate domains from external feeds and user reports."""

import json
import re
import urllib.request
from pathlib import Path
from typing import Iterator

import config

# Regex to extract the domain from a hosts file line
HOSTS_LINE_RE = re.compile(r'^\s*(?:0\.0\.0\.0|127\.0\.0\.1)?\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\s*(?:#.*)?$')
# Regex to validate a domain
DOMAIN_RE = re.compile(r'^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$')


def normalize_domain(domain: str) -> str | None:
    """Normalize a domain: lowercase, strip www., validate, decode punycode."""
    if not domain:
        return None
    domain = domain.strip().lower()
    # Remove protocol
    domain = re.sub(r'^https?://', '', domain)
    # Remove path
    domain = domain.split('/', 1)[0]
    # Strip www.
    if domain.startswith('www.'):
        domain = domain[4:]
    # Validate
    if not DOMAIN_RE.match(domain):
        return None
    return domain


def parse_hosts_format(text: str) -> list[str]:
    """Parse a hosts-format blocklist (0.0.0.0 domain)."""
    domains = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = HOSTS_LINE_RE.match(line)
        if m:
            normalized = normalize_domain(m.group(1))
            if normalized:
                domains.append(normalized)
    return domains


def parse_plain_format(text: str) -> list[str]:
    """Parse a plain one-domain-per-line list."""
    domains = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        normalized = normalize_domain(line)
        if normalized:
            domains.append(normalized)
    return domains


def fetch_feed(url: str, fmt: str) -> list[str]:
    """Fetch and parse a remote feed."""
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            text = response.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"[warn] Failed to fetch {url}: {e}")
        return []

    if fmt == 'hosts':
        return parse_hosts_format(text)
    elif fmt == 'plain':
        return parse_plain_format(text)
    else:
        print(f"[warn] Unknown feed format: {fmt}")
        return []


def load_existing_hosts() -> set[str]:
    """Load domains already in HOSTS.txt."""
    path = Path(config.HOSTS_FILE)
    if not path.exists():
        return set()
    return set(parse_hosts_format(path.read_text(encoding='utf-8', errors='ignore')))


def load_whitelist() -> set[str]:
    """Load whitelisted domains."""
    path = Path(config.WHITELIST_FILE)
    if not path.exists():
        return set()
    domains = set()
    for line in path.read_text(encoding='utf-8', errors='ignore').splitlines():
        normalized = normalize_domain(line)
        if normalized:
            domains.add(normalized)
    return domains


def load_user_reports() -> list[str]:
    """Load user-submitted missed-site reports from data/reports/."""
    reports_dir = Path(config.REPORTS_DIR)
    if not reports_dir.exists():
        return []
    domains = []
    for report_file in reports_dir.glob('*.json'):
        try:
            data = json.loads(report_file.read_text(encoding='utf-8'))
            for item in data if isinstance(data, list) else [data]:
                d = normalize_domain(item.get('domain', ''))
                if d:
                    domains.append(d)
        except (json.JSONDecodeError, KeyError) as e:
            print(f"[warn] Failed to parse {report_file}: {e}")
    return domains


def ingest_all() -> Iterator[tuple[str, str]]:
    """Yield (domain, source) pairs from all sources."""
    blocked = load_existing_hosts()
    whitelist = load_whitelist()

    # External feeds
    for feed in config.EXTERNAL_FEEDS:
        for d in fetch_feed(feed['url'], feed['format']):
            if d not in blocked and d not in whitelist:
                yield d, feed['url']

    # User reports
    for d in load_user_reports():
        if d not in blocked and d not in whitelist:
            yield d, 'user-report'


if __name__ == '__main__':
    candidates = list(ingest_all())
    print(f"Ingested {len(candidates)} candidate domains")
    sources: dict[str, int] = {}
    for _, src in candidates:
        sources[src] = sources.get(src, 0) + 1
    for src, count in sources.items():
        print(f"  {src}: {count}")
```

- [ ] **Step 2: Verify ingest module runs**

Run: `cd scripts/curation && python ingest.py`

Expected: Prints total candidate count and per-source breakdown (numbers may vary).

- [ ] **Step 3: Commit**

```bash
git add scripts/curation/ingest.py
git commit -m "feat(curation): add ingest module for external feeds and user reports"
```

---

## Task 3: Scorer Module

**Files:**
- Create: `scripts/curation/scorer.py`
- Create: `scripts/curation/test_scorer.py`

**Context:** Computes a 0-1 score per domain using weighted heuristic features.

- [ ] **Step 1: Write test_scorer.py first (TDD)**

```python
"""Unit tests for the scorer."""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import scorer
import config


def test_strong_keyword_high_score():
    """A domain with a strong adult keyword should score high."""
    score, features = scorer.score_domain('pornhub-example.com')
    assert score >= 0.7, f"Expected high score, got {score}"


def test_typosquat_high_score():
    """A typosquat of a known adult brand should score high."""
    score, features = scorer.score_domain('pornhob.com')  # typo of pornhub
    assert score >= 0.6, f"Expected high score, got {score}"


def test_whitelist_force_zero():
    """A whitelisted domain should score 0."""
    score, features = scorer.score_domain('recoverfromporn.com')
    assert score == 0.0


def test_benign_domain_low_score():
    """A clearly benign domain should score low."""
    score, features = scorer.score_domain('github.com')
    assert score < 0.3, f"Expected low score, got {score}"


def test_multilingual_keyword_scores_high():
    """A domain with CJK adult keyword should score high."""
    score, features = scorer.score_domain('example-色情.com')
    assert score >= 0.4


def test_safe_tld_penalty():
    """A domain with .edu TLD should get a safety penalty."""
    score_edu, _ = scorer.score_domain('something.edu')
    score_com, _ = scorer.score_domain('something.com')
    assert score_edu <= score_com


def test_high_risk_tld_boost():
    """A domain with .xxx TLD should get a TLD boost."""
    score_xxx, _ = scorer.score_domain('example.xxx')
    score_com, _ = scorer.score_domain('example.com')
    assert score_xxx >= score_com


def test_score_clamped_to_unit_interval():
    """Score must always be in [0, 1]."""
    for d in ['pornhub.com', 'github.com', '色情site.cn', 'recovery.support', 'xvideosx.xxx']:
        s, _ = scorer.score_domain(d)
        assert 0.0 <= s <= 1.0, f"Score {s} out of range for {d}"


if __name__ == '__main__':
    test_strong_keyword_high_score()
    test_typosquat_high_score()
    test_whitelist_force_zero()
    test_benign_domain_low_score()
    test_multilingual_keyword_scores_high()
    test_safe_tld_penalty()
    test_high_risk_tld_boost()
    test_score_clamped_to_unit_interval()
    print("All tests passed.")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/curation && python test_scorer.py`

Expected: Error like `ModuleNotFoundError: No module named 'scorer'`

- [ ] **Step 3: Write scorer.py**

```python
"""Heuristic domain scorer.

Computes a 0-1 score indicating likelihood the domain hosts adult content.
"""

import re
from difflib import SequenceMatcher

import config
import ingest


def _extract_core_label(domain: str) -> str:
    """Get the deepest subdomain label (usually the brand name)."""
    parts = domain.split('.')
    # Skip ccTLD and TLD (last 2 parts typically)
    if len(parts) >= 3:
        return parts[-3]
    return parts[0]


def _ngram_overlap(a: str, b: str, n: int = config.NGRAM_SIZE) -> float:
    """Compute character n-gram Jaccard similarity."""
    if len(a) < n or len(b) < n:
        return 0.0
    grams_a = {a[i:i + n] for i in range(len(a) - n + 1)}
    grams_b = {b[i:i + n] for i in range(len(b) - n + 1)}
    intersection = grams_a & grams_b
    union = grams_a | grams_b
    if not union:
        return 0.0
    return len(intersection) / len(union)


def _levenshtein(a: str, b: str) -> int:
    """Standard Levenshtein distance."""
    if len(a) < len(b):
        return _levenshtein(b, a)
    if len(b) == 0:
        return len(a)
    prev_row = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr_row = [i + 1]
        for j, cb in enumerate(b):
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (ca != cb)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row
    return prev_row[-1]


def _is_hyphen_bounded(text: str, keyword: str) -> bool:
    """Check if keyword appears as a whole token (delimited by hyphens, dots, or string boundaries)."""
    pattern = r'(?:^|[\-\.])' + re.escape(keyword) + r'(?:[\-\.]|$)'
    return bool(re.search(pattern, text))


def score_keyword(domain: str) -> float:
    """Score based on adult keyword presence (0-1)."""
    score = 0.0
    domain_lower = domain.lower()
    label = _extract_core_label(domain_lower)

    # Strong keywords — exact match or hyphen-bounded
    for kw in config.STRONG_HOST_KEYWORDS:
        if _is_hyphen_bounded(label, kw.lower()) or kw.lower() in label:
            score = max(score, 0.95)
            break

    # Multilingual keywords — substring match
    for kw in config.MULTILINGUAL_KEYWORDS:
        if kw in domain_lower:
            score = max(score, 0.85)
            break

    # If no strong signals, check ambiguous keywords (lower weight)
    if score < 0.3:
        for kw in config.AMBIGUOUS_KEYWORDS:
            if _is_hyphen_bounded(label, kw):
                score = max(score, 0.15)
                break

    return score


def score_tld(domain: str) -> float:
    """Score based on TLD risk (0-1)."""
    parts = domain.rsplit('.', 1)
    if len(parts) != 2:
        return 0.0
    tld = parts[1]
    if tld in config.HIGH_RISK_TLDS:
        return 1.0
    if tld in config.BENIGN_TLDS:
        return 0.0
    return 0.2  # neutral


def score_structure(domain: str) -> float:
    """Score based on suspicious structural patterns (0-1)."""
    score = 0.0
    label = _extract_core_label(domain)

    # Numeric prefix/suffix (common in mirror sites)
    if re.search(r'\d{2,}', label):
        score += 0.4

    # Excessive hyphens
    hyphen_count = label.count('-')
    if hyphen_count >= 2:
        score += 0.3
    elif hyphen_count == 1:
        score += 0.1

    # Very long label
    if len(label) > 20:
        score += 0.2

    # Random-looking (high consonant ratio, no vowels in long segments)
    if len(label) > 8 and not re.search(r'[aeiouy]', label):
        score += 0.3

    return min(score, 1.0)


def score_similarity(domain: str) -> float:
    """Score based on similarity to known adult brands (0-1)."""
    label = _extract_core_label(domain)

    # Check n-gram overlap with existing blocklist
    # Lazy-load existing hosts to avoid circular dependency
    existing = ingest.load_existing_hosts()
    if not existing:
        return 0.0

    max_overlap = 0.0
    for blocked in list(existing)[:500]:  # sample for performance
        blocked_label = _extract_core_label(blocked)
        overlap = _ngram_overlap(label, blocked_label)
        max_overlap = max(max_overlap, overlap)
        if max_overlap >= 0.7:
            break  # good enough

    # Check typosquat distance to top brands
    for brand in config.TOP_BRAND_DOMAINS:
        brand_label = _extract_core_label(brand)
        if abs(len(label) - len(brand_label)) > config.TYPOSQUAT_MAX_DISTANCE + 2:
            continue
        dist = _levenshtein(label, brand_label)
        if 0 < dist <= config.TYPOSQUAT_MAX_DISTANCE:
            return max(max_overlap, 0.8)  # typosquat is strong signal

    return max_overlap


def score_safety(domain: str) -> float:
    """Safety penalty score (0-1, higher = safer, subtracted from total)."""
    domain_lower = domain.lower()

    # Check whitelist first
    whitelist = ingest.load_whitelist()
    if domain in whitelist:
        return 1.0  # force zero

    # Check safe tokens
    for token in config.SAFE_HOST_TOKENS:
        if token in domain_lower:
            return 0.8

    return 0.0


def score_domain(domain: str) -> tuple[float, dict]:
    """Compute final 0-1 score for a domain. Returns (score, feature_dict)."""
    features = {
        'keyword': score_keyword(domain),
        'tld': score_tld(domain),
        'structure': score_structure(domain),
        'similarity': score_similarity(domain),
        'safety': score_safety(domain),
    }

    # Whitelist forces zero
    if features['safety'] >= 1.0:
        return 0.0, features

    # Weighted sum
    total = (
        features['keyword'] * config.WEIGHT_KEYWORD +
        features['tld'] * config.WEIGHT_TLD +
        features['structure'] * config.WEIGHT_STRUCTURE +
        features['similarity'] * config.WEIGHT_SIMILARITY
    )

    # Apply safety penalty
    total -= features['safety'] * config.WEIGHT_SAFETY_PENALTY

    # Clamp to [0, 1]
    total = max(0.0, min(1.0, total))

    return total, features


if __name__ == '__main__':
    for d in ['pornhub.com', 'github.com', 'xvideosx.xxx', 'recovery.support',
              'pornhob.com', 'example-色情.cn', 'something-archive-2024.com']:
        s, f = score_domain(d)
        print(f"{d}: score={s:.3f} {f}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/curation && python test_scorer.py`

Expected: `All tests passed.`

- [ ] **Step 5: Commit**

```bash
git add scripts/curation/scorer.py scripts/curation/test_scorer.py
git commit -m "feat(curation): add heuristic scorer with TDD tests"
```

---

## Task 4: Update Module

**Files:**
- Create: `scripts/curation/update_hosts.py`

**Context:** Appends auto-merged domains to HOSTS.txt, regenerates blocklist.json, writes review queue.

- [ ] **Step 1: Write update_hosts.py**

```python
"""Update HOSTS.txt, regenerate blocklist.json, write review queue."""

import json
from datetime import datetime, timezone
from pathlib import Path

import config


def load_existing_hosts_set() -> set[str]:
    """Load existing domains from HOSTS.txt."""
    path = Path(config.HOSTS_FILE)
    if not path.exists():
        return set()
    from ingest import normalize_domain
    domains = set()
    for line in path.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or line.startswith('0.0.0.0') is False:
            # Accept both '0.0.0.0 domain' and 'domain' formats
            if line.startswith('0.0.0.0') or line.startswith('127.0.0.1'):
                parts = line.split()
                if len(parts) >= 2:
                    d = normalize_domain(parts[1])
                    if d:
                        domains.add(d)
            elif '.' in line and not line.startswith('#'):
                d = normalize_domain(line)
                if d:
                    domains.add(d)
    return domains


def update_hosts(new_domains: set[str]) -> int:
    """Append new domains to HOSTS.txt. Returns count added."""
    path = Path(config.HOSTS_FILE)
    existing = load_existing_hosts_set()
    to_add = new_domains - existing
    if not to_add:
        return 0

    with path.open('a', encoding='utf-8') as f:
        f.write(f"\n# Auto-curated by ML pipeline on {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n")
        for d in sorted(to_add):
            f.write(f"0.0.0.0 {d}\n")
    return len(to_add)


def regenerate_blocklist_json() -> int:
    """Regenerate blocklist.json (plain domain array for extension)."""
    domains = sorted(load_existing_hosts_set())
    with open(config.BLOCKLIST_JSON, 'w', encoding='utf-8') as f:
        json.dump(domains, f, ensure_ascii=False, separators=(',', ':'))
    return len(domains)


def write_review_queue(review_items: list[tuple[str, float, str]]) -> None:
    """Write REVIEW_QUEUE.md with medium-confidence domains."""
    path = Path(config.REVIEW_QUEUE_FILE)
    with path.open('w', encoding='utf-8') as f:
        f.write("# Domain Review Queue\n\n")
        f.write(f"_Auto-generated by ML curation pipeline on {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}_\n\n")
        f.write("These domains scored between the review threshold and the auto-merge threshold.\n")
        f.write("A human maintainer should review and either add to `data/HOSTS.txt` or reject.\n\n")
        f.write("| Domain | Score | Source |\n")
        f.write("|--------|------:|--------|\n")
        for domain, score, source in sorted(review_items, key=lambda x: -x[1]):
            short_source = source if len(source) < 60 else source[:57] + "..."
            f.write(f"| `{domain}` | {score:.2f} | {short_source} |\n")
```

- [ ] **Step 2: Verify module imports without error**

Run: `cd scripts/curation && python -c "import update_hosts; print('OK')"`

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/curation/update_hosts.py
git commit -m "feat(curation): add update module for HOSTS.txt and review queue"
```

---

## Task 5: Pipeline Orchestrator

**Files:**
- Create: `scripts/curation/pipeline.py`

**Context:** Runs the full ingest → score → update sequence.

- [ ] **Step 1: Write pipeline.py**

```python
"""Orchestrate the full curation pipeline.

Run via: python pipeline.py [--dry-run]
"""

import argparse
import sys
from pathlib import Path

# Allow running from scripts/curation/ directory
sys.path.insert(0, str(Path(__file__).parent))

import config
import ingest
import scorer
import update_hosts


def run(dry_run: bool = False) -> int:
    print(f"[pipeline] Starting curation {'(DRY RUN) ' if dry_run else ''}...")
    print(f"[pipeline] Thresholds: auto-merge>={config.AUTO_MERGE_THRESHOLD}, "
          f"review>={config.REVIEW_THRESHOLD}")

    # Step 1: Ingest
    candidates = list(ingest.ingest_all())
    print(f"[pipeline] Ingested {len(candidates)} candidate domains")

    # Step 2: Score
    scored = []
    for domain, source in candidates:
        s, features = scorer.score_domain(domain)
        scored.append((domain, s, source, features))

    # Step 3: Route
    auto_merge = [d for d, s, _, _ in scored if s >= config.AUTO_MERGE_THRESHOLD]
    review = [(d, s, src) for d, s, src, _ in scored
              if config.REVIEW_THRESHOLD <= s < config.AUTO_MERGE_THRESHOLD]
    rejected = [d for d, s, _, _ in scored if s < config.REVIEW_THRESHOLD]

    print(f"[pipeline] Auto-merge: {len(auto_merge)} | Review: {len(review)} | Rejected: {len(rejected)}")

    if dry_run:
        print("\n[dry-run] Would auto-merge:")
        for d in sorted(auto_merge)[:20]:
            print(f"  + {d}")
        if len(auto_merge) > 20:
            print(f"  ... and {len(auto_merge) - 20} more")
        print("\n[dry-run] Would add to review queue:")
        for d, s, src in sorted(review, key=lambda x: -x[1])[:20]:
            print(f"  ? {d} (score={s:.2f})")
        if len(review) > 20:
            print(f"  ... and {len(review) - 20} more")
        return 0

    # Step 4: Update
    if auto_merge:
        added = update_hosts.update_hosts(set(auto_merge))
        print(f"[pipeline] Added {added} domains to HOSTS.txt")

    total = update_hosts.regenerate_blocklist_json()
    print(f"[pipeline] Regenerated blocklist.json ({total} domains total)")

    if review:
        update_hosts.write_review_queue(review)
        print(f"[pipeline] Wrote {len(review)} domains to review queue")
    else:
        # Clear stale review queue
        Path(config.REVIEW_QUEUE_FILE).write_text(
            "# Domain Review Queue\n\n_No domains currently pending review._\n"
        )

    print("[pipeline] Done.")
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ML domain curation pipeline')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes without writing')
    args = parser.parse_args()
    sys.exit(run(dry_run=args.dry_run))
```

- [ ] **Step 2: Test with dry run**

Run: `cd scripts/curation && python pipeline.py --dry-run`

Expected: Prints candidate counts, would-merge list, would-review list. No files written.

- [ ] **Step 3: Commit**

```bash
git add scripts/curation/pipeline.py
git commit -m "feat(curation): add pipeline orchestrator with dry-run support"
```

---

## Task 6: GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/curation.yml`

- [ ] **Step 1: Write curation.yml**

```yaml
name: ML Domain Curation

on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday midnight UTC
  workflow_dispatch:       # Manual trigger

permissions:
  contents: write

jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Run curation pipeline
        run: |
          python scripts/curation/pipeline.py --dry-run > /tmp/dryrun.log 2>&1 || true
          cat /tmp/dryrun.log
          python scripts/curation/pipeline.py

      - name: Commit changes
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/HOSTS.txt data/REVIEW_QUEUE.md blocklist.json
          if git diff --cached --quiet; then
            echo "No changes to commit"
          else
            git commit -m "chore(curation): auto-update blocklist [$(date -u +%Y-%m-%d)]"
            git push
          fi

      - name: Create PR for review items
        if: always()
        run: |
          # If review queue is non-empty, the maintainer will create a PR via the
          # GitHub UI to review REVIEW_QUEUE.md. The auto-commit only contains
          # high-confidence domains.
          echo "Review queue: data/REVIEW_QUEUE.md (open a PR to review if non-empty)"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/curation.yml
git commit -m "ci(curation): add weekly GitHub Actions workflow for ML curation"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 8 spec sections map to tasks (config, ingest, scorer, update, pipeline, workflow, tests, files).
- [x] **No placeholders:** All code blocks are complete and runnable.
- [x] **Type consistency:** `ingest_all()` returns `(domain, source)` tuples, `score_domain()` returns `(score, features)`, all used consistently.
- [x] **TDD:** Tests written before scorer implementation (Task 3).
- [x] **Frequent commits:** Each task ends with a commit.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-06-ml-domain-curation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session with checkpoints

Which approach?
