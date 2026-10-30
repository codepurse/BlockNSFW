# Privacy Policy for BlockNSFW

**Last Updated:** October 30, 2026

## Overview

BlockNSFW is a browser extension designed to block adult websites and inappropriate content for safer browsing. To do this, the extension analyzes website data in your browser, stores certain settings and logs locally on your device, and makes limited network requests only when a feature requires it.

Most filtering decisions are made locally in your browser. We do not sell personal data, do not use your data for advertising, and do not run general analytics or telemetry for ordinary extension usage.

## How We Collect and Handle Data

BlockNSFW may handle data in the following ways:

- **Automatically on-device while you browse:** the extension may access and process the URL, domain, page title, page metadata, visible text, links, and certain page element attributes in order to detect and block adult or inappropriate content.
- **When you change settings:** the extension stores your configuration and related preferences in browser extension storage on your device.
- **When optional network-based features are used:** the extension may send limited data to third-party services that help provide a feature, such as DNS filtering, rule updates, or Reddit NSFW checks.
- **When you manually submit a report:** the extension sends the information you choose to submit, along with limited technical data needed to process the report.

## Data We Handle

Depending on which features you use, BlockNSFW may handle the following categories of data:

- Website URLs and domains
- Page titles and metadata
- Visible text, links, and certain content attributes used for filtering
- Subreddit names or Reddit URLs when Reddit-related filtering is used
- Addresses of image files, when the on-device image classifier is enabled
- Extension settings and preferences
- Addresses of any rule lists you choose to subscribe to
- Whitelist entries, temporary allow-list entries, and custom block patterns
- Local blocked counts, statistics, streak data, and history summaries
- Local audit log entries for blocked pages and extension disable/enable events
- PIN or lock settings if you choose to set one
- Information submitted in a manual website report, such as a URL, domain, report type, category, and optional notes
- The text of a community story, if you choose to write and submit one
- A locally generated device identifier used to help rate-limit and de-duplicate manual reports, community stories, and story likes

## What We Do Not Collect or Do

- We do not sell your personal data.
- We do not use your data for advertising, profiling, or creditworthiness decisions.
- We do not require an account, sign-in, or payment information to use the extension.
- We do not maintain a central browsing-history database of your ordinary browsing activity on our own servers.
- We do not send automatic background telemetry about your general browsing activity to our own backend.

## What We Store Locally

BlockNSFW stores data locally in your browser extension storage on your device. This may include:

- Extension settings and preferences
- Custom block patterns and keyword settings
- Whitelist entries and temporary allow-list entries
- Cached remote blocklist and whitelist data
- Rule-list subscriptions you have added, and the rules downloaded from them
- Local blocked counts, daily history, and top blocked domains
- Local audit/history entries related to blocked pages and extension disable/enable events
- PIN or lock data if you set a PIN. The PIN is stored as a salted
  PBKDF2-SHA256 hash (150,000 rounds), never as plain text; a PIN saved by an
  older version is turned into a hash the first time you enter it. A count of
  wrong tries is kept too, so that after five, PIN entry waits a minute,
  doubling up to an hour. The PIN is a deliberate speed bump against your own
  impulse, not a defence against someone with access to your computer: a
  short PIN can still be guessed from its hash, and anyone who can open your
  browser's developer tools can change extension settings directly, whatever
  the PIN is set to. Do not reuse a PIN that protects anything else
- Access code configuration if you enable it. The code itself is generated
  fresh each time it is shown and is never stored
- How turning protection off works, as you chose it, and, if you wrote your
  own sentence for it, that sentence. It is part of your settings, so a backup
  holds it too; it is never sent anywhere
- The Pact, if you make one: the wait you chose, the changes waiting it out,
  the time last read from the server's clock, and a count of wrong witness
  codes. With a witness, also the key their authenticator app shares with
  this one, and your recovery codes
