# Store images

Every image the three stores ask for, set in monolab Threshold (the same
tokens as the extension, `ui/tokens.css`). The screenshots are plates of the
real extension pages, captured from a build with a demo profile.

## What goes where

| Store field | File | Size |
| --- | --- | --- |
| **Chrome Web Store** · Store icon | `chrome/icon-128.png` | 128 × 128, 96 artwork + 16 clear |
| Chrome · Screenshots (up to 5) | `chrome/screenshot-1.png` … `-5.png` | 1280 × 800, 24-bit PNG |
| Chrome · Small promo tile | `chrome/promo-small-440x280.png` | 440 × 280 |
| Chrome · Marquee promo tile | `chrome/promo-marquee-1400x560.png` | 1400 × 560 |
| **Firefox Add-ons** · Icon | `firefox/icon-128.png` (or `icon-64.png`) | 128 × 128 / 64 × 64 |
| Firefox · Screenshots | `firefox/screenshot-1.png` … `-5.png` | 1280 × 800 |
| **Edge Add-ons** · Logo | `edge/logo-300x300.png` | 300 × 300 |
| Edge · Small promotional tile | `edge/promo-small-440x280.png` | 440 × 280 |
| Edge · Large promotional tile | `edge/promo-large-1400x560.png` | 1400 × 560 |
| Edge · Screenshots | `edge/screenshot-1.png` … `-5.png` | 1280 × 800 |

The extension's own icons are in `icons/` (16, 32, 48, 64, 128), listed in
both manifests.

Screenshots in order: 01 the blocked page, 02 the toolbar popup, 03 gateways,
04 the Pact, 05 Supporter (the one pine band; it says plainly that every
protection is free and Supporter is paid, which Firefox Add-ons asks for).

## The icon

A shield with the eye struck through: protection from what you'd rather not
see. Pine shield, sheet eye, brass stroke; on the pine band (the small tile,
screenshot 5) it turns round to a sheet shield with a pine eye. From 32 px up
it is one vector drawing (`shieldEye` in `src/frames.html`); the 16 px
toolbar icon is drawn cell by cell (`pixelIcon`), with a filled eye and the
stroke just beside the pupil, because a vector shield goes soft that small.
Picked on 2026-10-11 from eight mockups; the earlier door directions are in
`src/icon-options.html`.

## Making them again

```bash
node store-assets/tools/capture.js "C:/Program Files/Google/Chrome/Application/chrome.exe" dist/chrome <code-file>
node store-assets/tools/render.js "C:/Program Files/Google/Chrome/Application/chrome.exe"
python store-assets/tools/flatten.py
```

- `capture.js` loads a build into a throwaway profile, fills it with a demo
  month (blocks, own words, a voice note, a pact with a change waiting, a
  Supporter plan) and saves 2x captures to `captures/`. `<code-file>` holds a
  test Supporter code (`name<TAB>code`); it is written straight into the
  throwaway profile, so no browser place on a plan is used.
- `render.js` photographs each frame of `src/frames.html` at its exact size
  into `chrome/`, `firefox/`, `edge/` and `icons/`, plus `contact-sheet.png`.
- `flatten.py` turns screenshots and tiles into 24-bit PNG: the Chrome Web
  Store refuses an alpha channel.

Change copy or layout in `src/frames.html` (open it in a browser to see every
frame at once), then run `render.js` and `flatten.py`. Run `capture.js` again
only when the pages themselves change.
