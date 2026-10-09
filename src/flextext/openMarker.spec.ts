// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The §5 open-marker contract: shape, heartbeat, staleness, delete on close, never deleting
// another instance's marker.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenMarker, isMarkerFresh, readOpenMarker, openMarkerPath, STALE_AFTER_MS, HEARTBEAT_MS } from "./device/openMarker";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-marker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("open marker", () => {
  it("has the contract's shape and the fork's identity", () => {
    const now = new Date("2026-10-09T20:00:00Z");
    const m = new OpenMarker(dir, { pid: 1234, now: () => now, version: "0.1.0" });
    m.start();
    const rec = JSON.parse(fs.readFileSync(openMarkerPath(dir), "utf8"));
    expect(rec).toEqual({
      app: "FlexText Metadata",
      version: "0.1.0",
      pid: 1234,
      since: "2026-10-09T20:00:00Z",
      heartbeat: "2026-10-09T20:00:00Z"
    });
    expect(Object.keys(rec)).toEqual(["app", "version", "pid", "since", "heartbeat"]);
    expect(path.basename(openMarkerPath(dir))).toBe(".flextext-open.json");
    m.stop();
    expect(fs.existsSync(openMarkerPath(dir))).toBe(false);
  });

  it("rewrites the heartbeat and keeps `since`", () => {
    let t = new Date("2026-10-09T20:00:00Z");
    const m = new OpenMarker(dir, { pid: 1, now: () => t, heartbeatMs: 60_000 });
    m.start();
    t = new Date("2026-10-09T20:05:30Z");
    m.write();
    const rec = readOpenMarker(dir)!;
    expect(rec.since).toBe("2026-10-09T20:00:00Z");
    expect(rec.heartbeat).toBe("2026-10-09T20:05:30Z");
    m.stop();
  });

  it("heartbeat interval and staleness match the contract (30 s, 2 min)", () => {
    expect(HEARTBEAT_MS).toBe(30_000);
    expect(STALE_AFTER_MS).toBe(120_000);
    const hb = new Date("2026-10-09T20:00:00Z");
    const rec = { app: "x", version: "1", pid: 1, since: hb.toISOString(), heartbeat: hb.toISOString() };
    expect(isMarkerFresh(rec, new Date(hb.getTime() + 119_000))).toBe(true);
    expect(isMarkerFresh(rec, new Date(hb.getTime() + 121_000))).toBe(false);
    expect(isMarkerFresh(null)).toBe(false);
    expect(isMarkerFresh({ ...rec, heartbeat: "garbage" })).toBe(false);
  });

  it("stop() does not delete a marker another instance has since written", () => {
    const m = new OpenMarker(dir, { pid: 1 });
    m.start();
    fs.writeFileSync(openMarkerPath(dir), JSON.stringify({ app: "FlexText Metadata", version: "x", pid: 2, since: "", heartbeat: new Date().toISOString() }));
    m.stop();
    expect(readOpenMarker(dir)!.pid).toBe(2);
  });

  it("a write failure is reported, not thrown", () => {
    const errors: string[] = [];
    const m = new OpenMarker(path.join(dir, "does", "not", "exist"), { onError: (e) => errors.push(e.message) });
    m.start();
    expect(errors.length).toBe(1);
    m.stop();
  });
});
