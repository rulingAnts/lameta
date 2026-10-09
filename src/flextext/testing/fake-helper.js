// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// A fake helper for the HelperClient tests: a node script speaking the same newline-delimited
// JSON-RPC 2.0 as helper/flextext_helper. It answers ping, echo, sleep (cancellable), crash,
// garbage, shutdown, and honours stdin EOF. It also writes a line to stderr at start.
//
//   node fake-helper.js [--parent-pid N] [--exit-on-start CODE] [--ignore-shutdown]

const readline = require("readline");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

if (has("--exit-on-start")) {
  process.exit(Number(flag("--exit-on-start")) || 1);
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
process.stderr.write(`fake helper starting pid=${process.pid} args=${args.join(" ")}\n`);

const sleepers = new Map(); // id -> timeout
const ignoreShutdown = has("--ignore-shutdown");

out({
  jsonrpc: "2.0",
  method: "ready",
  params: { pid: process.pid, methods: ["ping", "echo", "sleep", "crash", "garbage", "cancel", "shutdown"] }
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const { id, method, params } = req;
  switch (method) {
    case "ping":
      out({ jsonrpc: "2.0", id, result: "pong" });
      break;
    case "echo":
      out({ jsonrpc: "2.0", id, result: params });
      break;
    case "args":
      out({ jsonrpc: "2.0", id, result: args });
      break;
    case "notify":
      out({ jsonrpc: "2.0", method: "progress", params: { id, done: 1, total: 2 } });
      out({ jsonrpc: "2.0", id, result: "notified" });
      break;
    case "sleep": {
      const t = setTimeout(() => {
        sleepers.delete(id);
        out({ jsonrpc: "2.0", id, result: "slept" });
      }, (params && params.ms) || 1000);
      sleepers.set(id, t);
      break;
    }
    case "cancel": {
      const target = params && params.id;
      const t = sleepers.get(target);
      if (t) {
        clearTimeout(t);
        sleepers.delete(target);
        out({ jsonrpc: "2.0", id: target, error: { code: -32001, message: "cancelled" } });
        out({ jsonrpc: "2.0", id, result: true });
      } else {
        out({ jsonrpc: "2.0", id, result: false });
      }
      break;
    }
    case "garbage":
      process.stdout.write("this is not json\n");
      out({ jsonrpc: "2.0", id, result: "after garbage" });
      break;
    case "crash":
      process.stderr.write("fake helper crashing on request\n");
      process.exit(3);
      break;
    case "shutdown":
      out({ jsonrpc: "2.0", id, result: true });
      if (!ignoreShutdown) process.exit(0);
      break;
    default:
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
});
rl.on("close", () => {
  if (!ignoreShutdown) process.exit(0);
});
if (ignoreShutdown) {
  // a misbehaving helper: stays alive after stdin EOF, so the client's kill() path is exercised
  setInterval(() => {}, 1000);
}

const parentPid = Number(flag("--parent-pid"));
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 200).unref();
}
