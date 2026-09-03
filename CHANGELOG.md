# Changelog

All notable project changes should be documented here going forward.

## [Unreleased]

### Added
- **DuckDuckGo and Brave now use their dedicated locked SafeSearch endpoints.**
  Normal searches are rewritten by the browser's request engine to the
  provider's safe host before the page loads, with permissive query values
  replaced by strict mode. This mirrors the effective behavior of their
  documented family-DNS mappings: strict filtering is enforced by the search
  host and its client-side SafeSearch controls are disabled. DuckDuckGo HTML
  and Lite searches retain their non-JavaScript layouts and continue to receive
  a network-level strict parameter.
- **Strict request enforcement now covers media-search verticals.** Bing,
  Ecosia, and Presearch image, video, and news routes no longer fall outside the
  rule that previously protected only their main web-search route.
- **Yandex now runs in Family mode.** A network-level request rule appends
  Yandex's current `yp` Family-mode preference before the first web, image, or
  video request, without replacing account or session cookies. The content
  script persists the same preference across Yandex's regional search domains
  and locks the weaker choices on the Search settings page. Existing explicit
  query blocking and per-result filtering remain as secondary layers.
- **Firefox's documented minimum is now 113.** This matches the first Firefox
  release with the dynamic request-header rules used by SafeSearch enforcement.
- **The AI image blocker can now use a second, more accurate model, and the
  extension download got smaller rather than bigger.** Settings offer a
  detection-model picker: the bundled NSFW.js MobileNetV2 (still the default,
  still works offline) or Marqo's `nsfw-image-detection-384` Vision Transformer.

  The reason to want the ViT is not a headline accuracy number — it is that it
  answers one question (is this NSFW?) instead of five. NSFW.js's "Sexy" class
  fires on beaches, fitness photos, fashion and ordinary portraits, which is why
  its bar has to sit all the way up at 0.90 to avoid blurring holiday snaps. A
  binary head has no such class to defend against.

  Getting there needed one long-standing belief corrected: the AI runtime was
  documented as unable to load tfjs *graph* models, which ruled out every
  model except the bundled MobileNet. That limit turned out to belong to the
  CSP-safe `nsfwjs.runtime.js` shim, not to TensorFlow.js — the vendored
  `tf.es2017.js` exports `loadGraphModel` and is eval-free. So the ViT bypasses
  nsfwjs entirely and does its own preprocessing and softmax.

  The conversion is reproducible via `tools/convert_vit384.py` and verified
  numerically: the packaged graph reproduces the original timm model's logits
  to within 8.3e-7, checked by loading it through the extension's own loader on
  the vendored TensorFlow.js build. Output is a 341 KB graph plus six weight
  shards totalling 21.4 MiB.

  Those weights are **not** in the extension package. Bundling them
  would have grown the store download about five-fold for a feature that is
  opt-in and off by default. Instead the execution graph ships in the package
  (the part worth reviewing) and the numeric weight shards are fetched once on
  first use and cached locally by the browser. Images are still never uploaded —
  the traffic goes one way, and the model comes to you.

  Three things this shook out:
  - The verdict cache stores raw *scores* and re-derives verdicts on every hit,
    so that changing strictness applies immediately instead of being frozen for
    24 hours. With two models that becomes a trap: a 0.8 from MobileNet's Sexy
    class and a 0.8 NSFW probability are different claims. Entries are now
    tagged with the model that produced them and are re-classified after a
    switch, and `verdictFor()` dispatches on the score shape rather than
    trusting whichever thresholds it was handed.
  - If the selected model cannot load — no connection, weights not published,
    cache evicted — classification falls back to the bundled model instead of
    leaving the page unfiltered. The response reports which model actually ran,
    so the cache records the truth rather than the setting.
  - Strictness presets are per model now (one NSFW bar for the ViT, the
    Porn+Hentai / Sexy pair for MobileNet), held in one table so the content
    script, the three inference routes and the tests cannot drift apart.
  - The ViT's thresholds are **calibrated rather than guessed**. The first cut
    (strict/balanced/relaxed = 0.40/0.70/0.90) was invented by analogy with
    NSFW.js and made the ViT *worse* in practice than the model it was meant to
    beat: content the model scored 0.35-0.65 NSFW was sailing straight through,
    and `relaxed: 0.90` sat exactly on the point where Marqo's published
    evaluation shows recall collapsing. Two measurements fixed it — a local scan
    of 18 varied safe photos (including people and sports) put ordinary content
    in a tight 0.047-0.094 band, and Marqo's threshold curves hold ~98%
    precision *and* recall anywhere from 0.1 to 0.9. The presets are now
    0.15/0.30/0.60, all inside that plateau, and none of the 18 safe photos is
    blurred at any of them.

- **DNS Protection can now use one of four filtering resolvers, and falls back
  to a second one when the first does not answer.** It was hardcoded to
  Cloudflare for Families, which made a single company both the only option and
  a single point of failure: when that resolver was unreachable or rate-limiting
  us, `checkDnsFilter()` failed open and the layer quietly stopped working with
  nothing in the UI to say so.

  Settings now offer Cloudflare for Families, AdGuard DNS Family, Mullvad DNS
  Family and the CleanBrowsing Adult Filter. All four are free, need no account,
  and are queried straight from the user's own browser — nothing passes through
  BlockNSFW's servers. Only resolvers whose terms permit this are listed;
  OpenDNS and Control D forbid providing their service to third parties, so they
  are recommended as device-level settings rather than queried by the extension.

  Three things this shook out:
  - AdGuard signals a block with its own block-page address (`94.140.14.35`)
    rather than a `0.0.0.0` sinkhole, so a naive "did it resolve?" check reads
    it as *nothing is ever blocked*. Block detection is now per-provider.
  - A lookup that fails is no longer indistinguishable from one that came back
    clean. `checkDnsFilter()` returns a tri-state, a no-answer is never cached,
    and `shouldBlock()` skips its URL cache write in that case — an outage used
    to whitelist the domain for the rest of the service worker's life.
  - A resolver that stops responding is muted for five minutes after three
    consecutive failures, so a dead provider costs one timeout rather than one
    per navigation.

  *Test DNS Connection* now checks that a known adult domain is actually
  filtered and a benign one is not, instead of only checking reachability — a
  resolver that answers but has stopped filtering used to look healthy.

