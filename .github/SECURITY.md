# Security Policy

## Supported Versions

Security fixes are best-effort for current development head and latest published extension version.

## Report Security Issues

Please do **not** open public GitHub issues for:

- security vulnerabilities
- privacy issues
- bypasses that materially weaken blocking
- abuse of backend/reporting endpoints

Use private maintainer contact channel when available. If this repository later enables GitHub private vulnerability reporting, prefer that channel.

If private channel is not yet available, contact maintainer through published extension support channel and clearly label report as `SECURITY`.

## What To Include

- affected browser and version
- extension version
- impact summary
- clear reproduction steps
- proof-of-concept URL or sequence if safe to share
- whether issue affects Chrome, Firefox, or both
- whether issue requires optional features such as DNS Protection or manual reports

## Response Expectations

- Initial triage target: within 7 days
- If issue is accepted, fix timing depends on severity and release window

## Scope

Examples in scope:

- permissions abuse
- data leakage
- backend/report abuse
- bypasses of blocking logic
- broken privacy guarantees

Examples out of scope unless they create real security impact:

- cosmetic UI bugs
- feature requests
- browser-store policy discussions without exploitable impact
