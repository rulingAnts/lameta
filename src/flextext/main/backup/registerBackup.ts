// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Main-process side of S3 backup: settings with the secret under safeStorage, and `configure`,
// which decrypts the secret and hands it to the helper (which puts it in rclone's environment).
// The renderer drives the jobs themselves through the helper API (backupStart/Status/Stop...).

import { app, dialog, ipcMain, safeStorage, BrowserWindow } from "electron";
import { addMainRegistrar } from "../registerMain";
import { getHelperClient } from "../helper/registerHelper";
import { BackupSettingsStore, BackupSettings, LastBackupRecord } from "./backupSettings";

export const BACKUP_IPC = {
  load: "FlexText.backup.load",
  save: "FlexText.backup.save",
  configure: "FlexText.backup.configure",
  chooseFolder: "FlexText.backup.chooseFolder",
  recordLastBackup: "FlexText.backup.recordLastBackup",
  lastBackup: "FlexText.backup.lastBackup"
} as const;

let store: BackupSettingsStore | null = null;

function getStore(): BackupSettingsStore {
  if (!store) {
    store = new BackupSettingsStore(app.getPath("userData"), {
      isAvailable: () => {
        try {
          return safeStorage.isEncryptionAvailable();
        } catch {
          return false;
        }
      },
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (buf) => safeStorage.decryptString(buf)
    });
  }
  return store;
}

addMainRegistrar(() => {
  ipcMain.handle(BACKUP_IPC.load, async () => getStore().load());

  ipcMain.handle(BACKUP_IPC.save, async (_e, settings: Partial<BackupSettings>, secret?: string) => {
    try {
      return { result: getStore().save(settings, secret) };
    } catch (e) {
      return { result: getStore().load(), error: (e as Error).message };
    }
  });

  ipcMain.handle(BACKUP_IPC.configure, async () => {
    const client = getHelperClient();
    if (!client) return { error: "The helper is not available, so backup cannot run." };
    const settings = getStore().helperSettings();
    if (!settings) return { error: "No secret access key is saved. Enter it and save the settings first." };
    try {
      const r = await client.call("backupConfigure", settings, { timeoutMs: 30_000 });
      return { result: r };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });

  ipcMain.handle(BACKUP_IPC.chooseFolder, async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win as BrowserWindow, {
      title,
      properties: ["openDirectory", "createDirectory", "promptToCreate"]
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  ipcMain.handle(BACKUP_IPC.recordLastBackup, async (_e, projectFolder: string, rec: LastBackupRecord) => {
    getStore().recordLastBackup(projectFolder, rec);
    return true;
  });

  ipcMain.handle(BACKUP_IPC.lastBackup, async (_e, projectFolder: string) => getStore().lastBackup(projectFolder));
});
