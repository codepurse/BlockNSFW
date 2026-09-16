# Privacy mode: scope and verification

Enable **Settings → Protection → Privacy mode**, then reload open pages.
The mode is opt-in so existing DNS and community features do not silently stop
working after an update. It does not change system DNS or proxy settings.

The extension continues to filter using local data and may keep local logs.
It may download only these shared, fixed resources from its GitHub repository:

- `data/HOSTS.txt`
- `data/WHITELIST.txt`
- `data/version.json`

The fetch boundary constructs a new GET request with no caller-provided body,
headers, credentials or referrer; redirects are rejected. A query string or
fragment on an approved resource is rejected too. The server necessarily sees
the connection's IP address. These requests contain no browsing URL or page
content supplied by the extension.

Other extension fetches are refused before reaching the native network API.
This covers DNS, Reddit, Appwrite, subscription URLs and remote image/model
loads, even if their saved feature setting is still enabled. AI image scanning
is suspended to avoid repeated failures and extra image requests. Text/URL
filtering, SafeSearch, local lists and statistics remain available. The AI
text feature's existing dependence on corroborating AI images still applies.
Custom HTML and remote blocked pages are replaced by the packaged page so
their markup/navigation cannot transmit a blocked URL. If session storage is
unavailable, the fallback page omits the URL instead of putting it in its query.

## Implementation boundary

`shared/privacy-guard.js` installs before other scripts in content contexts,
extension pages and background/offscreen contexts. Content scripts run in the
browser's isolated world; this wrapper does not replace a website's own fetch.
The guard reads the current setting for each fetch and rejects on storage-read
failure. Navigation behavior is updated when content-script settings reload;
reload open pages after enabling. It cannot recall an already sent request.

This does not prevent normal website traffic, browser history sync, the store's
extension updates or user-initiated external links. It is not a VPN or a claim
of absolute anonymity, and does not protect against a malicious future update.
The fetch wrapper is an application boundary, not a browser-enforced sandbox
against arbitrary malicious extension code. New code can introduce another
transport; review new network sinks and HTML resources as well as running tests.

## Tests

### CI checks and declarative contract

`.github/workflows/privacy.yml` runs on pushes and pull requests and can also
be started manually. Its independent checks are **Privacy contract** (Ubuntu)
and **Chrome privacy (normal and incognito)** (Windows). They use Node 22 without
installing npm dependencies and do not need secrets or write permissions. The
Chrome job builds the actual package with `build-chrome.ps1`; an unavailable
browser or failed assertion fails the job rather than skipping it. The existing
build workflow still includes these unit tests in `npm test`.

`tests/fixtures/privacy-contract.json` declares approved downloads, required
request options, denied request examples and permissions requiring review.
Tests read this independently of the implementation. Changing a privacy promise
therefore requires an explicit, reviewable change to the contract. This is not
a declaration that the entire application is safe: other transports, browser
traffic and malicious future code remain outside the stated guarantee.

Both jobs upload logs as artifacts even on failure. The browser launcher creates
and removes its own temporary profile, stops the processes it starts, and disables
external DNS/proxy access as defense in depth for synthetic probes. It does not
use a personal profile. For local reproduction after building:

```sh
npm run test:privacy
npm run test:privacy:ci
```

Chrome is detected in standard locations; override with `BLOCKNSFW_CHROME_PATH`.
The output is saved under `artifacts/privacy/` (ignored by Git).

The repository maintainer can mark both check names as required in branch
protection/rulesets. This workflow does not change those repository settings.
For contributions from forks, GitHub may require a maintainer to approve the
workflow run before it starts.

### Test coverage

Run `npm test` (Node's built-in runner; no runtime dependencies needed).

`tests/privacy-egress.test.js` captures calls that would reach native fetch and
uses synthetic private markers. It exercises the real report/community and
DNS clients, Reddit lookup and offscreen image fetch; verifies the public
download request reconstruction, destination/method restrictions, storage
failure and setting changes; and checks guard loading order and known alternate
transport entry points. No test sends these synthetic markers to a server.

`tests/blocked-detail-privacy.test.js` tests remote-page replacement and fallback
URLs. `tests/blocked-page-escaping.test.js` tests that private mode never renders
custom markup containing external resources.

These are unit/integration tests with mocked browser APIs, not proof of every
possible execution path.

`tests/browser/privacy-smoke.mjs` additionally exercises a built Chrome package
through CDP, including a content-script request from an incognito window. Start
a **disposable** Chrome profile with `--remote-debugging-port=0` and
`--enable-unsafe-extension-debugging`, then run:

```sh
BLOCKNSFW_CDP_URL='ws://127.0.0.1:PORT/devtools/browser/ID' node tests/browser/privacy-smoke.mjs
```

The default package path is `dist/chrome`; override with `BLOCKNSFW_BUNDLE`.
This installs the test package in that profile and enables incognito access.
HTTP requests in the attached test page and service worker are intercepted and
answered with synthetic responses, so private test markers are not sent to a
remote server. The test asserts that blocked operations never reach that
interception boundary, while a public download does. It is a bounded smoke test,
not an exhaustive network audit. Close/discard the disposable profile afterwards.

Before release, also test Firefox, settings transitions, navigation and longer
sessions. Do not use real browsing history or credentials in these tests.
