// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The fork's identity, in one place. Everything that names the app reads these constants, so the
// product name never has to be edited in an upstream file (CLAUDE.md, "Rebrand by override").
// Keep in step with electron-builder.flextext.json5 (productName / appId); a test checks that.

/** Product name: the installer, the Start-menu entry and the window title all derive from it. */
export const APP_NAME = "FlexText Metadata";

/** The full form, used where lameta is credited (window title, About). */
export const APP_TITLE = "FlexText Metadata (for lameta)";

/** electron-builder appId; also the Windows AppUserModelId base. */
export const APP_ID = "app.flextext.metadata";

/** Folder name under the OS app-data directory (`%APPDATA%` on Windows). Distinct from stock
 * lameta's "lameta", so settings and stores never collide, dev runs included. */
export const USER_DATA_DIR_NAME = "FlexText Metadata";

/** The fork's own version, independent of lameta's `package.json` version (which upstream owns). */
export const FLEXTEXT_VERSION = "0.1.0";

/** Where this fork lives. */
export const FORK_URL = "https://github.com/rulingAnts/lameta";
export const UPSTREAM_URL = "https://github.com/onset/lameta";
