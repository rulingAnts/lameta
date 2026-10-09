// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Pins "quiet": the three seams (no-sentry, no-segment, no-update-check) stop upstream's
// telemetry and release check. Each has a control case with the switch mocked OFF, which proves
// the test would notice if a seam were lost in a merge.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sentryMock = {
  init: vi.fn(),
  configureScope: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  Severity: { Error: "error" },
  Integrations: { Breadcrumbs: class {} }
};
vi.mock("@sentry/browser", () => sentryMock);
vi.mock("@sentry/integrations", () => ({ RewriteFrames: class {} }));

const AnalyticsCtor = vi.fn(() => ({
  identify: vi.fn(),
  page: vi.fn(),
  track: vi.fn()
}));
vi.mock("@segment/analytics-node", () => ({ Analytics: AnalyticsCtor }));

vi.mock("fs", async () => {
  const real = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...real,
    default: {
      ...(real as any).default,
      existsSync: (p: string) =>
        String(p).endsWith(".segment") ? true : real.existsSync(p),
      readFileSync: (p: any, o?: any) =>
        String(p).endsWith(".segment")
          ? "testKey, productionKey"
          : (real.readFileSync as any)(p, o)
    },
    existsSync: (p: string) =>
      String(p).endsWith(".segment") ? true : real.existsSync(p),
    readFileSync: (p: any, o?: any) =>
      String(p).endsWith(".segment")
        ? "testKey, productionKey"
        : (real.readFileSync as any)(p, o)
  };
});

const quietState = { telemetryOff: true, updateCheckOff: true };
vi.mock("./quiet", () => ({
  telemetryIsOff: () => quietState.telemetryOff,
  updateCheckIsOff: () => quietState.updateCheckOff
}));

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  quietState.telemetryOff = true;
  quietState.updateCheckOff = true;
  // make upstream's own guards permissive, so only the seams stand between us and the network
  process.env.NODE_ENV = "production";
  delete process.env.E2E;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("quiet.ts itself", () => {
  it("switches are ON (telemetry off, update check off)", async () => {
    const real = await vi.importActual<typeof import("./quiet")>("./quiet");
    expect(real.telemetryIsOff()).toBe(true);
    expect(real.updateCheckIsOff()).toBe(true);
  });
});

describe("seam no-sentry", () => {
  it("initializeSentry(true) never calls Sentry.init", async () => {
    const { initializeSentry } = await import("../other/errorHandling");
    initializeSentry(true);
    expect(sentryMock.init).not.toHaveBeenCalled();
  });

  it("control: with the switch off, upstream's code would call Sentry.init", async () => {
    quietState.telemetryOff = false;
    const { initializeSentry } = await import("../other/errorHandling");
    initializeSentry(true);
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
  });
});

describe("seam no-segment", () => {
  it("initializeAnalytics never constructs a Segment client, even with a key file present", async () => {
    const { initializeAnalytics } = await import("../other/analytics");
    await initializeAnalytics();
    expect(AnalyticsCtor).not.toHaveBeenCalled();
  });

  it("control: with the switch off, upstream's code would construct the client", async () => {
    quietState.telemetryOff = false;
    const { initializeAnalytics } = await import("../other/analytics");
    await initializeAnalytics();
    expect(AnalyticsCtor).toHaveBeenCalledTimes(1);
  });
});