- Storm Mode and your risk hours, if you use them: when each starts and ends
- Streak and usage-related local counters used by extension features
- The result of the most recent update check
- Setup progress, such as whether first-run onboarding has been completed
- When the on-device image classifier is enabled, a cache of recently
  classified image addresses and their scores. This is kept in session storage
  where the browser supports it, which is cleared when the browser closes; on
  older browser versions that lack it, the cache is written to ordinary local
  extension storage instead and persists until cleared
- Manual report and community story cooldown data, daily limits, report keys,
  a cached copy of the community stories you have viewed, which stories you
  have liked, and a locally generated device identifier
- For the stories shelf in the Settings sidebar: the title, length and
  publication date of the newest published stories, a few short passages
  from them, and when they were fetched. These are other people's published
  stories, not anything about you
- Your progress on the path (which days you have read and finished), and the
  one-line answers you write there
- Your evening check-ins (how you slept, your stress, time alone, mood and
  whether you moved), and whether each day had a hard moment
- A long record of the last 400 days, one line per day: whether the day was
  kept, how many times you turned back at a gateway, waited a moment out or
  slipped, how many pages were held, and the hours the hard moments came.
  It holds counts and hours only, never a site or a page
- A photo you choose for the hard moment, if you choose one, shrunk on your
  device
- A message you record in your own voice for the hard moment, if you record
  one (up to a minute), or a sound file you choose instead (up to ten
  minutes). The microphone is used only while you record, and only after
  your browser asks you to allow it. The sound stays on your device and
  plays when you tap "Hear yourself", or by itself on the blocked page if
  you switch that on
- For each urge you wait out on the blocked page (the last 200): when the
  wait started, how long it took until you pressed "I'm OK now" (never more
  than the wait itself), and how strong it was before and after, from 1 to
  5, if you said. Proof it passes, if it is switched on, draws these as a
  dial on the blocked page; whether it is switched on is kept too
- For Storm warning, if you use it: whether it is switched on, the evening
  you last said "Not tonight", and when you last started Storm Mode from it.
  The warning itself is worked out on your device each time the popup
  opens, from the records above, and is not kept
- The colours of a Supporter look, if you choose one
- Which popup face you chose (Plain, your words, days kept, your photo or
  the path), if you choose one. The face is drawn from the records above
  each time the popup opens, and nothing else is kept for it
- Your supporter code, if you enter one
- A random identifier for this computer, made on the device, used only to
  tell your computers apart in a backup or in sync
- Your other computers' history, if it reached this one from a backup or
  sync: the same kind of record as the long record above (counts and hours,
  never a site or a page), the last five weeks of when you turned back,
  waited a moment out or slipped, and a name for each computer such as
  "Chrome on Windows"

This locally stored information remains on your device unless you remove it, reset extension data, or uninstall the extension, except for entries that are automatically trimmed or expire as described below.

## Network Requests and Third-Party Services

BlockNSFW may contact third-party services for specific functionality. These requests are limited to what is needed for the relevant feature.

### 1. Filtering DNS Resolvers

If DNS Protection is enabled, BlockNSFW sends domain lookup requests over
DNS-over-HTTPS to the resolver you have selected, to help determine whether a
domain should be blocked. **This means the resolver you choose sees the
hostnames you visit**, in the same way it would if you configured it on your
device directly. The requests go from your browser to that resolver; they do
not pass through any server we operate.

- Default behavior: **off**. DNS Protection is opt-in and can be turned off
  again at any time in extension settings
- Purpose: domain-level adult content filtering
- Data involved: the hostname being checked, and standard network metadata such
  as your IP address, which any DNS resolver necessarily receives
- Services available, one selected at a time:
  - Cloudflare for Families — `family.cloudflare-dns.com` (default)
  - AdGuard DNS Family — `dns-family.adguard.com`
  - CleanBrowsing Adult Filter — `doh.cleanbrowsing.org`
  - **Custom** — any DNS-over-HTTPS endpoint you enter yourself. If you use
    this, the operator of that endpoint receives the queries, and their privacy
    policy applies rather than any of the above
