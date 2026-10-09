// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Watches `<project>/Sessions/` so that session folders written by the lameta-device agent while
// the fork has the project open are loaded live (PLAN §5): a new folder with a `.session` file
// is reported at once; a changed `.session` is reported unless that session is being edited, in
// which case it waits until it no longer is. fs.watch gives the prompt signal; a periodic rescan
// covers the platforms and cases where fs.watch is unreliable. Nothing here knows about lameta's
// model: projectHooks.ts turns the reports into Session objects.

import * as fs from "fs";
import * as path from "path";

export interface SessionsWatcherCallbacks {
  /** A session folder that was not there before and now holds a .session file. */
  onNewSession(sessionDir: string): void;
  /** The .session file of a known folder changed on disk (and the session is not being edited). */
  onSessionChanged(sessionDir: string): void;
  /** True while the user has that session open for editing: changes are deferred. */
  isBeingEdited(sessionDir: string): boolean;
  onError?(e: Error): void;
}

export interface SessionsWatcherOptions {
  /** Rescan period; the safety net behind fs.watch. */
  pollMs?: number;
  /** Debounce for fs.watch bursts. */
  debounceMs?: number;
}

interface Snapshot {
  mtimeMs: number;
  file: string;
}

/** The .session file in a session folder, or null. */
export function findSessionFile(sessionDir: string): string | null {
  try {
    const names = fs.readdirSync(sessionDir).filter((n) => n.toLowerCase().endsWith(".session"));
    if (!names.length) return null;
    // prefer the one named after the folder, as lameta writes it
    const base = path.basename(sessionDir).toLowerCase() + ".session";
    const chosen = names.find((n) => n.toLowerCase() === base) ?? names.sort()[0];
    return path.join(sessionDir, chosen);
  } catch {
    return null;
  }
}

export function scanSessions(sessionsDir: string): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(sessionsDir, e.name);
    const file = findSessionFile(dir);
    if (!file) continue;
    try {
      out.set(dir, { mtimeMs: fs.statSync(file).mtimeMs, file });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out;
}

export class SessionsWatcher {
  private snapshot = new Map<string, Snapshot>();
  private watchers = new Map<string, fs.FSWatcher>();
  private rootWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deferred = new Set<string>();
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private running = false;

  constructor(
    public readonly sessionsDir: string,
    private readonly callbacks: SessionsWatcherCallbacks,
    options: SessionsWatcherOptions = {}
  ) {
    this.pollMs = options.pollMs ?? 5000;
    this.debounceMs = options.debounceMs ?? 300;
  }

  /** Takes the current state as the baseline (nothing is reported for what exists now). */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.snapshot = scanSessions(this.sessionsDir);
    for (const dir of this.snapshot.keys()) this.watchDir(dir);
    this.rootWatcher = this.tryWatch(this.sessionsDir);
    this.pollTimer = setInterval(() => this.tick(), this.pollMs);
    (this.pollTimer as any).unref?.();
  }

  public stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.rootWatcher?.close();
    this.rootWatcher = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.deferred.clear();
  }

  /** Tells the watcher that we wrote this session ourselves: the current disk state is taken as known. */
  public acknowledge(sessionDir: string): void {
    const file = findSessionFile(sessionDir);
    if (!file) return;
    try {
      this.snapshot.set(sessionDir, { mtimeMs: fs.statSync(file).mtimeMs, file });
    } catch {
      /* ignore */
    }
  }

  private tryWatch(dir: string): fs.FSWatcher | null {
    try {
      const w = fs.watch(dir, { persistent: false }, () => this.schedule());
      w.on("error", () => {
        /* the poll covers it */
      });
      return w;
    } catch {
      return null;
    }
  }

  private watchDir(dir: string): void {
    if (this.watchers.has(dir)) return;
    const w = this.tryWatch(dir);
    if (w) this.watchers.set(dir, w);
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tick();
    }, this.debounceMs);
  }

  /** One rescan: diff against the snapshot and report. Public for tests. */
  public tick(): void {
    if (!this.running) return;
    let current: Map<string, Snapshot>;
    try {
      current = scanSessions(this.sessionsDir);
    } catch (e) {
      this.callbacks.onError?.(e as Error);
      return;
    }
    for (const [dir, snap] of current) {
      const known = this.snapshot.get(dir);
      if (!known) {
        this.snapshot.set(dir, snap);
        this.watchDir(dir);
        this.report(() => this.callbacks.onNewSession(dir));
        continue;
      }
      if (snap.mtimeMs !== known.mtimeMs || snap.file !== known.file) {
        if (this.callbacks.isBeingEdited(dir)) {
          this.deferred.add(dir); // keep the old snapshot: it stays "changed"
          continue;
        }
        this.snapshot.set(dir, snap);
        this.deferred.delete(dir);
        this.report(() => this.callbacks.onSessionChanged(dir));
      } else if (this.deferred.has(dir) && !this.callbacks.isBeingEdited(dir)) {
        this.deferred.delete(dir);
      }
    }
    for (const dir of [...this.snapshot.keys()]) {
      if (!current.has(dir)) {
        // removed: forget it (lameta's own deletes go through its UI; nothing to load)
        this.snapshot.delete(dir);
        this.watchers.get(dir)?.close();
        this.watchers.delete(dir);
        this.deferred.delete(dir);
      }
    }
  }

  private report(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.callbacks.onError?.(e as Error);
    }
  }

  public get pendingDeferred(): string[] {
    return [...this.deferred];
  }
}
