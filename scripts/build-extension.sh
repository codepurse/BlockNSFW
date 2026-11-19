#!/usr/bin/env bash
# scripts/build-extension.sh
# The macOS/Linux build. Stages a Chrome or Firefox bundle step for step as
# build-chrome.ps1 / build-firefox.ps1 do, and with --zip packs it and reads
# it back. build-chrome.sh, build-firefox.sh and build-safari.sh call it.
# Usage:
#   scripts/build-extension.sh <chrome|firefox> [--zip] [--open-source] [--sandbox] [--out DIR]
#
# The file lists are read from build-<target>.ps1, parsed the way the tests
# parse them (tests/page-scripts-ship.test.js), so each build keeps one list
# and the two platforms can't drift apart.
#
# --zip makes a store package: it needs the Supporter extras (extras-private/),
# Polar's live store, and everything that ships committed, as on Windows.
# --open-source packages without the extras; --sandbox makes a test package.
# --out stages somewhere other than dist/<target>/ (build-safari.sh uses it).

set -euo pipefail

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mbuild-extension: %s\033[0m\n' "$*" >&2; exit 1; }

TARGET="${1:-}"
case "$TARGET" in
  chrome|firefox) shift ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  *) echo "First argument must be chrome or firefox (see --help)" >&2; exit 2 ;;
esac

ZIP=0
OPEN_SOURCE=0
SANDBOX=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip) ZIP=1 ;;
    --open-source) OPEN_SOURCE=1 ;;
    --sandbox) SANDBOX=1 ;;
    --out)
      [[ $# -ge 2 ]] || { echo "--out needs a directory" >&2; exit 2; }
      OUT="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null || fail "node is required."

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "$TARGET" in
  chrome)  LABEL="Chrome";  MANIFEST="manifest.json" ;;
  firefox) LABEL="Firefox"; MANIFEST="manifest.firefox.json" ;;
esac
PS1="$ROOT/build-$TARGET.ps1"
OUT="${OUT:-$ROOT/dist/$TARGET}"
ZIP_PATH="$ROOT/dist/blocknsfw-$TARGET.zip"

# Checked before anything is cleaned, so a refused package leaves dist/ as it was.
if [[ $ZIP -eq 1 && $OPEN_SOURCE -eq 0 && $SANDBOX -eq 0 ]]; then
  step "Checking that Supporter sells through the live store"
  node scripts/check-store-mode.js \
    || fail "Not packaging for a store while Supporter is in Polar's sandbox (RELEASE_CHECKLIST.md, section 0). Pass --sandbox for a test package."
  step "Checking that everything that ships is committed"
  node scripts/check-package.js tree \
    || fail "Not packaging for a store from code that isn't committed: the build note couldn't say what the release carries."
fi
if [[ $ZIP -eq 1 ]]; then
  command -v zip >/dev/null || fail "zip is required for --zip (macOS ships it; on Linux install the zip package)."
fi

