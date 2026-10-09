// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The pure part of the boot seam, kept free of Electron imports so it can be unit-tested:
// given something app-like, set the name and an explicit userData path. See ../boot.ts.

import { join } from "path";
import { APP_NAME, APP_TITLE, USER_DATA_DIR_NAME } from "../branding/brand";

/** The subset of Electron's `app` the boot step needs. */
export interface AppLike {
  setName(name: string): void;
  getName(): string;
  getPath(name: string): string;
  setPath(name: string, path: string): void;
}

export interface BootResult {
  name: string;
  userData: string;
}

/**
 * Sets the app name and an explicit `userData` (and `sessionData`) path.
 *
 * Electron derives `userData` from the package.json name ("lameta") at startup, and
 * `app.setName()` alone does not move it, so the path is set explicitly here. This runs at
 * import time, before `Store.initRenderer()` and everything else in main.ts, and before the
 * E2E / `--user-data-dir=` overrides in main.ts, which still win when present.
 */
export function configureApp(app: AppLike): BootResult {
  app.setName(APP_NAME);
  const userData = join(app.getPath("appData"), USER_DATA_DIR_NAME);
  app.setPath("userData", userData);
  // Chromium's cache lives under sessionData, which defaults to the ORIGINAL userData, so it is
  // set too, or the fork would share stock lameta's cache directory.
  try {
    app.setPath("sessionData", userData);
  } catch {
    // older Electron: no sessionData path; the cache then follows userData
  }
  return { name: APP_NAME, userData };
}

/** The window title the fork shows regardless of what index.html's <title> says. */
export function windowTitle(): string {
  return APP_TITLE;
}

/** The subset of BrowserWindow used to pin the title. */
export interface WindowLike {
  setTitle(title: string): void;
  on(event: "page-title-updated", listener: (event: { preventDefault(): void }) => void): unknown;
}

/** "<project> 3.0.22-beta" (what lameta's HomePage sets) becomes "<project> 3.0.22-beta – FlexText Metadata (for lameta)". */
export function brandedTitle(requested: string): string {
  const brand = windowTitle();
  const t = (requested ?? "").trim();
  if (!t || t === "lameta" || t === "Main window") return brand;
  if (t.includes(brand)) return t;
  return `${t} – ${brand}`;
}

/**
 * Pins the fork's title on a window: sets it now, cancels the renderer's own title updates
 * (index.html says "lameta"; upstream's index.html stays untouched), and wraps `setTitle` so a
 * title set from the renderer (HomePage sets "<project> <version>") keeps the brand.
 */
export function brandWindow(win: WindowLike): void {
  const original = win.setTitle.bind(win);
  win.setTitle = (title: string) => original(brandedTitle(title));
  win.setTitle(windowTitle());
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(windowTitle());
  });
}
