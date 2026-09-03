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

## Machine Learning Models

### NSFW.js / MobileNetV2 (bundled)

The default image classifier is the NSFW.js MobileNetV2 model
(`nsfwjs/model.json` + `nsfwjs/group1-shard1of1.bin`), from
[infinitered/nsfwjs](https://github.com/infinitered/nsfwjs) — MIT licensed.
The CSP-safe runtime shim in `vendor/nsfwjs/nsfwjs.runtime.js` and the
TensorFlow.js build in `vendor/tfjs/tf.es2017.js` come from the same upstream
family (nsfwjs, MIT; TensorFlow.js, Apache-2.0).

### Marqo NSFW Image Detection 384 (optional, downloaded)

The optional "Vision Transformer (ViT-384)" classifier is
[Marqo/nsfw-image-detection-384](https://huggingface.co/Marqo/nsfw-image-detection-384),
a `vit_tiny_patch16_384` fine-tune published under the **Apache License 2.0**.

- The execution graph (`models/vit384/model.json`) is converted from the
  upstream Hugging Face weights by `tools/convert_vit384.py` and ships in the
  extension package.
- The weight shards are **not** bundled. They are published separately (see
  `VIT384_WEIGHTS_BASE_URL` in `shared/ai-image-models.js`) and downloaded once
  on first use, then cached locally by the browser.

Attribution and the Apache-2.0 terms travel with the converted artifacts.
Conversion is a format change only — no retraining, no weight modification.

Verified note:

- The `nsfw-filter/nsfw-filter` browser extension also ships this model and
  informed the approach taken here (a tfjs GraphModel rather than ONNX
  Runtime). That project is **GPL-3.0** and this one is MIT, so none of its
  code or its converted artifacts are used: the model is converted from the
  Apache-2.0 Hugging Face source independently.

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
