// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The boot seam. This module is the FIRST import of src/mainProcess/main.ts
// (`// FLEXTEXT-SEAM: boot`), so it runs before anything in the main process reads the app name
// or the userData path (electron-store's `Store.initRenderer()`, `app.setAppUserModelId`, ...).
//
// It does three things and nothing else:
//   1. names the app and gives it its own userData directory (bootLogic.configureApp);
//   2. pins the window title "FlexText Metadata (for lameta)" on every window;
//   3. starts the fork's main-process services (IPC handlers, the helper) once the app is ready.
//
// Only this file and ./main/** are compiled into the main-process bundle
// (vite.config.ts, `// FLEXTEXT-SEAM: main-build-include`).

import { app } from "electron";
import { brandWindow, configureApp } from "./main/bootLogic";
import { registerFlextextMain } from "./main/registerMain";

const booted = configureApp(app);
console.log(`[flextext] ${booted.name}: userData=${booted.userData}`);

app.on("browser-window-created", (_event, win) => brandWindow(win));

registerFlextextMain();
