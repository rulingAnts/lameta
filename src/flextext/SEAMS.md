# Registered seams (FlexText Metadata for lameta)

SPDX-License-Identifier: AGPL-3.0-or-later. Copyright (C) 2026 Seth Johnston.

A **seam** is the only kind of edit this fork makes to an upstream lameta file: one to three lines
that call into `src/flextext/`, marked in the file with `// FLEXTEXT-SEAM: <name>` (`#` in YAML
or Python, `<!-- -->` in HTML). Everything else lives in fork-owned territory (see `CLAUDE.md`).

`src/flextext/footprint.spec.ts` fails when:

- a `FLEXTEXT-SEAM` marker exists in the tree but is not listed here;
- a seam listed here no longer exists in the named file (lost in an upstream merge);
- an upstream file differs from `upstream/V3` (or is new) and is not listed here.

**After an upstream merge:** resolve conflicts in favour of upstream, then re-apply each seam
below from its "Re-apply" column, and run `yarn vitest run src/flextext/footprint.spec.ts`.

The table is parsed by the test. Keep the four columns, the file in back-ticks, and the seam name
in back-ticks. A seam name of `-` registers a file that carries no marker (none so far).

| File | Seam | Purpose | Re-apply |
|---|---|---|---|
| `src/mainProcess/main.ts` | `boot` | Branding and isolation before anything reads `userData`: the FIRST import of the main-process entry. | Add `import "../flextext/boot"; // FLEXTEXT-SEAM: boot` as the first import line (above `import { dialog } from "electron"`). |
| `vite.config.ts` | `main-build-include` | The main-process compiler (vite-electron-plugin) only emits files listed in `include`; this adds the fork's main-process directory. | In `electron({ include: [...] })` add `"src/flextext/main", // FLEXTEXT-SEAM: main-build-include` as the last entry. |
| `src/other/menu.ts` | `help-menu` | Adds "About FlexText Metadata…" to the Help menu (credits lameta and its MIT licence). | In `helpMenu.submenu`, before the `Credits` item, add `...flextextHelpMenuItems(), // FLEXTEXT-SEAM: help-menu` and import `flextextHelpMenuItems` from `../flextext/branding/helpMenu`. |
| `src/other/errorHandling.ts` | `no-sentry` | Telemetry OFF: Sentry is never initialised, so nothing is reported into upstream's account. | First statement of `initializeSentry`: `if (telemetryIsOff()) return; // FLEXTEXT-SEAM: no-sentry`, importing `telemetryIsOff` from `../flextext/quiet`. |
| `src/other/analytics.ts` | `no-segment` | Telemetry OFF: Segment is never initialised. | First statement of `initializeAnalytics`: `if (telemetryIsOff()) return; // FLEXTEXT-SEAM: no-segment`, importing `telemetryIsOff` from `../flextext/quiet`. |
| `src/components/ReleasesDialog.tsx` | `no-update-check` | The fork never asks api.github.com for stock lameta releases, so it never tells users to "update" to stock lameta. | First statement of `checkForUpdates`: `if (updateCheckIsOff()) return; // FLEXTEXT-SEAM: no-update-check`, importing `updateCheckIsOff` from `../flextext/quiet`. |
| `src/components/Workspace.tsx` | `workspace-tabs` | One hook registers every fork tab (Backup, later Checklist) beside Project / Sessions / People. | Import `flextextWorkspaceTabHeaders, flextextWorkspaceTabPanels` from `../flextext/workspaceTabs`; add `{flextextWorkspaceTabHeaders() /* FLEXTEXT-SEAM: workspace-tabs */}` as the last child of `<TabList>`, and `{flextextWorkspaceTabPanels(this.props.project) /* FLEXTEXT-SEAM: workspace-tabs */}` after the People `<TabPanel>`. |
| `src/model/Project/Project.ts` | `project-open` | Device cooperation: the open marker and the Sessions/ watcher start when a project opens and stop when it closes. | In `ProjectHolder.setProject`, after `sCurrentProject = p;` add `flextextOnProjectChanged(p); // FLEXTEXT-SEAM: project-open`, importing it from `../../flextext/device/projectHooks`. |
