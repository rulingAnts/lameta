// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The footprint check: this fork may touch upstream lameta files only through registered seams
// (CLAUDE.md, "STAY MERGEABLE WITH UPSTREAM"). It fails the build when a FLEXTEXT-SEAM marker is
// unregistered, when a registered seam is gone (lost in a merge), or when an upstream file is
// changed without being registered. It skips, loudly, when `upstream/V3` has not been fetched.

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  FORK_OWNED_PREFIXES,
  FORK_OWNED_FILES,
  isForkOwned,
  parseSeamsRegistry,
  findSeamMarkers
} from "./footprint";

const repoRoot = path.resolve(__dirname, "../..");
const UPSTREAM_REF = "upstream/V3";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function upstreamIsAvailable(): boolean {
  try {
    git("rev-parse", "--verify", "--quiet", `${UPSTREAM_REF}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Every tracked or untracked (not ignored) file, repo-relative with forward slashes. */
function listTreeFiles(): string[] {
  const tracked = git("ls-files", "-z").split("\0");
  const untracked = git("ls-files", "-z", "--others", "--exclude-standard").split(
    "\0"
  );
  return [...tracked, ...untracked].filter((f) => f.length > 0);
}

const registry = parseSeamsRegistry(
  fs.readFileSync(path.join(__dirname, "SEAMS.md"), "utf8")
);

describe("fork footprint: seams registry", () => {
  it("SEAMS.md has at least the boot seam", () => {
    expect(registry.map((s) => s.name)).toContain("boot");
  });

  it("every FLEXTEXT-SEAM marker in the tree is registered in SEAMS.md", () => {
    const markers = findSeamMarkers(repoRoot, listTreeFiles());
    const registered = new Set(
      registry.map((s) => `${s.file}::${s.name}`)
    );
    const unregistered = markers.filter(
      (m) => !registered.has(`${m.file}::${m.name}`)
    );
    expect(
      unregistered,
      `Unregistered FLEXTEXT-SEAM markers (add them to src/flextext/SEAMS.md): ${JSON.stringify(
        unregistered
      )}`
    ).toEqual([]);
  });

  it("every seam registered in SEAMS.md still exists in its file", () => {
    const markers = findSeamMarkers(repoRoot, listTreeFiles());
    const present = new Set(markers.map((m) => `${m.file}::${m.name}`));
    const lost = registry
      .filter((s) => s.name !== "-")
      .filter((s) => !present.has(`${s.file}::${s.name}`));
    expect(
      lost,
      `Seams listed in SEAMS.md but missing from the tree (lost in a merge? re-apply them): ${JSON.stringify(
        lost
      )}`
    ).toEqual([]);
  });

  it("files registered with no marker exist", () => {
    for (const s of registry.filter((s) => s.name === "-")) {
      expect(fs.existsSync(path.join(repoRoot, s.file)), s.file).toBe(true);
    }
  });

  it("seams are not in fork-owned territory (those need no registration)", () => {
    const inside = registry.filter((s) => isForkOwned(s.file));
    expect(inside).toEqual([]);
  });
});

describe("fork footprint: upstream files changed vs upstream/V3", () => {
  if (!upstreamIsAvailable()) {
    it.skip(`SKIPPED: ${UPSTREAM_REF} is not fetched. Run: git remote add upstream https://github.com/onset/lameta.git && git fetch --no-tags upstream V3`, () => {});
    return;
  }

  it("every changed or added upstream file is a registered seam", () => {
    // Committed changes since the fork point, plus whatever is in the working tree.
    const committed = git(
      "diff",
      "--name-only",
      `${UPSTREAM_REF}...HEAD`
    ).split("\n");
    const workingTree = git("diff", "--name-only", UPSTREAM_REF).split("\n");
    const untracked = git(
      "ls-files",
      "--others",
      "--exclude-standard"
    ).split("\n");
    const changed = Array.from(
      new Set([...committed, ...workingTree, ...untracked])
    )
      .filter((f) => f.length > 0)
      .filter((f) => !isForkOwned(f))
      .sort();
    const registeredFiles = new Set(registry.map((s) => s.file));
    const unregistered = changed.filter((f) => !registeredFiles.has(f));
    expect(
      unregistered,
      `Upstream files changed without a registered seam (register them in src/flextext/SEAMS.md, or move the change into fork-owned territory): ${JSON.stringify(
        unregistered
      )}`
    ).toEqual([]);
  });

  it("package.json and electron-builder.json5 are byte-identical to upstream", () => {
    for (const f of ["package.json", "electron-builder.json5"]) {
      const upstream = git("show", `${UPSTREAM_REF}:${f}`);
      const ours = fs.readFileSync(path.join(repoRoot, f), "utf8");
      expect(ours === upstream, `${f} differs from ${UPSTREAM_REF}`).toBe(true);
    }
  });
});

describe("fork footprint: territory definition", () => {
  it("recognises fork-owned paths", () => {
    expect(isForkOwned("src/flextext/boot.ts")).toBe(true);
    expect(isForkOwned("helper/flextext_helper/server.py")).toBe(true);
    expect(isForkOwned("docs/flextext-metadata/PLAN.md")).toBe(true);
    expect(isForkOwned("scripts/flextext/build-win.sh")).toBe(true);
    expect(isForkOwned(".github/workflows/flextext-metadata-windows.yml")).toBe(
      true
    );
    expect(isForkOwned("electron-builder.flextext.json5")).toBe(true);
    expect(isForkOwned("CLAUDE.md")).toBe(true);
  });
  it("recognises upstream paths", () => {
    expect(isForkOwned("src/mainProcess/main.ts")).toBe(false);
    expect(isForkOwned("package.json")).toBe(false);
    expect(isForkOwned(".github/workflows/main.yml")).toBe(false);
    expect(isForkOwned("src/flextextual/x.ts")).toBe(false);
  });
  it("exports the territory for the docs", () => {
    expect(FORK_OWNED_PREFIXES.length).toBeGreaterThan(3);
    expect(FORK_OWNED_FILES).toContain("CLAUDE.md");
  });
});