- **Failover:** if a preset resolver does not answer — a timeout, an error, or
  no response — the query is retried against one other preset on a different
  network, so a single resolver being unreachable does not silently disable the
  feature. This means a hostname may occasionally be sent to a preset resolver
  other than the one you selected. A resolver you entered yourself is never
  failed over, because choosing it is a choice about who sees your browsing
- Queries are cached locally for an hour and are only made for hostnames that
  the local blocklist has not already decided about, so the number of lookups
  is far smaller than the number of pages you visit
- Local, private and intranet addresses are never sent to any resolver

### 2. Rule List Subscriptions

If you subscribe to a rule list, BlockNSFW downloads that list from the address
you provided, on adding it and roughly once a day thereafter.

- Default behavior: **none are subscribed** unless you add one
- Purpose: keep a blocklist maintained by someone else up to date
- Data involved: standard request metadata sent to whoever hosts that address,
  including your IP address. We do not choose these addresses and do not
  receive anything about them
- A subscribed list can only add blocks. Nothing in the format can remove a
  block, disable the extension, or change your settings

### 3. GitHub-Hosted Blocklist, Whitelist and Version Updates

BlockNSFW downloads its blocklist and whitelist from GitHub-hosted files in
this project's repository, roughly twice a day, to keep filtering rules
current. With them comes a short list of search engines SafeSearch can't
reach, so those can be blocked. On the same schedule it
fetches a small file listing the latest published version, so it can tell you
when an update is available. The same
file can carry Supporter's current offer, such as a founding price, which
Settings › Supporter shows as text.

