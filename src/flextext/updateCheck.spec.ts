// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Pins the no-update-check seam: mounting upstream's ReleasesDialog (which queries
// api.github.com/repos/onset/lameta/releases on startup) performs no request in the fork.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, unmountComponentAtNode } from "react-dom";
import { act } from "react-dom/test-utils";

const axiosGet = vi.fn(() => new Promise(() => {}));
vi.mock("axios", () => ({ default: { get: axiosGet }, get: axiosGet }));

const quietState = { updateCheckOff: true };
vi.mock("./quiet", () => ({
  telemetryIsOff: () => true,
  updateCheckIsOff: () => quietState.updateCheckOff
}));

async function mountReleasesDialog() {
  const { ReleasesDialog } = await import("../components/ReleasesDialog");
  const { I18nProvider } = await import("@lingui/react");
  const { i18n } = await import("../other/localization");
  i18n.load("en", {});
  i18n.activate("en");
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    render(
      React.createElement(
        I18nProvider,
        { i18n },
        React.createElement(ReleasesDialog)
      ),
      container
    );
  });
  return () => {
    act(() => {
      unmountComponentAtNode(container);
    });
    container.remove();
  };
}

beforeEach(() => {
  axiosGet.mockClear();
  quietState.updateCheckOff = true;
  delete process.env.E2E;
  // src/vitest.mock.ts replaces `window` with a stub that react-dom cannot commit into;
  // put happy-dom's real window back for this rendering test.
  (globalThis as any).window = document.defaultView;
});

describe("seam no-update-check", () => {
  it("ReleasesDialog mounts without asking GitHub for stock lameta releases", async () => {
    const unmount = await mountReleasesDialog();
    expect(axiosGet).not.toHaveBeenCalled();
    unmount();
  });

  it("control: with the switch off, upstream's code queries api.github.com", async () => {
    quietState.updateCheckOff = false;
    const unmount = await mountReleasesDialog();
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(String(axiosGet.mock.calls[0][0])).toContain(
      "api.github.com/repos/onset/lameta/releases"
    );
    unmount();
  });
});
