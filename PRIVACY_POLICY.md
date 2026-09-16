# Privacy Policy for BlockNSFW

**Last Updated:** September 10, 2026

## Overview

BlockNSFW is a browser extension designed to block adult websites and inappropriate content for safer browsing. To do this, the extension analyzes website data in your browser, stores certain settings and logs locally on your device, and makes limited network requests only when a feature requires it.

Most filtering decisions are made locally in your browser. We do not sell personal data, do not use your data for advertising, and do not run general analytics or telemetry for ordinary extension usage.

## How We Collect and Handle Data

### Optional Privacy mode

In Settings → Protection, **Privacy mode** limits extension-initiated fetches
to the three public GitHub files for the blocklist, whitelist and version.
These downloads omit credentials and referrers, discard caller-provided
headers and reject HTTP redirects. Their hosts still receive your IP address
and ordinary connection metadata. The mode is off by default for compatibility
with existing optional features.

While on, DNS checks, Reddit API lookups, AI image scanning and model downloads,
custom list subscriptions, reports and community requests are unavailable.
Saved settings are preserved, but a built-in blocked page replaces external
or custom HTML blocked pages. Local filtering, SafeSearch and local statistics
remain available. Reload existing pages after switching the mode; requests
already sent cannot be recalled.

This is a restriction on this extension's data transfers, not anonymity for
your browser: websites you visit, browser sync, other extensions, and browser
or store updates have their own behavior. See `docs/PRIVACY_MODE.md` for the
scope and regression tests.

BlockNSFW may handle data in the following ways:

- **Automatically on-device while you browse:** the extension may access and process the URL, domain, page title, page metadata, visible text, links, and certain page element attributes in order to detect and block adult or inappropriate content.
- **When you change settings:** the extension stores your configuration and related preferences in browser extension storage on your device.
- **When optional network-based features are used:** the extension may send limited data to third-party services that help provide a feature, such as DNS filtering, rule updates, or Reddit NSFW checks.
- **When you manually submit a report:** the extension sends the information you choose to submit, along with limited technical data needed to process the report.

## Data We Handle

Depending on which features you use, BlockNSFW may handle the following categories of data:

- Website URLs and domains
- Page titles and metadata
- Visible text, links, and certain content attributes used for filtering
- Subreddit names or Reddit URLs when Reddit-related filtering is used
- Addresses of image files, when the on-device image classifier is enabled
- Extension settings and preferences
- Addresses of any rule lists you choose to subscribe to
- Whitelist entries, temporary allow-list entries, and custom block patterns
- Local blocked counts, statistics, streak data, and history summaries
- Local audit log entries for blocked pages and extension disable/enable events
- PIN or lock settings if you choose to set one
- Information submitted in a manual website report, such as a URL, domain, report type, category, and optional notes
- The text of a community story, if you choose to write and submit one
- A locally generated device identifier used to help rate-limit and de-duplicate manual reports, community stories, and story likes

## What We Do Not Collect or Do

- We do not sell your personal data.
- We do not use your data for advertising, profiling, or creditworthiness decisions.
- We do not require an account, sign-in, or payment information to use the extension.
- We do not maintain a central browsing-history database of your ordinary browsing activity on our own servers.
- We do not send automatic background telemetry about your general browsing activity to our own backend.

## What We Store Locally

BlockNSFW stores data locally in your browser extension storage on your device. This may include:

- Extension settings and preferences
- Custom block patterns and keyword settings
- Whitelist entries and temporary allow-list entries
- Cached remote blocklist and whitelist data
- Rule-list subscriptions you have added, and the rules downloaded from them
- Local blocked counts, daily history, and top blocked domains
- Local audit/history entries related to blocked pages and extension disable/enable events
- PIN or lock data if you set a PIN. The PIN is stored in your browser's
  extension storage in plain form, not hashed. It is a deliberate speed bump
  against your own impulse, not a defence against someone with access to your
  computer — anyone who can open your browser's developer tools can read or
  change extension settings directly, whatever the PIN is set to. Do not reuse
  a PIN that protects anything else
- Access code configuration if you enable it. The code itself is generated
  fresh each time it is shown and is never stored
- Streak and usage-related local counters used by extension features
- The result of the most recent update check
- Setup progress, such as whether first-run onboarding has been completed
- When the on-device image classifier is enabled, a cache of recently
  classified image addresses and their scores. This is kept in session storage
  where the browser supports it, which is cleared when the browser closes; on
  older browser versions that lack it, the cache is written to ordinary local
  extension storage instead and persists until cleared
- Manual report and community story cooldown data, daily limits, report keys,
  a cached copy of the community stories you have viewed, which stories you
  have liked, and a locally generated device identifier

This locally stored information remains on your device unless you remove it, reset extension data, or uninstall the extension, except for entries that are automatically trimmed or expire as described below.

## Network Requests and Third-Party Services

BlockNSFW may contact third-party services for specific functionality. These requests are limited to what is needed for the relevant feature.

### 1. Filtering DNS Resolvers

