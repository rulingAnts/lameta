// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The workspace-tabs seam spreads arrays of <Tab>/<TabPanel> into react-tabs; this proves
// react-tabs accepts them and selects the fork's panel.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, unmountComponentAtNode } from "react-dom";
import { act } from "react-dom/test-utils";
import { Tab, Tabs, TabList, TabPanel } from "react-tabs";

vi.mock("./backup/BackupTab", () => ({
  BackupTab: (props: any) => React.createElement("div", { "data-testid": "fake-backup-tab" }, "backup for " + props.project.directory)
}));

beforeEach(() => {
  (globalThis as any).window = document.defaultView;
});

describe("fork workspace tabs", () => {
  it("adds a Backup tab beside Project/Sessions/People and shows its panel when selected", async () => {
    const { flextextWorkspaceTabHeaders, flextextWorkspaceTabPanels, flextextTabIds } = await import("./workspaceTabs");
    expect(flextextTabIds()).toEqual(["backup"]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const project = { directory: "/p" } as any;
    await act(async () => {
      render(
        React.createElement(
          Tabs,
          { defaultIndex: 0 },
          React.createElement(
            TabList,
            null,
            React.createElement(Tab, null, "Project"),
            React.createElement(Tab, null, "Sessions"),
            React.createElement(Tab, null, "People"),
            flextextWorkspaceTabHeaders()
          ),
          React.createElement(TabPanel, null, "p"),
          React.createElement(TabPanel, null, "s"),
          React.createElement(TabPanel, null, "pe"),
          flextextWorkspaceTabPanels(project)
        ),
        container
      );
    });
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(4);
    expect(tabs[3].textContent).toBe("Backup");
    expect(container.querySelector('[data-testid="fake-backup-tab"]')).toBeNull();
    await act(async () => {
      (tabs[3] as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="fake-backup-tab"]')?.textContent).toBe("backup for /p");
    act(() => {
      unmountComponentAtNode(container);
    });
    container.remove();
  });
});
