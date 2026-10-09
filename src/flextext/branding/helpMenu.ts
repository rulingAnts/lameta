// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Called from the `help-menu` seam in src/other/menu.ts: the fork's own Help items, spread into
// lameta's Help menu ahead of "Credits".

import { ShowAboutDialog } from "./AboutDialog";
import { APP_TITLE } from "./brand";

export function flextextHelpMenuItems(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: `About ${APP_TITLE}...`,
      click: () => ShowAboutDialog()
    },
    { type: "separator" }
  ];
}
