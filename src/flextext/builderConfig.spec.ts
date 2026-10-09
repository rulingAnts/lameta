// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Pins the rebrand-by-override: electron-builder.flextext.json5 `extends` upstream's config, and
// the merge electron-builder actually performs yields the fork's identity while keeping
// upstream's file lists. Uses app-builder-lib's own loader, so a change in how `extends` merges
// shows up here rather than in a broken installer.

import { describe, it, expect } from "vitest";
import * as path from "path";
import { execFileSync } from "child_process";
import { APP_ID, APP_NAME } from "./branding/brand";

const repoRoot = path.resolve(__dirname, "../..");

// The merge runs in a plain node process (scripts/flextext/print-builder-config.js), outside the
// happy-dom test environment, exactly as `electron-builder --config` would do it.
let merged: any;
async function loadMerged(): Promise<any> {
  if (!merged) {
    const out = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/flextext/print-builder-config.js")],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const marker = "---MERGED-CONFIG-JSON---\n";
    merged = JSON.parse(out.slice(out.indexOf(marker) + marker.length));
  }
  return merged;
}

describe("electron-builder.flextext.json5 (extends upstream's electron-builder.json5)", () => {
  it("overrides the identity and never publishes", async () => {
    const c = await loadMerged();
    expect(c.productName).toBe(APP_NAME);
    expect(c.productName).toBe("FlexText Metadata");
    expect(c.appId).toBe(APP_ID);
    expect(c.appId).toBe("app.flextext.metadata");
    expect(c.publish).toBeNull();
  });

  it("targets Windows x64 nsis only (win.target string replaced by the object form)", async () => {
    const c = await loadMerged();
    expect(c.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(c.win.icon).toBe("build/windows.ico");
  });

  it("keeps upstream's files list (file sets merge under extends) and adds the exclusions", async () => {
    const c = await loadMerged();
    // electron-builder normalises `files` into file sets ({from, to, filter[]}) and merges the
    // filters of similar sets, so flatten them back to the plain patterns.
    const files: string[] = (c.files as any[]).flatMap((f) =>
      typeof f === "string" ? [f] : f.filter ?? []
    );
    const froms = (c.files as any[])
      .filter((f) => typeof f !== "string" && f.from)
      .map((f) => `${f.from}->${f.to}`);
    expect(froms).toContain("assets/->dist/assets");
    expect(files).toContain("dist/");
    expect(files).toContain("locale/");
    expect(files).toContain("archive-configurations/");
    expect(files).toContain("!helper/");
    expect(files).toContain("!docs/flextext-metadata/");
  });

  it("ships the helper, rclone and the third-party notices as extra resources", async () => {
    const c = await loadMerged();
    const tos = c.extraResources.map((r: any) => r.to);
    expect(tos).toEqual(
      expect.arrayContaining(["flextext-helper", "rclone", "THIRD-PARTY-NOTICES"])
    );
    const helper = c.extraResources.find((r: any) => r.to === "flextext-helper");
    expect(helper.from).toBe("helper/dist/flextext-helper");
  });

  it("keeps upstream's directories and nsis artifact naming", async () => {
    const c = await loadMerged();
    expect(c.directories.output).toBe("release");
    expect(c.nsis.artifactName).toBe(
      "${productName} Windows Setup ${version}.${ext}"
    );
    expect(c.nsis.shortcutName).toBe("FlexText Metadata");
  });
});
