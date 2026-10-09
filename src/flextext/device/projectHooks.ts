// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Called from the `project-open` seam in src/model/Project/Project.ts (ProjectHolder.setProject):
// when a project opens, write the open marker and watch Sessions/; when it closes, stop both.
// A new session folder written by the lameta-device agent becomes a Session in the list at once;
// a changed .session is reloaded unless it is the one being edited.

import * as fs from "fs";
import * as path from "path";
import { runInAction } from "mobx";
import type { Project } from "../../model/Project/Project";
import { Session } from "../../model/Project/Session/Session";
import { OpenMarker } from "./openMarker";
import { SessionsWatcher } from "./sessionsWatcher";

interface Attached {
  project: Project;
  marker: OpenMarker;
  watcher: SessionsWatcher;
  dispose: () => void;
}

let current: Attached | null = null;

// Upstream's unit tests open projects constantly (some from the repo's own "sample data"); a
// marker written there would dirty the tree, and fs.watch handles would pile up. So under vitest
// the hook is off unless a test opts in.
let enabled = !(process.env.VITEST_POOL_ID && process.env.VITEST_WORKER_ID);
export function setProjectHooksEnabledForTests(value: boolean): void {
  enabled = value;
}

function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function findSessionIndex(project: Project, dir: string): number {
  return project.sessions.items.findIndex((s) => sameDir(s.directory, dir));
}

/** True when the .session on disk already equals what this in-memory session would write
 * (lameta saved it itself): reloading would only churn the UI. */
function diskMatchesMemory(session: Session): boolean {
  try {
    const file = session.metadataFile?.metadataFilePath;
    if (!file || !fs.existsSync(file)) return false;
    const onDisk = fs.readFileSync(file, "utf8").trim();
    const inMemory = session.metadataFile!.getXml().trim();
    return onDisk === inMemory;
  } catch {
    return false;
  }
}

export function attachToProject(project: Project): Attached {
  const marker = new OpenMarker(project.directory);
  const watcher = new SessionsWatcher(path.join(project.directory, "Sessions"), {
    isBeingEdited: (dir) => {
      const sel = project.sessions.selectedIndex;
      const s = sel >= 0 ? project.sessions.items[sel] : undefined;
      return !!s && sameDir(s.directory, dir);
    },
    onNewSession: (dir) => {
      if (findSessionIndex(project, dir) >= 0) return;
      const session = Session.fromDirectory(dir, (project as any).customVocabularies);
      runInAction(() => {
        project.sessions.items.push(session);
      });
      console.log(`[flextext] loaded new session folder: ${path.basename(dir)}`);
    },
    onSessionChanged: (dir) => {
      const index = findSessionIndex(project, dir);
      if (index < 0) {
        const session = Session.fromDirectory(dir, (project as any).customVocabularies);
        runInAction(() => {
          project.sessions.items.push(session);
        });
        return;
      }
      const existing = project.sessions.items[index] as Session;
      if (diskMatchesMemory(existing)) return;
      const fresh = Session.fromDirectory(dir, (project as any).customVocabularies);
      runInAction(() => {
        project.sessions.items[index] = fresh;
      });
      console.log(`[flextext] reloaded changed session: ${path.basename(dir)}`);
    },
    onError: (e) => console.error(`[flextext] sessions watcher: ${e.message}`)
  });

  const dispose = () => {
    watcher.stop();
    marker.stop();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", dispose);
  };
  marker.start();
  watcher.start();
  if (typeof window !== "undefined") window.addEventListener("beforeunload", dispose);
  return { project, marker, watcher, dispose };
}

/** The seam entry point: the project that is now open, or null. */
export function flextextOnProjectChanged(project: Project | null): void {
  if (!enabled) return;
  try {
    if (current) {
      if (project && current.project === project) return;
      current.dispose();
      current = null;
    }
    if (!project || (project as any).loadingError || !project.directory) return;
    current = attachToProject(project);
  } catch (e) {
    console.error(`[flextext] project hook failed: ${(e as Error).message}`);
  }
}

export function currentAttachmentForTests(): Attached | null {
  return current;
}
