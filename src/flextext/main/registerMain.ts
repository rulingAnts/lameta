// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Registers the fork's main-process services. Called once from ../boot.ts at import time; the
// pieces that need Electron to be ready wait for `app.whenReady()` themselves.
//
// Add-ons register here rather than through more seams in main.ts: one boot seam, many services.

import { app, ipcMain } from "electron";

type Registrar = (ctx: { app: typeof app; ipcMain: typeof ipcMain }) => void;

const registrars: Registrar[] = [];

/** Lets a main-process add-on register IPC handlers and lifecycle hooks. */
export function addMainRegistrar(r: Registrar): void {
  registrars.push(r);
}

let registered = false;

export function registerFlextextMain(): void {
  if (registered) return;
  registered = true;
  for (const r of registrars) {
    try {
      r({ app, ipcMain });
    } catch (e) {
      console.error("[flextext] registrar failed", e);
    }
  }
}
