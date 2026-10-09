// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Prints the electron-builder configuration exactly as electron-builder merges it from
// electron-builder.flextext.json5 (which `extends` upstream's electron-builder.json5), as JSON on
// stdout. Used by src/flextext/builderConfig.spec.ts and handy in CI logs:
//
//   node scripts/flextext/print-builder-config.js [path/to/config.json5]

const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const configPath = path.resolve(
  process.argv[2] || path.join(repoRoot, "electron-builder.flextext.json5")
);

// app-builder-lib logs through builder-util; keep stdout clean for the JSON.
const { getConfig } = require("app-builder-lib/out/util/config/config");

// builder-util's "loaded configuration" lines go to stdout too, so the JSON follows a marker.
const MARKER = "---MERGED-CONFIG-JSON---";

getConfig(repoRoot, configPath, null)
  .then((config) => {
    process.stdout.write(MARKER + "\n" + JSON.stringify(config, null, 2) + "\n");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
