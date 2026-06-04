# Third-Party Notices

This project depends on external services and data sources for some features.

## Blocklists and Rule Sources

### Self-hosted remote lists (this repository)

`background.js` fetches the remote blocklist and whitelist from the
maintainer-owned `codepurse/BlockNSFW` GitHub repository:

- `REMOTE_BLOCKLIST_URL` = `https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/HOSTS.txt`
- `REMOTE_WHITELIST_URL` = `https://raw.githubusercontent.com/codepurse/BlockNSFW/refs/heads/main/data/WHITELIST.txt`

These data files are committed to the same repository (under `data/`) under
the MIT License (see `data/LICENSE`). Provenance and snapshot details are
recorded in `data/SOURCE_NOTES.txt`.

### Historical upstream reference

Initial content for `data/HOSTS.txt` and `data/WHITELIST.txt` was ported from
the maintainer-owned `codepurse/BlockNSFW` repository. Snapshot details
(commit `bee0db2`, fetched 2026-06-03) are recorded in `data/SOURCE_NOTES.txt`.

### Historical / documented upstream list reference

`UPGRADE_NOTES.md` references:

- [Anti-Porn HOSTS File](https://github.com/4skinSkywalker/Anti-Porn-HOSTS-File)

Verified note:

- `4skinSkywalker/Anti-Porn-HOSTS-File` is MIT-licensed according to upstream repository license page.

If this project redistributes, snapshots, or derives data from upstream blocklists, verify license compatibility before release.

## Third-Party Services

### Cloudflare for Families

Used for optional DNS-based adult-domain filtering.

- Service: `family.cloudflare-dns.com`
- Purpose: DNS-over-HTTPS domain classification / blocking support

### Reddit

Used for optional Reddit NSFW subreddit checks.

- Purpose: determine whether subreddit is marked NSFW

### Appwrite

Used for optional manual community-report submission backend.

- Purpose: process blocked / misblocked site reports
- Client code in this repository does not prove server-side validation, rate limiting, moderation, or retention policy.
- Backend service is maintained out-of-tree and is not bundled in this client repository.

Public-launch status (as of 2026-06-03):

- The manual-report feature is shipped enabled and points at the Appwrite
  Function URL configured in `appwrite-client.js`.
- Client-side controls present: 120s per-report cooldown, 5 reports / day
  limit, dedupe by `reportKey`, allowed `reportType` / `category` whitelist,
  and a 500-character cap on user-supplied `notes`.
- Server-side controls (validation, rate limiting, abuse handling, moderation
  workflow, retention policy) are maintained outside this repo and are under
  ongoing review by the project maintainer.
- The privacy policy already discloses what data is sent to this backend; see
  `PRIVACY_POLICY.md` section "Manual User Reports to Our Appwrite-Hosted
  Backend" and the "Data Retention" section.
- Users who do not want to use this feature can simply not submit reports;
  no automatic background traffic is sent to the backend.

## Maintainer Note

Before public launch:

- confirm Appwrite backend server-side controls (validation, rate limiting,
  abuse handling, moderation, retention) are operating per the public-launch
  status note in the Appwrite section above
