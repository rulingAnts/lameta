// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The project-open seam end to end on a temp copy of lameta's own "Edolo sample": the marker
// appears when the project opens, a session folder dropped in by "the agent" becomes a Session,
// a changed .session is reloaded (unless selected), and closing removes the marker.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Project, ProjectHolder } from "../model/Project/Project";
import { Session } from "../model/Project/Session/Session";
import { currentAttachmentForTests, setProjectHooksEnabledForTests } from "./device/projectHooks";
import { openMarkerPath, readOpenMarker } from "./device/openMarker";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-hooks-"));
  fs.copySync(path.resolve("sample data", "Edolo sample"), dir);
  setProjectHooksEnabledForTests(true);
});
afterEach(() => {
  setProjectHooksEnabledForTests(false);
  currentAttachmentForTests()?.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function touchSession(sessionDir: string, mutate: (xml: string) => string) {
  const file = fs.readdirSync(sessionDir).find((n) => n.endsWith(".session"))!;
  const p = path.join(sessionDir, file);
  fs.writeFileSync(p, mutate(fs.readFileSync(p, "utf8")));
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(p, t, t);
}

describe("project-open seam", () => {
  it("writes the marker on open, loads new and changed sessions live, deletes the marker on close", () => {
    const holder = new ProjectHolder();
    const project = Project.fromDirectory(dir);
    expect(project.loadingError).toBeUndefined();
    holder.setProject(project);

    const att = currentAttachmentForTests()!;
    expect(att).not.toBeNull();
    const marker = readOpenMarker(dir)!;
    expect(marker.app).toBe("FlexText Metadata");
    expect(marker.pid).toBe(process.pid);

    const before = project.sessions.items.length;
    expect(before).toBeGreaterThan(0);

    // "the agent" writes a new session folder: copy an existing one under a new id
    const source = project.sessions.items[0].directory;
    const newDir = path.join(dir, "Sessions", "FromPhone");
    fs.copySync(source, newDir);
    for (const n of fs.readdirSync(newDir)) {
      if (n.endsWith(".session")) fs.renameSync(path.join(newDir, n), path.join(newDir, "FromPhone.session"));
    }
    att.watcher.tick();
    expect(project.sessions.items.length).toBe(before + 1);
    const added = project.sessions.items.find((s) => path.basename(s.directory) === "FromPhone") as Session;
    expect(added).toBeDefined();
    expect(added.id).toBe("FromPhone");

    // a change to a session that is NOT selected is reloaded
    project.sessions.selectedIndex = 0;
    touchSession(newDir, (xml) => {
      expect(xml).toMatch(/<title[^>]*>[^<]*<\/title>/i);
      return xml.replace(/<title[^>]*>[^<]*<\/title>/i, '<title type="string">Edited by the agent</title>');
    });
    att.watcher.tick();
    const reloaded = project.sessions.items.find((s) => path.basename(s.directory) === "FromPhone") as Session;
    expect(reloaded).not.toBe(added);
    expect(reloaded.properties.getTextStringOrEmpty("title")).toBe("Edited by the agent");

    // a change to the SELECTED session is deferred
    project.sessions.selectedIndex = project.sessions.items.indexOf(reloaded);
    touchSession(newDir, (xml) => xml.replace("Edited by the agent", "Edited again"));
    att.watcher.tick();
    expect(project.sessions.items.indexOf(reloaded)).toBeGreaterThanOrEqual(0);
    expect(att.watcher.pendingDeferred.length).toBe(1);
    project.sessions.selectedIndex = 0;
    att.watcher.tick();
    const again = project.sessions.items.find((s) => path.basename(s.directory) === "FromPhone") as Session;
    expect(again.properties.getTextStringOrEmpty("title")).toBe("Edited again");

    holder.setProject(null);
    expect(fs.existsSync(openMarkerPath(dir))).toBe(false);
    expect(currentAttachmentForTests()).toBeNull();
  });

  it("is a no-op under vitest unless a test opts in", () => {
    setProjectHooksEnabledForTests(false);
    const holder = new ProjectHolder();
    holder.setProject(Project.fromDirectory(dir));
    expect(fs.existsSync(openMarkerPath(dir))).toBe(false);
    holder.setProject(null);
  });
});