- **Or point DNS Protection at any resolver you like.** Picking *Custom* in the
  resolver list reveals an address box that takes any DNS-over-HTTPS endpoint —
  your own NextDNS config ID, a Control D profile, DNS for Family, or something
  you run yourself. This is how the resolvers we cannot ship as presets become
  usable anyway: OpenDNS and Control D forbid *us* from querying on a user's
  behalf, but nothing stops a user pointing their own copy wherever they want.

  Custom endpoints are spoken to in RFC 8484 wireformat rather than the JSON
  dialect, because wireformat is the actual standard and the JSON one is a
  Cloudflare extra most resolvers do not implement — guessing wrong would have
  looked identical to "your resolver is broken". The address must be `https://`
  and carry no embedded credentials, and a saved address that later fails to
  parse degrades to the default resolver rather than to no DNS layer at all.

  **A custom resolver has no fallback, deliberately.** The presets fail over to
  a second network when one does not answer; a custom one does not. Someone who
  typed in their own endpoint chose who gets to see their browsing, and quietly
  redirecting those queries to Cloudflare the moment their resolver hiccuped
  would override that choice without telling them.

- **A fifth onboarding step covers network-level blocking.** It offers the
  in-extension DNS check as a toggle (off by default, like every other feature
  that sends anything off-device), and then gives copyable addresses for
  CleanBrowsing Family and DNS for Family to set on the device or router.
  That second half is the part the extension cannot do for the user: it covers
  every app rather than one browser, and it survives the extension being
  removed — which is the gap Desktop Guard exists to defend, approached from
  the other side. The step is skippable.

### Fixed
- **DNS Protection blocked every local development server.** With the setting
  on, `http://localhost:3000` — and every other local address — was redirected
  to the blocked page on every load, reason "Blocked by DNS filter". Neither the
  blocklist nor the keyword filter was involved; the DNS check did it alone.

  A filtering resolver signals a block three ways, and one of them is NXDOMAIN
  (Mullvad's answer, and Cloudflare's for some domains). A *public* resolver
  also returns NXDOMAIN for every name that does not exist in public DNS —
  which is exactly what `localhost`, `app.test`, `nas.local`, a bare intranet
  hostname and a private address all are. So "is this host filtered?" came back
  yes, every time, for the whole local network.

  The layer now declines to ask. Loopback and private addresses, the reserved
  local TLDs (`.localhost`, `.local`, `.test`, `.example`, `.invalid`,
  `.internal`, `home.arpa`), bare single-label hostnames and IP literals of any
  kind are recognised by `isLocalHostname` in `shared/hostname.js` and answered
  "not blocked" without a lookup — in the content script as well, so a dev page
  does not pay for the round trip either. Public hostnames still go to the
  resolvers exactly as before, and no other blocking layer changed.

