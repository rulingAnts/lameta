// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The JSON-RPC 2.0 client for the ONE long-lived helper process (PLAN §1). Main process only.
//
// - spawn: shell:false, windowsHide:true, not detached; stdin/stdout are the protocol, stderr is
//   drained into a ring buffer and the log;
// - one request per line, one response per line; per-call timeouts; cancel is a message;
// - restart with backoff when the helper dies; pending calls are rejected, never retried
//   silently (a FLEx read that died half-way is the caller's to repeat);
// - quit: a `shutdown` request, 3 s, then kill() of that ONE process.
//
// No Electron import here, so it is unit-tested against a fake helper script (vitest).

import { ChildProcess, spawn, SpawnOptions } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";

export interface HelperCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface HelperClientOptions {
  /** How to start the helper (found by locateHelper.ts in the app; a node script in tests). */
  command: HelperCommand;
  /** Default per-call timeout. */
  callTimeoutMs?: number;
  /** Backoff for restarts, in ms: first, then doubling up to the last. */
  restartBackoffMs?: number[];
  /** Give up restarting after this many consecutive failures (0 = never). */
  maxRestarts?: number;
  /** Grace after `shutdown` before kill(). */
  shutdownGraceMs?: number;
  /** Called with every stderr line. */
  log?: (line: string) => void;
  /** Extra args appended on every spawn, e.g. ["--parent-pid", String(process.pid)]. */
  extraArgs?: string[];
}

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class HelperRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "HelperRpcError";
  }
}

export class HelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperUnavailableError";
  }
}

/** Error codes the helper uses (helper/flextext_helper/jsonrpc.py). */
export const HelperErrorCodes = {
  CANCELLED: -32001,
  SHUTTING_DOWN: -32002,
  FLEX_LOCKED: -32010,
  FLEX_MIGRATION_REQUIRED: -32011,
  FLEX_NOT_INSTALLED: -32012,
  FLEX_NO_PROJECT_OPEN: -32013,
  FLEX_NOT_FOUND: -32014,
  RCLONE_NOT_RUNNING: -32020,
  RCLONE_ERROR: -32021
} as const;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export type HelperState = "stopped" | "starting" | "ready" | "restarting" | "failed";

export interface HelperStatus {
  state: HelperState;
  pid: number | null;
  restarts: number;
  methods: string[];
  lastExit: { code: number | null; signal: string | null } | null;
  recentStderr: string[];
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

export class HelperClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private state: HelperState = "stopped";
  private restarts = 0;
  private consecutiveFailures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readyMethods: string[] = [];
  private lastExit: HelperStatus["lastExit"] = null;
  private stderrRing: string[] = [];
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  private readonly opts: Required<
    Omit<HelperClientOptions, "log" | "extraArgs">
  > & { log: (line: string) => void; extraArgs: string[] };

  constructor(options: HelperClientOptions) {
    super();
    this.opts = {
      command: options.command,
      callTimeoutMs: options.callTimeoutMs ?? 30_000,
      restartBackoffMs: options.restartBackoffMs ?? DEFAULT_BACKOFF,
      maxRestarts: options.maxRestarts ?? 0,
      shutdownGraceMs: options.shutdownGraceMs ?? 3000,
      log: options.log ?? ((line) => console.error(`[flextext-helper] ${line}`)),
      extraArgs: options.extraArgs ?? []
    };
  }

  // -- lifecycle -------------------------------------------------------------------------

