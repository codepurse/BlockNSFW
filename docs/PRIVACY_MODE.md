# Privacy mode: scope and verification

Enable **Settings → Protection → Privacy mode**, then reload open pages.
The goal: nothing about your browsing reaches a third party, except a DNS
lookup sent to the resolver you chose. Turning it on requires the PIN, if one
is set, because it stops two blocking layers (Reddit lookups and subscribed
list updates). It does not change system DNS or proxy settings.

Filtering keeps working. The blocklist, DNS Protection, AI image and text
scanning, SafeSearch, local lists and statistics all stay on. What still
leaves the device:

- **Public downloads.** These are fixed files in this repository:
  `data/HOSTS.txt`, `data/WHITELIST.txt`, `data/version.json` and the AI model
  weights under `data/models/`. The guard rebuilds each request as a bare GET
  with no caller body, headers, credentials or referrer. A query string or
  fragment is rejected. Redirects are followed, because the target only learns
  the fixed public URL, and this keeps updates working if GitHub moves raw
  content.
- **DNS-over-HTTPS queries.** These go to a built-in resolver, or to the
  user's own endpoint once they have saved one. The request carries only the
  checked hostname, in the `name=…&type=A` or `dns=…` form that
  `shared/dns-providers.js` sends, plus a DoH `Accept` header. Credentials and
  referrer are dropped, and redirects are rejected so the query cannot be
  handed to another host.
- **AI image re-fetches.** These go through `PrivacyGuard.fetchImage()` only.
  It repeats a request for an image the page already loaded, to the host that
  served it, without cookies or referrer and from cache, so it tells that host
  nothing new. Plain `fetch()` of the same URL is refused.

Everything else is refused before it reaches the native network API. That
covers Appwrite reports and community stories, Reddit lookups, subscribed list
downloads and anything not listed above. It applies even when the feature's own
setting is still on. The matching Options controls render locked. Subscribed
lists keep the copy they already downloaded. Custom HTML and remote blocked
pages are replaced by the packaged page, so their markup or navigation cannot
send a blocked URL. If session storage is unavailable, the fallback page leaves
the URL out of its query.

## Implementation boundary

`shared/privacy-guard.js` installs before other scripts in content contexts,
extension pages and background/offscreen contexts. Content scripts run in the
browser's isolated world; this wrapper does not replace a website's own fetch.
The guard reads settings once per context and keeps them current through
`storage.onChanged`, so a fetch with the mode off costs nothing extra. A failed
settings read rejects the fetch (it fails closed) and is retried on the next one. Navigation behavior is updated when content-script settings reload;
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

`tests/fixtures/privacy-contract.json` declares approved downloads, approved
DNS queries, required request options for each, denied request examples and
permissions requiring review.
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
DNS clients (built-in and custom resolvers), Reddit lookup and offscreen image
re-fetch. It verifies how public download and DNS requests are rebuilt, the
destination and method restrictions, refused subscription downloads, the
settings cache, storage failure and setting changes. It also checks the guard's
load order, that only the AI classifiers call `fetchImage()`, and known
alternate transport entry points. No test sends these synthetic markers to a server.

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
interception boundary, while a public download and a DNS query to the chosen
resolver do, without cookies or referrer. It is a bounded smoke test,
not an exhaustive network audit. Close/discard the disposable profile afterwards.

Before release, also test Firefox, settings transitions, navigation and longer
sessions. Do not use real browsing history or credentials in these tests.
