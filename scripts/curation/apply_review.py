"""Apply the marks in the AI review list.

Run from repo root after marking data/REVIEW_AI.md:
    python scripts/curation/apply_review.py [--dry-run]

  [x]  block it      -> appended to data/HOSTS.txt
  [-]  leave it out  -> appended to data/REVIEW_REJECTED.txt (never proposed again)
  [ ]  not decided   -> stays in the list

Then it regenerates blocklist.json and the static ruleset
(rules/blocklist-rules.json), as the weekly workflow does after a run.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


def run(dry_run: bool = False) -> int:
    repo_root = Path(__file__).resolve().parent.parent.parent
    os.chdir(repo_root)

    marks = update_hosts.read_review_marks(config.REVIEW_AI_FILE)
    block = {d for d, m in marks.items() if m == update_hosts.BLOCK_MARK}
    leave_out = {d for d, m in marks.items() if m == update_hosts.LEAVE_OUT_MARK}
    undecided = len(marks) - len(block) - len(leave_out)
    print(f"[apply] {config.REVIEW_AI_FILE}: {len(block)} to block, "
          f"{len(leave_out)} to leave out, {undecided} not decided yet")

    if dry_run:
        for d in sorted(block):
            print(f"  + {d}")
        for d in sorted(leave_out):
            print(f"  - {d}")
        print("[apply] DRY RUN: nothing written.")
        return 0
    if not block and not leave_out:
        print("[apply] Nothing marked; nothing to do.")
        return 0

    added = update_hosts.update_hosts(block, comment='Reviewed: adult AI services (data/REVIEW_AI.md)')
    print(f"[apply] Added {added} domains to {config.HOSTS_FILE}")
    rejected = update_hosts.add_rejected(leave_out)
    print(f"[apply] Added {rejected} domains to {config.REVIEW_REJECTED_FILE}")
    update_hosts.remove_review_lines(config.REVIEW_AI_FILE, block | leave_out)

    total = update_hosts.regenerate_blocklist_json()
    print(f"[apply] Regenerated {config.BLOCKLIST_JSON} ({total} total domains)")
    try:
        subprocess.run(['node', 'scripts/build-dnr-ruleset.mjs'], check=True)
        print("[apply] Rebuilt rules/blocklist-rules.json")
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"[apply] Could not rebuild the ruleset ({e}); run: node scripts/build-dnr-ruleset.mjs")
        return 1
    return 0


sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import update_hosts  # noqa: E402


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Apply the marks in data/REVIEW_AI.md')
    parser.add_argument('--dry-run', action='store_true', help='Show what would change')
    args = parser.parse_args()
    sys.exit(run(dry_run=args.dry_run))
