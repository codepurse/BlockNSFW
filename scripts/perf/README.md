# Firefox rendering benchmark

This harness launches dedicated Firefox profiles under Xvfb and drives them
through Firefox's WebDriver BiDi endpoint. It runs a deterministic dynamic-feed
fixture first without BlockNSFW and then with a temporary unpacked install.

```bash
npm run perf:firefox
```

The useful comparison fields are median FPS, 95th-percentile frame time,
frames over 20 ms, and 95th-percentile mutation time. Five runs per variant are
the default; use a shorter smoke run while changing the harness:

```bash
npm run perf:firefox -- --runs 1 --duration-ms 1000
```

Write every raw sample to JSON when investigating a regression:

```bash
npm run perf:firefox -- --output artifacts/firefox-render.json
```

The fixture is local and contains ordinary benign text, inline thumbnails, and
inert links under the reserved `.invalid` TLD. This exercises media discovery
and batched host checks without depending on the network or third-party page
changes. Each variant gets a fresh profile and the Firefox extension is staged
from the same runtime files as `build-firefox.ps1`.

Use `--extension-source PATH` to compare another checkout or an archived Git
revision against the working tree.

For diagnosis, `--extension-mode background-only` and `--extension-mode
content-only` isolate the extension halves. Normal comparisons use the default
`full` mode.

The default three-second warmup excludes one-time add-on verification and lets
fresh-install onboarding open before the harness creates its dedicated active
tab. Set `--warmup-ms 0` when intentionally measuring install startup.

## Measured result

Firefox 153.0.3 under Xvfb, five four-second samples per variant using the
link-and-media feed fixture (2026-08-11):

| Tree | Median FPS off → on | Frame p95 off → on | Frames over 20 ms off → on |
| --- | ---: | ---: | ---: |
| Git baseline `a9f2f0e` | 59.5 → 55.2 | 18 → 29 ms | 0 → 15 |
| Optimized working tree | 59.5 → 59.5 | 18 → 19 ms | 0 → 1 |

The valid comparison explicitly activates the benchmark tab. Without that,
fresh-install onboarding takes focus and Firefox's background-tab rAF
throttling can be mistaken for an extension rendering regression.

## The fixture must actually get blocked

Those numbers were measured against a fixture that **blocked nothing**. Its
images were `data:` URIs and its links used the reserved `.invalid` TLD, so
`isUrlBlockedByBackground` rejected them on scheme and no host matched. Nothing
ever reached `hideElement`, `notifyBackground`, or the background's per-block
storage path — which is where most of the extension's cost lives.

It was served from `127.0.0.1` as well, and `hostIsLocal()` matches `127.*`, so
`isLocalPage()` switched off `checkPageMetadata`, `checkPageBodyText` and the AI
text scan for every run. The benchmark was measuring an extension with three of
its scans disabled and its whole block path untouched.

`--blockable-every N` now makes every Nth card carry a third-party thumbnail
whose path trips `HIGH_CONFIDENCE_PATH_KEYWORDS`, and the page is served from a
non-local hostname mapped to loopback with `network.dns.localDomains`. Every
sample reports `blockedElements`; a run that reports 0 in the `on` variant has
told you nothing about the block path, and the harness says so.

The difference is not subtle. Three runs each, identical settings, only the
fixture content changed (Firefox headless, Windows, 2026-09-06):

| Fixture | Median FPS | Frame p95 | Blocked |
| --- | ---: | ---: | ---: |
| `--blockable-every 0` (old behaviour) | 101.9 | 12–18 ms | 0 |
| `--blockable-every 8` | 35.2 | 89–133 ms | 150 |

Two caveats on those specific figures: they were taken on a machine whose
enterprise policy force-installs the released extension into every profile, so
both arms carry that copy and this is "extension idle vs extension blocking",
not off-vs-on. And headless on Windows is not the Xvfb/Linux environment the
table above used. Re-measure on a clean Linux host for an authoritative
baseline. The *shape* of the result reproduces regardless: cost appears when
blocking happens.

## Only compare within one session

Absolute numbers drift heavily between sessions on a working machine. The same
commit, measured twice on the same laptop a few minutes apart, produced:

    42.0-47.5 fps      and      27.2-31.3 fps

That is a ~35% swing with no code change, so a figure recorded in one session
cannot be compared against one recorded in another. Comparing across sessions
will invent improvements and regressions that are not there.

Capture both arms back to back in one sitting, using `--extension-source` to
point one of them at the other revision:

```bash
git worktree add /tmp/baseline <commit>
npm run perf:firefox -- --blockable-every 8 --extension-source /tmp/baseline --output artifacts/before.json
npm run perf:firefox -- --blockable-every 8 --output artifacts/after.json
```

Then read the per-run spreads, not just the medians: if the two ranges overlap,
the result is directional at best. A clean result has non-overlapping ranges.

## Enterprise policies invalidate the comparison

A `force_installed` ExtensionSettings policy applies to every profile on the
machine, including the throwaway ones this harness creates — so the `off`
variant silently runs the policy's copy and the delta becomes meaningless.
BlockNSFW's own guard installs exactly such a policy, so this is the normal case
on a maintainer's machine, not an exotic one. The harness detects it and refuses
to run; `--allow-forced-policy` overrides that when you know what the numbers
mean.

## Running on Windows or macOS

`Xvfb` is Linux-only, so on other platforms the harness uses Firefox's own
`-headless`. Point it at the binary with `FIREFOX_BIN`:

```bash
FIREFOX_BIN="/c/Program Files/Mozilla Firefox/firefox.exe" npm run perf:firefox
```

Keep authoritative baselines on Linux under Xvfb so they stay comparable with
the recorded table above.
