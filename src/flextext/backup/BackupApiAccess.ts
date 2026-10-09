// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Renderer-side wrappers for the main process's backup IPC (src/flextext/main/backup/registerBackup.ts).

import type { BackupSettings, LastBackupRecord, PublicBackupSettings } from "../main/backup/backupSettings";

export type { BackupSettings, LastBackupRecord, PublicBackupSettings };

export interface BackupApi {
  load(): Promise<PublicBackupSettings>;
  /** secret undefined = keep, "" = clear, else store encrypted. Returns the public settings and
   * an error message when the secret could not be stored. */
  save(settings: Partial<BackupSettings>, secret?: string): Promise<{ result: PublicBackupSettings; error?: string }>;
  /** Decrypts the secret in the main process and starts rclone through the helper. */
  configure(): Promise<{ result?: unknown; error?: string }>;
  chooseFolder(title: string): Promise<string | null>;
  recordLastBackup(projectFolder: string, rec: LastBackupRecord): Promise<boolean>;
  lastBackup(projectFolder: string): Promise<LastBackupRecord | null>;
}

const IPC = {
  load: "FlexText.backup.load",
  save: "FlexText.backup.save",
  configure: "FlexText.backup.configure",
  chooseFolder: "FlexText.backup.chooseFolder",
  recordLastBackup: "FlexText.backup.recordLastBackup",
  lastBackup: "FlexText.backup.lastBackup"
};

let mock: BackupApi | null = null;
export function setBackupApiForTests(api: BackupApi | null): void {
  mock = api;
}

function createIpcApi(): BackupApi {
  const { ipcRenderer } = require("electron");
  return {
    load: () => ipcRenderer.invoke(IPC.load),
    save: (settings, secret) => ipcRenderer.invoke(IPC.save, settings, secret),
    configure: () => ipcRenderer.invoke(IPC.configure),
    chooseFolder: (title) => ipcRenderer.invoke(IPC.chooseFolder, title),
    recordLastBackup: (folder, rec) => ipcRenderer.invoke(IPC.recordLastBackup, folder, rec),
    lastBackup: (folder) => ipcRenderer.invoke(IPC.lastBackup, folder)
  };
}

let cached: BackupApi | null = null;
export const backupApi: BackupApi = new Proxy({} as BackupApi, {
  get(_t, prop: keyof BackupApi) {
    if (mock) return mock[prop];
    if (!cached) cached = createIpcApi();
    return cached[prop];
  }
});
