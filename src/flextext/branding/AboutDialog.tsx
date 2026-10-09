// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.

import * as React from "react";
import { ShowMessageDialog } from "../../components/ShowMessageDialog/MessageDialog";
import pkg from "package.json";
import {
  APP_TITLE,
  FLEXTEXT_VERSION,
  FORK_URL,
  UPSTREAM_URL
} from "./brand";

/** The About text, as plain lines, so a test can pin the credit without rendering React. */
export function aboutLines(): string[] {
  return [
    `${APP_TITLE} ${FLEXTEXT_VERSION}`,
    `Built on lameta ${pkg.version}, by the lameta project (John Hatton and contributors), used under the MIT License.`,
    `lameta: ${UPSTREAM_URL}`,
    `This fork: ${FORK_URL}`,
    "Additions in this fork are licensed AGPL-3.0-or-later. FLEx access uses flexicon (LGPL-2.1-or-later); backup uses rclone (MIT). See the Third-party notices in the installation folder."
  ];
}

export function ShowAboutDialog(): void {
  const lines = aboutLines();
  ShowMessageDialog({
    title: `About ${APP_TITLE}`,
    width: "420px",
    content: (
      <React.Fragment>
        {lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </React.Fragment>
    )
  });
}