- **The AI image filter flagged explicit images on X/Twitter without blurring
  them.** Reported in
  [#17](https://github.com/codepurse/BlockNSFW/issues/17). The model was working
  — the blocks were counted, which is why they showed up in the log — but the
  blur kept coming straight back off.

  X runs a virtualised timeline: it keeps a pool of `<img>` nodes and swaps
  their `src` as you scroll, and the browser re-resolves `srcset` to a
  higher-res candidate once an image is laid out. Either can change the picture
  in a node *while* its classification is still in flight. `applyVerdict()`
  applied whatever came back to whatever the node held by then, so a stale
  `allow` from the node's previous occupant would strip the blur off an image
  the model had just blocked — and a stale `block` would blur an innocent one.
  A verdict now carries the URL it was computed for and is dropped if the node
  has moved on. Its scores are still cached, so nothing is re-fetched.

  `observeImage()` made it worse by unblurring a node the moment its `src`
  changed, which left the new image fully visible for a whole classify
  round-trip. It now hands the node to the blocker, which hides it until its own
  verdict lands. Every path that declines to classify an image reveals it again,
  so nothing can be stranded invisible.

- **None of the buttons on the audit log's pagination worked.** Also reported in
  [#17](https://github.com/codepurse/BlockNSFW/issues/17). They were rendered
  with inline `onclick="changePage(n)"`, which the extension-page CSP
  (`script-src 'self'`) blocks outright — so every one of them was a silent
  no-op and the log was stuck on its first 20 entries. The target page moved to
  `data-page` with a delegated listener, and `changePage()` now clamps to the
  range that actually exists.

- **The popup could unblock a site with nothing but the PIN, however the access
  code was configured.** Reported in
  [#29](https://github.com/codepurse/BlockNSFW/issues/29). The access code —
  the layer whose whole point is that a 32-256 character retype outlasts an
  urge — lived only in `options.js`. The popup carried its own older copy of
  the gate, which verified four digits and returned. So popup → *unblock this
  site* → PIN wrote a whole-site whitelist entry, and a whitelist entry
  overrides blocking entirely: the site was open, and the code was never asked
  for. The options page meanwhile promised the code on "every change that
  reduces your protection". Whitelisting a site by hand and switching SafeSearch
  off went the same way.

  The rules, the charset, the config shape and the paste guards now live in
  `shared/access-code.js`, and the popup enforces them through the same
  `requirePIN` / `requirePINIfSet` chain the options page uses. Two copies of a
  gate is how the first one quietly stopped covering everything, so there is one.

  Where the popup cannot show the modal it refuses the action rather than
  waving it through, and it never falls back to `prompt()` — that box accepts a
  paste, which is the one thing this feature must not allow.

### Changed
- **Whitelisting a whole site is now a critical action.** It unlocks every page
  on the domain, which is as total as switching blocking off, so it faces the
  access code in the default `critical` scope rather than only under "ask on
  every change" — as does importing a whitelist file. Whitelisting a single
  *page* (`example.com/r/Name`) opens one section and is not treated as
  critical. Both entry points ask for the code after the input has been checked
  and found not to be a duplicate, so a typo can no longer cost someone 256
  characters of typing.

### Removed
- **The remote announcement banner at the top of Settings.** It rendered a
  message fetched from `data/announcement.json` in this repo, so a notice could
  be broadcast to every install by editing one file, with no store release. The
  banner, its 6-hourly GitHub fetch and the `get_announcement` message route are
  all gone — opening Settings now makes one fewer network request — and the two
  keys the feature wrote (`pblocker_announcement_info`,
  `pblocker_announcement_dismissed`) are cleared on update. The per-browser
  override plumbing it needed (`lookupBrowserOverride`) went with it;
  `detectBrowserKey()` stays, since the update check still picks a store URL
  with it. `data/announcement.json` itself stays in the repo: copies already
  installed keep polling it until they update.

- **~856 KB of dead code that shipped in every release.** `classify.worker.js`
  and the `tf.min.js` / `nsfwjs.min.js` pair it imported were left behind by the
  move to the service-worker-delegated classifier. Nothing had spawned that
  worker in months (`new Worker` appears nowhere in the tree) and Chrome's
  manifest never even exposed it, but the build copied all of `vendor/`
  wholesale, so it went out anyway. The Chrome package drops from 4.99 MB to
  4.13 MB. A new test asserts both directions of that drift: every path a
  manifest declares must exist, and every vendored file must be referenced by
  something.

## [1.7.5] - 2026-08-24

### Added
- **A count on the toolbar icon.** Nothing outside the page ever showed that the
  extension was working; `setBadgeText` was not called anywhere in the codebase,
  while the counts themselves had been tracked in storage all along. The toolbar
  icon now carries the number of things blocked in that tab — search results,
  filtered images, AI-filtered images — capped at `99+` so a long scroll through
  an image-heavy page cannot put four digits on it. A navigation starts a fresh
  count.

  This matters more than it sounds now that blocked results leave nothing behind:
  it is the ambient signal that the extension is alive when a quiet page is
  simply a quiet page. It reads the badge back from the browser rather than
  keeping a tally in memory, because the MV3 service worker is torn down after
  about thirty seconds idle while the badge text survives — a tally would have
  jumped from *12* back to *1* on the next block.

  Whole-site blocks are not counted, since the tab navigates to the blocked page
  and the count is cleared by that navigation anyway.
- **The count can live in the page instead of on the icon.** A badge on an
  unpinned toolbar icon is a badge nobody sees — Chrome tucks unpinned extensions
  behind the puzzle-piece menu, and no API exists to pin one on the user's behalf.
  Settings → Customization → **Blocked Search Results** → *Where To Show The
  Count* offers **Floating button on the page** instead: a small pill in the
  bottom-right corner showing what was blocked here.

  Clicking the pill lists the hosts the blocks came from, busiest first, since one
  site usually accounts for most of an image grid. The listed hosts are inert
  text — not links, no handler, nothing to click through to. Accounting for what
  happened is the point; offering a route back to it is not.

  On an image search the pill reports the *source* of each blocked picture rather
  than the search engine. Thumbnails are served through the engine's own proxy, so
  without unwrapping that address every image on the page would appear to have
  come from DuckDuckGo.

  Only one of the two is ever active: choosing the pill clears the badges already
  drawn on open tabs, so the same blocks are never reported in two places.
  Social-feed posts are counted by neither.
- **Subscribed lists.** Settings → Customization → **Subscribed Lists** takes the
  address of a ruleset file and follows it: the rules are downloaded, applied
  alongside your own entries, and re-checked once a day. Requested by a user who
  keeps his blocking in lists other people maintain and had no way to bring them
  across.

  The file format is uBlacklist's, deliberately, so an address already followed
  in that extension can be pasted in unchanged. That was mostly free: the rule
  syntax has matched since 1.7.4 (`example.com`, `*.example.com`,
  `/example\.(net|org)/`, `title/Example Domain/`), and the comment support above
  covers the headings and attribution those published files carry. What the
  parser adds is the optional YAML front matter a ruleset uses to name itself.

  **A subscribed list can only add blocks.** It cannot whitelist a site, cannot
  unblock anything, and cannot change a setting. The rule syntax has no allow
  form and nothing in the download path touches the whitelist or the enabled
  flag. A file fetched from a stranger that could say "never block this site"
  would be a remote off switch on a porn blocker, and that is the one thing this
  must never become. Turning a subscription off, or removing it, is treated as
  weakening protection and asks for the PIN like everything else in that
  category.

  A published list can be tens of thousands of lines, where a hand-typed one is a
  dozen, and those rules are consulted for every image and every search result.
  Bare domains — nearly all of any real list — therefore go into a hash set for a
  single lookup, and only the wildcard and regex entries keep the loop. That is
  the same path that made pages crawl in 1.7.0.

  Failures are reported rather than hidden. A list whose host is down keeps
  working from the copy already on disk and shows the error; one bad regex in
  someone else's file is skipped rather than costing you the other thirty
  thousand rules; and a file that is too long is applied up to the limit and says
  so. Pasting the address of a GitHub *page* instead of the raw file is rejected
  outright, rather than counting the lines of an HTML document as rules.

  One-click subscribe links work too. Authors publish buttons pointing at
  uBlacklist's redirect page, and since the format is shared, those open Settings
  here with the address filled in. Filled in only — nothing is subscribed until
  you press the button, so a web page cannot add a list by linking at one.
- **Comment lines in the three user lists.** A line starting with `#` or `!` is a
  note, ignored when matching — in the blocklist, the blocked-word list and the
  trusted-sites list. Both markers are accepted because the tools people arrive
  from disagree: uBlacklist uses `#`, uBlock Origin and AdGuard use `!`, and lists
  get pasted between all three. Requested by a user.

  Before this, such a line was not rejected — it was saved as a real entry that
  matched nothing. A dead wildcard in the blocklist, or a literal phrase in the
  word list that only fired on pages containing the text of the note. Silently
  accepting junk was the worst of the three possible behaviours.

  Two things made this more than a parser change.

  Saving sorts A–Z and de-duplicates, and a note is almost always a heading for
  the lines beneath it. Sorting lines individually would tear every comment away
  from the group it labels, so entries are now sorted in **blocks**: the comments
  immediately above an entry travel with it. Identical notes are never
  de-duplicated — two `# ---` separators are both meant to be there — and a
  duplicate entry's note joins the surviving copy rather than drifting onto
  whatever sorts next. A list with no comments in it sorts exactly as it did
  before.

  And `#nsfw` is a realistic blocked word, since hashtags start with `#`. A single
  leading backslash marks an entry that really does begin with `#` or `!` —
  `\#nsfw` — and is stripped before matching. Entries already saved that would
  now read as comments are rewritten with that escape once, on first open of the
  options page, so nothing anyone saved changes meaning.

  The rule lives in `shared/keyword-pattern.js` alongside the regex syntax, which
  means the options page and the content script cannot disagree about what a
  comment is. Every consumer of a stored list now goes through one filter, so a
  comment cannot reach a matcher — the failure that would matter here is a
  `# block example.com later` note compiled into a host pattern that blocks
  `example.com`.
- **A prompt to pin the extension.** Settings shows a dismissible banner
  explaining how to pin the toolbar icon, and why it is worth doing — the count is
  hidden without it, and so is the quickest route to unblocking a site. On Chrome
  it appears only when the icon is genuinely unpinned, via
  `action.getUserSettings()`. Firefox has no equivalent, so there it shows once
  and stays dismissed.

### Changed
- **A blocked search result is now removed, not replaced with a card.** Every
  blocked result used to become a full-width panel: the extension's logo in a
  40px circle, *Content Filtered by BlockNSFW*, a line of explanation, a
  **BLOCKED** badge and a hover lift. That is bearable when two results in ten
  are hidden. It stopped being bearable in this release, which extends filtering
  to DuckDuckGo's Images and Videos tabs and to the thumbnail rows on the All
  tab — a 5×4 image grid with fifteen blocks became twenty shield boxes and no
  pictures. Reported by a user who had just moved over from uBlacklist and ran
  into it on exactly those verticals.

  Blocked web results are now taken out of the list, and one line above the
  results accounts for them: **"3 results blocked by BlockNSFW"**. One line
  however many were blocked. Image and video results simply go — in a grid, a gap
  reads as *fewer results*, while a grid of placeholders reads as an error state.

  The line is deliberately text with nothing to click. uBlacklist's equivalent
  carries a *Show* link, which makes sense for a tool that hides SEO spam and
  makes much less sense here: a one-click reveal on every search page is a bypass
  sitting on the surface people hit while browsing normally. Revealing blocked
  results stays the popup's job, where it can be PIN-gated.

  Placeholders are unchanged for images embedded in ordinary pages. There the box
  is doing real work — holding the layout and explaining why an article has a
  hole in it — which is a different job from a search grid.

  Settings → Customization → **Blocked Search Results** keeps the old behaviour
  available: *Show a notice in place* restores the per-result card for web
  results. It is worth having rather than deleting, because a removed result is
  indistinguishable from a result that never existed, and per-position evidence
  is the point in an accountability setup. The choice covers web results only —
  image and video results are always removed, since the card is a full-width flex
  row with an avatar and a badge and a 200px tile cannot hold it. A second switch
  turns the summary line off entirely for anyone who wants no on-page footprint
  at all.

  Changing either setting re-does the results already on screen, so the picker
  does not appear to do nothing until the tab is reloaded.

### Added
- **Block a whole top-level domain.** `.xyz` on its own line blocks every site
  ending in it. Some TLDs are used almost entirely for spam and malware, and
  listing their sites one at a time is hopeless. It is the broadest entry the
  blocklist accepts, so the settings page says so plainly next to it.

  Most of this already worked and nobody could reach it: a bare host entry
  covers its subdomains, and `xyz` is only the shortest case of that. But
  `.xyz` — the form anyone actually writes — matched nothing, on both the
  navigation and the in-page path, and said nothing about it. A leading dot is
  now stripped wherever a blocklist host is read, so `.xyz` and `xyz` are the
  same entry, and `.example.com` works as well as `example.com`. Requested by
  Maksim.

  Images from a blocked TLD are hidden page-side rather than by a network rule.
  The network rule takes domains, not suffixes, and blocking every image request
  under a TLD is broader than a rule at that level should be.

### Changed
- **Notes are dimmed in the list boxes.** A `#` or `!` line now reads in grey
  while the entries stay bright, so a list with headings in it can be scanned at
  a glance instead of being one wall of identical text. Nothing about what gets
  saved or matched changed — a textarea cannot colour one line differently from
  another, so the box is drawn in two layers, with the text painted underneath
  and the real textarea kept on top for typing, selection, undo and spellcheck.
  Suggested by Maksim.

### Fixed
- **A blocklist entry written with a leading dot reached the image rule
  verbatim.** `.xyz` passed the domain check that guards the image-blocking
  rule, so the literal string `.xyz` was handed to the browser as a domain to
  block requests from. It is not a domain, and one bad entry is enough to
  invalidate the single rule that every other blocked host shares — so adding
  `.xyz` to the list could stop image blocking working for the sites that were
  blocking correctly before it.
- **Sorting filed `/regex/` entries under their slash.** Saving sorts a list
  A–Z, and a pattern entry was compared on its opening delimiter rather than on
  the word inside it, so every pattern clumped at the top of the list. Notes are
  attached to the entry written beneath them and travel with it, so a pattern
  overtaking that entry dragged the whole block down — which is how notes
  written at the top of a list ended up underneath it. (The locale order of the
  three markers involved is `!`, then `/`, then `#`, which is why the result
  looked arbitrary rather than merely wrong.) Entries are now filed under their
  first letter or digit, so `/apricots?/` sorts beside `apricots` instead of
  above the entire list. Reported by Maksim.
- **DuckDuckGo's Images and Videos tabs were not filtered at all.** A blocked
  word stopped the matching web results, then the same search on the Images or
  Videos tab showed everything. The selectors the filter used —
  `.tile--img`, `.tile__title`, `.result` — belong to DuckDuckGo's pre-React
  layout and match nothing on the current site, so there was no result to
  examine and no keyword check ever ran. Google was unaffected, which is why
  this looked like a keyword bug rather than a DuckDuckGo one.

  Both verticals now key on the `data-testid` attributes DuckDuckGo puts on
  each one, and on the semantic tags inside them (`figure` for an image result,
  `article` for a video result), because every class name on that page is a
  build hash that changes on each deploy. The old class selectors are kept as
  fallbacks so older self-hosted instances keep working.

  Two smaller things had to change with them. Image thumbnails are served
  through DuckDuckGo's own proxy — `external-content.duckduckgo.com/iu/?u=…` —
  so every picture on the page appeared to come from DuckDuckGo: the host and
  path carry no information and the real address sits in a parameter. That
  parameter is now unwrapped and scanned, as it already was for Yandex. And a
  blocked image result now takes its whole tile with it rather than just the
  picture, since the caption underneath spells out the title the block was
  keyed on.

  The All tab needed one more thing: it carries an inline row of thumbnails for
  the same query, and no result selector reached it, so the web results above it
  were replaced while the pictures stayed. Each row on that page is an
  `<li data-layout="…">` naming what it holds, so the images and videos rows are
  now treated as results and replaced whole — while ads and related searches are
  left alone.

  The knowledge panel — the Wikipedia summary above the results — is covered
  too, but judged differently. It is several hundred words of reference prose
  rather than a snippet, and at that length the built-in keyword scoring
  misreads legitimate text, so the panel is blocked only on a stated signal: a
  link to a blocklisted site, or a word from your own blocked-word list. The
  heuristics get no vote on it.
- **A search result that arrived late was never filtered.** DuckDuckGo serves no
  results in its HTML at all — the entire page is built in the browser, row by
  row. A result row therefore exists for a moment with its title still missing,
  and both filtering paths marked such a row as "inspected" on the way past, so
  once it filled in nothing looked at it again. Whichever row happened to be
  slowest that pageload was the one that survived. A row is now only marked off
  once it has actually been recognised as a result, and is re-examined until
  then.

  The incremental path the page-change observer uses had drifted from the full
  pass as well: it judged the raw changed element rather than the result row
  around it, and did not know about the explicit-signals-only rule. Both now go
  through one shared resolver, so they cannot disagree about what a result is,
  which element to replace, or how to judge it.
- **Custom blocked words were ignored in image search below the strictest
  setting.** In image results, a word from your own list only counted when the
  image filter was set to Strict; on Moderate or Lenient the built-in term list
  was consulted and yours was not. A word you typed yourself is an instruction
  rather than a heuristic, so it now applies at every level — the level still
  decides how far the built-in lists reach.
- **"Go Back" on the blocked page did nothing.** It was wired as an inline
  `onclick`, which the extension's content-security policy (`script-src 'self'`)
  blocks outright, so the click was silently discarded. It is now a real
  listener — and when the blocked page is the only entry in a tab's history,
  with nothing to go back to, it leaves the page instead of sitting there.
- **AI image blocking never worked on Firefox.** Turning the beta on did
  nothing: no image was ever scanned, no image was ever blurred, and the only
  hint was `AI runtime was not preloaded` in the background console. The cause
  was one line in `background.js`, `if (typeof self.importScripts !== 'function')
  return;`. Chrome runs the background as an MV3 service worker, where
  `importScripts()` is the only way to pull in TensorFlow.js *and* may be called
  only during the worker's first synchronous evaluation — hence the eager
  preload. Firefox has no background service worker; `background.scripts` runs in
  an event *page*, where `importScripts` does not exist at all. So the preload
  returned immediately, `tf` and `nsfwjs` were never defined, and every
  classify/ping request from the content script failed at the first step. The
  fallback chain hid it: with the model unavailable, candidate images are
  revealed rather than left hidden, so a Firefox page looked exactly like a page
  with nothing to block.

  An event page does have a DOM, so on Firefox the runtime is now loaded with
  `<script>` tags instead — lazily, on the first classify or ping, and never
  twice. Lazily matters: Firefox suspends idle event pages, and parsing the
  4.5 MB TF.js bundle on every background wake-up would be a real cost for the
  majority of users who leave this opt-in beta off. Chrome's eager
  `importScripts` path is untouched.

- **Firefox was also running the background with a degraded blocklist and broken
  path-scoped whitelists.** Same root cause, separate symptom: `background.js`
  pulls `shared/hostname.js`, `shared/host-keywords.js` and
  `shared/validate-domain.js` in with `importScripts` too, and
  `manifest.firefox.json` only declared three of the six shared helpers in
  `background.scripts`. Each missing module has a guarded fallback, so nothing
  threw — Firefox quietly used the short inline keyword list (27 entries instead
  of the full host list, no punycode handling, no ambiguous-keyword rules) and
  `whitelistPathMatches` degraded to *whole-domain entries only*, which meant a
  path-scoped whitelist entry never allowed anything. All six are now declared.
  A test asserts the manifest lists every helper `background.js` imports, so the
  two cannot drift apart again.

- **"Unblock this website" whitelisted the extension instead of the site.** Used
  from a blocked page, the popup read the address of the tab it was open on —
  which is the extension's own blocked page, not the site that was blocked. So
  the entry it saved was `moz-extension://<uuid>/blocked.html` (or
  `chrome-extension://<id>/…`), which matches nothing: the whitelist appeared to
  accept it while the site stayed blocked, with nothing to explain why. The popup
  now takes the site from the `url` parameter the blocked page already carries.
  Reported in [#26](https://github.com/codepurse/BlockNSFW/issues/26) on Firefox,
  though the same code path affects Chrome and Edge.

  Only *our own* blocked page is unwrapped, so another extension cannot point the
  popup at a site of its choosing by putting a `url=` parameter in its address,
  and a non-http target is refused rather than acted on.

## [1.7.4] - 2026-08-16

### Added
- **Images from sites you blocked yourself are now blocked too.** Adding a site
  to your custom blocklist stopped you visiting it, but its pictures still came
  through everywhere else — most visibly in image search, where a blocked site's
  results sat in the grid untouched. The two halves of the extension were never
  introduced: navigation checked your list, while the image and search-result
  filters only ever consulted the built-in blocklist. They now share the same
  answer, so a site you block is blocked as a *source* — its results are hidden
  in image search, and its images are hidden wherever they are embedded or
  hotlinked. Blocking a site by hand also now outranks the built-in trusted-CDN
  allowlist, on the grounds that typing a domain in yourself is about as
  explicit as an instruction gets.
- Alongside that, requests for images and video from sites on your custom
  blocklist are now refused at the network level rather than hidden after they
  arrive. This catches what page-level filtering structurally cannot: the
  full-size image behind a search result, and pictures hotlinked into forums and
  feeds. Page navigation is deliberately left alone so you still get the usual
  blocked page instead of a browser error. Entries scoped to a path
  (`example.com/gallery`) keep their old page-level handling, since blocking a
  whole host's images would be broader than what you asked for.

  One honest limit: search engines serve result thumbnails from their own
  servers, not from the site the picture came from, so those are matched by
  reading the source attributed to each result. That works, but it depends on
  page structure the engines change without notice. Requested in
  [#23](https://github.com/codepurse/BlockNSFW/issues/23).
- Optional access code, a second layer on top of the PIN. When enabled, a
  freshly generated random code (32, 64, 128 or 256 characters) must be retyped
  by hand before the change goes through. By default it guards only the decisive
  actions — turning blocking off, clearing the PIN, or weakening the code
  itself — so routine edits are unaffected; a switch extends it to every
  weakening change. The default is deliberately narrow: a code demanded on
  every small edit trains people to resent the feature and switch it off, which
  protects nobody. The code is not a secret — it is displayed in full above the
  input. The deterrent is the deliberate effort of typing it, so copy and paste
  are blocked (paste, drag, drop and Ctrl/Cmd+V on the input; selection, copy
  and cut on the displayed code), and a wrong answer issues a brand new code
  rather than letting the same one be retried. Off by default; turning it off
  or shortening it requires passing the challenge. Characters that look alike
  (`0`/`O`, `1`/`l`/`I`) are excluded so retyping is effort, not guesswork.
  Requested by two users.
- The blocked-site list accepts regular expressions too, matching uBlacklist's
  syntax so lists can be carried across: `/example\.(net|org)/` matches against
  the address, and `title/Example Domain/` matches against the page title.
  Wildcards (`*.example.com`, `example.com/adult/*`) remain the default, so
  existing lists are untouched. Requested by a user.

  One difference worth knowing: address patterns block before the page loads,
  while title patterns can only be applied once it has loaded, so a title match
  shows the page briefly before blocking it. Title patterns deliberately ignore
  the smart-blocking setting and apply on search engines as well — an entry the
  user typed themselves outranks the heuristics.
- Custom blocked words can now be regular expressions, so one line covers many
  spellings instead of a long list of near-duplicates. A line wrapped in
  slashes is a pattern — `/p[o0]rn/` catches both spellings, `/escort(s|ing)?/`
  catches all three forms — and everything else stays a literal, so existing
  lists are unaffected. Matching ignores capitals either way, since literals
  always have. Syntax follows uBlacklist's, which users of these tools already
  know. Requested by a user.

  Patterns are checked when you save, and a broken one is refused with the
  engine's own message. Two things are refused outright. The `g` and `y` flags,
  because they make a pattern stateful — it would match on one page and
  silently skip the next, which is worse than an error. And patterns slow
  enough to freeze pages: `/(a+)+$/` is perfectly valid and takes exponential
  time on the right input, which no amount of reading the source reveals, so
  each candidate is *timed* against adversarial input built from its own
  characters before it is ever allowed near a real page. A pattern that somehow
  reaches storage anyway is skipped at match time rather than run.
- Import and export for the custom blocklist, blocked words and trusted sites.
  Export writes one entry per line as `.csv`, which is both a valid
  single-column spreadsheet file and plain text you can paste straight back
  into the box; import accepts `.csv` or `.txt`. Blocked *words* can be phrases
  containing commas, so entries are quoted per RFC 4180 on the way out and
  unquoted on the way in — a phrase survives the round trip instead of being
  split in two. Import merges rather than replaces, so it can never silently
  drop entries you already had, and it fills the box rather than saving
  directly: you see exactly what is about to be added, and the usual PIN rules
  still apply when you press Save. Requested by a user. `.xlsx` is deliberately
  not supported — it would mean bundling a spreadsheet parser into an extension
  that ships almost no dependencies, for a format both Excel and Sheets already
  export as `.csv`.
- Custom blocklist, blocked words and trusted domains lists are now
  de-duplicated and sorted A-Z when saved, and the tidied list is shown back in
  the box immediately. Duplicate detection is case-insensitive, matching how the
  lists are actually used, so `Apricot` and `apricot` count as one entry.

### Fixed
- **The name "Jerome" was blocked**, because it contains "erome" (erome.com is
  on the adult site-name list) and those names were matched as bare substrings.
  One match is enough to block on its own, so this hit harder than the report
  suggested: a page titled "Jerome Powell speaks on rates" was blocked outright
  by the metadata scan, searching "jerome powell" blocked the results page, and
  any element or image caption naming a Jerome was hidden. Site names are now
  matched as standalone tokens — a name glued to another letter is part of a
  different word — so "Jerome", "Jerome's", "Jerome, Arizona", "St. Jerome" and
  the Greek "eromenos" all pass, while "erome.com", "on erome", "EROME",
  "erome/album/1" and "erome_2" still match. Digits and punctuation stay inside
  the boundary so "tube8" and "pornhub2" are unaffected. Reported by a user.
- **A search engine's own adult filter was read as adult content.** 4get.ca
  turns its filter on with a URL parameter, `&nsfw=no`, and the smart keyword
  filter scanned the raw query string — so the page was blocked for saying the
  word "nsfw" while doing exactly what this extension wants. Query parameters
  are now treated as controls rather than content: a keyword in a parameter
  *name* only counts when the value says the switch is turned on, so `&nsfw=no`,
  `&nsfw=0` and `&hide-nsfw=true` pass while `&nsfw=yes` (the user switching the
  engine's filter off) still blocks. Parameter values are unchanged — `?q=porn`
  is still a signal — and so are paths, so `/porn/clip?nsfw=no` blocks on the
  path alone. Reported by a user of 4get.ca.
- **Settings could be weakened without the PIN.** Several changes that reduce
  protection were not covered by the PIN gate, so a blocked word could be
  deleted in seconds and put back later. All of these now require the PIN:
  removing custom blocked words (both the main save and the dedicated save
  button), adding a trusted image domain, lowering image filtering or either AI
  strictness level, turning off DNS Protection, switching the blocked page to a
  custom URL or changing that URL, and uploading custom HTML for the blocked
  page. Clearing the PIN now also has to pass the access code when one is set.
  Reported by a user who found they could edit their own blocked word list
  during a moment of temptation.
- **AI text detector blocked ordinary sites**, most visibly `m.youtube.com` at
  99% confidence. The v3 model's vocabulary is inverted: measured in isolation
  it scores `videos` (+8.27) as a stronger adult signal than `nude` (+0.27),
  `naked` (-0.44) or `erotic` (-0.60), and `youtube` (+3.74) inherits weight
  from `tube` purely through character n-grams. The cause is the training data —
  adult phrases average 1.7 words per line against 8.0 for the benign ones, so
  short generic media words absorbed the positive signal. No threshold separates
  that, so text blocking has been restricted rather than retuned (see Changed).
  A retrained model is planned.

### Changed
- **The AI text blocker no longer blocks a page on text alone.** Until the model
  is retrained, a high text score only blocks when the AI image scanner has
  independently flagged an image on the same page. This makes the text detector
  weaker and it will miss adult pages it would previously have caught; the other
  layers (blocklist, keywords, URL matching and the image scanner) are
  unaffected. The trade is deliberate while the model cannot be trusted alone.
- Changes that *tighten* protection remain free of any prompt. Adding a blocked
  word or domain, raising strictness, and turning protections on never ask for
  the PIN or access code — only weakening does. This is intentional: making it
  harder to strengthen your own protection would work against the point of the
  extension.

## [1.7.1] - 2026-07-14

### Added
- Path-scoped whitelisting. A whitelist entry can now target a single section
  of a site instead of the whole domain — e.g. `reddit.com/r/NoFap` allows that
  subreddit while the rest of reddit.com stays blocked. Entries with no path
  behave exactly as before (whole domain), so existing entries are unaffected.
  Matching is path-segment-boundary safe (`/r/NoFap` never allows
  `/r/NoFapVille`) and case-insensitive. The popup and options inputs accept a
  bare domain or a domain+path, and scoped entries are labelled "Page only" in
  the list. Enforced in all three gates (background navigation, content-script
  block, content-script page scan) via a shared `whitelistPathMatches` helper in
  `shared/validate-domain.js`. Known limitation: path scope is re-evaluated on
  navigation and full page loads, so on SPA navigation (e.g. new reddit.com
  switching subreddits without a reload) the page-scan gate keeps the value from
  initial load; full-reload sites like old.reddit.com are unaffected.

### Fixed
- Major browsing slowdown on content-heavy and dynamic pages (streaming chat
  apps, SPAs, infinite scroll), present even with all AI/smart features off. The
  `content.js` MutationObserver ran heavy work synchronously on every DOM
  mutation — reading each added node's `textContent` and running three
  subtree `querySelectorAll` sweeps — which becomes O(n²) as a re-rendering
  container grows. Media (img/video/iframe) discovery for container nodes is now
  deferred to a coalesced `requestIdleCallback` batch (directly-added media is
  still checked instantly), the per-node `textContent` read is removed, and
  page-text scanning is only scheduled when a text feature is actually enabled.
- `debounce()` used a single shared module-level timer, so the page-text,
  search-result and social-post debouncers cancelled each other and only the
  last-scheduled one ran. Each debounced function now owns its timer, making
  dynamic-content filtering reliable.

### Changed
- The MutationObserver now honors the site whitelist (via a cached flag) and
  bails immediately when the page is blocked or the extension is disabled, so a
  whitelisted site does no per-mutation work at all.

## [1.7.0] - 2026-07-07

### Added
- First-run onboarding wizard (`onboarding.html` / `onboarding.js`). Opens
  once on fresh install only (`onInstalled` `reason === 'install'`, guarded by
  `pblocker_onboarding_completed`). Four steps: welcome / on-device explainer,
  enable AI image + text protection with a strictness preset, optional PIN /
  commitment lock, and Desktop Guard uninstall-proofing. Writes the same
  storage keys the rest of the extension reads (`pblocker_settings`,
  `pblocker_pin`). A "Re-run setup wizard" link was added to the options
  Welcome section.

### Fixed
- Chrome content script ran at `document_idle`, which fired after the page had
  largely painted and defeated the `instantBlockEarly()` anti-flash early
  block. Chrome `manifest.json` now uses `run_at: document_start`, matching
  `manifest.firefox.json` and the content-script design, so blocklisted pages
  are redirected before they render.

### Removed
- Bundled desktop guard source (Windows/Linux native companion app). It is now
  maintained in the standalone `codepurse/extension-guard` repository.

## [1.6.1] - 2026-06-06

Non-English adult-site blocking improvements. No algorithm-breaking changes;
all existing English blocking still works.

### Fixed
- `isLikelyDomain()` regex silently dropped IDN / punycode hostnames
  (`xn--` prefixed labels). The 93 punycode entries already present in
  `data/HOSTS.txt` are now retained at runtime.

### Added
- Browser-safe punycode / IDN helpers in `shared/hostname.js`. Decodes
  `xn--...` labels per RFC 3492 without relying on Node-only APIs.
- Shared smart-blocking module in `shared/host-keywords.js`. Single
  source of truth for adult host keywords and the safe-host bypass
  (`SAFE_HOST_TOKENS`). Loaded by both `background.js` and `content.js`
  so the service-worker early block and the on-page decision agree.
- Hostname smart filter now scans both the ASCII / punycode form AND
  the decoded Unicode form of a hostname.
- Multilingual host-keyword curation in `STRONG_HOST_KEYWORDS`:
  Chinese (`色情`), Korean (`야동`), Russian (`порно`), Arabic (`سكس`),
  Thai (`หนังโป๊`), plus transliterated Latin (`bokep`, `yadong`,
  `seks`, `sikis`).
- `AMBIGUOUS_HOST_KEYWORDS` documentation list of rejected tokens
  (`sex`, `jav`, `cam`, `tube`, `video`, `live`, etc.) with reasons,
  so future curation stays conservative.
- Curation policy header in `data/HOSTS.txt` and `data/SOURCE_NOTES.txt`
  documenting the missed-site reporting flow and the parent-domain
  rules.
- 27 new focused tests (62 total, all passing) covering punycode /
  IDN, multilingual positive coverage (CN / JP / KR / Cyrillic / AR /
  TH), strict whole-label vs substring matching, and false-positive
  guards for benign contexts.

### Changed
- `data/blocklist.json` regenerated from the curated `data/HOSTS.txt`
  using the same parser rules as the runtime. Deduplicated, validity-
  filtered, 58,075 entries. Same exact-domain coverage as the runtime
  load path; older JSON was 32,793 entries larger because it included
  duplicates and 4 invalid hostnames that the runtime would have
  silently rejected.

## [1.6.0]

Current open-source baseline at time of public-repo preparation.

Highlights already present in codebase:

- Manifest V3 Chrome and Firefox manifests
- Remote blocklist and whitelist caching
- Expanded SafeSearch enforcement across multiple search engines
- Optional DNS Protection through Cloudflare for Families
- Reddit NSFW checks
- Facebook Reels and Instagram Reels controls
- Local audit pages, stats pages, and whitelist tools
- Manual community report flow

## Older Notes

Historical release notes still exist in:

- `VERSION_NOTES.md`
- `UPGRADE_NOTES.md`
