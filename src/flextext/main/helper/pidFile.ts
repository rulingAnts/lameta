// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// PID file plus a stale-helper sweep at launch (PLAN §1.7). A crash can leave a helper running
// with its pipes gone; the next launch finds the previous PID file and, ONLY when the process
// with that PID is still our helper (image-name check on Windows), kills it. Elsewhere the sweep
// is a no-op: it just removes the file. No Electron import, so it is unit-tested.

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export const PID_FILE_NAME = "flextext-helper.pid";
export const HELPER_IMAGE_NAME = "flextext-helper.exe";

export interface PidRecord {
  pid: number;
  startedAt: string;
  appPid: number;
}

export function pidFilePath(userDataDir: string): string {
  return path.join(userDataDir, PID_FILE_NAME);
}

export function writePidFile(userDataDir: string, pid: number): void {
  const rec: PidRecord = {
    pid,
    startedAt: new Date().toISOString(),
    appPid: process.pid
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(pidFilePath(userDataDir), JSON.stringify(rec), "utf8");
}

export function readPidFile(userDataDir: string): PidRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(pidFilePath(userDataDir), "utf8"));
    if (typeof rec?.pid === "number" && rec.pid > 0) return rec as PidRecord;
  } catch {
    /* absent or unreadable */
  }
  return null;
}

export function removePidFile(userDataDir: string): void {
  try {
    fs.unlinkSync(pidFilePath(userDataDir));
  } catch {
    /* already gone */
  }
}

/** Hooks so the sweep can be tested without touching real processes. */
export interface SweepPlatform {
  platform: NodeJS.Platform;
  /** The image name of the process with that PID, or null when it does not exist. */
  imageNameOf: (pid: number) => string | null;
  kill: (pid: number) => void;
}

export const realPlatform: SweepPlatform = {
  platform: process.platform,
  imageNameOf: (pid) => {
    if (process.platform !== "win32") return null;
    try {
      // CSV, no header: "Image Name","PID",...
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 5000 }
      );
      const m = /^"([^"]+)","(\d+)"/m.exec(out);
      return m && Number(m[2]) === pid ? m[1] : null;
    } catch {
      return null;
    }
  },
  kill: (pid) => {
    // only reached on Windows, for a process proven to be our helper image
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5000
    });
  }
};

export interface SweepResult {
  found: PidRecord | null;
  killed: boolean;
  reason: string;
}

/**
 * Removes a stale helper left by a crashed app. Kills only on Windows, only when the PID's
 * image name is the helper's, never a PID that now belongs to something else.
 */
export function sweepStaleHelper(
  userDataDir: string,
  platform: SweepPlatform = realPlatform
): SweepResult {
  const rec = readPidFile(userDataDir);
  if (!rec) return { found: null, killed: false, reason: "no pid file" };
  removePidFile(userDataDir);
  if (platform.platform !== "win32") {
    return { found: rec, killed: false, reason: "sweep is a no-op off Windows" };
  }
  if (rec.appPid === process.pid) {
    return { found: rec, killed: false, reason: "pid file is ours" };
  }
  const image = platform.imageNameOf(rec.pid);
  if (!image) return { found: rec, killed: false, reason: "process is gone" };
  if (image.toLowerCase() !== HELPER_IMAGE_NAME) {
    return { found: rec, killed: false, reason: `pid reused by ${image}` };
  }
  try {
    platform.kill(rec.pid);
    return { found: rec, killed: true, reason: "stale helper killed" };
  } catch (e) {
    return { found: rec, killed: false, reason: `kill failed: ${(e as Error).message}` };
  }
}