If DNS Protection is enabled, BlockNSFW sends domain lookup requests over
DNS-over-HTTPS to the resolver you have selected, to help determine whether a
domain should be blocked. **This means the resolver you choose sees the
hostnames you visit**, in the same way it would if you configured it on your
device directly. The requests go from your browser to that resolver; they do
not pass through any server we operate.

- Default behavior: **off**. DNS Protection is opt-in and can be turned off
  again at any time in extension settings
- Purpose: domain-level adult content filtering
- Data involved: the hostname being checked, and standard network metadata such
  as your IP address, which any DNS resolver necessarily receives
- Services available, one selected at a time:
  - Cloudflare for Families — `family.cloudflare-dns.com` (default)
  - AdGuard DNS Family — `dns-family.adguard.com`
  - Mullvad DNS Family — `family.dns.mullvad.net`
  - CleanBrowsing Adult Filter — `doh.cleanbrowsing.org`
  - **Custom** — any DNS-over-HTTPS endpoint you enter yourself. If you use
    this, the operator of that endpoint receives the queries, and their privacy
    policy applies rather than any of the above
- **Failover:** if a preset resolver does not answer — a timeout, an error, or
  no response — the query is retried against one other preset on a different
  network, so a single resolver being unreachable does not silently disable the
  feature. This means a hostname may occasionally be sent to a preset resolver
  other than the one you selected. A resolver you entered yourself is never
  failed over, because choosing it is a choice about who sees your browsing
- Queries are cached locally for an hour and are only made for hostnames that
  the local blocklist has not already decided about, so the number of lookups
  is far smaller than the number of pages you visit
- Local, private and intranet addresses are never sent to any resolver

### 2. Rule List Subscriptions

If you subscribe to a rule list, BlockNSFW downloads that list from the address
you provided, on adding it and roughly once a day thereafter.

- Default behavior: **none are subscribed** unless you add one
- Purpose: keep a blocklist maintained by someone else up to date
- Data involved: standard request metadata sent to whoever hosts that address,
  including your IP address. We do not choose these addresses and do not
  receive anything about them
- A subscribed list can only add blocks. Nothing in the format can remove a
  block, disable the extension, or change your settings

### 3. GitHub-Hosted Blocklist, Whitelist and Version Updates

BlockNSFW downloads its blocklist and whitelist from GitHub-hosted files in
this project's repository, roughly twice a day, to keep filtering rules
current. On the same schedule it fetches a small file listing the latest
published version, so it can tell you when an update is available.

- Services used: `raw.githubusercontent.com` (the files `data/HOSTS.txt`,
  `data/WHITELIST.txt` and `data/version.json` in this project's public
  repository)
- Purpose: update domain block and allow rules; check for a newer release
- Data involved: standard request metadata only. These are plain file
  downloads — nothing about your browsing is sent with them, and the request
  is identical for every user
- These requests are not used for advertising or behavioral profiling

### 4. Optional Detection Model Download

If you switch the AI image blocker to the optional "Vision Transformer
(ViT-384)" model, BlockNSFW downloads that model's weight files once from a
GitHub-hosted URL and caches them in your browser.

- Service used: `raw.githubusercontent.com`
- Purpose: obtain the optional image classifier you selected
- Data involved: standard request metadata only
- The default model is bundled with the extension, so no download happens
  unless you choose the optional one
- **Your images are never uploaded.** The download goes in one direction: the
  model comes to your device, and all image analysis happens locally

### 5. Reddit API Checks

When Reddit-related filtering features are used, BlockNSFW may query Reddit endpoints to determine whether a subreddit is marked as NSFW.

- Service used: `www.reddit.com`
- Purpose: help identify NSFW Reddit content
- Data involved: subreddit name or Reddit URL needed for the check, plus standard request metadata. Because this request is made from the page you are on, it carries your Reddit cookies when you are browsing Reddit itself

### 6. Manual User Reports to Our Appwrite-Hosted Backend

If you choose to report a blocked or misblocked website, that report is sent to and stored in our Appwrite-hosted backend database for review.

- Service used: `699ac1b100018b3f455a.sgp.appwrite.run`
- Purpose: review false positives, missed blocks, abuse prevention, and improve filtering
- Data involved: the reported URL, normalized domain, report type, category, optional notes you submit, a generated device ID, a report key used to reduce duplicates, browser type, extension version, and standard request metadata
- Access: submitted reports may be reviewed by authorized developers or administrators for moderation, abuse prevention, and product improvement
- This is manual only. We do not send automatic background telemetry for ordinary browsing activity to our backend

### 7. Community Stories

The Community page shows recovery stories other people have chosen to share,
and lets you write one.

- **Reading:** opening the Community page fetches the published stories from
  our Appwrite-hosted backend. That request carries standard network metadata,
  including your IP address. No request is made unless you open the page
- **Writing:** if you submit a story, its title and text are sent to and stored
  in that backend, together with a generated device identifier, the extension
  version and your browser type. Stories are submitted under the name
  "Anonymous" — we do not ask for, and the extension does not send, your name
  or any contact details
