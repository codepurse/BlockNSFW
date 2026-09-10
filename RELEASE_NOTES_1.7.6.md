# BlockNSFW 1.7.6

*Released 30 August 2026*

A large release. The headline is that the extension stops slowing your browser
down — that was the most-reported problem and it had four separate causes. Also
here: a choice of DNS resolver instead of one hardcoded provider, a second and
more accurate image-detection model that made the download *smaller* rather
than bigger, and a run of fixes for people who develop software locally, use X,
or rely on the access code.

---

## Highlights

**Your browser stops feeling slow.** Several of you reported Firefox feeling
janky, and busier pages lagging the whole machine. It was not one hot loop but
four costs multiplying each other:

- Blocking an image used to cost about thirteen writes to storage — and on
  Firefox each is a disk transaction against the same disk the page is loading
  from. A page blocking 150 images made roughly 1,950 of them. It now makes
  six, and that number no longer grows with how much a page blocks.
- Every time the browser woke the extension after an idle pause, it re-saved
  its settings, which told every open tab to re-scan its page from scratch. One
  wake cost a full re-scan in every tab you had open. It now costs nothing.
- The image scan measured each picture's position while it was hiding others,
  forcing the browser to recalculate the whole page layout once per image. On
  an image grid that meant hundreds of recalculations in a row, on every pass.
- The page-text scan re-read the entire rendered page — another full layout
  recalculation — as often as ten times a second on any site with a live feed,
  a chat widget or a rotating ad.

Measured on a dynamic-feed benchmark in Firefox: median frame rate up from 27
to 34 fps, average frame time down 22%, worst frame of a run down 41%, with the
same number of elements blocked before and after.

**Long sessions stay fast too.** Feeds that recycle rows as you scroll — X,
Reddit, Instagram — left every picture the tab had ever shown held in memory
for the life of the tab. That is why things got slower the longer you browsed.

**Choose who answers your DNS queries.** DNS Protection was hardcoded to
Cloudflare for Families, which made one company both the only option and a
single point of failure — when it was unreachable, the layer quietly stopped
working with nothing in the interface to say so. You can now pick Cloudflare
for Families, AdGuard DNS Family, Mullvad DNS Family or the CleanBrowsing Adult
Filter, and if one does not answer, a second on a different network is asked.
All four are free, need no account, and are queried straight from your own
browser — nothing passes through our servers.

Picking **Custom** takes any DNS-over-HTTPS address: your own NextDNS config, a
Control D profile, DNS for Family, or a resolver you run yourself. A custom
resolver deliberately has *no* fallback — you chose who sees your browsing, and
quietly redirecting those queries elsewhere when your resolver hiccuped would
override that choice without telling you.

**A second, more accurate image-detection model — and a smaller download.**
Settings now offer a detection-model picker: the bundled NSFW.js model (still
the default, still works offline) or Marqo's Vision Transformer. The reason to
want the second one is not a headline accuracy figure; it is that it answers
one question — is this explicit? — instead of five. The old model's "Sexy"
class fires on beaches, fitness photos, fashion and ordinary portraits, which
is why its bar had to sit very high to avoid blurring holiday snaps.

Its weights are **not** in the extension package — bundling them would have
grown the store download about five-fold for a feature that is opt-in and off
by default. They are fetched once on first use and cached by your browser. Your
images are never uploaded; the traffic goes one way, and the model comes to
you.

## Also new

- **DuckDuckGo and Brave now use their dedicated locked SafeSearch endpoints**,
  so strict filtering is enforced by the search host itself and its own
  SafeSearch controls are switched off. The non-JavaScript DuckDuckGo layouts
  keep working and still get strict mode.
- **Strict search enforcement now covers image, video and news tabs** on Bing,
  Ecosia and Presearch, which previously only had their main web-search route
  protected.
- **Yandex now runs in Family mode**, applied before its first search request
  and kept in step across its regional domains, with the weaker options locked
  on its settings page.
- **First-run setup has a fifth step covering blocking beyond this browser.**
  It offers the in-extension DNS check as a toggle (off by default, like
  everything that sends anything off-device), then gives you copyable addresses
  to set on your device or router — which covers every app rather than one
  browser, and survives the extension being removed. The step is skippable.
