# Privacy Policy for BlockNSFW

**Last Updated:** March 31, 2026

## Overview

BlockNSFW is a browser extension designed to block adult websites and inappropriate content for safer browsing. To do this, the extension analyzes website data in your browser, stores certain settings and logs locally on your device, and makes limited network requests only when a feature requires it.

Most filtering decisions are made locally in your browser. We do not sell personal data, do not use your data for advertising, and do not run general analytics or telemetry for ordinary extension usage.

## How We Collect and Handle Data

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
- Extension settings and preferences
- Whitelist entries, temporary allow-list entries, and custom block patterns
- Local blocked counts, statistics, streak data, and history summaries
- Local audit log entries for blocked pages and extension disable/enable events
- PIN or lock settings if you choose to set one
- Information submitted in a manual website report, such as a URL, domain, report type, category, and optional notes
- A locally generated device identifier used to help rate-limit and de-duplicate manual reports

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
- Local blocked counts, daily history, and top blocked domains
- Local audit/history entries related to blocked pages and extension disable/enable events
- PIN or lock data if you set a PIN
- Streak and usage-related local counters used by extension features
- Manual report cooldown data, daily report limits, report keys, and a locally generated report device ID

This locally stored information remains on your device unless you remove it, reset extension data, or uninstall the extension, except for entries that are automatically trimmed or expire as described below.

## Network Requests and Third-Party Services

BlockNSFW may contact third-party services for specific functionality. These requests are limited to what is needed for the relevant feature.

### 1. Cloudflare for Families

If DNS Protection is enabled, BlockNSFW sends domain lookup requests to Cloudflare for Families using DNS-over-HTTPS to help determine whether a domain should be blocked.

- Service used: `family.cloudflare-dns.com`
- Purpose: domain-level adult and malware filtering
- Data involved: the domain being checked and standard network metadata needed to make the request
- Default behavior: this feature is user-configurable and can be turned off in extension settings

### 2. GitHub-Hosted Blocklist and Whitelist Updates

BlockNSFW may download remote blocklist and whitelist files from GitHub-hosted URLs in order to keep filtering rules current.

- Purpose: update domain block and allow rules
- Data involved: standard request metadata only
- These update requests are not used for advertising or behavioral profiling

### 3. Reddit API Checks

When Reddit-related filtering features are used, BlockNSFW may query Reddit endpoints to determine whether a subreddit is marked as NSFW.

- Purpose: help identify NSFW Reddit content
- Data involved: subreddit name or Reddit URL needed for the check, plus standard request metadata

### 4. Manual User Reports to Our Appwrite-Hosted Backend

If you choose to report a blocked or misblocked website, that report is sent to and stored in our Appwrite-hosted backend database for review.

- Purpose: review false positives, missed blocks, abuse prevention, and improve filtering
- Data involved: the reported URL, normalized domain, report type, category, optional notes you submit, a generated device ID, a report key used to reduce duplicates, browser type, extension version, and standard request metadata
- Access: submitted reports may be reviewed by authorized developers or administrators for moderation, abuse prevention, and product improvement
- This is manual only. We do not send automatic background telemetry for ordinary browsing activity to our backend

## How We Use Data

We use the limited data handled by BlockNSFW only to:

- block or allow content based on your settings
- analyze pages locally so filtering can work
- keep local settings, logs, counters, and statistics working
- refresh remote filtering rules
- perform optional DNS-based domain checks
- perform optional Reddit NSFW checks
- process and review manual user-submitted reports
- prevent abuse and duplicate report submissions

We do not use this data for unrelated purposes.

## Data Sharing and Disclosure

We do not sell personal data to third parties.

We share or transmit limited data only when needed to provide a feature or process a request you initiate. The parties that may receive data are:

- **Cloudflare for Families**, when DNS Protection is enabled
- **GitHub-hosted resources**, when blocklist or whitelist updates are downloaded
- **Reddit**, when Reddit NSFW checks are performed
- **Our Appwrite-hosted backend**, when you manually submit a website report

Outside of the cases above, we do not share your data except if required by law, needed to protect security, or as part of a business transfer such as a merger or sale of assets.

## Data Retention

- Local settings, whitelist entries, cached lists, counters, streak data, and related extension data remain in browser storage until you clear them, reset the extension, or uninstall it.
- Temporary local allow-list entries may expire automatically based on your settings.
- Local audit logs for blocked pages and extension disable/enable events are automatically limited and are currently retained for up to 30 days, subject to size limits used by the extension.
- Local top-domain summaries and daily history are retained in browser storage until cleared or overwritten by the extension.
- Manual report cooldown data, duplicate-report keys, and the generated local device ID remain in local extension storage until cleared or the extension is removed.
- Manual reports submitted to our backend may be stored in our backend database and retained for as long as reasonably necessary to review reports, reduce abuse, and improve filtering quality.

## Security

We aim to minimize data use and keep as much processing local as possible. External requests used by the extension are sent over secure connections such as HTTPS. However, no system can guarantee absolute security.

## Your Choices and Control

You can:

- enable or disable DNS Protection
- change extension settings at any time
- add or remove whitelist entries and custom rules
- clear extension data by resetting settings or uninstalling the extension
- decide whether to submit a blocked or misblocked site report

## Children's Privacy

BlockNSFW is intended to help users and families reduce exposure to adult content. We do not knowingly collect personal data from children through account systems, advertising systems, or general analytics systems.

## Changes to This Policy

We may update this Privacy Policy from time to time. When we do, we will update the "Last Updated" date above.

## Contact

If you have questions about this Privacy Policy or BlockNSFW's data practices, please contact us through the browser extension store listing or the project's published support channel.