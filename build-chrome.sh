#!/usr/bin/env bash
# build-chrome.sh
# The macOS/Linux counterpart of build-chrome.ps1: builds dist/chrome/ from this folder.
# Usage:
#   ./build-chrome.sh
#   ./build-chrome.sh --zip
#   ./build-chrome.sh --open-source
#   ./build-chrome.sh --zip --sandbox
# Same steps and checks as build-chrome.ps1, whose file lists it reads
# (scripts/build-extension.sh does the work).
exec "$(dirname "${BASH_SOURCE[0]}")/scripts/build-extension.sh" chrome "$@"
