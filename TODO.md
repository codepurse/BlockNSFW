# Remaining Tasks — ML Domain Curation Pipeline

This is the running checklist of remaining work for the BlockNSFW ML Domain Curation Pipeline. Track progress here between sessions.

---

## P0 — Critical (Pipeline Won't Run Without These)

- [x] **Task 5: Pipeline Orchestrator** — Create `scripts/curation/pipeline.py`
  - Wires ingest → score → update into one command
  - Supports `--dry-run` flag for previewing changes
  - Prints summary (auto-merge / review / reject counts)
  - Exit codes: 0 on success, non-zero on failure
  - Commit: `feat(curation): add pipeline orchestrator with dry-run support`

- [x] **Task 6: GitHub Actions Workflow** — Create `.github/workflows/curation.yml`
  - Runs every Sunday at 00:00 UTC (`cron: '0 0 * * 0'`)
  - Manual trigger via `workflow_dispatch`
  - Sets up Python 3.12, runs `pipeline.py`, commits changes
  - Permissions: `contents: write` for auto-commit
  - Commit: `ci(curation): add weekly GitHub Actions workflow`

- [x] **Dry-run test** — Run `python scripts/curation/pipeline.py --dry-run` from repo root
  - Should print: ingest count, scoring distribution, sample merges
  - Should NOT modify any files
  - Verify the output makes sense (some AUTO, some REVIEW, lots of REJECT)

---

## P1 — Important (Quality / Cleanup)

- [x] **Fix dead feed URL** — `chadmayfield/pihole-blocklists/master/lists/porn.txt` returns 404
  - Edit `scripts/curation/config.py`
  - Remove the dead URL or replace with a working mirror
  - Re-run `test_e2e.py` to confirm no more 404 warnings
  - Commit: `fix(curation): remove dead external feed URL`

- [x] **Add `.gitignore` entry for `__pycache__/`**
  - Create or update `.gitignore` at repo root
  - Add these lines:
    ```
    # Python
    __pycache__/
    *.pyc
    *.pyo
    ```
  - Remove tracked `scripts/curation/__pycache__/` if present: `git rm -r --cached scripts/curation/__pycache__/`
  - Commit: `chore: ignore Python cache files`

- [ ] **Commit the design docs and test file**
  - `docs/superpowers/specs/2026-06-06-ml-domain-curation-design.md`
  - `docs/superpowers/plans/2026-06-06-ml-domain-curation.md`
  - `scripts/curation/test_e2e.py`
  - Single commit: `docs(curation): add design spec, implementation plan, and e2e test`

---

## P2 — Nice to Have (Improvements)

- [ ] **Improve feed quality** — Steven Black feed has many non-adult domains (CDN/analytics)
  - Research better-curated NSFW-only feeds
  - Candidates to evaluate:
    - `https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/nocoin.txt` (verify NSFW relevance)
    - Community-curated NSFW-specific lists on GitHub
  - Add best one to `EXTERNAL_FEEDS` in `config.py`
  - Commit: `feat(curation): add higher-quality NSFW feed`

- [ ] **Add a "known good" sample test** to `test_e2e.py`
  - Add a list of ~20 domains that MUST be rejected (e.g., `paypal.com`, `amazon.com`, `microsoft.com`)
  - Add a list of ~10 domains that MUST be auto-merged (sample from existing blocklist)
  - Asserts serve as regression tests for the scorer
  - Commit: `test(curation): add regression test with known good/bad domains`

- [ ] **Add WHOIS age check** (future enhancement per spec)
  - Newly registered domains (< 90 days) are higher risk
  - Would require a free WHOIS API (e.g., RDAP)
  - Out of scope unless you want to add it

- [ ] **Tighten the scorer to reduce feed noise**
  - The current scorer correctly rejects CDN/analytics, but the feed stage sends 100k+ domains to be scored
  - Add a quick pre-filter in `ingest.py` to drop obvious non-adult patterns (e.g., `cdn.`, `analytics.`, `static.`, `assets.`)
  - Commit: `perf(curation): pre-filter CDN/analytics domains before scoring`

---

## P3 — Optional / Documentation

- [ ] **Add a README for the curation pipeline**
  - File: `scripts/curation/README.md`
  - Explain: what it does, how to run, how to add feeds, how to interpret scores
  - Useful for future contributors

- [ ] **Add a CHANGELOG entry**
  - Document the new pipeline feature

- [ ] **Clean up duplicate commit messages** (Task 1 and Task 2 had the same message)
  - Cosmetic, not blocking

---

## Verification Checklist (After All Tasks)

Once P0 is complete, verify:

- [ ] `python scripts/curation/test_scorer.py` → all 8 tests pass
- [ ] `python scripts/curation/test_e2e.py` → reasonable output
- [ ] `python scripts/curation/pipeline.py --dry-run` → prints summary, no files modified
- [ ] `python scripts/curation/pipeline.py` (real run) → updates `data/HOSTS.txt`, `blocklist.json`, `data/REVIEW_QUEUE.md`
- [ ] Push to GitHub, manually trigger workflow from Actions tab
- [ ] Verify the workflow runs and commits the updated blocklist
