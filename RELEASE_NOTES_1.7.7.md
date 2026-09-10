# BlockNSFW 1.7.7

*Unreleased*

One file per release, alongside `RELEASE_NOTES_1.7.6.md`. The full technical
history lives in `CHANGELOG.md`.

---

A maintenance release with no new features. It closes four ways the filter
could stop doing its job without saying so, plus one way a website could put
its own content on the blocked page, and adds the tests that keep them shut.
Every one of these was silent — nothing logged an error, nothing showed in the
UI, and the extension went on reporting that protection was on.

## Fixed

**Ordinary words in a domain name no longer switch the smart filter off.**

The smart hostname filter deliberately stands down when a domain looks like a
recovery or support site, so that `porn-addiction-treatment.org` is never
filtered. It recognised those words as bare substrings anywhere in the
hostname, which meant a domain merely *containing* one of about thirty-nine
everyday English words had the filter switched off wholesale —
`safe-pornhub.com`, `xnxx-safer.tv`, `hentai-protect.io`,
`cdn.safe.pornhub-mirror.com`. An operator could buy an exemption for a new
mirror by putting "safe" in its name.

A safe word now has to occupy whole hyphen-separated parts of a name.
`porn-addiction-treatment.org` still stands down, because its parts really are
"addiction" and "treatment"; `helpxxx.com` does not, because its single part is
"helpxxx". Eight words that were free cover rather than genuinely
support-related are gone: safe, safer, study, research, academic, freedom,
liberty, protect. "protection" stays.

Worth knowing where this bit hardest: page *navigation* had a second, broader
check that already caught most of these. Images, embedded frames, video and
links inside social posts did not — they consult only the strict matcher, so an
image host named `safe-cdn.<mirror>.com` served unfiltered pictures anywhere it
was hotlinked. That is the part this fixes.

**A blocked word written as a pattern can no longer freeze the browser, and a
subscribed list can no longer stall the extension.**

Custom blocked words may be regular expressions. Because a regular expression
is the one kind of input that can hang a browser, candidates were timed against
deliberately awkward test strings and rejected if slow. Two gaps:

- The test strings were built only from the letters and digits a pattern
  mentions, falling back to "a". A pattern about punctuation was therefore
  tested with characters it never matches: one such pattern passed validation
  in a millisecond and then took about fifteen seconds against a run of thirty
  dots — a `.....` ellipsis or a `-----` separator, which ordinary pages are
  full of. Patterns run against page text on every page, so a single saved word
  of that shape froze all browsing.
- The stopwatch was read only *after* each test finished, so a test that did
  not finish was never billed. The guard could stall on the very pattern it was
  inspecting. The same guard runs in the background whenever a subscribed list
  is downloaded, and while it is stalled nothing answers the question "is this
  site blocked?" — so the main blocklist stops being consulted, with the
  interface still reporting that protection is on.

No stopwatch can fix the second one, because the thing doing the measuring is
the thing that hangs. Patterns that repeat a repeat are now refused on sight,
before anything is compiled or run. Bounded repeats are unaffected, and so are
groups with no inner repeat. Subscribed lists also cap how many pattern rules
they may carry, so a hostile file cannot multiply the cost across fifty
thousand lines.

**Blocked videos, embedded frames and social posts are counted again.**

Three of the six kinds of block the extension performs were reported by the
page but received by nothing, so they reached neither the toolbar counter, nor
the totals, nor the history. The in-page counter tallied videos and frames
itself, which is why it and the toolbar disagreed on the same page. All three
are now recorded, each with its own figure behind the scenes.

**The extension no longer writes the title and address of every page you visit
into that page's own console.**

Four entries per page load, on every site, whether or not debugging was on.
Analytics and error-reporting tools embedded in websites routinely record
console output, so a site's vendor could pick up both the page title and the
fact that BlockNSFW was installed — from an extension whose whole premise is
that browsing stays on your machine. On AOL and Yahoo search pages the search
query went the same way. Both are now silent unless debug mode is on.

**A website could put its own content on the blocked page.**

If you use a custom blocked page written in HTML, the address of the site you
were blocked from was dropped into your template without being made safe
first. Because the blocked page can be opened by any website, a malicious one
could use that to draw its own content there — most usefully a convincing fake
"enter your PIN" box, at what looks like a genuine extension address.

Your template still renders as HTML, because that is the point of it. What gets
substituted into it no longer can. The extension also decides which kind of
blocked page to show from your settings rather than from the address, so a
website cannot select the custom-HTML path for someone who never chose it.

## Upgrading

Nothing to do. Settings are unchanged, and the AI model is not re-downloaded.

Two behaviour changes are worth knowing about:

- **A saved blocked word written as a pattern that repeats a repeat will stop
  matching.** These are the ones that could freeze a page, so they are now
  refused. If you rely on one, rewrite it without the inner repeat and save it
  again.
- **A site that was previously exempt because its name contained one of the
  eight removed words may now be blocked.** If that catches a legitimate site,
  add it to your whitelist — and please report it, so it can go in the shared
  whitelist for everyone.

## For contributors

The test suite goes from 588 to 616. Four new files, each pinning a fix that
was invisible in normal use:

- `tests/safe-host-token-bypass.test.js` — the bypass corpus, asserted against
  the strict matcher, the content script's broader check, and the combination
  of the two. Testing only the first is what made the original report overstate
  the impact.
- `tests/redos-guard.test.js` — every pattern that could hang runs in a **child
  process with a hard timeout**, because a test that hangs in-process does not
  fail, it wedges the whole run.
- `tests/message-contract.test.js` — enumerates what the content script sends
  and asserts the background can answer all of it, rather than testing the
  three types that were missing.
- `tests/content-logging-gated.test.js` — scans the source for an ungated
  console call carrying a page URL or title.

Deliberately not changed: an adult word glued inside a longer name
(`freedomporn.com`) is still not matched by the strict matcher. Loosening that
is the same rule that stops "essex" matching "sex", so it trades directly
against false positives on news, reference and support sites and needs a
corpus before anyone decides. Page navigation already catches these through its
broader check.
