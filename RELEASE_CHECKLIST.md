# Release Checklist

Use this before publishing Chrome Web Store or Firefox Add-ons update.

## 1. Prepare

- [ ] Confirm target version number
- [ ] Update `manifest.json`
- [ ] Update `manifest.firefox.json`
- [ ] Update `CHANGELOG.md` or release notes
- [ ] Review `README.md` if user-visible behavior changed
- [ ] Review `PRIVACY_POLICY.md` if privacy/network behavior changed

## 2. Build

- [ ] Run `build-chrome.ps1`
- [ ] Run `build-firefox.ps1`
- [ ] Optionally run both zip builds
- [ ] Confirm `dist\chrome\manifest.json` exists
- [ ] Confirm `dist\firefox\manifest.json` exists

## 3. Smoke Test

- [ ] Popup opens
- [ ] Main toggle works
- [ ] Options page opens
- [ ] Settings persist after reload
- [ ] Blocked page opens for blocked target
- [ ] Stats page opens
- [ ] Audit page opens
- [ ] SafeSearch works on at least one supported engine
- [ ] Whitelist add/remove works
- [ ] No new console errors on fresh install

## 4. Asset Check

- [ ] Confirm manifest icon files exist and load correctly
- [ ] Confirm any screenshots or store assets match current UI

## 5. Chrome Web Store Notes

- Uses root `manifest.json`
- Uses `background.service_worker`
- Uses `declarativeNetRequestWithHostAccess`
- Review any new permission text shown to users

## 6. Firefox Add-ons Notes

- Uses `manifest.firefox.json` copied to `dist\firefox\manifest.json`
- Uses `background.scripts`
- Uses `declarativeNetRequest`
- Confirm final Gecko ID before AMO release
- Re-test DNR and options-page flows after Firefox-specific changes

## 7. Publish

- [ ] Upload correct browser-specific package
- [ ] Publish release notes
- [ ] Tag release in git if desired
- [ ] Upload packaged zips to GitHub Release if using GitHub Releases
