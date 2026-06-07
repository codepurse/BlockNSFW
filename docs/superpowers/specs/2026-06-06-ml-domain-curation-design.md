# ML-Driven Domain Curation Pipeline — Design Spec

**Date:** 2026-06-06
**Status:** Draft — pending review
**Scope:** Build-step automation to improve blocklist accuracy and coverage using heuristic scoring, with zero client-side cost.

---

## 1. Problem Statement

BlockNSFW currently relies on:
- A manually curated `HOSTS.txt` blocklist
- User-submitted missed-site reports (stored in extension storage, reviewed manually)
- Keyword-based smart blocking at runtime

This process is reactive and labor-intensive. New adult domains (especially non-English mirrors and typosquats) appear faster than they can be manually reviewed and added.

**Goal:** Automate the curation pipeline so high-confidence adult domains are auto-merged into the blocklist, while medium-confidence candidates are flagged for human review — all without increasing extension bundle size, memory usage, or requiring paid APIs.

---

## 2. Constraints & Non-Goals

### Constraints
- **Zero client-side impact:** No code changes to the extension. No bundle size increase. No runtime memory increase.
- **Zero API costs:** No paid ML APIs. All processing runs in GitHub Actions (free tier).
- **Deterministic & auditable:** Scoring logic must be transparent, not a black-box model.
- **False-positive safety:** Auto-merge only when confidence is very high. Medium-confidence items require human review.
- **Privacy-preserving:** No user browsing data leaves the device. Only domain names (not URLs or content) are processed in CI.

### Non-Goals
- Real-time blocking of newly discovered domains (users get updates via the existing 12-hour remote sync)
- Image/video content classification (out of scope — this is domain-level curation only)
- Replacing the existing keyword-based smart blocking (complements it)

---

## 3. Architecture

```
GitHub Actions (scheduled weekly + manual trigger)
|
|-- Step 1: Ingest Sources
|   |-- 1a: Parse user-submitted missed-site reports
|   |-- 1b: Fetch external domain feeds (open-source blocklists)
|
|-- Step 2: Deduplicate & Filter
|   |-- Remove already-blocked domains
|   |-- Remove whitelisted domains
|   |-- Normalize (punycode, www stripping, lowercase)
|
|-- Step 3: Heuristic Scoring
|   |-- Compute score 0-1 per domain
|   |-- Features: keywords, TLD, structure, similarity, safety
|
|-- Step 4: Threshold Routing
|   |-- Score >= 0.85  → Auto-merge into HOSTS.txt
|   |-- Score 0.60-0.85 → Add to review queue (REVIEW_QUEUE.md)
|   |-- Score < 0.60   → Reject
|
|-- Step 5: Update Artifacts
|   |-- Append auto-merged domains to data/HOSTS.txt
|   |-- Regenerate blocklist.json
|   |-- Update review queue
|
|-- Step 6: Commit & Notify
    |-- If only auto-merged items: direct commit to main
    |-- If review items exist: create PR with review queue
```

---

## 4. Component Design

### 4.1 Ingestion Module (`scripts/curation/ingest.py`)

**User Reports Source**
- Reads from `data/reports/` directory (JSON/CSV files exported from extension storage)
- Expected shape: `{ domain, url, language, reason, timestamp, source }`
- Domains are extracted and normalized

**External Feeds Source**
- Configurable list of open-source blocklist URLs in `scripts/curation/config.py`
- Default feeds:
  - `https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts`
  - `https://raw.githubusercontent.com/chadmayfield/pihole-blocklists/master/lists/porn.txt`
- Each feed is parsed (hosts-file format or plain domain lists)
- Only domains not already in HOSTS.txt are kept as candidates

**Output:** List of candidate domains with provenance metadata

### 4.2 Scorer Module (`scripts/curation/scorer.py`)

Computes a composite score `[0, 1]` per domain.

#### Feature Categories

