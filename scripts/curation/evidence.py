"""Evidence for the AI review list: who else lists a domain, and what
Cloudflare for Families says about it.

Nothing here decides anything. It gives the person marking the list what they
need without opening the sites: a nudify site that two other lists carry and
Cloudflare blocks is an easy yes; one nobody else has needs a closer look; one
with no address is gone and is left off until it comes back.
"""

import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import config
import ingest

# Cloudflare for Families answers this for a domain it blocks.
BLOCKED_ADDRESS = '0.0.0.0'


def listed_in_evidence_feeds(domains: set[str]) -> dict[str, list[str]]:
    """Map each domain to the short names of the evidence feeds listing it
    (or a parent of it). A feed that fails to load is skipped."""
    found: dict[str, list[str]] = {d: [] for d in domains}
    for feed in config.EVIDENCE_FEEDS:
        listed = set(ingest.fetch_feed(feed['url'], feed['format']))
        if not listed:
            continue
        for d in domains:
            if ingest.is_covered(d, listed):
                found[d].append(feed['short'])
    return found


def family_verdict(domain: str) -> str:
    """'blocks', 'allows', 'gone' (no such domain, or no address) or
    'unknown' (the lookup failed)."""
    query = urllib.parse.urlencode({'name': domain, 'type': 'A'})
    req = urllib.request.Request(
        f"{config.FAMILY_DOH_URL}?{query}",
        headers={'Accept': 'application/dns-json', 'User-Agent': 'BlockNSFW-Curation/1.0'},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            answer = json.loads(response.read().decode('utf-8'))
    except Exception:
        return 'unknown'
    status = answer.get('Status')
    if status == 3:
        return 'gone'
    if status != 0:
        return 'unknown'
    addresses = [a.get('data') for a in answer.get('Answer') or [] if a.get('type') == 1]
    if not addresses:
        return 'gone'
    return 'blocks' if BLOCKED_ADDRESS in addresses else 'allows'


def family_verdicts(domains: list[str]) -> dict[str, str]:
    """family_verdict for many domains, a few at a time."""
    with ThreadPoolExecutor(max_workers=config.FAMILY_DOH_WORKERS) as pool:
        return dict(zip(domains, pool.map(family_verdict, domains)))


def gather(domains: list[str]) -> dict[str, dict]:
    """{domain: {'lists': ['HZ', 'OI'], 'family': 'blocks'}} for each domain."""
    unique = sorted(set(domains))
    lists = listed_in_evidence_feeds(set(unique))
    family = family_verdicts(unique)
    return {d: {'lists': lists.get(d, []), 'family': family.get(d, 'unknown')} for d in unique}
