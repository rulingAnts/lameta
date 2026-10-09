#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
#
# Syncs this fork with a new lameta release (CLAUDE.md, "Syncing with upstream: merge, never
# rebase"):
#   1. fetches an upstream release tag (or V3's head) with --no-tags, one ref explicitly, because
#      two old upstream tags differ only by case (a problem on macOS);
#   2. creates upstream-sync/<version> from flextext-metadata and MERGES the upstream ref into it;
#   3. stops at the first conflict, listing the files and the seams to re-apply (SEAMS.md);
#   4. on a clean merge: yarn install, the footprint check, then the unit tests.
# It never pushes. Afterwards, open a PR WITHIN the fork:
#   gh pr create --repo rulingAnts/lameta --base flextext-metadata --head upstream-sync/<version>
#
#   scripts/flextext/sync-upstream.sh v3.0.23-beta      # a release tag
#   scripts/flextext/sync-upstream.sh V3                # the branch head, when a fix is needed
#   scripts/flextext/sync-upstream.sh v3.0.23-beta --no-tests
set -euo pipefail

UPSTREAM_URL="https://github.com/onset/lameta.git"
BASE_BRANCH="flextext-metadata"

ref="${1:-}"
run_tests=1
if [ -z "$ref" ]; then
  echo "usage: $0 <upstream tag | V3> [--no-tests]" >&2
  exit 2
fi
if [ "${2:-}" = "--no-tests" ]; then run_tests=0; fi

cd "$(dirname "$0")/../.."

if [ -n "$(git status --porcelain)" ]; then
  echo "sync-upstream.sh: the working tree is not clean; commit or stash first." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

echo "sync-upstream.sh: fetching $ref from upstream (no tags)"
if [ "$ref" = "V3" ] || [ "$ref" = "master" ]; then
  git fetch --no-tags upstream "$ref"
  merge_ref="upstream/$ref"
  version="$ref-$(git rev-parse --short "upstream/$ref")"
else
  # one tag, explicitly, into a local ref of the same name
  git fetch --no-tags upstream "refs/tags/$ref:refs/tags/$ref"
  merge_ref="refs/tags/$ref"
  version="$ref"
fi
# the footprint check compares against upstream/V3; keep it fresh too
git fetch --no-tags upstream V3

sync_branch="upstream-sync/$version"
echo "sync-upstream.sh: creating $sync_branch from $BASE_BRANCH"
git checkout -q "$BASE_BRANCH"
git checkout -q -B "$sync_branch"

echo "sync-upstream.sh: merging $merge_ref (no rebase, no fast-forward)"
if ! git merge --no-ff --no-edit "$merge_ref"; then
  echo
  echo "sync-upstream.sh: CONFLICTS. Stopped on branch $sync_branch." >&2
  echo "Conflicted files:" >&2
  git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  echo >&2
  echo "Resolve in favour of upstream's code, then re-apply the seams listed in src/flextext/SEAMS.md" >&2
  echo "for these files:" >&2
  for f in $(git diff --name-only --diff-filter=U); do
    if grep -q "\`$f\`" src/flextext/SEAMS.md 2>/dev/null; then
      echo "  $f  (has registered seams: see SEAMS.md)" >&2
    fi
  done
  echo "Then: git add -A && git commit, and run:" >&2
  echo "  yarn install --frozen-lockfile && yarn vitest run src/flextext/footprint.spec.ts && yarn vitest run" >&2
  exit 1
fi

echo "sync-upstream.sh: merge is clean; installing and checking"
yarn install --frozen-lockfile

echo "sync-upstream.sh: footprint check"
yarn vitest run src/flextext/footprint.spec.ts

if [ "$run_tests" = 1 ]; then
  echo "sync-upstream.sh: full unit tests"
  yarn tsc --noEmit
  yarn vitest run
fi

echo
echo "sync-upstream.sh: done. Branch $sync_branch is ready. Nothing was pushed."
echo "Next: git push -u origin $sync_branch && gh pr create --repo rulingAnts/lameta --base $BASE_BRANCH --head $sync_branch"
