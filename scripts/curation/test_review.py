"""Tests for ingest's coverage check and the AI review list round trip."""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

import config
import ingest
import update_hosts


def test_is_covered_by_a_listed_parent():
    blocked = {'example.com', 'deep.example.net'}
    assert ingest.is_covered('example.com', blocked)
    assert ingest.is_covered('ads.example.com', blocked)
    assert ingest.is_covered('a.b.deep.example.net', blocked)
    assert not ingest.is_covered('example.net', blocked)
    assert not ingest.is_covered('notexample.com', blocked)


def test_wildcard_format():
    text = "# comment\n! also a comment\n*.example.com\nplain.example.org\n\n*.bad_domain\n"
    assert ingest.parse_wildcard_format(text) == ['example.com', 'plain.example.org']


class _Files:
    """Point the review and hosts files at a temporary directory."""

    def __enter__(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.saved = (config.REVIEW_AI_FILE, config.REVIEW_REJECTED_FILE, config.HOSTS_FILE)
        config.REVIEW_AI_FILE = str(root / 'REVIEW_AI.md')
        config.REVIEW_REJECTED_FILE = str(root / 'REVIEW_REJECTED.txt')
        config.HOSTS_FILE = str(root / 'HOSTS.txt')
        Path(config.HOSTS_FILE).write_text('0.0.0.0 already.example\n', encoding='utf-8')
        return root

    def __exit__(self, *exc):
        config.REVIEW_AI_FILE, config.REVIEW_REJECTED_FILE, config.HOSTS_FILE = self.saved
        self.dir.cleanup()


ITEMS = [
    ('nudify.online', 'Block List Project', 'nudify'),
    ('kupid.ai', 'StevenBlack, Block List Project', 'ai-domain'),
    ('lonely.ai', 'Block List Project', 'ai-domain'),
    ('gone.ai', 'Block List Project', 'ai-domain'),
]
EVIDENCE = {
    'nudify.online': {'lists': ['HZ', 'OI'], 'family': 'blocks'},
    'kupid.ai': {'lists': ['HZ'], 'family': 'blocks'},
    'lonely.ai': {'lists': [], 'family': 'allows'},
    'gone.ai': {'lists': [], 'family': 'gone'},
}


def test_review_list_premarks_only_what_everything_agrees_on():
    with _Files():
        counts = update_hosts.write_ai_review(ITEMS, EVIDENCE)
        marks = update_hosts.read_review_marks(config.REVIEW_AI_FILE)
        assert marks == {'nudify.online': 'x', 'kupid.ai': 'x', 'lonely.ai': ' '}
        assert counts['offline'] == 1
        text = Path(config.REVIEW_AI_FILE).read_text(encoding='utf-8')
        assert '- [x] `nudify.online` · BLP HZ OI · Cloudflare blocks' in text
        assert '## Nudify, undress or deepfake' in text


def test_a_rerun_keeps_the_reviewers_marks():
    with _Files():
        update_hosts.write_ai_review(ITEMS, EVIDENCE)
        path = Path(config.REVIEW_AI_FILE)
        text = path.read_text(encoding='utf-8')
        text = text.replace('- [x] `kupid.ai`', '- [-] `kupid.ai`').replace('- [ ] `lonely.ai`', '- [x] `lonely.ai`')
        path.write_text(text, encoding='utf-8')
        update_hosts.write_ai_review(ITEMS, EVIDENCE)
        marks = update_hosts.read_review_marks(config.REVIEW_AI_FILE)
        assert marks == {'nudify.online': 'x', 'kupid.ai': '-', 'lonely.ai': 'x'}


def test_applying_marks_blocks_rejects_and_keeps_the_undecided():
    with _Files():
        items = ITEMS + [('later.ai', 'Block List Project', 'ai-domain')]
        found = dict(EVIDENCE, **{'later.ai': {'lists': [], 'family': 'allows'}})
        update_hosts.write_ai_review(items, found)
        path = Path(config.REVIEW_AI_FILE)
        path.write_text(path.read_text(encoding='utf-8').replace('- [x] `kupid.ai`', '- [-] `kupid.ai`'), encoding='utf-8')
        marks = update_hosts.read_review_marks(config.REVIEW_AI_FILE)
        block = {d for d, m in marks.items() if m == 'x'}
        leave_out = {d for d, m in marks.items() if m == '-'}
        assert update_hosts.update_hosts(block, comment='Reviewed') == 1
        assert update_hosts.add_rejected(leave_out) == 1
        update_hosts.remove_review_lines(config.REVIEW_AI_FILE, block | leave_out)
        assert set(update_hosts.read_review_marks(config.REVIEW_AI_FILE)) == {'lonely.ai', 'later.ai'}
        assert '0.0.0.0 nudify.online' in Path(config.HOSTS_FILE).read_text(encoding='utf-8')
        ingest.load_rejected.cache_clear()
        try:
            assert ingest.load_rejected() == {'kupid.ai'}
        finally:
            ingest.load_rejected.cache_clear()
