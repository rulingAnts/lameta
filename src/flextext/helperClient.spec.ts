// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// HelperClient against the fake helper script (src/flextext/testing/fake-helper.js): the line
// protocol, timeouts, cancel by message, restart with backoff, shutdown-then-kill, and the
// PID-file sweep rules.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  HelperClient,
  HelperErrorCodes,
  HelperRpcError,
  HelperUnavailableError
} from "./main/helper/HelperClient";
import {
  sweepStaleHelper,
  writePidFile,
  readPidFile,
  pidFilePath,
  SweepPlatform
} from "./main/helper/pidFile";
import { locateHelper, parseCommandLine } from "./main/helper/locateHelper";

const FAKE = path.join(__dirname, "testing", "fake-helper.js");

function makeClient(extra: string[] = [], opts: Partial<ConstructorParameters<typeof HelperClient>[0]> = {}) {
  const log: string[] = [];
  const client = new HelperClient({
    command: { command: process.execPath, args: [FAKE, ...extra] },
    callTimeoutMs: 2000,
    restartBackoffMs: [50, 100],
    shutdownGraceMs: 500,
    log: (l) => log.push(l),
    ...opts
  });
  return { client, log };
}

const clients: HelperClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
});

describe("HelperClient protocol", () => {
  it("starts, receives ready, and round-trips calls", async () => {
    const { client, log } = makeClient();
    clients.push(client);
    await client.start();
    expect(client.status().state).toBe("ready");
    expect(client.status().methods).toContain("ping");
    expect(await client.call("ping")).toBe("pong");
    expect(await client.call("echo", { a: 1, s: "ünïcödé" })).toEqual({ a: 1, s: "ünïcödé" });
    expect(log.some((l) => l.includes("fake helper starting"))).toBe(true); // stderr drained
  });

  it("passes the parent pid and extra args to the helper", async () => {
    const { client } = makeClient([], { extraArgs: ["--parent-pid", String(process.pid)] });
    clients.push(client);
    const args = await client.call<string[]>("args");
    expect(args).toEqual(["--parent-pid", String(process.pid)]);
  });

  it("surfaces JSON-RPC errors with their code", async () => {
    const { client } = makeClient();
    clients.push(client);
    await expect(client.call("nope")).rejects.toMatchObject({ name: "HelperRpcError", code: -32601 });
  });

  it("forwards notifications", async () => {
    const { client } = makeClient();
    clients.push(client);
    const seen: any[] = [];
    client.on("notification", (m, p) => seen.push([m, p]));
    expect(await client.call("notify")).toBe("notified");
    expect(seen).toEqual([["progress", { id: expect.any(Number), done: 1, total: 2 }]]);
  });

  it("ignores non-JSON lines on stdout and keeps going", async () => {
    const { client, log } = makeClient();
    clients.push(client);
    expect(await client.call("garbage")).toBe("after garbage");
    expect(log.some((l) => l.includes("non-JSON on stdout"))).toBe(true);
  });

  it("times out a call and sends cancel for it", async () => {
    const { client } = makeClient();
    clients.push(client);
    const t0 = Date.now();
    await expect(client.call("sleep", { ms: 5000 }, { timeoutMs: 200 })).rejects.toMatchObject({
      code: HelperErrorCodes.CANCELLED
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await client.call("ping")).toBe("pong"); // still healthy
  });

  it("cancel is a message: a cancelled call rejects with -32001 and the helper lives on", async () => {
    const { client } = makeClient();
    clients.push(client);
    await client.start();
    const pidBefore = client.pid;
    // keep the rejection handled from the start (it arrives while we await the cancel)
    const slow = client.call("sleep", { ms: 5000 }).then(
      (v) => ({ ok: v }),
      (e) => ({ err: e })
    );
    expect(client.status().state).toBe("ready");
    // the fake helper tracks sleepers by id; the client numbers ids from 1 (start() used none)
    const ok = await client.cancel(1);
    expect(ok).toBe(true);
    const outcome: any = await slow;
    expect(outcome.err).toBeInstanceOf(HelperRpcError);
    expect(outcome.err.code).toBe(HelperErrorCodes.CANCELLED);
    expect(client.pid).toBe(pidBefore);
  });
});

describe("HelperClient lifecycle", () => {
  it("restarts with backoff after a crash and rejects the pending calls", async () => {
    const { client } = makeClient();
    clients.push(client);
    await client.start();
    const firstPid = client.pid;
    const restarting = new Promise<any>((r) => client.once("restarting", r));
    const pending = client.call("sleep", { ms: 5000 });
    client.call("crash").catch(() => {});
    await expect(pending).rejects.toBeInstanceOf(HelperUnavailableError);
    const info = await restarting;
    expect(info.delay).toBe(50);
    // the next call waits for the restart and succeeds on the new process
    expect(await client.call("ping")).toBe("pong");
    expect(client.pid).not.toBe(firstPid);
    expect(client.status().restarts).toBe(1);
    expect(client.status().lastExit).toEqual({ code: 3, signal: null });
  });

  it("gives up after maxRestarts consecutive failures", async () => {
    const { client } = makeClient(["--exit-on-start", "7"], { maxRestarts: 2 });
    clients.push(client);
    await expect(client.start()).rejects.toBeInstanceOf(HelperUnavailableError);
    expect(client.status().state).toBe("failed");
    await expect(client.call("ping")).rejects.toBeInstanceOf(HelperUnavailableError);
  });

  it("stop() sends shutdown and the helper exits before the grace period", async () => {
    const { client, log } = makeClient();
    await client.start();
    const exited = new Promise<any>((r) => client.once("exit", r));
    await client.stop();
    const e = await exited;
    expect(e.code).toBe(0);
    expect(client.status().state).toBe("stopped");
    expect(log.some((l) => l.includes("killing"))).toBe(false);
  });

  it("stop() kills a helper that ignores shutdown, after the grace period", async () => {
    const { client, log } = makeClient(["--ignore-shutdown"], { shutdownGraceMs: 300 });
    await client.start();
    const pid = client.pid!;
    const t0 = Date.now();
    await client.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(log.some((l) => l.includes("killing"))).toBe(true);
    // the process is gone
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does not restart after stop()", async () => {
    const { client } = makeClient();
    await client.start();
    await client.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(client.status().state).toBe("stopped");
    expect(client.pid).toBeNull();
  });
});

describe("PID file and stale sweep", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function platform(p: NodeJS.Platform, image: string | null): SweepPlatform & { killed: number[] } {
    const killed: number[] = [];
    return { platform: p, imageNameOf: () => image, kill: (pid) => killed.push(pid), killed };
  }

  it("writes and reads the record", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-pid-"));
    writePidFile(dir, 4321);
    const rec = readPidFile(dir)!;
    expect(rec.pid).toBe(4321);
    expect(rec.appPid).toBe(process.pid);
    expect(fs.existsSync(pidFilePath(dir))).toBe(true);
  });

  it("is a no-op off Windows (removes the file, kills nothing)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-pid-"));
    fs.writeFileSync(pidFilePath(dir), JSON.stringify({ pid: 999999, appPid: 1, startedAt: "" }));
    const p = platform("linux", "flextext-helper.exe");
    const r = sweepStaleHelper(dir, p);
    expect(r.killed).toBe(false);
    expect(p.killed).toEqual([]);
    expect(fs.existsSync(pidFilePath(dir))).toBe(false);
  });

  it("on Windows kills only when the PID's image is the helper", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-pid-"));
    const rec = { pid: 999999, appPid: 1, startedAt: "" };
    fs.writeFileSync(pidFilePath(dir), JSON.stringify(rec));
    const helper = platform("win32", "FlexText-Helper.exe");
    expect(sweepStaleHelper(dir, helper)).toMatchObject({ killed: true, reason: "stale helper killed" });
    expect(helper.killed).toEqual([999999]);

    fs.writeFileSync(pidFilePath(dir), JSON.stringify(rec));
    const other = platform("win32", "notepad.exe");
    expect(sweepStaleHelper(dir, other)).toMatchObject({ killed: false, reason: "pid reused by notepad.exe" });
    expect(other.killed).toEqual([]);

    fs.writeFileSync(pidFilePath(dir), JSON.stringify(rec));
    const gone = platform("win32", null);
    expect(sweepStaleHelper(dir, gone)).toMatchObject({ killed: false, reason: "process is gone" });
  });

  it("never kills a helper that belongs to this very app instance", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-pid-"));
    writePidFile(dir, 999999);
    const p = platform("win32", "flextext-helper.exe");
    expect(sweepStaleHelper(dir, p).killed).toBe(false);
  });

  it("handles a missing or corrupt file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-pid-"));
    expect(sweepStaleHelper(dir, platform("win32", null)).reason).toBe("no pid file");
    fs.writeFileSync(pidFilePath(dir), "garbage");
    expect(sweepStaleHelper(dir, platform("win32", null)).reason).toBe("no pid file");
  });
});

