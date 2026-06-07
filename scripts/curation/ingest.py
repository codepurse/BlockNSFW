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
    """Normalize a domain: lowercase, strip www., validate."""
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
        req = urllib.request.Request(url, headers={'User-Agent': 'BlockNSFW-Curation/1.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
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
        line = line.strip()
        if not line or line.startswith('#'):
            continue
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
            items = data if isinstance(data, list) else [data]
            for item in items:
                d = normalize_domain(item.get('domain', ''))
                if d:
                    domains.append(d)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
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
        # Shorten URL for display
        short = src if len(src) < 60 else src[:57] + "..."
        sources[short] = sources.get(short, 0) + 1
    for src, count in sources.items():
        print(f"  {src}: {count}")
