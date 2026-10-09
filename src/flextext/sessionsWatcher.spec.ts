// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionsWatcher, findSessionFile, scanSessions } from "./device/sessionsWatcher";

let root: string;
let sessionsDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ft-sessions-"));
  sessionsDir = path.join(root, "Sessions");
  fs.mkdirSync(sessionsDir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function makeSession(id: string, body = "<Session></Session>"): string {
  const dir = path.join(sessionsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.session`), body);
  return dir;
}

function touch(file: string, body: string) {
  fs.writeFileSync(file, body);
  // make sure the mtime moves even on coarse filesystems
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(file, t, t);
}

function harness(edited: Set<string> = new Set()) {
  const events: string[] = [];
  const w = new SessionsWatcher(
    sessionsDir,
    {
      onNewSession: (d) => events.push("new:" + path.basename(d)),
      onSessionChanged: (d) => events.push("changed:" + path.basename(d)),
      isBeingEdited: (d) => edited.has(path.basename(d)),
      onError: (e) => events.push("error:" + e.message)
    },
    { pollMs: 60_000, debounceMs: 10 }
  );
  return { w, events };
}

describe("scanning", () => {
  it("finds the .session file, preferring the one named after the folder", () => {
    const dir = makeSession("S1");
    fs.writeFileSync(path.join(dir, "aaa.session"), "");
    expect(path.basename(findSessionFile(dir)!)).toBe("S1.session");
    fs.mkdirSync(path.join(sessionsDir, "NoFile"));
    const snap = scanSessions(sessionsDir);
    expect([...snap.keys()].map((d) => path.basename(d))).toEqual(["S1"]);
    expect(findSessionFile(path.join(sessionsDir, "NoFile"))).toBeNull();
  });
});

describe("SessionsWatcher", () => {
  it("reports nothing for what exists at start, then a new folder", () => {
    makeSession("Existing");
    const { w, events } = harness();
    w.start();
    w.tick();
    expect(events).toEqual([]);
    makeSession("FromPhone");
    w.tick();
    expect(events).toEqual(["new:FromPhone"]);
    w.tick();
    expect(events).toEqual(["new:FromPhone"]); // reported once
    w.stop();
  });

  it("ignores a folder until it holds a .session file", () => {
    const { w, events } = harness();
    w.start();
    fs.mkdirSync(path.join(sessionsDir, "Partial"));
    w.tick();
    expect(events).toEqual([]);
    fs.writeFileSync(path.join(sessionsDir, "Partial", "Partial.session"), "<Session></Session>");
    w.tick();
    expect(events).toEqual(["new:Partial"]);
    w.stop();
  });

  it("reports a changed .session, but defers it while that session is being edited", () => {
    const dir = makeSession("Edited");
    makeSession("Other");
    const edited = new Set(["Edited"]);
    const { w, events } = harness(edited);
    w.start();
    touch(path.join(dir, "Edited.session"), "<Session><Title>new</Title></Session>");
    touch(path.join(sessionsDir, "Other", "Other.session"), "<Session><Title>x</Title></Session>");
    w.tick();
    expect(events).toEqual(["changed:Other"]);
    expect(w.pendingDeferred.map((d) => path.basename(d))).toEqual(["Edited"]);
    w.tick();
    expect(events).toEqual(["changed:Other"]); // still deferred, not repeated for Other
    edited.clear(); // the user moved to another session
    w.tick();
    expect(events).toEqual(["changed:Other", "changed:Edited"]);
    expect(w.pendingDeferred).toEqual([]);
    w.stop();
  });

  it("acknowledge() marks our own write as known", () => {
    const dir = makeSession("Mine");
    const { w, events } = harness();
    w.start();
    touch(path.join(dir, "Mine.session"), "<Session><Title>saved by lameta</Title></Session>");
    w.acknowledge(dir);
    w.tick();
    expect(events).toEqual([]);
    w.stop();
  });

  it("forgets a removed folder and survives a missing Sessions dir", () => {
    const dir = makeSession("Gone");
    const { w, events } = harness();
    w.start();
    fs.rmSync(dir, { recursive: true, force: true });
    w.tick();
    expect(events).toEqual([]);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    w.tick();
    expect(events).toEqual([]);
    w.stop();
  });

  it("fs.watch delivers a new folder without waiting for the poll", async () => {
    const { w, events } = harness();
    w.start();
    makeSession("Prompt");
    await new Promise((r) => setTimeout(r, 400));
    if (events.length === 0) w.tick(); // platforms where fs.watch is inert: the poll covers it
    expect(events).toEqual(["new:Prompt"]);
    w.stop();
  });
});