- Services used: `raw.githubusercontent.com` (the files `data/HOSTS.txt`,
  `data/WHITELIST.txt`, `data/UNSAFE_SEARCH.json` and `data/version.json` in
  this project's public repository)
- Purpose: update domain block and allow rules; check for a newer release
- Data involved: standard request metadata only. These are plain file
  downloads — nothing about your browsing is sent with them, and the request
  is identical for every user
- These requests are not used for advertising or behavioral profiling

While a change is waiting under **The Pact** (Settings, Security), BlockNSFW
also asks GitHub for the time, so the wait can't be skipped by changing your
computer's clock. It sends a `HEAD` request for the same `data/version.json`
file and reads only the server's `Date` header. This happens only while
something is waiting: when the change is asked for, about every half hour, and
when it comes due. Nothing about the change, your settings or your browsing is
sent with it.

The Pact's witness key and recovery codes stay in your browser. Pairing a
witness shows the key as a QR code on your own screen for them to scan; it is
never sent to us, to the witness, or to anyone else. Witness codes are worked
out from that key and the clock, on your device and in their app separately.

### 4. Optional Detection Model Download

If you switch the AI image blocker to the optional "Vision Transformer
(ViT-384)" model, BlockNSFW downloads that model's weight files once from a
GitHub-hosted URL and caches them in your browser.

- Service used: `raw.githubusercontent.com`
- Purpose: obtain the optional image classifier you selected
- Data involved: standard request metadata only
- The default model is bundled with the extension, so no download happens
  unless you choose the optional one
- **Your images are never uploaded.** The download goes in one direction: the
  model comes to your device, and all image analysis happens locally

### 5. Reddit API Checks

When Reddit-related filtering features are used, BlockNSFW may query Reddit endpoints to determine whether a subreddit is marked as NSFW.

- Service used: `www.reddit.com`
- Purpose: help identify NSFW Reddit content
- Data involved: subreddit name or Reddit URL needed for the check, plus standard request metadata. Because this request is made from the page you are on, it carries your Reddit cookies when you are browsing Reddit itself

### 6. Manual User Reports to Our Appwrite-Hosted Backend

If you choose to report a blocked or misblocked website, that report is sent to and stored in our Appwrite-hosted backend database for review.

- Service used: `699ac1b100018b3f455a.sgp.appwrite.run`
- Purpose: review false positives, missed blocks, abuse prevention, and improve filtering
- Data involved: the reported URL, normalized domain, report type, category, optional notes you submit, a generated device ID, a report key used to reduce duplicates, browser type, extension version, and standard request metadata
- Access: submitted reports may be reviewed by authorized developers or administrators for moderation, abuse prevention, and product improvement
- This is manual only. We do not send automatic background telemetry for ordinary browsing activity to our backend

### 7. Community Stories

The Community page shows recovery stories other people have chosen to share,
and lets you write one.

- **Reading:** opening the Community page fetches the published stories from
  our Appwrite-hosted backend. So does opening Settings, for the stories shelf
  in its sidebar, at most once every six hours. That request carries standard
  network metadata, including your IP address, and nothing else. No request
  is made unless you open one of those pages
- **Writing:** if you submit a story, its title and text are sent to and stored
  in that backend, together with a generated device identifier, the extension
  version and your browser type. Stories are submitted under the name
  "Anonymous" — we do not ask for, and the extension does not send, your name
  or any contact details
- **Liking:** liking or unliking a story sends the story's identifier and your
  device identifier, so that a like can be counted once and undone
- Submitted stories are reviewed before publication and may be moderated,
  edited for length, or declined
- **A story is published to strangers.** Please do not include anything you
  would not want read publicly — real names, workplaces, addresses, or details
  that identify you or anyone else. Once a story is published we cannot
  guarantee it has not been copied elsewhere
- Service used: `6a3aafbf000d1e70cc28.sgp.appwrite.run`
- Purpose: let people who use the extension read and share recovery
  experiences
- Access: submitted stories may be reviewed by authorized developers or
  administrators for moderation and abuse prevention

### 8. Image Addresses, When the On-Device Image Classifier Is Enabled

To classify an image, the extension needs the image itself. It re-requests the
image from wherever the page loaded it from, usually straight out of the
browser cache.

- Default behavior: **off**. The AI image blocker is opt-in
- Purpose: fetch the image bytes so they can be analysed on your device
- Data involved: a request to the site hosting the image — the same host the
  page had already loaded it from. These requests are sent **without cookies
  or credentials**
- **Images are never uploaded.** All analysis happens on your device. Nothing
  about the image, and no score, is sent to us or to anyone else

### 9. Addresses You Ask the Extension to Check

Two settings send a request to an address you typed in yourself: testing that
a custom blocked-page address is reachable, and testing that a DNS resolver
answers. These only happen when you press the button.

### 10. Checking a Supporter Code

Supporter is optional, and blocking is the same with or without it. If you
buy it, the payment page is run by Polar (polar.sh), our payment provider, and
what you give there is covered by Polar's own privacy policy. BlockNSFW never
sees your payment details.

- When: when you enter a code from the store in Settings › Supporter and
  press Unlock, then at most about once a day, when you open the
  extension, so that a monthly or yearly plan that has ended closes the
  extras, and when you press "Remove it from this browser"
- Where: `api.polar.sh` (or `sandbox-api.polar.sh` while we test with Polar's
  test store)
- Data involved: the code and our store's identifier, sent without cookies.
  A plan works on a limited number of browsers at once, so entering the code
  also sends a name for this browser, made from its kind and system (for
  example "BlockNSFW · Chrome on Windows"), and Polar returns a number for
  this browser's place on the plan, which later checks send back. That name
  shows on your Polar purchases page, so you can tell your browsers apart.
  Nothing about your browsing, your check-ins or your path is sent
- The code and that number are kept on your device. If the check can't reach
  the store, the extras simply stay as they were
- The "Open your purchases" and "Manage or cancel your plan" links open
  Polar's purchases page (`polar.sh`, or `sandbox.polar.sh` while testing) in
  a new tab, only when you click them
- The "Become a supporter" button opens Polar's checkout in a new tab, only
  when you click it. Its address says which page of the extension led there,
  as one word from a fixed list (for example `release` for the 2.0 page,
  `popup`, `path`, or `settings`), so we can see what helps people decide.
  Polar keeps that word with the checkout. Nothing else about you or your
  browsing is in it
- A code the developer makes by hand (one that starts with `BN1-`) is checked
  on your device and is never sent anywhere

The Supporter extras themselves (days 8 to 30 of the path, the evening
check-in, Your good days, When it's hardest, Your month and Your year, the
photo and the voice message for the hard moment, Proof it passes, Storm
warning, your progress on every computer, and Supporter looks) are not open
source, unlike the rest of
BlockNSFW. They ship inside the extension like everything else, never decide
what is blocked, make no network requests of their own, and keep what they
store on your device, as described above, except what you choose to sync
(section 11).

### 11. Your Progress on Every Computer (Browser Sync)

Off until you switch it on, in Settings › About › Your data, and only for
supporters.

- What: your long record (counts and hours per day, never a site or a page),
  the last five weeks of when you turned back, waited a moment out or
  slipped, the path and the lines you wrote, your evening check-ins of the
  last 120 days, your own words, and a name for each computer such as
  "Chrome on Windows"
- Where: your browser's own sync (`storage.sync`), which your browser stores
  with your Google account (Chrome, Edge) or Firefox account, under that
  provider's privacy policy. BlockNSFW has no server for this and never sees
  it. It travels only if you're signed in to your browser with sync on
- Never: protection settings, your whitelist or lists, the PIN, the Pact or
  its witness, an access code, your Supporter code, your photo or your voice
  message
- When: when you open the popup or Settings, at most once a minute
- Switching it off stops it. What was already synced stays in your browser's
  sync until you remove it there or reset your browser's sync

### 12. Backups

A backup is a file you save yourself, from Settings › About › Your data. It
goes wherever you put it; BlockNSFW sends it nowhere. It holds your settings
and lists, your history (counts and hours per day, and the last five weeks
of when you turned back, waited a moment out or slipped), the path,
check-ins, your own words, your photo and voice message, how long the urges
you waited out took to pass, and your current run. It never holds the PIN, the Pact or its witness, an access code, your
Supporter code, the log of blocked addresses or which sites were blocked
most. Because it holds your history, words, photo and voice, keep the file
somewhere private.

### 13. The 2.0 Film (YouTube)

The 2.0 page (and a link in Settings › What's new) offers a one-minute film
about the update. It is hosted on YouTube. Nothing is loaded from YouTube
until you press play: the page shows a picture that ships with the
extension.

- When: only when you open the film
- What: the film plays in YouTube's privacy-enhanced player
  (`www.youtube-nocookie.com`), which then loads video from Google's servers.
  YouTube and Google handle that request under Google's privacy policy
- To let the player run inside the extension, that one request is sent with
  our website, `https://monolab.dev/`, as its referrer, for as long as the
  film is open. Nothing about you or your browsing is added to it
- Closing the film removes the player. "Watch on YouTube" opens the film on
  www.youtube.com in a new tab instead

### 14. The Page That Opens When You Remove BlockNSFW

When you remove BlockNSFW, your browser opens a page on our website,
`https://monolab.dev/blocknsfw/goodbye`, that asks why, in one tap. The
extension sets this address while it is installed; the browser opens it after
the extension is gone.

- What the address carries: the BlockNSFW version, your browser (Chrome, Edge
  or Firefox), and roughly how long BlockNSFW was installed (under a day,
  under a week, under a month, or longer). Nothing else: no device ID, no
  settings, nothing about what you browsed or blocked
- What the page keeps: a count of the page being opened, with those three
  things; the reason you tap, if you tap one; and a note, if you write and
  send one, with the reason and the day beside it. Answering is optional, and
  closing the tab sends nothing more
- What it does not keep: your internet address (it is used for an hour, in a
  one-way form, to limit how often one connection can send), your email
  address (the page never asks for it), or any cookie
- Where it is kept: our website's database (Upstash, through Vercel). The
  counts are totals. Only the newest 500 notes are kept; older ones are
  deleted as new ones arrive
- Who sees it: the developer, to find out what to fix
- Don't write anything in a note that identifies you. If you want a reply,
  write to the address under Contact instead

## How We Use Data

We use the limited data handled by BlockNSFW only to:

- block or allow content based on your settings
- analyze pages locally so filtering can work
- keep local settings, logs, counters, and statistics working
- refresh remote filtering rules, including any rule lists you subscribed to
- tell you when a newer version has been published
- download the optional detection model you selected
- perform optional DNS-based domain checks
- perform optional Reddit NSFW checks
- fetch image files so they can be classified on your device
- show, submit and moderate community stories, and count story likes
- process and review manual user-submitted reports
- prevent abuse and duplicate report or story submissions
- learn why people remove BlockNSFW, from the page that opens when they do

We do not use this data for unrelated purposes.

## Data Sharing and Disclosure

We do not sell personal data to third parties.

We share or transmit limited data only when needed to provide a feature or process a request you initiate. The parties that may receive data are:

- **The filtering DNS resolver you selected** — Cloudflare for Families,
  AdGuard, CleanBrowsing, or an endpoint you entered yourself — when
  DNS Protection is enabled, and occasionally one other preset resolver when
  your selected one does not answer
- **GitHub-hosted resources**, when blocklist, whitelist or version updates are
  downloaded, or when the optional detection model is downloaded
- **Whoever hosts a rule list you subscribed to**, when that list is refreshed
- **The sites hosting images on pages you visit**, when the on-device image
  classifier is enabled and re-requests an image to analyse it locally
- **Reddit**, when Reddit NSFW checks are performed
- **Our Appwrite-hosted backend**, when you manually submit a website report,
  when you open the Community page, and when you submit or like a story
- **Our website, monolab.dev**, when you remove BlockNSFW and your browser
  opens the page that asks why (section 14)

Outside of the cases above, we do not share your data except if required by law, needed to protect security, or as part of a business transfer such as a merger or sale of assets.

## Data Retention

- Local settings, whitelist entries, cached lists, counters, streak data, and related extension data remain in browser storage until you clear them, reset the extension, or uninstall it.
- Temporary local allow-list entries may expire automatically based on your settings.
- Local audit logs for blocked pages and extension disable/enable events are automatically limited and are currently retained for up to 30 days, subject to size limits used by the extension.
- Local top-domain summaries and daily history are retained in browser storage until cleared or overwritten by the extension.
- Manual report cooldown data, duplicate-report keys, and the generated local device ID remain in local extension storage until cleared or the extension is removed.
- Manual reports submitted to our backend may be stored in our backend database and retained for as long as reasonably necessary to review reports, reduce abuse, and improve filtering quality.
- Community stories submitted to our backend are retained until removed. A published story is visible to anyone who opens the Community page. If you want a story you submitted taken down, contact us through the channel below and we will remove it.
- Answers on the page that opens when you remove BlockNSFW are kept as running totals. Of the notes written there, only the newest 500 are kept.

## Security

We aim to minimize data use and keep as much processing local as possible. External requests used by the extension are sent over secure connections such as HTTPS. However, no system can guarantee absolute security.

## Your Choices and Control

You can:

- enable or disable DNS Protection, and choose which resolver it uses — including one of your own
- enable or disable the on-device image and text classifiers, which are off until you turn them on
- add or remove rule-list subscriptions
- change extension settings at any time
- add or remove whitelist entries and custom rules
- clear extension data by resetting settings or uninstalling the extension
- decide whether to submit a blocked or misblocked site report
- decide whether to read or write a community story, and ask us to remove one you submitted
- save a backup of your data, restore one, or delete the file
- record, replay or remove a voice message, and remove a photo
- switch your progress on every computer on or off

## Children's Privacy

BlockNSFW is intended to help users and families reduce exposure to adult content. We do not knowingly collect personal data from children through account systems, advertising systems, or general analytics systems.

## Changes to This Policy

We may update this Privacy Policy from time to time. When we do, we will update the "Last Updated" date above.

## Contact

If you have questions about this Privacy Policy or BlockNSFW's data practices, please contact us through the browser extension store listing or the project's published support channel.