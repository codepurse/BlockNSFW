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

The fixture is local and contains only ordinary benign text, so results do not
depend on the network or third-party page changes. Each variant gets a fresh
profile and the Firefox extension is staged from the same runtime files as
`build-firefox.ps1`.

Use `--extension-source PATH` to compare another checkout or an archived Git
revision against the working tree.

For diagnosis, `--extension-mode background-only` and `--extension-mode
content-only` isolate the extension halves. Normal comparisons use the default
`full` mode.

The default three-second warmup excludes one-time add-on verification and lets
fresh-install onboarding open before the harness creates its dedicated active
tab. Set `--warmup-ms 0` when intentionally measuring install startup.

## Measured result

Firefox 153.0.3 under Xvfb, five four-second samples per variant (2026-08-10):

| Tree | Median FPS off → on | Frame p95 off → on | Frames over 20 ms off → on |
| --- | ---: | ---: | ---: |
| Git baseline `a9f2f0e` | 59.5 → 57.6 | 18 → 22 ms | 0 → 12 |
| Optimized working tree | 59.5 → 59.5 | 18 → 18 ms | 0 → 0 |

The valid comparison explicitly activates the benchmark tab. Without that,
fresh-install onboarding takes focus and Firefox's background-tab rAF
throttling can be mistaken for an extension rendering regression.
