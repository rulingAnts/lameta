// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Pure helpers for the footprint check (footprint.spec.ts): the fork-owned territory, the
// SEAMS.md parser and the FLEXTEXT-SEAM marker scanner.

import * as fs from "fs";
import * as path from "path";

/** Directories (with trailing slash) that belong to the fork: edit freely, no registration. */
export const FORK_OWNED_PREFIXES: readonly string[] = [
  "src/flextext/",
  "helper/",
  "docs/flextext-metadata/",
  "scripts/flextext/",
  ".github/workflows/flextext-metadata-",
  "ci/flextext-metadata-"
];

/** Single files that belong to the fork. */
export const FORK_OWNED_FILES: readonly string[] = [
  "CLAUDE.md",
  "electron-builder.flextext.json5"
];

export function isForkOwned(repoRelativePath: string): boolean {
  const p = repoRelativePath.replace(/\\/g, "/");
  if (FORK_OWNED_FILES.includes(p)) return true;
  return FORK_OWNED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export interface SeamEntry {
  file: string;
  name: string; // "-" means the file is registered without a marker
  purpose: string;
  reapply: string;
}

/**
 * Parses the table in SEAMS.md. A row is `| \`file\` | \`name\` | purpose | re-apply |`.
 * Rows whose first cell is not a back-ticked path (the header, the separator) are ignored.
 */
export function parseSeamsRegistry(markdown: string): SeamEntry[] {
  const out: SeamEntry[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cells = splitTableRow(line);
    if (cells.length < 4) continue;
    const file = unticked(cells[0]);
    const name = unticked(cells[1]);
    if (!file || !name) continue;
    out.push({ file, name, purpose: cells[2], reapply: cells[3] });
  }
  return out;
}

function splitTableRow(line: string): string[] {
  // strip the leading and trailing pipe, then split on pipes that are not escaped
  const inner = line.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function unticked(cell: string): string | undefined {
  const m = /^`([^`]+)`$/.exec(cell);
  return m ? m[1] : undefined;
}

export interface SeamMarker {
  file: string;
  name: string;
  line: number;
}

const MARKER = /FLEXTEXT-SEAM:\s*([A-Za-z0-9_.-]+)/g;
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".json5",
  ".yml",
  ".yaml",
  ".py",
  ".html",
  ".css",
  ".md",
  ".sh",
  ".txt"
]);

/**
 * Finds every FLEXTEXT-SEAM marker in the given repo-relative files, skipping fork-owned
 * territory (where the marker text may appear in documentation) and binary-looking files.
 */
export function findSeamMarkers(
  repoRoot: string,
  repoRelativeFiles: string[]
): SeamMarker[] {
  const found: SeamMarker[] = [];
  for (const rel of repoRelativeFiles) {
    if (isForkOwned(rel)) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(repoRoot, rel);
    let text: string;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("FLEXTEXT-SEAM")) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((lineText, i) => {
      MARKER.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MARKER.exec(lineText)) !== null) {
        found.push({ file: rel, name: m[1], line: i + 1 });
      }
    });
  }
  return found;
}
