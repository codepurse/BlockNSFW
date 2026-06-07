"""Unit tests for the scorer."""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import scorer


def test_strong_keyword_high_score():
    """A domain with a strong adult keyword should score high."""
    score, features = scorer.score_domain('pornhub-example.com')
    assert score >= 0.7, f"Expected high score, got {score}"


def test_typosquat_high_score():
    """A typosquat of a known adult brand should score high."""
    score, features = scorer.score_domain('pornhob.com')  # typo of pornhub
    assert score >= 0.6, f"Expected high score, got {score}"


def test_whitelist_force_zero():
    """A domain containing a safe/recovery token should score 0."""
    score, features = scorer.score_domain('recoverfromporn.com')
    assert score == 0.0, f"Expected zero, got {score}"


def test_benign_domain_low_score():
    """A clearly benign domain should score low."""
    score, features = scorer.score_domain('github.com')
    assert score < 0.3, f"Expected low score, got {score}"


def test_multilingual_keyword_scores_high():
    """A domain with CJK adult keyword should score high."""
    score, features = scorer.score_domain('example-色情.com')
    assert score >= 0.4, f"Expected high score, got {score}"


def test_safe_tld_penalty():
    """A domain with .edu TLD should get a safety penalty."""
    score_edu, _ = scorer.score_domain('something.edu')
    score_com, _ = scorer.score_domain('something.com')
    assert score_edu <= score_com, f"edu={score_edu} should be <= com={score_com}"


def test_high_risk_tld_boost():
    """A domain with .xxx TLD should get a TLD boost."""
    score_xxx, _ = scorer.score_domain('example.xxx')
    score_com, _ = scorer.score_domain('example.com')
    assert score_xxx >= score_com, f"xxx={score_xxx} should be >= com={score_com}"


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
