#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
#
# Downloads the pinned rclone build for windows-amd64 from GitHub releases, verifies its SHA256
# against the value pinned here (taken from the release's SHA256SUMS), and unpacks rclone.exe
# plus its licence into helper/third_party/rclone/, which electron-builder.flextext.json5 ships
# as resources/rclone/. Run from anywhere; needs curl and unzip (or python3).
#
#   scripts/flextext/fetch-rclone.sh            # windows-amd64 (the app's platform)
#   scripts/flextext/fetch-rclone.sh linux-amd64  # for running the helper's tests on Linux
set -euo pipefail

RCLONE_VERSION="v1.68.2"
# From https://github.com/rclone/rclone/releases/download/v1.68.2/SHA256SUMS
declare -A RCLONE_SHA256=(
  ["windows-amd64"]="812bf76cc02c04cf6327f3683f3d5a88e47d36c39db84c1a745777496be7d993"
  ["linux-amd64"]="0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c"
)

platform="${1:-windows-amd64}"
expected="${RCLONE_SHA256[$platform]:-}"
if [ -z "$expected" ]; then
  echo "fetch-rclone.sh: no pinned checksum for $platform" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
out="helper/third_party/rclone"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

zip="rclone-${RCLONE_VERSION}-${platform}.zip"
url="https://github.com/rclone/rclone/releases/download/${RCLONE_VERSION}/${zip}"
echo "fetch-rclone.sh: downloading $url"
curl -sSL --fail -o "$tmp/$zip" "$url"

actual="$(sha256sum "$tmp/$zip" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "fetch-rclone.sh: SHA256 mismatch for $zip" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi
echo "fetch-rclone.sh: SHA256 verified"

mkdir -p "$out"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$tmp/$zip" -d "$tmp/x"
elif command -v python3 >/dev/null 2>&1; then
  python3 -I -m zipfile -e "$tmp/$zip" "$tmp/x"
else
  python -I -m zipfile -e "$tmp/$zip" "$tmp/x"
fi
dir="$tmp/x/rclone-${RCLONE_VERSION}-${platform}"
if [ "$platform" = "windows-amd64" ]; then
  cp "$dir/rclone.exe" "$out/rclone.exe"
else
  cp "$dir/rclone" "$out/rclone"
  chmod +x "$out/rclone"
fi
cp helper/THIRD-PARTY-NOTICES/rclone-LICENSE.txt "$out/LICENSE.txt"
printf 'rclone %s %s\nsha256 %s\n' "$RCLONE_VERSION" "$platform" "$expected" > "$out/VERSION.txt"
echo "fetch-rclone.sh: rclone $RCLONE_VERSION ($platform) in $out"
