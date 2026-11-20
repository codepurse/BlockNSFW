#!/usr/bin/env bash
# build-safari.sh
# Builds a Safari Web Extension (macOS) from this folder into dist/safari/.
# Usage:
#   ./build-safari.sh                 # stage the extension and generate the Xcode project
#   ./build-safari.sh --build         # ...and compile it, signed to run locally
#   ./build-safari.sh --open-source   # leave the Supporter extras as empty stand-ins
#   ./build-safari.sh --bundle-id com.example.blocknsfw
#
# macOS only: Apple's safari-web-extension-converter ships with Xcode, and a
# Safari extension has to live inside a Mac app, which Xcode builds.
#
# Safari gets the Firefox build, not the Chrome one. Safari has no
# chrome.offscreen, and the Firefox build already runs everything Chrome puts
# in the offscreen document (the AI image classifier) on the background page.
# So the extension is staged by the Firefox build itself
# (scripts/build-extension.sh firefox): one list per build, and Safari can't
# drift from the build it's based on.
#
# Output:
#   dist/safari/extension/   the staged web extension (what the converter reads)
#   dist/safari/xcode/       the generated Xcode project
#   dist/safari/build/       with --build: BlockNSFW.app, signed to run locally
#
# This is a development build. It does not package for the App Store: that
# needs an Apple Developer team, its signing identity and a real bundle ID.

set -euo pipefail

BUILD=0
OPEN_SOURCE=0
BUNDLE_ID="local.blocknsfw.safari"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=1 ;;
    --open-source) OPEN_SOURCE=1 ;;
    --bundle-id)
      [[ $# -ge 2 ]] || { echo "--bundle-id needs a value" >&2; exit 2; }
      BUNDLE_ID="$2"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mbuild-safari: %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "Safari extensions build on macOS only."
xcrun --find safari-web-extension-converter >/dev/null 2>&1 \
  || fail "safari-web-extension-converter not found. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/dist/safari"
EXT="$OUT/extension"
cd "$ROOT"

step "Cleaning $OUT"
rm -rf "$OUT"

# Staged exactly as the Firefox build: the same lists, extras, data files,
# build timestamp and asset checks (scripts/build-extension.sh), only into
# dist/safari/extension/ instead of dist/firefox/.
STAGE_ARGS=(firefox --out "$EXT")
[[ $OPEN_SOURCE -eq 1 ]] && STAGE_ARGS+=(--open-source)
"$ROOT/scripts/build-extension.sh" "${STAGE_ARGS[@]}"
WITH_EXTRAS=0
[[ -d "$ROOT/extras-private/extras" && $OPEN_SOURCE -eq 0 ]] && WITH_EXTRAS=1

step "Generating the Xcode project"
xcrun safari-web-extension-converter "$EXT" \
  --project-location "$OUT/xcode" \
  --app-name BlockNSFW \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --swift \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force

PROJECT_DIR="$OUT/xcode/BlockNSFW"
APP="$OUT/build/Build/Products/Debug/BlockNSFW.app"

if [[ $BUILD -eq 1 ]]; then
  # "-" is an ad-hoc signature. Without any signature macOS never registers
  # the extension, and it doesn't appear in Safari's settings at all; with
  # one, Safari runs it once Develop > Allow Unsigned Extensions is on.
  step "Compiling, signed to run locally"
  xcodebuild \
    -project "$PROJECT_DIR/BlockNSFW.xcodeproj" \
    -scheme BlockNSFW \
    -configuration Debug \
    -derivedDataPath "$OUT/build" \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM="" \
    PROVISIONING_PROFILE_SPECIFIER="" \
    -quiet \
    build
  [[ -d "$APP" ]] || fail "xcodebuild finished but $APP is missing"
fi

printf '\033[32m==> Safari build complete: %s\033[0m\n' "$OUT"
if [[ $WITH_EXTRAS -eq 1 ]]; then
  printf '\033[32m==> Supporter extras: included\033[0m\n'
else
  warn "Supporter extras: not included (open-source build)"
fi
if [[ $BUILD -eq 1 ]]; then
  cat <<EOF
==> App: $APP
    To try it:
      1. Safari > Settings > Advanced: show features for web developers
      2. Develop > Allow Unsigned Extensions (Safari turns this off on every quit)
      3. open "$APP"   (launching the app is what registers the extension)
      4. Safari > Settings > Extensions: enable BlockNSFW, allow it on every website
EOF
else
  echo "==> Xcode project: $PROJECT_DIR/BlockNSFW.xcodeproj (run again with --build to compile)"
fi