describe("locateHelper", () => {
  it("prefers FLEXTEXT_HELPER_CMD", () => {
    const c = locateHelper({
      isPackaged: false,
      resourcesPath: "/nowhere",
      appPath: "/repo",
      env: { FLEXTEXT_HELPER_CMD: "python -m flextext_helper --adapter fake" },
      platform: "linux"
    })!;
    expect(c.command).toBe("python");
    expect(c.args).toEqual(["-m", "flextext_helper", "--adapter", "fake"]);
    expect(c.cwd).toBe(path.join("/repo", "helper"));
  });

  it("finds the packaged exe under resources", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ft-res-"));
    const exe = path.join(tmp, "flextext-helper", "flextext-helper.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    const c = locateHelper({ isPackaged: true, resourcesPath: tmp, appPath: "/x", env: {}, platform: "win32" })!;
    expect(c.command).toBe(exe);
    expect(c.cwd).toBe(path.dirname(exe));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("falls back to python from source in development, else null", () => {
    const repo = path.resolve(__dirname, "../..");
    const dev = locateHelper({ isPackaged: false, resourcesPath: "/nowhere", appPath: repo, env: {}, platform: "linux" })!;
    expect(dev.args).toEqual(["-m", "flextext_helper"]);
    const none = locateHelper({ isPackaged: true, resourcesPath: "/nowhere", appPath: "/nowhere", env: {}, platform: "win32" });
    expect(none).toBeNull();
    expect(parseCommandLine("  a  b ")).toEqual({ command: "a", args: ["b"] });
  });
});
