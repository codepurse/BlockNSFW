# BlockNSFW 1.8.0

*Unreleased*

One file per release, alongside `RELEASE_NOTES_1.7.7.md`. The full technical
history lives in `CHANGELOG.md`.

---

The release where blocking stops being something the extension does to a page
after it has started loading, and becomes something the browser refuses
outright. Two structural gaps close — both of which had been there since the
beginning.

## Blocked sites no longer receive the request

Until now, blocking worked like this: the page began loading, the extension's
script started, stopped it, and sent you to the blocked page. You never saw the
site — but the site saw you. The request had already gone out, with your
address and any cookies you had, and it was recorded at the other end.

The blocklist is now handed to the browser's own request engine, which refuses
those requests before anything is sent. All 204,000 sites, not a shortlist.

One deliberate exception: navigating *to* a blocked site still goes through the
old path. If the browser refused it outright you would get a blank error page
instead of the blocked page — no reason, nothing in your history of blocked
attempts, and no way to tell a block from a site being down. The page you see
is worth more than the request saved, so navigation keeps the route that can
explain itself. Everything invisible — images, videos, embedded frames,
scripts — is now refused at the network layer.

## Content inside embedded frames is filtered

Filtering only ever ran on the main page. Anything inside a frame embedded on
that page was checked against the blocklist by address and nothing else: no
image filtering, no AI, no text scanning. A site not on the list, loaded in a
frame, was seen by nothing.

That was the easiest way around the extension, and it needed no technical
knowledge — sites exist for exactly this. It is closed.

Ordinary pages carry a dozen small frames for adverts and analytics, so the
work is matched to the frame: a frame too small to show anything does nothing
at all, a content frame gets the image and media filters, and the whole-page
checks stay on the page itself, where they belong.

## The blocked page no longer leaves the address in your history

When a site was blocked, the address of the blocked page contained the address
of the site — so it went into your browser history, into address-bar
suggestions, and, if you have history sync switched on, into your Google
account. The words that triggered the block went with it.

It is now held in memory for the moment it takes to show you the page, and
never written down. If you have history sync on, entries from before this
update are already in your account; clearing them is worth doing.

## Also fixed

**The AI image filter stops re-checking the same pictures.** Its results were
meant to be remembered for a day, but the store it wrote to was unreachable
from where it was writing, and the failure was silent — so every page analysed
every image from scratch, every time. If you use it, pages with many images
should feel noticeably lighter.

## Upgrading

Nothing to do. Settings carry over.

- **Chrome 101 or newer is now required.** The network-level blocking uses a
  capability added in Chrome 101 (April 2022). Chrome updates itself, so this
  affects almost nobody — but a browser older than that will stay on 1.7.7
  rather than updating. Firefox is unaffected; 113 is still the minimum.
- **If a site you allowed still seems partly blocked**, reload it once. Your
  whitelist now also applies at the network layer, and the rules are rebuilt
  when the extension starts.

## For contributors

`rules/blocklist-rules.json` is generated — do not edit it. Run
`node scripts/build-dnr-ruleset.mjs` after changing `data/HOSTS.txt`; both
build scripts run it and fail if it cannot be built, so a stale ruleset cannot
ship.

The generator applies the same public-suffix guard as the runtime, from the
same `shared/domain-policy.js`. That matters more in the generator than at
runtime: a domain in a rule matches its sub-domains too, at a layer where the
user sees no explanation and no whitelist entry can help. A post-pack assertion
refuses to emit a ruleset containing a namespace, and the guard has to run
*before* the subdomain fold, or an entry collapses into the very name being
excluded.

New tests: `static-dnr-ruleset.test.js`, `frame-coverage.test.js`,
`blocked-detail-privacy.test.js`. The frame tests assert that `filterImages()`
runs *before* the top-frame gate — placed one line later, sub-frames get no
image filtering and the feature does nothing while every other test still
passes.
