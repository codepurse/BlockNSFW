"""End-to-end sanity test for curation modules.

Run from repo root: python scripts/curation/test_e2e.py
"""

import sys
from pathlib import Path

# Add curation dir to path
sys.path.insert(0, str(Path(__file__).parent))

import config
import ingest
import scorer
import update_hosts


def main():
    print(f"[e2e] Loading existing blocklist from {config.HOSTS_FILE}")
    existing = update_hosts.load_existing_hosts_set()
    print(f"[e2e] {len(existing)} domains already blocked")

    print(f"[e2e] Loading whitelist from {config.WHITELIST_FILE}")
    whitelist = ingest.load_whitelist()
    print(f"[e2e] {len(whitelist)} domains whitelisted")

    # Take a small sample from existing hosts to score (faster than fetching feeds)
    sample = list(existing)[:30]
    print(f"\n[e2e] Scoring {len(sample)} known-blocked domains (should be mostly high):\n")
    for d in sorted(sample)[:10]:
        s, f = scorer.score_domain(d)
        print(f"  {d}: {s:.3f}  kw={f['keyword']:.2f} tld={f['tld']:.2f} sim={f['similarity']:.2f} safety={f['safety']:.2f}")

    # Test on a few known-benign domains
    print(f"\n[e2e] Scoring known-benign domains (should be mostly low):\n")
    benign = ['google.com', 'wikipedia.org', 'github.com', 'stackoverflow.com',
              'mozilla.org', 'recoverfromporn.com', 'example.edu']
    for d in benign:
        s, f = scorer.score_domain(d)
        print(f"  {d}: {s:.3f}  kw={f['keyword']:.2f} tld={f['tld']:.2f} sim={f['similarity']:.2f} safety={f['safety']:.2f}")

    # Test ingest pipeline
    print(f"\n[e2e] Running ingest (external feeds)...")
    candidates = list(ingest.ingest_all())
    print(f"[e2e] {len(candidates)} candidate domains ingested (already filtered against blocklist+whitelist)")

    if candidates:
        # Score a small subset
        sample_size = min(20, len(candidates))
        sample = candidates[:sample_size]
        print(f"\n[e2e] Scoring {sample_size} sample candidates:\n")
        high_count = 0
        review_count = 0
        reject_count = 0
        for d, src in sample:
            s, f = scorer.score_domain(d)
            if s >= config.AUTO_MERGE_THRESHOLD:
                bucket = "AUTO"
                high_count += 1
            elif s >= config.REVIEW_THRESHOLD:
                bucket = "REVIEW"
                review_count += 1
            else:
                bucket = "REJECT"
                reject_count += 1
            print(f"  [{bucket}] {d}: {s:.3f}")
        print(f"\n[e2e] Sample distribution: auto={high_count} review={review_count} reject={reject_count}")

    print("\n[e2e] Sanity test complete.")


if __name__ == '__main__':
    main()
