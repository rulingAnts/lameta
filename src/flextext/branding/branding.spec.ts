// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.

import { describe, it, expect, vi } from "vitest";
import pkg from "package.json";
import { APP_TITLE, FLEXTEXT_VERSION } from "./brand";

vi.mock("../../components/ShowMessageDialog/MessageDialog", () => ({
  ShowMessageDialog: vi.fn()
}));

describe("About FlexText Metadata", () => {
  it("credits lameta, its version and its MIT licence", async () => {
    const { aboutLines } = await import("./AboutDialog");
    const text = aboutLines().join("\n");
    expect(text).toContain(`${APP_TITLE} ${FLEXTEXT_VERSION}`);
    expect(text).toContain(`lameta ${pkg.version}`);
    expect(text).toContain("MIT License");
    expect(text).toContain("https://github.com/onset/lameta");
    expect(text).toContain("AGPL-3.0-or-later");
  });

  it("the Help menu gains an About item that opens the dialog", async () => {
    const { flextextHelpMenuItems } = await import("./helpMenu");
    const { ShowMessageDialog } = await import(
      "../../components/ShowMessageDialog/MessageDialog"
    );
    const items = flextextHelpMenuItems();
    const about = items.find((i) => String(i.label).startsWith("About "));
    expect(about).toBeDefined();
    expect(about!.label).toBe("About FlexText Metadata (for lameta)...");
    (about!.click as () => void)();
    expect(ShowMessageDialog).toHaveBeenCalledTimes(1);
    const config = (ShowMessageDialog as any).mock.calls[0][0];
    expect(config.title).toBe("About FlexText Metadata (for lameta)");
  });
});