  /** Starts the helper. Resolves when it has sent its `ready` notification. */
  public start(): Promise<void> {
    this.stopping = false;
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "stopped" || this.state === "failed") {
      this.spawnChild();
    }
    return this.waitReady();
  }

  private waitReady(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.readyWaiters.push({ resolve, reject })
    );
  }

  private spawnChild(): void {
    this.state = "starting";
    const { command, args, cwd, env } = this.opts.command;
    const spawnOptions: SpawnOptions = {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      shell: false, // a killed cmd.exe wrapper is how grandchildren get orphaned
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"]
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [...args, ...this.opts.extraArgs], spawnOptions);
    } catch (e) {
      this.onChildGone(null, null, e as Error);
      return;
    }
    this.child = child;
    this.emit("spawn", child.pid);

    child.on("error", (err) => {
      this.opts.log(`spawn error: ${err.message}`);
      this.onChildGone(null, null, err);
    });
    child.on("exit", (code, signal) => this.onChildGone(code, signal));

    readline
      .createInterface({ input: child.stdout!, crlfDelay: Infinity })
      .on("line", (line) => this.onStdoutLine(line));
    readline
      .createInterface({ input: child.stderr!, crlfDelay: Infinity })
      .on("line", (line) => {
        this.stderrRing.push(line);
        if (this.stderrRing.length > 200) this.stderrRing.shift();
        this.opts.log(line);
      });
    child.stdin!.on("error", (err) => this.opts.log(`stdin error: ${err.message}`));
  }

  private onChildGone(
    code: number | null,
    signal: NodeJS.Signals | null,
    err?: Error
  ): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null && !err) {
      // 'exit' not yet; ignore (should not happen)
    }
    const wasReady = this.state === "ready";
    this.child = null;
    this.lastExit = { code, signal };
    const reason = err
      ? err.message
      : `exited code=${code} signal=${signal}`;
    this.rejectAllPending(new HelperUnavailableError(`helper ${reason}`));
    this.emit("exit", { code, signal, error: err });

    if (this.stopping) {
      this.state = "stopped";
      this.failReadyWaiters(new HelperUnavailableError("helper stopped"));
      return;
    }
    if (wasReady) this.consecutiveFailures = 0;
    this.consecutiveFailures++;
    if (
      this.opts.maxRestarts > 0 &&
      this.consecutiveFailures > this.opts.maxRestarts
    ) {
      this.state = "failed";
      this.failReadyWaiters(
        new HelperUnavailableError(`helper failed ${this.consecutiveFailures} times; giving up`)
      );
      this.emit("failed");
      return;
    }
    const backoff = this.opts.restartBackoffMs;
    const delay =
      backoff[Math.min(this.consecutiveFailures - 1, backoff.length - 1)];
    this.state = "restarting";
    this.restarts++;
    this.emit("restarting", { delay, attempt: this.consecutiveFailures });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnChild();
    }, delay);
  }

  /** Orderly stop: `shutdown`, wait up to the grace period, then kill(). */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      this.failReadyWaiters(new HelperUnavailableError("helper stopped"));
      return;
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    try {
      this.writeLine({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown" });
    } catch {
      /* already gone */
    }
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), this.opts.shutdownGraceMs)
    );
    const outcome = await Promise.race([exited.then(() => "exited"), timeout]);
    if (outcome === "timeout") {
      this.opts.log("helper did not exit after shutdown; killing");
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
    this.state = "stopped";
  }

  // -- calls -----------------------------------------------------------------------------

  public async call<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.state !== "ready") {
      if (this.state === "stopped" || this.state === "failed") {
        if (this.stopping || this.state === "failed") {
          throw new HelperUnavailableError(`helper is ${this.state}`);
        }
        this.spawnChild();
      }
      await this.waitReady();
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.opts.callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.cancel(id).catch(() => {});
        reject(
          new HelperRpcError(
            HelperErrorCodes.CANCELLED,
            `helper call ${method} timed out after ${timeoutMs} ms`
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      });
      try {
        this.writeLine({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperUnavailableError(`cannot write to helper: ${(e as Error).message}`));
      }
    });
  }

  /** Cancel by message (never a kill). Resolves to the helper's answer, or false if it is gone. */
  public async cancel(id: number): Promise<boolean> {
    if (!this.child || this.state !== "ready") return false;
    try {
      return (await this.call<boolean>("cancel", { id }, { timeoutMs: 5000 })) === true;
    } catch {
      return false;
    }
  }

  public status(): HelperStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      methods: [...this.readyMethods],
      lastExit: this.lastExit,
      recentStderr: [...this.stderrRing]
    };
  }

  public get pid(): number | null {
    return this.child?.pid ?? null;
  }

  // -- protocol --------------------------------------------------------------------------

  private writeLine(msg: object): void {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("helper stdin is closed");
    }
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onStdoutLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log(`non-JSON on stdout (ignored): ${line.slice(0, 200)}`);
      return;
    }
    if (msg && typeof msg === "object" && "method" in msg && !("id" in msg)) {
      if (msg.method === "ready") {
        this.readyMethods = msg.params?.methods ?? [];
        this.state = "ready";
        this.consecutiveFailures = 0;
        const waiters = this.readyWaiters.splice(0);
        waiters.forEach((w) => w.resolve());
        this.emit("ready", msg.params);
        return;
      }
      this.emit("notification", msg.method, msg.params);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // late reply to a timed-out or cancelled call
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if ("error" in msg && msg.error) {
      const e = msg.error as RpcErrorShape;
      p.reject(new HelperRpcError(e.code, e.message, e.data));
    } else {
      p.resolve(msg.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private failReadyWaiters(err: Error): void {
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach((w) => w.reject(err));
  }
}
