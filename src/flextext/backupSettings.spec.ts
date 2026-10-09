// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BackupSettingsStore, SecretCrypto, SETTINGS_FILE_NAME } from "./main/backup/backupSettings";

function fakeCrypto(available = true): SecretCrypto & { encrypted: string[] } {
  const encrypted: string[] = [];
  return {
    encrypted,
    isAvailable: () => available,
    encrypt: (plain) => {
      encrypted.push(plain);
      return Buffer.from("ENC(" + Buffer.from(plain).toString("hex") + ")");
    },
    decrypt: (buf) => {
      const m = /^ENC\(([0-9a-f]*)\)$/.exec(buf.toString());
      if (!m) throw new Error("not ours");
      return Buffer.from(m[1], "hex").toString();
    }
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-backup-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("BackupSettingsStore", () => {
  it("starts empty and reports encryption availability", () => {
    const s = new BackupSettingsStore(dir, fakeCrypto());
    const pub = s.load();
    expect(pub.hasSecret).toBe(false);
    expect(pub.encryptionAvailable).toBe(true);
    expect(pub.endpoint).toBe("");
  });

  it("stores the secret only encrypted, never returns it to the renderer", () => {
    const crypto = fakeCrypto();
    const s = new BackupSettingsStore(dir, crypto);
    const pub = s.save(
      { endpoint: "https://s3.example.test ", bucket: "b", prefix: "/team/x/", accessKeyId: "AK" },
      "the-secret"
    );
    expect(pub.hasSecret).toBe(true);
    expect(pub).not.toHaveProperty("secretAccessKey");
    expect(pub.endpoint).toBe("https://s3.example.test");
    expect(pub.prefix).toBe("team/x");
    const onDisk = fs.readFileSync(path.join(dir, SETTINGS_FILE_NAME), "utf8");
    expect(onDisk).not.toContain("the-secret");
    expect(crypto.encrypted).toEqual(["the-secret"]);
    expect(s.secret()).toBe("the-secret");
    expect(s.helperSettings()).toMatchObject({ secretAccessKey: "the-secret", bucket: "b", prefix: "team/x" });
  });

  it("keeps the secret when saving without one, clears it on empty string", () => {
    const s = new BackupSettingsStore(dir, fakeCrypto());
    s.save({ bucket: "b" }, "sec");
    s.save({ bucket: "c" });
    expect(s.load().bucket).toBe("c");
    expect(s.secret()).toBe("sec");
    s.save({}, "");
    expect(s.load().hasSecret).toBe(false);
    expect(s.helperSettings()).toBeNull();
  });

  it("refuses to store a secret when encryption is unavailable (never plaintext)", () => {
    const s = new BackupSettingsStore(dir, fakeCrypto(false));
    expect(() => s.save({ bucket: "b" }, "sec")).toThrow(/cannot encrypt/);
    // the other settings were saved, the secret was not
    expect(s.load().bucket).toBe("b");
    expect(s.load().hasSecret).toBe(false);
    expect(fs.readFileSync(path.join(dir, SETTINGS_FILE_NAME), "utf8")).not.toContain("sec\"");
  });

  it("records and reads the last backup per project folder", () => {
    const s = new BackupSettingsStore(dir, fakeCrypto());
    expect(s.lastBackup("/p/one")).toBeNull();
    s.recordLastBackup("/p/one", { at: "2026-10-10T00:00:00Z", ok: true, message: "ok", bytes: 5 });
    expect(s.lastBackup("/p/one")).toMatchObject({ ok: true, bytes: 5 });
    expect(s.lastBackup("/p/two")).toBeNull();
  });

  it("survives a corrupt file", () => {
    fs.writeFileSync(path.join(dir, SETTINGS_FILE_NAME), "{not json");
    const s = new BackupSettingsStore(dir, fakeCrypto());
    expect(s.load().hasSecret).toBe(false);
    s.save({ bucket: "b" });
    expect(s.load().bucket).toBe("b");
  });
});
