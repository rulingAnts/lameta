// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Backup settings on this machine (PLAN §3): endpoint, region, bucket, prefix, key id, bandwidth
// limit, and the secret. The secret is stored ONLY encrypted by Electron safeStorage (DPAPI on
// Windows); when encryption is unavailable it is not stored at all. Nothing here is ever written
// as a plaintext rclone.conf: the main process decrypts and hands the secret to the helper, which
// puts it in rclone's environment. The renderer never receives the secret back.
//
// Pure: the crypto and the file location are injected, so it is unit-tested with fakes.

import * as fs from "fs";
import * as path from "path";

export interface BackupSettings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  bwlimit: string;
  forcePathStyle: boolean;
  autoBackupMinutes: number; // 0 = off
}

export interface LastBackupRecord {
  at: string; // ISO time the backup finished
  ok: boolean;
  message: string;
  bytes?: number;
  files?: number;
  backupDir?: string;
}

export interface BackupSettingsFile {
  version: 1;
  settings: BackupSettings;
  secret: { scheme: "safeStorage"; data: string } | null; // base64 of the encrypted buffer
  lastBackups: Record<string, LastBackupRecord>;
}

export interface SecretCrypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export const EMPTY_SETTINGS: BackupSettings = {
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  bwlimit: "",
  forcePathStyle: false,
  autoBackupMinutes: 0
};

export const SETTINGS_FILE_NAME = "flextext-backup.json";

/** What the renderer sees: the settings plus whether a secret is stored, never the secret. */
export interface PublicBackupSettings extends BackupSettings {
  hasSecret: boolean;
  encryptionAvailable: boolean;
}

function normalise(input: Partial<BackupSettings>): BackupSettings {
  const s = { ...EMPTY_SETTINGS, ...input };
  return {
    endpoint: String(s.endpoint ?? "").trim(),
    region: String(s.region ?? "").trim(),
    bucket: String(s.bucket ?? "").trim(),
    prefix: String(s.prefix ?? "").trim().replace(/^\/+|\/+$/g, ""),
    accessKeyId: String(s.accessKeyId ?? "").trim(),
    bwlimit: String(s.bwlimit ?? "").trim(),
    forcePathStyle: !!s.forcePathStyle,
    autoBackupMinutes: Math.max(0, Math.floor(Number(s.autoBackupMinutes) || 0))
  };
}

export class BackupSettingsStore {
  private readonly file: string;

  constructor(userDataDir: string, private readonly crypto: SecretCrypto) {
    this.file = path.join(userDataDir, SETTINGS_FILE_NAME);
  }

  get filePath(): string {
    return this.file;
  }

  private read(): BackupSettingsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && raw.version === 1) {
        return {
          version: 1,
          settings: normalise(raw.settings ?? {}),
          secret: raw.secret?.scheme === "safeStorage" && typeof raw.secret.data === "string" ? raw.secret : null,
          lastBackups: raw.lastBackups ?? {}
        };
      }
    } catch {
      /* absent or unreadable: start fresh */
    }
    return { version: 1, settings: { ...EMPTY_SETTINGS }, secret: null, lastBackups: {} };
  }

  private write(data: BackupSettingsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  public load(): PublicBackupSettings {
    const d = this.read();
    return { ...d.settings, hasSecret: d.secret !== null, encryptionAvailable: this.crypto.isAvailable() };
  }

  /**
   * Saves the settings; `secret` undefined keeps the stored one, "" clears it, anything else is
   * encrypted and stored. Throws when a secret is given but encryption is unavailable: the
   * secret is then NOT stored (never plaintext), though the other settings are.
   */
  public save(settings: Partial<BackupSettings>, secret?: string): PublicBackupSettings {
    const d = this.read();
    d.settings = normalise({ ...d.settings, ...settings });
    let encryptionError: string | null = null;
    if (secret === "") {
      d.secret = null;
    } else if (secret !== undefined) {
      if (!this.crypto.isAvailable()) {
        encryptionError = "This computer cannot encrypt the secret (Electron safeStorage is unavailable), so it was not saved.";
        d.secret = null;
      } else {
        d.secret = { scheme: "safeStorage", data: this.crypto.encrypt(secret).toString("base64") };
      }
    }
    this.write(d);
    if (encryptionError) throw new Error(encryptionError);
    return this.load();
  }

  /** The decrypted secret, for the main process to pass to the helper; null when none. */
  public secret(): string | null {
    const d = this.read();
    if (!d.secret) return null;
    if (!this.crypto.isAvailable()) return null;
    try {
      return this.crypto.decrypt(Buffer.from(d.secret.data, "base64"));
    } catch {
      return null;
    }
  }

  /** The settings the helper's backupConfigure wants, secret included; null without a secret. */
  public helperSettings(): Record<string, string> | null {
    const d = this.read();
    const s = this.secret();
    if (!s) return null;
    return {
      endpoint: d.settings.endpoint,
      region: d.settings.region,
      bucket: d.settings.bucket,
      prefix: d.settings.prefix,
      accessKeyId: d.settings.accessKeyId,
      secretAccessKey: s,
      bwlimit: d.settings.bwlimit,
      forcePathStyle: d.settings.forcePathStyle ? "true" : ""
    };
  }

  public recordLastBackup(projectFolder: string, rec: LastBackupRecord): void {
    const d = this.read();
    d.lastBackups[path.normalize(projectFolder)] = rec;
    this.write(d);
  }

  public lastBackup(projectFolder: string): LastBackupRecord | null {
    return this.read().lastBackups[path.normalize(projectFolder)] ?? null;
  }
}
