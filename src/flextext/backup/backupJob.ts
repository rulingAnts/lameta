// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The renderer's view of one running rclone job (backup or restore): start it through the
// helper, poll its status, stop it. Pure apart from the injected helper and clock, so the
// BackupTab's logic is tested without React.

import type { HelperApi } from "../helper/HelperApiAccess";

export interface JobProgress {
  jobid: number | null;
  running: boolean;
  finished: boolean;
  success: boolean | null;
  error: string;
  bytes: number;
  totalBytes: number;
  transfers: number;
  totalTransfers: number;
  speed: number; // bytes/s
  eta: number | null; // seconds
  elapsed: number; // seconds
}

export const EMPTY_PROGRESS: JobProgress = {
  jobid: null,
  running: false,
  finished: false,
  success: null,
  error: "",
  bytes: 0,
  totalBytes: 0,
  transfers: 0,
  totalTransfers: 0,
  speed: 0,
  eta: null,
  elapsed: 0
};

/** Maps the helper's backupStatus result ({job, stats}) to a JobProgress. */
export function progressFromStatus(jobid: number, status: any): JobProgress {
  const job = status?.job ?? {};
  const stats = status?.stats ?? {};
  const finished = !!job.finished;
  return {
    jobid,
    running: !finished,
    finished,
    success: finished ? !!job.success : null,
    error: String(job.error ?? stats.lastError ?? ""),
    bytes: Number(stats.bytes ?? 0),
    totalBytes: Number(stats.totalBytes ?? 0),
    transfers: Number(stats.transfers ?? 0),
    totalTransfers: Number(stats.totalTransfers ?? 0),
    speed: Number(stats.speed ?? 0),
    eta: stats.eta == null ? null : Number(stats.eta),
    elapsed: Number(stats.elapsedTime ?? job.duration ?? 0)
  };
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatProgress(p: JobProgress): string {
  if (!p.jobid) return "";
  if (p.finished) return p.success ? "Finished" : `Failed: ${p.error || "unknown error"}`;
  const parts = [`${formatBytes(p.bytes)}${p.totalBytes ? ` of ${formatBytes(p.totalBytes)}` : ""}`];
  if (p.totalTransfers) parts.push(`${p.transfers} of ${p.totalTransfers} files`);
  if (p.speed) parts.push(`${formatBytes(p.speed)}/s`);
  if (p.eta != null) parts.push(`about ${Math.ceil(p.eta)} s left`);
  return parts.join(", ");
}

export class JobRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  public progress: JobProgress = { ...EMPTY_PROGRESS };

  constructor(
    private readonly helper: HelperApi,
    private readonly onProgress: (p: JobProgress) => void,
    private readonly pollMs = 1000
  ) {}

  /** Starts a job with the given helper method (backupStart / backupRestore) and polls it. */
  public async start(method: "backupStart" | "backupRestore", params: Record<string, unknown>): Promise<any> {
    if (this.progress.running) throw new Error("a job is already running");
    const started = await this.helper.call<{ jobid: number }>(method, params);
    this.progress = { ...EMPTY_PROGRESS, jobid: started.jobid, running: true };
    this.onProgress(this.progress);
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    return started;
  }

  public async poll(): Promise<JobProgress> {
    if (!this.progress.jobid) return this.progress;
    try {
      const status = await this.helper.call("backupStatus", { jobid: this.progress.jobid });
      this.progress = progressFromStatus(this.progress.jobid, status);
    } catch (e) {
      this.progress = { ...this.progress, running: false, finished: true, success: false, error: (e as Error).message };
    }
    if (this.progress.finished) this.clearTimer();
    this.onProgress(this.progress);
    return this.progress;
  }

  public async stop(): Promise<void> {
    if (!this.progress.jobid || !this.progress.running) return;
    try {
      await this.helper.call("backupStop", { jobid: this.progress.jobid });
    } finally {
      await this.poll();
    }
  }

  public dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
