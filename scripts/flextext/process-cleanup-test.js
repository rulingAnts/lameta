// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The §1.9 regression test (PLAN.md): kill the parent abruptly, then assert the helper and
// rclone are gone within 5 seconds. Runs with the fake flexicon, so it needs no FieldWorks.
//
//   node scripts/flextext/process-cleanup-test.js --helper "<command to start the helper>" \
//        [--rclone <path to rclone>] [--cwd <dir>] [--timeout-ms 5000]
//
// e.g. on Windows CI:  --helper helper/dist/flextext-helper/flextext-helper.exe --rclone helper/third_party/rclone/rclone.exe
//      on Linux:       --helper "python3 -m flextext_helper" --cwd helper --rclone /path/to/rclone
//
// How it works: this script starts a stand-in for Electron (itself, with --role parent), which
// spawns the helper exactly as the app does (shell:false, windowsHide:true, not detached, with
// --parent-pid), asks it to start rclone (backupConfigure with placeholder settings: rclone rcd
// starts without contacting any server), and prints both PIDs. The test then kills ONLY the
// parent, hard (SIGKILL / taskkill without /T), and polls for the two PIDs to disappear.
//
// On Windows the Job Object in the helper is what makes rclone die; the parent-PID watchdog is
// what makes the helper die. Off Windows the watchdog handles both (the helper's shutdown hook
// stops rclone before it exits).

const { spawn, execFileSync } = require("child_process");
const readline = require("readline");

function parseArgs(argv) {
  const out = { timeoutMs: 5000, role: "test" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--helper") out.helper = argv[++i];
    else if (a === "--rclone") out.rclone = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--role") out.role = argv[++i];
  }
  return out;
}

function pidAlive(pid) {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true
      });
      return new RegExp(`^"[^"]+","${pid}"`, "m").test(out);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function hardKill(pid) {
  if (process.platform === "win32") {
    // no /T: only the parent dies; the children must go on their own
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- the stand-in parent

async function runParent(opts) {
  const parts = opts.helper.trim().split(/\s+/);
  const env = { ...process.env, FLEXTEXT_FLEX_ADAPTER: "fake" };
  if (opts.rclone) env.FLEXTEXT_RCLONE = opts.rclone;
  if (!parts[0].includes("flextext_helper") && parts.includes("-m")) env.PYTHONPATH = opts.cwd || process.cwd();
  const child = spawn(parts[0], [...parts.slice(1), "--parent-pid", String(process.pid)], {
    cwd: opts.cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", (d) => process.stderr.write(`[helper] ${d}`));
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 20000);
    });
  const ready = new Promise((resolve) => {
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method === "ready") resolve(msg.params);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  });
  const params = await ready;
  let rclonePid = null;
  if (opts.rclone) {
    const r = await call("backupConfigure", {
      endpoint: "http://127.0.0.1:9",
      region: "",
      bucket: "placeholder",
      prefix: "",
      accessKeyId: "placeholder",
      secretAccessKey: "placeholder"
    });
    rclonePid = r.rclonePid;
  }
  process.stdout.write(JSON.stringify({ helperPid: params.pid, rclonePid }) + "\n");
  // stay alive until killed
  setInterval(() => {}, 1000);
}

// ---------------------------------------------------------------- the test

async function runTest(opts) {
  if (!opts.helper) {
    console.error("usage: --helper <command> [--rclone <path>] [--cwd <dir>]");
    process.exit(2);
  }
  const args = [__filename, "--role", "parent", "--helper", opts.helper];
  if (opts.rclone) args.push("--rclone", opts.rclone);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  const parent = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  const info = await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: parent.stdout });
    rl.on("line", (line) => {
      try {
        resolve(JSON.parse(line));
      } catch {
        /* not ours */
      }
    });
    parent.on("exit", (code) => reject(new Error(`parent exited early with ${code}`)));
    setTimeout(() => reject(new Error("parent did not report pids in time")), 60000);
  });
  console.log(`parent=${parent.pid} helper=${info.helperPid} rclone=${info.rclonePid}`);
  const watched = [["helper", info.helperPid], ["rclone", info.rclonePid]].filter(([, p]) => p);
  for (const [name, pid] of watched) {
    if (!pidAlive(pid)) throw new Error(`${name} (${pid}) is not running before the kill`);
  }
  await sleep(300);
  hardKill(parent.pid);
  const t0 = Date.now();
  const deadline = t0 + opts.timeoutMs;
  let alive = watched.slice();
  while (alive.length && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter(([, pid]) => pidAlive(pid));
  }
  const elapsed = Date.now() - t0;
  if (alive.length) {
    for (const [name, pid] of alive) {
      console.error(`FAIL: ${name} (${pid}) still alive ${elapsed} ms after the parent was killed`);
      try {
        hardKill(pid);
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  }
  console.log(`OK: ${watched.map(([n]) => n).join(" and ")} gone ${elapsed} ms after the parent was killed`);
}

const opts = parseArgs(process.argv.slice(2));
(opts.role === "parent" ? runParent(opts) : runTest(opts)).catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