| Category | Weight | Description |
|----------|--------|-------------|
| Keyword Signals | 0.35 | Exact/hyphen-bounded matches against STRONG_HOST_KEYWORDS; multilingual keyword matches (CJK, Cyrillic, Arabic, Thai, etc.) |
| TLD Risk | 0.15 | Known adult TLDs (.xxx, .adult, .porn, .sex) get boost; benign TLDs (.edu, .gov) get penalty |
| Structural Patterns | 0.15 | Numeric prefixes/suffixes, excessive hyphens, random-looking subdomains |
| Similarity to Known Adult | 0.25 | Character n-gram overlap with existing blocklist; Levenshtein distance to known adult brands (typosquat detection) |
| Safety Signals | -0.20 | Safe-host tokens ("help", "recovery", "education"); whitelist match |

#### Scoring Rules

- Each feature returns a sub-score in `[0, 1]`
- Weighted sum is computed, then clamped to `[0, 1]`
- Safety signals subtract from the total (negative weight)
- A domain matching the whitelist gets score = 0 (force reject)

#### Typosquat Detection

- For each candidate, compute Levenshtein distance to top 50 most-blocked domains
- Distance <= 2 with high brand similarity → score boost (+0.3)
- Catches domains like `pornhob.com`, `xhamsterx.com`, `xvideosx.com`

### 4.3 Update Module (`scripts/curation/update_hosts.py`)

**Auto-merge Flow**
- Reads scorer output (domains with score >= 0.85)
- Appends to `data/HOSTS.txt` in standard hosts-file format (`0.0.0.0 <domain>`)
- Sorts and deduplicates the file
- Regenerates `blocklist.json` (plain domain array for extension fallback)

**Review Queue Flow**
- Creates/updates `data/REVIEW_QUEUE.md`
- Lists domains with score 0.60-0.85 with provenance and score
- Maintainer reviews and manually adds or rejects

### 4.4 Configuration (`scripts/curation/config.py`)

Central configuration for:
- Feed URLs and parsing rules
- Scoring weights and thresholds
- Keyword lists (synced with `shared/host-keywords.js`)
- TLD risk classifications
- Safety token lists

---

## 5. GitHub Actions Workflow (`.github/workflows/curation.yml`)

```yaml
name: ML Domain Curation

on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday midnight UTC
  workflow_dispatch:  # Manual trigger

jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: python scripts/curation/pipeline.py
      - name: Commit changes
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add data/HOSTS.txt data/REVIEW_QUEUE.md blocklist.json
          git diff --cached --quiet || git commit -m "chore: auto-curate blocklist [$(date +%Y-%m-%d)]"
          git push
```

---

## 6. Files to Create

| File | Purpose |
|------|---------|
| `scripts/curation/__init__.py` | Package marker |
| `scripts/curation/config.py` | Scoring weights, thresholds, feed URLs, keyword lists |
| `scripts/curation/ingest.py` | Feed ingestion + report parsing |
| `scripts/curation/scorer.py` | Heuristic domain scorer |
| `scripts/curation/update_hosts.py` | HOSTS.txt updater + blocklist.json generator |
| `scripts/curation/pipeline.py` | Orchestrates the full pipeline |
| `.github/workflows/curation.yml` | Scheduled GitHub Actions workflow |
| `data/REVIEW_QUEUE.md` | Human review queue (created on first run) |

---

## 7. Testing Strategy

- **Unit tests:** Each scorer feature tested individually with known good/bad domains
- **Integration test:** Full pipeline run on a small test dataset
- **Regression test:** Verify no false positives on whitelist domains
- **Threshold calibration:** Run on historical data to validate 0.85 threshold catches >95% of true adult domains

---

## 8. Success Metrics

| Metric | Target |
|--------|--------|
| Auto-merge accuracy | >99% (measured by manual spot-checks) |
| New domains discovered per week | >50 from external feeds |
| False positive rate (auto-merge) | <0.1% |
| Review queue size | <20 items per week |
| Pipeline runtime | <5 minutes in GitHub Actions |

---

## 9. Future Enhancements (Out of Scope)

- Train a lightweight scikit-learn model on scored data for improved accuracy
- Add WHOIS age check (very new domains are higher risk)
- Add DNS resolution check (NXDOMAIN = likely dead, skip)
- Community voting on review queue items via GitHub reactions