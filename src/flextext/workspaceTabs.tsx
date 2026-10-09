// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The fork's top-level tabs, spread into lameta's Workspace tabs by the `workspace-tabs` seam
// (src/components/Workspace.tsx): one seam registers every fork tab. react-tabs flattens arrays
// of <Tab>/<TabPanel> children, and the headers and panels must stay in the same order.

import * as React from "react";
import { Tab, TabPanel } from "react-tabs";
import { Project } from "../model/Project/Project";
import { BackupTab } from "./backup/BackupTab";

interface ForkTab {
  id: string;
  label: string;
  render: (project: Project) => React.ReactNode;
}

const FORK_TABS: ForkTab[] = [
  {
    id: "backup",
    label: "Backup",
    render: (project) => <BackupTab project={project} />
  }
];

export function flextextTabIds(): string[] {
  return FORK_TABS.map((t) => t.id);
}

// Both return arrays of elements (react-tabs flattens them with Children.map). The return type is
// `any` on purpose: the repo carries two @types/react versions (MUI nests its own), and a typed
// ReactElement[] fails to assign to the other version's ReactNode at the seam in Workspace.tsx.
export function flextextWorkspaceTabHeaders(): any {
  return FORK_TABS.map((t) => (
    <Tab key={`flextext-${t.id}`} className={`react-tabs__tab tab-flextext-${t.id}`} data-testid={`flextext-${t.id}-tab`}>
      <div className={"icon-and-label"}>{t.label}</div>
    </Tab>
  ));
}

export function flextextWorkspaceTabPanels(project: Project): any {
  return FORK_TABS.map((t) => (
    <TabPanel key={`flextext-${t.id}`} className={`tab-panel-flextext-${t.id}`}>
      {t.render(project) as any}
    </TabPanel>
  ));
}
