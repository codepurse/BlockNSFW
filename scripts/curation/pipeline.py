"""Orchestrate the full curation pipeline.

Run from repo root:
    python scripts/curation/pipeline.py [--dry-run]

The pipeline:
  1. Ingests candidate domains from external feeds + user reports
  2. Scores each candidate with the heuristic scorer
  3. Routes:
     - score >= AUTO_MERGE_THRESHOLD  -> append to data/HOSTS.txt
     - an adult AI service (scorer.ai_kind) below that -> data/REVIEW_AI.md,
       with evidence from other lists and Cloudflare for Families
     - REVIEW_THRESHOLD <= score < AUTO_MERGE_THRESHOLD -> write to REVIEW_QUEUE.md
     - score < REVIEW_THRESHOLD  -> reject (drop)
  4. Regenerates blocklist.json (plain sorted domain array for the extension)

    python scripts/curation/pipeline.py --ai-review-only

rewrites data/REVIEW_AI.md and nothing else. Marked lines there go into
HOSTS.txt with scripts/curation/apply_review.py.
"""

import argparse
import os
import sys
from pathlib import Path


def _setup_cwd() -> Path:
    """Chdir to the repo root so relative paths in config.py resolve correctly.

    Repo root is the parent of the directory containing this file.
    """
    repo_root = Path(__file__).resolve().parent.parent.parent
    os.chdir(repo_root)
    return repo_root


def write_ai_review(ai_items: list[tuple[str, float, str, str]]) -> None:
    """Gather evidence for the AI review items and write REVIEW_AI.md."""
    print(f"[pipeline]   -> Checking {len(ai_items)} AI sites against other lists and Cloudflare for Families...")
    found = evidence.gather([d for d, _, _, _ in ai_items])
    counts = update_hosts.write_ai_review([(d, src, kind) for d, _, src, kind in ai_items], found)
    print(f"[pipeline]   -> Wrote {counts['written']} sites to {config.REVIEW_AI_FILE} "
          f"({counts['premarked']} arrive marked [x], {counts['kept_marks']} kept their marks, "
          f"{counts['offline']} left off with no address)")


def run(dry_run: bool = False, ai_review_only: bool = False) -> int:
    """Run the full pipeline. Returns 0 on success."""
    repo_root = _setup_cwd()
    print(f"[pipeline] Repo root: {repo_root}")
    print(f"[pipeline] Mode: {'DRY RUN' if dry_run else 'AI REVIEW ONLY' if ai_review_only else 'WRITE'}")
    print(f"[pipeline] Thresholds: auto-merge>={config.AUTO_MERGE_THRESHOLD}, "
          f"review>={config.REVIEW_THRESHOLD}")

    # Step 1: Ingest candidates
    print("\n[pipeline] Step 1/4: Ingesting candidates from external feeds and user reports...")
    candidates = list(ingest.ingest_all())
    print(f"[pipeline]   -> {len(candidates)} candidate domains")

    # Step 2: Score
    print("\n[pipeline] Step 2/4: Scoring candidates...")
    scored: list[tuple[str, float, str, dict]] = []
    for domain, source in candidates:
        s, features = scorer.score_domain(domain)
        scored.append((domain, s, source, features))

    # Step 3: Route by threshold
    print("\n[pipeline] Step 3/4: Routing by score threshold...")
    auto_merge = [d for d, s, _, _ in scored if s >= config.AUTO_MERGE_THRESHOLD]
    ai_items = [
        (d, s, src, f['ai_kind']) for d, s, src, f in scored
        if f.get('ai_kind') and s < config.AUTO_MERGE_THRESHOLD
    ]
    review_items = [
        (d, s, src) for d, s, src, f in scored
        if config.REVIEW_THRESHOLD <= s < config.AUTO_MERGE_THRESHOLD and not f.get('ai_kind')
    ]
    rejected = [d for d, s, _, _ in scored if s < config.REVIEW_THRESHOLD]
    print(f"[pipeline]   -> auto-merge: {len(auto_merge)}")
    print(f"[pipeline]   -> AI review list: {len(ai_items)}")
    print(f"[pipeline]   -> review queue: {len(review_items)}")
    print(f"[pipeline]   -> rejected: {len(rejected)}")

    if ai_review_only:
        print("\n[pipeline] Writing the AI review list only...")
        write_ai_review(ai_items)
        print("\n[pipeline] Done.")
        return 0

    if dry_run:
        print("\n[DRY-RUN] Would auto-merge (showing first 20):")
        for d in sorted(auto_merge)[:20]:
            print(f"  + {d}")
        if len(auto_merge) > 20:
            print(f"  ... and {len(auto_merge) - 20} more")

        print("\n[DRY-RUN] Would add to review queue (showing first 20):")
        for d, s, src in sorted(review_items, key=lambda x: (-x[1], x[0]))[:20]:
            short_src = src if len(src) < 50 else src[:47] + "..."
            print(f"  ? {d} (score={s:.2f}, src={short_src})")
        if len(review_items) > 20:
            print(f"  ... and {len(review_items) - 20} more")

        print("\n[DRY-RUN] Would add to the AI review list (showing first 20):")
        for d, _, src, kind in sorted(ai_items, key=lambda x: (x[3], x[0]))[:20]:
            print(f"  ? {d} ({kind}, src={src})")
        if len(ai_items) > 20:
            print(f"  ... and {len(ai_items) - 20} more")

        print("\n[DRY-RUN] No files written.")
        return 0

    # Step 4: Update artifacts
    print("\n[pipeline] Step 4/4: Writing artifacts...")
    if auto_merge:
        added = update_hosts.update_hosts(set(auto_merge))
        print(f"[pipeline]   -> Added {added} domains to {config.HOSTS_FILE}")
    else:
        print(f"[pipeline]   -> No auto-merge domains (no changes to {config.HOSTS_FILE})")

    total = update_hosts.regenerate_blocklist_json()
    print(f"[pipeline]   -> Regenerated {config.BLOCKLIST_JSON} ({total} total domains)")

    update_hosts.write_review_queue(review_items)
    if review_items:
        print(f"[pipeline]   -> Wrote {len(review_items)} domains to {config.REVIEW_QUEUE_FILE}")
    else:
        print(f"[pipeline]   -> Cleared {config.REVIEW_QUEUE_FILE} (no items pending)")

    write_ai_review(ai_items)

    print("\n[pipeline] Done.")
    return 0


# Import siblings AFTER _setup_cwd is defined (so chdir happens before they load)
# but BEFORE run() is called.
# The imports must happen at module level for `python -c` to work, but they use
# config.HOSTS_FILE etc. which are path strings — those don't read files. So the
# import order is safe.
import config  # noqa: E402
import evidence  # noqa: E402
import ingest  # noqa: E402
import scorer  # noqa: E402
import update_hosts  # noqa: E402


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='ML domain curation pipeline for BlockNSFW'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without writing to files'
    )
    parser.add_argument(
        '--ai-review-only',
        action='store_true',
        help='Rewrite data/REVIEW_AI.md and nothing else'
    )
    args = parser.parse_args()
    sys.exit(run(dry_run=args.dry_run, ai_review_only=args.ai_review_only))