- **Firefox's documented minimum is now 113**, the first release with the
  request-header rules SafeSearch enforcement uses.

## Fixed

- **The AI image filter flagged explicit images on X without blurring them.**
  ([#17](https://github.com/codepurse/BlockNSFW/issues/17)) The model was
  working — the blocks were counted — but the blur kept coming back off. X
  keeps a pool of image slots and swaps their contents as you scroll, so the
  picture in a slot could change while its check was still running, and the
  previous occupant's verdict was applied to whichever image had arrived. A
  verdict now remembers which picture it was for and is discarded if the slot
  has moved on.
- **None of the buttons on the audit log's pagination worked.**
  ([#17](https://github.com/codepurse/BlockNSFW/issues/17)) Every one was a
  silent no-op, so the log was stuck on its first 20 entries.
- **The popup could unblock a whole site with nothing but the PIN**, however
  you had configured the access code.
  ([#29](https://github.com/codepurse/BlockNSFW/issues/29)) The access code —
  whose entire point is that retyping 32-256 characters outlasts an urge —
  existed only on the Settings page. The popup had its own older gate that
  checked four digits and returned, so *unblock this site* wrote a whole-site
  exception without ever asking for the code. Both now use the same gate.
- **Changing detection strictness demanded the full access code.** Nudging
  image strictness down one step cost the same 32-256 characters as turning
  blocking off entirely. Nobody doing that was trying to switch the AI off —
  they were trying to stop a holiday photo being blurred. Sensitivity dials are
  now their own tier and never ask for the code; your PIN still applies, and
  the master switches are gated exactly as before.
- **Local development servers were blocked, with no way out of it.**
  `localhost` and every other local address was redirected to the blocked page
  on every load, by two separate mechanisms — and the whitelist refused to
  accept `localhost` or a bare IP address, so there was no spelling of the one
  thing that would have helped. The heuristic scans now skip local and private
  addresses, and the whitelist accepts them. Your own blocklist and title
  patterns still apply there, because those are an instruction rather than a
  guess.
- **The AI text classifier could switch itself on.** It is an opt-in beta and
  documented as off by default, but a missing setting read as "enabled" —
  downloading and scoring a model on every page for a result that was then
  discarded anyway.
- **A page that changed only in the middle could escape the text scan.** The
  scan recognised pages it had already judged by their first line, last line
  and line count, which a site swapping content under a fixed header and footer
  leaves untouched. It reads the whole text now.
- **Embedded frames were re-checked on every pass**, even after being cleared.
  A frame later pointed at a different address is still re-checked.

## Changed

- **Whitelisting a whole site is now treated as a critical action.** It unlocks
  every page on the domain, which is as total as switching blocking off, so it
  asks for the access code under the default scope — as does importing a
  whitelist file. Whitelisting a single *page* opens one section and is not
  critical. Both ask only after the entry has been checked and found not to be
  a duplicate, so a typo cannot cost you 256 characters of typing.
- **Chrome no longer loads the image-classifier runtime unless it is used**, and
  releases it after five idle minutes or immediately when the AI image blocker
  is switched off.
- **The blocklist is no longer rebuilt every time the background wakes.**

## Removed

- **The remote announcement banner.** It rendered a message fetched from this
  repository, which meant a notice could be broadcast to every install by
  editing one file, with no store release. The banner and its six-hourly fetch
  are gone, so opening Settings makes one fewer network request.
- **About 856 KB of dead code that shipped in every release** — a worker and
  the two libraries it imported, left behind by an earlier change and copied
  into the package by the build even though nothing referenced them. The Chrome
  package drops from 4.99 MB to 4.13 MB.

## Upgrading

Nothing to do. Settings carry over, and the default detection model is
unchanged — the new one is opt-in under *Settings → AI Image Blocker*.

Two things worth knowing:

- If you use DNS Protection, it still defaults to Cloudflare for Families. The
  other three resolvers and the custom option are there when you want them.
- If you had the AI text classifier appearing to run despite never enabling it,
  that was the bug above; it is genuinely off now unless you turn it on.

The full technical detail for every item is in
[CHANGELOG.md](CHANGELOG.md#176---2026-08-30).