read_list() {
  node -e '
    const src = require("fs").readFileSync(process.argv[1], "utf8");
    const block = src.match(new RegExp("\\$" + process.argv[2] + "\\s*=\\s*@\\(([\\s\\S]*?)\\)"));
    if (!block) { console.error("no $" + process.argv[2] + " list in " + process.argv[1]); process.exit(1); }
    for (const m of block[1].matchAll(/"([^"]+)"/g)) console.log(m[1]);
  ' "$PS1" "$1"
}
FOLDERS=(); while IFS= read -r line; do FOLDERS+=("$line"); done < <(read_list RuntimeFolders)
FILES=();   while IFS= read -r line; do FILES+=("$line");   done < <(read_list RuntimeFiles)
[[ ${#FOLDERS[@]} -gt 0 && ${#FILES[@]} -gt 0 ]] || fail "Could not read the file lists from $(basename "$PS1")"

step "Building static declarativeNetRequest ruleset"
# Generated from data/HOSTS.txt. Committed, but rebuilt here so a stale
# ruleset can never ship.
node scripts/build-dnr-ruleset.mjs || fail "Failed to build the static DNR ruleset"

step "Cleaning $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

step "Copying manifest ($MANIFEST)"
cp "$MANIFEST" "$OUT/manifest.json"

step "Copying runtime folders"
for folder in "${FOLDERS[@]}"; do
  [[ -e "$folder" ]] && cp -R "$folder" "$OUT/"
done

if [[ "$TARGET" == "firefox" ]]; then
  step "Packing the static ruleset into one rule for Firefox"
  # Same domains, one rule (see FIREFOX GETS ONE RULE in the generator).
  node scripts/build-dnr-ruleset.mjs --firefox "$OUT/rules/blocklist-rules.json" \
    || fail "Failed to pack the static DNR ruleset for Firefox"
fi

step "Copying runtime files"
for file in "${FILES[@]}"; do
  [[ -e "$file" ]] && cp "$file" "$OUT/$file"
done

# Supporter extras: each empty stand-in in extras/ is replaced by its file
# from the private repository. Only those names, so nothing else in that
# repository (its tests, its tools) can reach a package.
EXTRAS_SRC="$ROOT/extras-private/extras"
rm -f "$OUT"/extras/*.md
WITH_EXTRAS=0
if [[ -d "$EXTRAS_SRC" && $OPEN_SOURCE -eq 0 ]]; then
  step "Copying the Supporter extras from extras-private"
  for stub in "$OUT"/extras/*; do
    [[ -f "$stub" ]] || continue
    name="$(basename "$stub")"
    real="$EXTRAS_SRC/$name"
    [[ -f "$real" ]] || fail "extras-private/extras is missing $name"
    [[ -s "$real" ]] || fail "extras-private/extras/$name is empty"
    cmp -s "$real" "$stub" && fail "extras-private/extras/$name is only the stand-in"
    cp "$real" "$stub"
  done
  WITH_EXTRAS=1
elif [[ $ZIP -eq 1 && $OPEN_SOURCE -eq 0 ]]; then
  fail "A store package needs the Supporter extras. Check out the private repository at extras-private/, or pass --open-source to package without them."
else
  warn "Open-source build: the Supporter extras stay empty stand-ins"
fi

step "Copying data files"
# Only the public suffix list ships; data/HOSTS.txt and data/WHITELIST.txt are
# fetched at runtime, not package content.
mkdir -p "$OUT/data"
cp data/public-suffixes.txt "$OUT/data/public-suffixes.txt"

node -e '
  const fs = require("fs");
  const [file, label] = process.argv.slice(1);
  const token = "__BLOCKNSFW_BUILD_TIMESTAMP_MS__";
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(token)) { console.error("Missing bundled blocklist build timestamp token in " + label + " background.js"); process.exit(1); }
  fs.writeFileSync(file, src.split(token).join(String(Date.now())));
' "$OUT/background.js" "$LABEL"

step "Verifying AI runtime assets"
for asset in \
  data/public-suffixes.txt \
  rules/blocklist-rules.json \
  vendor/tfjs/tf.es2017.js \
  vendor/nsfwjs/nsfwjs.runtime.js \
  nsfwjs/model.json \
  nsfwjs/group1-shard1of1.bin \
  text-model.json; do
  [[ -e "$OUT/$asset" ]] || fail "Missing required asset in $LABEL build: $asset"
done

if [[ $ZIP -eq 1 ]]; then
  step "Creating $ZIP_PATH"
  rm -f "$ZIP_PATH"
  # Files only (-D), forward-slash paths, no macOS extra attributes (-X), and
  # no dotfiles: the .ps1 builds skip hidden files too, and .DS_Store must
  # never reach a store.
  (cd "$OUT" && zip -q -r -X -D -9 "$ZIP_PATH" . -x '.*' '*/.*')

  # Read the package back: the extras right for its kind, nothing that
  # mustn't ship, and a build note of the commits it came from.
  if [[ $OPEN_SOURCE -eq 1 ]]; then KIND="open-source"; elif [[ $SANDBOX -eq 1 ]]; then KIND="test"; else KIND="store"; fi
  step "Checking the package ($KIND)"
  if ! node scripts/check-package.js zip "$ZIP_PATH" "$TARGET" "$KIND"; then
    rm -f "$ZIP_PATH"
    fail "The package failed its check and was removed. See the list above."
  fi
fi

ok "$LABEL build complete: $OUT"
if [[ $WITH_EXTRAS -eq 1 ]]; then ok "Supporter extras: included"; else warn "Supporter extras: not included (open-source build)"; fi
if [[ $ZIP -eq 1 && $SANDBOX -eq 1 ]]; then warn "TEST PACKAGE: Supporter uses Polar's sandbox. Never upload it to a store."; fi
if [[ $ZIP -eq 1 ]]; then
  ok "Zip: $ZIP_PATH"
  ok "Build note: ${ZIP_PATH%.zip}.build.txt (keep it with the release)"
fi
