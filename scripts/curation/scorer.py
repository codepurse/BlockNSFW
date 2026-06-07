"""Heuristic domain scorer.

Computes a 0-1 score indicating likelihood the domain hosts adult content.
"""

import re

import config
import ingest


def _extract_core_label(domain: str) -> str:
    """Get the deepest subdomain label (usually the brand name)."""
    parts = domain.split('.')
    # Skip ccTLD and TLD (last 2 parts typically)
    if len(parts) >= 3:
        return parts[-3]
    return parts[0]


def _ngram_overlap(a: str, b: str, n: int = 3) -> float:
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
        kw_lower = kw.lower()
        if _is_hyphen_bounded(label, kw_lower) or kw_lower in label:
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

    # Random-looking (no vowels in long segments)
    if len(label) > 8 and not re.search(r'[aeiouy]', label):
        score += 0.3

    return min(score, 1.0)


_SIMILARITY_SAMPLE = None
_SIMILARITY_SAMPLE_PRECOMPUTED = None

def get_similarity_sample() -> list[str]:
    global _SIMILARITY_SAMPLE
    if _SIMILARITY_SAMPLE is None:
        existing = ingest.load_existing_hosts()
        if existing:
            _SIMILARITY_SAMPLE = list(existing)[:500]
        else:
            _SIMILARITY_SAMPLE = []
    return _SIMILARITY_SAMPLE


def get_similarity_sample_precomputed() -> list[tuple[str, set[str], int]]:
    global _SIMILARITY_SAMPLE_PRECOMPUTED
    if _SIMILARITY_SAMPLE_PRECOMPUTED is None:
        sample = get_similarity_sample()
        precomputed = []
        for blocked in sample:
            blocked_label = _extract_core_label(blocked)
            if len(blocked_label) >= 3:
                grams = {blocked_label[i:i + 3] for i in range(len(blocked_label) - 3 + 1)}
            else:
                grams = set()
            precomputed.append((blocked_label, grams, len(grams)))
        _SIMILARITY_SAMPLE_PRECOMPUTED = precomputed
    return _SIMILARITY_SAMPLE_PRECOMPUTED


def score_similarity(domain: str) -> float:
    """Score based on similarity to known adult brands (0-1)."""
    label = _extract_core_label(domain)

    # Precompute n-grams of label
    if len(label) >= 3:
        grams_label = {label[i:i + 3] for i in range(len(label) - 3 + 1)}
    else:
        return 0.0

    len_label = len(grams_label)
    if len_label == 0:
        return 0.0

    # Check n-gram overlap with existing blocklist
    sample_precomputed = get_similarity_sample_precomputed()
    if not sample_precomputed:
        return 0.0

    max_overlap = 0.0
    for blocked_label, grams_blocked, len_blocked in sample_precomputed:
        if len_blocked == 0:
            continue

        # Quick upper bound check: max possible overlap is min(len_label, len_blocked) / max(len_label, len_blocked)
        if min(len_label, len_blocked) / max(len_label, len_blocked) <= max_overlap:
            continue

        intersection_len = len(grams_label & grams_blocked)
        union_len = len_label + len_blocked - intersection_len
        overlap = intersection_len / union_len if union_len else 0.0

        if overlap > max_overlap:
            max_overlap = overlap
        if max_overlap >= 0.7:
            break  # good enough

    # Check typosquat distance to top brands
    for brand in config.TOP_BRAND_DOMAINS:
        brand_label = _extract_core_label(brand)
        if abs(len(label) - len(brand_label)) > 4:
            continue
        dist = _levenshtein(label, brand_label)
        if 0 < dist <= 2:
            return max(max_overlap, 0.8)  # typosquat is strong signal

    return max_overlap


def score_safety(domain: str) -> float:
    """Safety penalty score (0-1, higher = safer, subtracted from total)."""
    domain_lower = domain.lower()

    # Check whitelist first
    whitelist = ingest.load_whitelist()
    if domain in whitelist:
        return 1.0  # force zero

    # Check safe tokens — any safe token (e.g. recovery, help, support) forces zero
    for token in config.SAFE_HOST_TOKENS:
        if token in domain_lower:
            return 1.0  # force zero

    return 0.0


def score_domain(domain: str) -> tuple[float, dict]:
    """Compute final 0-1 score for a domain. Returns (score, feature_dict)."""
    # Check safety first
    safety = score_safety(domain)
    if safety >= 1.0:
        return 0.0, {
            'keyword': 0.0,
            'tld': 0.0,
            'structure': 0.0,
            'similarity': 0.0,
            'safety': 1.0,
        }

    keyword = score_keyword(domain)
    tld = score_tld(domain)
    structure = score_structure(domain)

    # If keyword < 0.5 and partial_score < 0.25, similarity can never push it above 0.50 (REVIEW_THRESHOLD)
    partial_score = (
        keyword * config.WEIGHT_KEYWORD +
        tld * config.WEIGHT_TLD +
        structure * config.WEIGHT_STRUCTURE
    )

    if keyword < 0.5 and partial_score < 0.25:
        # Guaranteed to be rejected, skip expensive similarity check
        similarity = 0.0
    else:
        similarity = score_similarity(domain)

    features = {
        'keyword': keyword,
        'tld': tld,
        'structure': structure,
        'similarity': similarity,
        'safety': safety,
    }

    # Weighted sum of features
    weighted = (
        features['keyword'] * config.WEIGHT_KEYWORD +
        features['tld'] * config.WEIGHT_TLD +
        features['structure'] * config.WEIGHT_STRUCTURE +
        features['similarity'] * config.WEIGHT_SIMILARITY
    )

    # A strong keyword match is a direct signal that the domain itself hosts
    # adult content, so it earns auto-merge. High similarity alone only means
    # the domain co-occurs in adult feeds (CDNs, analytics, accidental
    # neighbors) and is not sufficient evidence to classify a domain as adult.
    if features['keyword'] >= 0.9:
        # Strong keyword (e.g. 'porn', 'xxx', 'hentai'): trust it.
        total = max(weighted, 0.9)
    elif features['keyword'] >= 0.5:
        # Multilingual or weaker keyword: review level, not auto-merge.
        total = max(weighted, features['keyword'] * 0.9)
    else:
        # No keyword signal: rely on the weighted sum, which will be low.
        total = weighted

    # Apply safety penalty (for any partial-safety scoring in the future)
    total -= features['safety'] * config.WEIGHT_SAFETY_PENALTY

    # Clamp to [0, 1]
    total = max(0.0, min(1.0, total))

    return total, features


if __name__ == '__main__':
    for d in ['pornhub.com', 'github.com', 'xvideosx.xxx', 'recovery.support',
              'pornhob.com', 'example-色情.cn', 'something-archive-2024.com']:
        s, f = score_domain(d)
        print(f"{d}: score={s:.3f} {f}")
