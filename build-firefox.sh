#!/usr/bin/env bash
# build-firefox.sh
# The macOS/Linux counterpart of build-firefox.ps1: builds dist/firefox/ from this folder.
# Usage:
#   ./build-firefox.sh
#   ./build-firefox.sh --zip
#   ./build-firefox.sh --open-source
#   ./build-firefox.sh --zip --sandbox
# Same steps and checks as build-firefox.ps1, whose file lists it reads
# (scripts/build-extension.sh does the work).
exec "$(dirname "${BASH_SOURCE[0]}")/scripts/build-extension.sh" firefox "$@"
