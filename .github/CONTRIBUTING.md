# Contributing to BlockNSFW

Thanks for helping improve BlockNSFW.

## Before You Start

- Read `README.md`
- Read `PRIVACY_POLICY.md`
- Check `BROWSER_COMPATIBILITY.md` for browser-specific constraints
- Search existing issues before opening new one

## Development Setup

This project is intentionally lightweight:

- Vanilla JavaScript / HTML
- No Node build step required
- Chrome build script: `build-chrome.ps1`
- Firefox build script: `build-firefox.ps1`

### Local run

Chromium browsers:

1. Open extensions page.
2. Enable Developer Mode.
3. Load repo root with `manifest.json`.

Firefox:

1. Run `build-firefox.ps1`
2. Open `about:debugging#/runtime/this-firefox`
3. Load `dist\firefox\manifest.json`

## Build Commands

```powershell
powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1
powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1
```

Optional zip output:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-chrome.ps1 -Zip
powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1 -Zip
```

## Pull Request Guidelines

Keep changes focused.

Include:

- short summary of problem solved
- browser(s) tested
- manual test steps
- privacy / network impact if behavior changed
- screenshots for popup/options/blocked-page UI changes

Avoid mixing unrelated refactors with feature or bug-fix work.

## Testing Expectations

There is no large automated test suite yet. For now, contributors should run focused manual checks:

1. Load Chrome build or unpacked root manifest.
2. If Firefox behavior changed, build and test Firefox bundle too.
3. Verify popup opens and main toggle persists.
4. Verify options page saves settings.
5. Verify target behavior on at least one real page or URL.
6. Check browser console for new errors.

For logic-heavy changes, add focused automated coverage when practical.

## Reporting Blocking Issues

For false positives / false negatives, include:

- full URL or domain
- why it should block or should not block
- browser and version
- enabled features relevant to report:
  - DNS Protection
  - SafeSearch
  - Reddit checks
  - Facebook Reels blocking
  - Instagram Reels blocking
  - whitelist entries

## Security and Privacy

Do not post sensitive private data in public issues.

If issue involves security, privacy, abuse prevention, or backend/reporting endpoints, follow `.github/SECURITY.md`.
