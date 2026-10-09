// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// "Quiet": nothing leaves the researcher's machine unasked. This app holds the language, voices
// and consent records of communities, and the privacy obligations that come with that are the
// reason (PLAN.md §6). Upstream's Sentry, Segment and GitHub release check are each switched off
// through one registered seam that calls here (src/flextext/SEAMS.md). These are functions rather
// than constants so the seams stay one line and the tests can mock them to prove the seams bite.

/** Sentry error reporting and Segment analytics never initialise in the fork. */
export function telemetryIsOff(): boolean {
  return true;
}

/** The fork never queries api.github.com/repos/onset/lameta/releases: it must never tell its
 * users to "update" to stock lameta. */
export function updateCheckIsOff(): boolean {
  return true;
}
