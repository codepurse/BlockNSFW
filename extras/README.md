# extras/

The files in this folder are empty stand-ins for BlockNSFW's **Supporter
extras**:

| File | The extra |
| --- | --- |
| `path-days.js` | Days 8 to 30 of the path (days 1 to 7 are free, in `shared/path-days.js`) |
| `checkin.js` | The evening check-in |
| `gooddays.js` | Your good days |
| `month.js` | Your month and Your year |
| `hardest.js` | When it's hardest |
| `photo.js` | Choosing a photo for the hard moment, in Settings |
| `looks.js` | Supporter looks (true black, an accent), in Settings |
| `extras.js` | Which extras a build carries (here: none) |

The extras themselves are not open source. They live in a separate, private
repository and are copied over these files when a store build is made
(`build-chrome.ps1`, `build-firefox.ps1`). The versions of BlockNSFW on the
Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons carry them.

**Every protection is open source and here**: the blocklists, the AI image and
text filters, SafeSearch and DNS, Gateways, the Pact, Storm Mode, your own
words, all five blocked-page designs and everything else that decides what
is blocked. A build made from this repository protects exactly as the store
version does. Without the extras, the pages that use them say so plainly.

The extras never decide what is blocked, and like the rest of BlockNSFW they
make no network requests: what they keep stays on the device.
