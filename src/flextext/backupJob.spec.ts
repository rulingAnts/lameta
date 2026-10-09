// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.

import { describe, it, expect } from "vitest";
import { JobRunner, formatBytes, formatProgress, progressFromStatus } from "./backup/backupJob";
import type { HelperApi } from "./helper/HelperApiAccess";

function fakeHelper() {
  const calls: Array<[string, any]> = [];
  let finished = false;
  const api: HelperApi = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push([method, params]);
      if (method === "backupStart") return { jobid: 7, dstFs: "fts3:b/p" } as any;
      if (method === "backupStatus")
        return {
          job: { id: 7, finished, success: finished, error: "" },
          stats: { bytes: finished ? 100 : 40, totalBytes: 100, transfers: 1, totalTransfers: 3, speed: 10, eta: 6 }
        } as any;
      if (method === "backupStop") {
        finished = true;
        return true as any;
      }
      throw new Error("unexpected " + method);
    },
    cancel: async () => true,
    status: async () => null,
    onNotification: () => () => {}
  };
  return { api, calls, finish: () => (finished = true) };
}

describe("JobRunner", () => {
  it("starts, polls, formats progress, finishes", async () => {
    const h = fakeHelper();
    const seen: string[] = [];
    const r = new JobRunner(h.api, (p) => seen.push(formatProgress(p)), 10_000);
    const started = await r.start("backupStart", { projectFolder: "/p" });
    expect(started.jobid).toBe(7);
    expect(r.progress.running).toBe(true);
    await r.poll();
    expect(seen[seen.length - 1]).toBe("40 B of 100 B, 1 of 3 files, 10 B/s, about 6 s left");
    h.finish();
    await r.poll();
    expect(r.progress.finished).toBe(true);
    expect(r.progress.success).toBe(true);
    expect(seen[seen.length - 1]).toBe("Finished");
    r.dispose();
  });

  it("stop() sends job/stop and refreshes", async () => {
    const h = fakeHelper();
    const r = new JobRunner(h.api, () => {}, 10_000);
    await r.start("backupStart", { projectFolder: "/p" });
    await r.stop();
    expect(h.calls.map((c) => c[0])).toContain("backupStop");
    expect(r.progress.finished).toBe(true);
    r.dispose();
  });

  it("refuses a second job while one runs", async () => {
    const h = fakeHelper();
    const r = new JobRunner(h.api, () => {}, 10_000);
    await r.start("backupStart", { projectFolder: "/p" });
    await expect(r.start("backupStart", { projectFolder: "/p" })).rejects.toThrow(/already running/);
    r.dispose();
  });

  it("maps a failed job and formats bytes", () => {
    const p = progressFromStatus(3, { job: { finished: true, success: false, error: "boom" }, stats: {} });
    expect(formatProgress(p)).toBe("Failed: boom");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });
});
