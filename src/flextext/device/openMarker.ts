// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The open marker `<project>/.flextext-open.json` (PLAN §5, the contract shared with the
// FlexText Researcher Panel's lameta-device agent; plans/flextext-metadata.md §5 owns it):
//
//   { "app": "FlexText Metadata", "version": "…", "pid": 1234,
//     "since": "2026-10-09T20:00:00Z", "heartbeat": "2026-10-09T20:05:30Z" }
//
// Written when a project opens, heartbeat rewritten every 30 s, deleted on close. A marker whose
// heartbeat is older than 2 minutes is stale and treated as absent (a crash leaves one behind).
// Excluded from backups (helper/flextext_helper/rclone/backup.py EXCLUDES).

import * as fs from "fs";
import * as path from "path";
import { APP_NAME, FLEXTEXT_VERSION } from "../branding/brand";

export const OPEN_MARKER_FILE_NAME = ".flextext-open.json";
export const HEARTBEAT_MS = 30_000;
export const STALE_AFTER_MS = 120_000;

export interface OpenMarkerRecord {
  app: string;
  version: string;
  pid: number;
  since: string;
  heartbeat: string;
}

export function openMarkerPath(projectDir: string): string {
  return path.join(projectDir, OPEN_MARKER_FILE_NAME);
}

/** ISO 8601 UTC to the second, as the contract's example shows ("2026-10-09T20:00:00Z"). */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function readOpenMarker(projectDir: string): OpenMarkerRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(openMarkerPath(projectDir), "utf8"));
    if (rec && typeof rec.pid === "number" && typeof rec.heartbeat === "string") return rec as OpenMarkerRecord;
  } catch {
    /* absent or unreadable */
  }
  return null;
}

/** Fresh = heartbeat within the last 2 minutes (the agent treats anything else as absent). */
export function isMarkerFresh(rec: OpenMarkerRecord | null, now: Date = new Date()): boolean {
  if (!rec) return false;
  const hb = Date.parse(rec.heartbeat);
  if (Number.isNaN(hb)) return false;
  return now.getTime() - hb <= STALE_AFTER_MS;
}

export interface OpenMarkerOptions {
  heartbeatMs?: number;
  pid?: number;
  now?: () => Date;
  version?: string;
  app?: string;
  /** Called when a write fails (e.g. a read-only project folder); the app keeps working. */
  onError?: (e: Error) => void;
}

export class OpenMarker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private since: string | null = null;
  private readonly opts: Required<OpenMarkerOptions>;

  constructor(public readonly projectDir: string, options: OpenMarkerOptions = {}) {
    this.opts = {
      heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
      pid: options.pid ?? process.pid,
      now: options.now ?? (() => new Date()),
      version: options.version ?? FLEXTEXT_VERSION,
      app: options.app ?? APP_NAME,
      onError: options.onError ?? ((e) => console.error(`[flextext] open marker: ${e.message}`))
    };
  }

  public get path(): string {
    return openMarkerPath(this.projectDir);
  }

  public start(): void {
    if (this.timer) return;
    this.since = isoSeconds(this.opts.now());
    this.write();
    this.timer = setInterval(() => this.write(), this.opts.heartbeatMs);
    // never keep the process alive just for the heartbeat
    (this.timer as any).unref?.();
  }

  /** Rewrites the file with a fresh heartbeat (atomic: temp file then rename). */
  public write(): void {
    const rec: OpenMarkerRecord = {
      app: this.opts.app,
      version: this.opts.version,
      pid: this.opts.pid,
      since: this.since ?? isoSeconds(this.opts.now()),
      heartbeat: isoSeconds(this.opts.now())
    };
    try {
      const tmp = `${this.path}.${this.opts.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec), "utf8");
      fs.renameSync(tmp, this.path);
    } catch (e) {
      this.opts.onError(e as Error);
    }
  }

  /** Stops the heartbeat and deletes the marker, but only if it is still ours (same pid). */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const current = readOpenMarker(this.projectDir);
    if (current && current.pid !== this.opts.pid) return; // another instance owns it now
    try {
      fs.unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }

  public get running(): boolean {
    return this.timer !== null;
  }
}