- **Liking:** liking or unliking a story sends the story's identifier and your
  device identifier, so that a like can be counted once and undone
- Submitted stories are reviewed before publication and may be moderated,
  edited for length, or declined
- **A story is published to strangers.** Please do not include anything you
  would not want read publicly — real names, workplaces, addresses, or details
  that identify you or anyone else. Once a story is published we cannot
  guarantee it has not been copied elsewhere
- Service used: `6a3aafbf000d1e70cc28.sgp.appwrite.run`
- Purpose: let people who use the extension read and share recovery
  experiences
- Access: submitted stories may be reviewed by authorized developers or
  administrators for moderation and abuse prevention

### 8. Image Addresses, When the On-Device Image Classifier Is Enabled

To classify an image, the extension needs the image itself. It re-requests the
image from wherever the page loaded it from, usually straight out of the
browser cache.

- Default behavior: **off**. The AI image blocker is opt-in
- Purpose: fetch the image bytes so they can be analysed on your device
- Data involved: a request to the site hosting the image — the same host the
  page had already loaded it from. These requests are sent **without cookies
  or credentials**
- **Images are never uploaded.** All analysis happens on your device. Nothing
  about the image, and no score, is sent to us or to anyone else

### 9. Addresses You Ask the Extension to Check

Two settings send a request to an address you typed in yourself: testing that
a custom blocked-page address is reachable, and testing that a DNS resolver
answers. These only happen when you press the button.

## How We Use Data

We use the limited data handled by BlockNSFW only to:

- block or allow content based on your settings
- analyze pages locally so filtering can work
- keep local settings, logs, counters, and statistics working
- refresh remote filtering rules, including any rule lists you subscribed to
- tell you when a newer version has been published
- download the optional detection model you selected
- perform optional DNS-based domain checks
- perform optional Reddit NSFW checks
- fetch image files so they can be classified on your device
- show, submit and moderate community stories, and count story likes
- process and review manual user-submitted reports
- prevent abuse and duplicate report or story submissions

We do not use this data for unrelated purposes.

## Data Sharing and Disclosure

We do not sell personal data to third parties.

We share or transmit limited data only when needed to provide a feature or process a request you initiate. The parties that may receive data are:

- **The filtering DNS resolver you selected** — Cloudflare for Families,
  AdGuard, Mullvad, CleanBrowsing, or an endpoint you entered yourself — when
  DNS Protection is enabled, and occasionally one other preset resolver when
  your selected one does not answer
- **GitHub-hosted resources**, when blocklist, whitelist or version updates are
  downloaded, or when the optional detection model is downloaded
- **Whoever hosts a rule list you subscribed to**, when that list is refreshed
- **The sites hosting images on pages you visit**, when the on-device image
  classifier is enabled and re-requests an image to analyse it locally
- **Reddit**, when Reddit NSFW checks are performed
- **Our Appwrite-hosted backend**, when you manually submit a website report,
  when you open the Community page, and when you submit or like a story

Outside of the cases above, we do not share your data except if required by law, needed to protect security, or as part of a business transfer such as a merger or sale of assets.

## Data Retention

- Local settings, whitelist entries, cached lists, counters, streak data, and related extension data remain in browser storage until you clear them, reset the extension, or uninstall it.
- Temporary local allow-list entries may expire automatically based on your settings.
- Local audit logs for blocked pages and extension disable/enable events are automatically limited and are currently retained for up to 30 days, subject to size limits used by the extension.
- Local top-domain summaries and daily history are retained in browser storage until cleared or overwritten by the extension.
- Manual report cooldown data, duplicate-report keys, and the generated local device ID remain in local extension storage until cleared or the extension is removed.
- Manual reports submitted to our backend may be stored in our backend database and retained for as long as reasonably necessary to review reports, reduce abuse, and improve filtering quality.
- Community stories submitted to our backend are retained until removed. A published story is visible to anyone who opens the Community page. If you want a story you submitted taken down, contact us through the channel below and we will remove it.

## Security

We aim to minimize data use and keep as much processing local as possible. External requests used by the extension are sent over secure connections such as HTTPS. However, no system can guarantee absolute security.

## Your Choices and Control

You can:

- enable or disable DNS Protection, and choose which resolver it uses — including one of your own
- enable or disable the on-device image and text classifiers, which are off until you turn them on
- add or remove rule-list subscriptions
- change extension settings at any time
- add or remove whitelist entries and custom rules
- clear extension data by resetting settings or uninstalling the extension
- decide whether to submit a blocked or misblocked site report
- decide whether to read or write a community story, and ask us to remove one you submitted

## Children's Privacy

BlockNSFW is intended to help users and families reduce exposure to adult content. We do not knowingly collect personal data from children through account systems, advertising systems, or general analytics systems.

## Changes to This Policy

We may update this Privacy Policy from time to time. When we do, we will update the "Last Updated" date above.

## Contact

If you have questions about this Privacy Policy or BlockNSFW's data practices, please contact us through the browser extension store listing or the project's published support channel.
