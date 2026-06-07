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


def score_similarity(domain: str) -> float:
    """Score based on similarity to known adult brands (0-1)."""
    label = _extract_core_label(domain)

    # Check n-gram overlap with existing blocklist
    existing = ingest.load_existing_hosts()
    if not existing:
        return 0.0

    max_overlap = 0.0
    for blocked in list(existing)[:500]:  # sample for performance
        blocked_label = _extract_core_label(blocked)
        overlap = _ngram_overlap(label, blocked_label)
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
    features = {
        'keyword': score_keyword(domain),
        'tld': score_tld(domain),
        'structure': score_structure(domain),
        'similarity': score_similarity(domain),
        'safety': score_safety(domain),
    }

    # Whitelist or safe token forces zero
    if features['safety'] >= 1.0:
        return 0.0, features

    # Weighted sum of features
    weighted = (
        features['keyword'] * config.WEIGHT_KEYWORD +
        features['tld'] * config.WEIGHT_TLD +
        features['structure'] * config.WEIGHT_STRUCTURE +
        features['similarity'] * config.WEIGHT_SIMILARITY
    )

    # Trust a single strong signal: any one feature being very strong is enough
    # to classify the domain as adult. This handles the case where a strong
    # keyword, TLD, or typosquat alone should produce a high score, even when
    # the weighted sum is modest.
    strongest = max(
        features['keyword'],
        features['tld'],
        features['structure'],
        features['similarity'],
    )
    single_signal = strongest * 0.8

    total = max(weighted, single_signal)

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
