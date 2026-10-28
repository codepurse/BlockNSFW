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


def test_core_label_is_the_site_name():
    """The site's own name is judged, not the first label of a long host.

    Regression: ads.alphaporno.com was judged as "ads", and the 2026-10-25
    run merged none of its 875,004 candidates.
    """
    assert scorer._extract_core_label('ads.alphaporno.com') == 'alphaporno'
    assert scorer._extract_core_label('1.pornoabuelas.net') == 'pornoabuelas'
    assert scorer._extract_core_label('example.co.uk') == 'example'
    assert scorer._extract_core_label('cdn.example.com.br') == 'example'
    assert scorer._extract_core_label('example.com') == 'example'
    for d in ['ads.alphaporno.com', '1.pornoabuelas.net', '1videoporno.en.wanadoo.es']:
        s, _ = scorer.score_domain(d)
        assert s >= 0.85, f"{d} scored {s}"


def test_adult_ai_services_go_to_review():
    """Nudify, AI sex chat, AI porn and .ai addresses from the feeds are
    reviewed, never dropped and never merged on the name alone."""
    expected = {
        'nudify.online': 'nudify',
        'clothoff.net': 'nudify',
        'undress.app': 'nudify',
        'deepnude.cc': 'nudify',
        'ai-nudes.ai': 'nudify',
        'girlfriendgpt.com': 'companion',
        'aigirlfriend.example': 'companion',
        'spicychat.ai': 'companion',
        'sexbot.example': 'companion',
        'ai-sex-chat.net': 'companion',
        'nsfwchatai.example': 'companion',
        'sexai.ai': 'generator',
        'ai-lewd.example': 'generator',
        'kupid.ai': 'ai-domain',
        'nectar.ai': 'ai-domain',
    }
    for d, kind in expected.items():
        s, f = scorer.score_domain(d)
        assert f['ai_kind'] == kind, f"{d}: {f['ai_kind']}"
        assert 0.5 <= s < 0.85, f"{d} scored {s}"


def test_ai_names_with_a_strong_keyword_still_merge():
    s, f = scorer.score_domain('aipornxxx.com')
    assert f['ai_kind'] == 'generator'
    assert s >= 0.85


def test_ai_only_counts_at_the_edge_of_a_name():
    """"thaisex" and "maisexo" are not AI sex sites."""
    for d in ['thaisex.com', 'maisexo.com', 'mumbaigf.com', 'example.com', 'aidan.com']:
        assert scorer.ai_kind(d) is None, d


def test_safe_tokens_beat_the_ai_rule():
    s, f = scorer.score_domain('nudify-recovery-help.ai')
    assert s == 0.0


if __name__ == '__main__':
    test_core_label_is_the_site_name()
    test_adult_ai_services_go_to_review()
    test_ai_names_with_a_strong_keyword_still_merge()
    test_ai_only_counts_at_the_edge_of_a_name()
    test_safe_tokens_beat_the_ai_rule()
    test_strong_keyword_high_score()
    test_typosquat_high_score()
    test_whitelist_force_zero()
    test_benign_domain_low_score()
    test_multilingual_keyword_scores_high()
    test_safe_tld_penalty()
    test_high_risk_tld_boost()
    test_score_clamped_to_unit_interval()
    print("All tests passed.")
