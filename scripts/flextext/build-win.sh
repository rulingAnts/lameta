#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
#
# Packages FlexText Metadata (for lameta) for Windows x64, artifacts only, no publishing.
# Run after `yarn fullbuild`, with the helper built (helper/dist/flextext-helper) and rclone
# downloaded (helper/third_party/rclone). Those two are what electron-builder.flextext.json5 lists
# as extraResources; electron-builder fails on a missing source, so this script checks first.
#
#   scripts/flextext/build-win.sh            # full build
#   scripts/flextext/build-win.sh --dir      # unpacked directory only (faster, for tests)
#
# Fork commands live here, not in package.json (which stays byte-identical to upstream).
set -euo pipefail

cd "$(dirname "$0")/../.."

missing=0
for p in helper/dist/flextext-helper helper/third_party/rclone helper/THIRD-PARTY-NOTICES; do
  if [ ! -e "$p" ]; then
    echo "build-win.sh: missing extra resource: $p" >&2
    missing=1
  fi
done
if [ "$missing" = 1 ]; then
  echo "build-win.sh: build the helper (helper/README.md) and download rclone (scripts/flextext/fetch-rclone.sh) first." >&2
  exit 1
fi

if [ ! -d dist ]; then
  echo "build-win.sh: dist/ is missing; run 'yarn fullbuild' first." >&2
  exit 1
fi

extra=()
if [ "${1:-}" = "--dir" ]; then
  extra+=(--dir)
fi

exec yarn electron-builder --config electron-builder.flextext.json5 --win --x64 --publish never "${extra[@]}"
