// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Wires the helper into the main process: starts it once the app is ready, exposes it to the
// renderer with ipcMain.handle (the pattern of src/mainProcess/MainProcessApi.ts; lameta runs
// with contextIsolation:false, so the renderer side is ipcRenderer.invoke wrappers in
// src/flextext/helper/HelperApiAccess.ts), forwards notifications, and shuts it down on quit.

import { app, ipcMain, BrowserWindow } from "electron";
import * as path from "path";
import { addMainRegistrar } from "../registerMain";
import { HelperClient, HelperRpcError, HelperUnavailableError } from "./HelperClient";
import { locateHelper } from "./locateHelper";
import { removePidFile, sweepStaleHelper, writePidFile } from "./pidFile";

export const HELPER_IPC = {
  call: "FlexText.helper.call",
  cancel: "FlexText.helper.cancel",
  status: "FlexText.helper.status",
  notification: "FlexText.helper.notification"
} as const;

let client: HelperClient | null = null;

export function getHelperClient(): HelperClient | null {
  return client;
}

/** Serialises an error so ipcRenderer.invoke rejects with something useful. */
function toIpcError(e: unknown): { code: number; message: string; data?: unknown; kind: string } {
  if (e instanceof HelperRpcError) {
    return { kind: "rpc", code: e.code, message: e.message, data: e.data };
  }
  if (e instanceof HelperUnavailableError) {
    return { kind: "unavailable", code: 0, message: e.message };
  }
  return { kind: "error", code: 0, message: (e as Error)?.message ?? String(e) };
}

addMainRegistrar(() => {
  ipcMain.handle(HELPER_IPC.call, async (_e, method: string, params?: unknown, timeoutMs?: number) => {
    if (!client) return { error: toIpcError(new HelperUnavailableError("helper not available")) };
    try {
      return { result: await client.call(method, params, { timeoutMs }) };
    } catch (e) {
      return { error: toIpcError(e) };
    }
  });
  ipcMain.handle(HELPER_IPC.cancel, async (_e, id: number) => (client ? client.cancel(id) : false));
  ipcMain.handle(HELPER_IPC.status, async () => (client ? client.status() : null));

  app.whenReady().then(() => {
    const userData = app.getPath("userData");
    const sweep = sweepStaleHelper(userData);
    if (sweep.found) console.log(`[flextext] stale helper sweep: ${sweep.reason}`);

    const command = locateHelper({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: path.resolve(app.getAppPath()),
      env: process.env,
      platform: process.platform
    });
    if (!command) {
      console.error("[flextext] helper not found; FLEx and backup features are unavailable");
      return;
    }
    client = new HelperClient({
      command,
      extraArgs: ["--parent-pid", String(process.pid)],
      log: (line) => console.error(`[flextext-helper] ${line}`)
    });
    client.on("spawn", (pid: number) => writePidFile(userData, pid));
    client.on("notification", (method: string, params: unknown) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(HELPER_IPC.notification, method, params);
      }
    });
    client.start().catch((e) => console.error(`[flextext] helper failed to start: ${e.message}`));
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (!client || quitting) return;
    quitting = true;
    event.preventDefault();
    const userData = app.getPath("userData");
    client
      .stop()
      .catch(() => {})
      .then(() => {
        removePidFile(userData);
        client = null;
        app.quit();
      });
  });
});
