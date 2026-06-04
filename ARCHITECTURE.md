# Architecture Notes

This project keeps runtime simple: no bundler, no framework, browser-native pages plus shared JavaScript files.

## High-Level Flow

1. `background.js`
   - loads packaged blocklist
   - refreshes remote blocklist / whitelist caches
   - manages settings, stats, streaks, audit logs, whitelist checks
   - applies SafeSearch DNR rules
   - answers messages from content/popup/options pages

2. `content.js`
   - runs at `document_start`
   - blocks or redirects early when possible
   - enforces SafeSearch on supported engines
   - filters DOM content, links, media, and selected social/search surfaces
   - performs Reddit NSFW checks when relevant

3. UI pages
   - `popup.html` / `popup.js` for quick toggle and shortcuts
   - `options.html` / `options.js` for full settings and admin-style controls
   - `blocked.html` / `blocked.js` for blocked-page experience
   - `audit.html` / `audit.js` for audit history
   - `stats.html` / `stats.js` for usage and blocking stats

## Data Storage

Browser storage is used for:

- settings
- whitelist entries
- cached remote lists metadata
- stats
- streaks
- audit/history data
- manual report cooldown and dedupe keys

Most keys still use `pblocker_*` prefix for backward compatibility with existing installs.
Debug/dev namespace also still exposes `window.PBlocker` for backward compatibility.

## Cross-Browser Strategy

- Chrome build uses `manifest.json`
- Firefox build uses `manifest.firefox.json`
- Runtime code uses `browser` when available, otherwise `chrome`
- Shared source files are reused across both browsers

## Network-Touching Features

Most logic is local, but these features call external services:

- GitHub-hosted blocklist / whitelist updates
- Cloudflare for Families DNS checks
- Reddit NSFW checks
- Appwrite-hosted manual reports

Any change to these paths should update `README.md`, `PRIVACY_POLICY.md`, and release notes.
