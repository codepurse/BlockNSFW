# Store listing text

Paste into each store's listing. It is plain text, so it reads the same in the
Chrome Web Store, Firefox Add-ons and Edge Add-ons. Figures were checked on
2026-10-11; re-check the competitor range and the prices before each release.

## Summary

- Chrome Web Store: taken from the manifest's `description` (132 characters
  at most), already set.
- Firefox Add-ons: the **Summary** field (250 at most).
- Edge Add-ons: the **Short description** field.

```
Blocks porn and adult sites before they load, and helps in the hard moment. Every protection is free.
```

## Description

```
Most paid blockers charge $9 to $18 a month to block. BlockNSFW blocks for free.

Every protection below costs nothing, needs no account, and will never move behind a payment. Supporter is optional: it adds extras for going further, from $4.99 a month or $29.99 a year.

WHAT IT BLOCKS
Six layers stand between you and an adult page:
• Your own list of sites and words
• A built-in list of 237,000+ adult sites, refused before anything loads
• DNS filtering through a family resolver you choose (Cloudflare for Families, AdGuard Family, Mullvad Family or CleanBrowsing), or your own
• SafeSearch held on for Google, Bing, DuckDuckGo, Yahoo, Brave, Ecosia, Qwant, AOL, Presearch and Yandex
• The words on the page
• An image check that runs on your device, if you turn it on. Images are never uploaded.

Also: Reddit NSFW communities, Facebook and Instagram Reels if you choose, and blocklists other people maintain in uBlacklist's format.

FOR THE HARD MOMENT
• Gateways: a pause of 5 to 60 seconds before the sites where it tends to start
• The Pact: anything that loosens protection waits out a cool-down you choose, from 15 minutes to 3 days. A friend can hold a code that lets a change through sooner.
• Storm Mode and risk hours: every layer at its strongest for 1, 4 or 12 hours, or the same hours every night
• Your own words: your plan, a note to yourself and someone to call, shown first on the blocked page
• A PIN over the settings that would weaken protection
• After a slip: a slip costs one day, never the count

HARD TO REMOVE
Anyone can remove or turn off an extension in two clicks. Extension Guard, a free and open-source companion app for Windows, locks BlockNSFW into Chrome, Edge, Brave and Firefox: Remove and Turn off are greyed out, it puts the lock back if anything undoes it, and uninstalling it needs a password a parent or accountability partner holds. Settings › Security shows whether this browser is locked, and links the download: github.com/codepurse/extension-guard

SEE HOW IT'S GOING
Days kept, your week every Sunday, statistics and an audit log, all kept on your computer. Back up everything to one file, and restore it on a new computer.

PRIVACY
No account and no ads. Blocking is decided in your browser, and what you browse isn't sent to us: a site reaches us only when you report it yourself. If you turn on DNS filtering, lookups go to the resolver you chose.

SUPPORTER (OPTIONAL)
Blocking is the same for everyone: paying never makes it stronger or weaker. Supporter adds:
• The rest of a 30-day path (the first 7 days are free)
• An evening check-in, and your good days: what your calm days have in common
• When it's hardest: your hard moments by weekday and hour
• A letter at the start of each month, and your year on one calendar
• A photo and a message in your own voice for the hard moment
• Your progress on every computer, through the browser's own sync
• Supporter looks, and four more blocked-page designs
$4.99 a month, $29.99 a year or $89.99 once, on up to three of your browsers. Payment through Polar. Cancel any time.

HELP
Problems and ideas: support@monolab.dev
```

## Notes

- **Firefox Add-ons** asks for paid features to be stated in the listing: the
  opening lines and the Supporter section do that.
- **Privacy policy**: each store has its own field for the link; the
  description doesn't need it.
- **The first line is a comparison.** It holds while most paid blockers stay
  in that range (Freedom $8.99, Canopy $9.99, Accountable2You $11, Ever
  Accountable $14.99, Truple $16, Covenant Eyes $18 a month, as listed on
  2026-10-11). If the range moves, change the figures; never "cheapest".
- If a price changes in Polar, change it here, in `shared/supporter.js`, on
  `release.html` and in screenshot 5 (`src/frames.html`).
