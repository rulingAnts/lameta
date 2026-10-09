// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Where the helper is. Packaged: <resources>/flextext-helper/flextext-helper.exe (the PyInstaller
// --onedir output, placed by electron-builder.flextext.json5 extraResources). Development:
// FLEXTEXT_HELPER_CMD, e.g. `python -m flextext_helper`, run in helper/.

import * as fs from "fs";
import * as path from "path";
import { HelperCommand } from "./HelperClient";

export interface LocateInput {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string; // the repo root in development
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/** Splits a simple command line ("python -m flextext_helper"); no quoting support needed. */
export function parseCommandLine(cmd: string): { command: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

export function locateHelper(input: LocateInput): HelperCommand | null {
  const exeName = input.platform === "win32" ? "flextext-helper.exe" : "flextext-helper";
  const override = input.env.FLEXTEXT_HELPER_CMD;
  if (override) {
    const { command, args } = parseCommandLine(override);
    return {
      command,
      args,
      cwd: input.env.FLEXTEXT_HELPER_CWD || path.join(input.appPath, "helper")
    };
  }
  const candidates = [
    path.join(input.resourcesPath, "flextext-helper", exeName),
    path.join(input.appPath, "helper", "dist", "flextext-helper", exeName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { command: c, args: [], cwd: path.dirname(c) };
    }
  }
  if (!input.isPackaged) {
    // development without a built helper: run from source if a python is around
    const python = input.platform === "win32" ? "python" : "python3";
    const src = path.join(input.appPath, "helper", "flextext_helper", "__main__.py");
    if (fs.existsSync(src)) {
      return {
        command: python,
        args: ["-m", "flextext_helper"],
        cwd: path.join(input.appPath, "helper")
      };
    }
  }
  return null;
}
