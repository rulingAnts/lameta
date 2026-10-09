// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.

import { describe, it, expect, vi } from "vitest";
import { join } from "path";
import { brandWindow, brandedTitle, configureApp, windowTitle } from "./main/bootLogic";
import { APP_NAME, APP_TITLE, USER_DATA_DIR_NAME } from "./branding/brand";

function fakeApp(appData = join("C:", "Users", "x", "AppData", "Roaming")) {
  const paths: Record<string, string> = {
    appData,
    userData: join(appData, "lameta") // what Electron derives from package.json's name
  };
  return {
    name: "lameta",
    paths,
    setName(n: string) {
      this.name = n;
    },
    getName() {
      return this.name;
    },
    getPath(k: string) {
      return paths[k];
    },
    setPath(k: string, p: string) {
      paths[k] = p;
    }
  };
}

describe("boot seam: configureApp", () => {
  it("names the app and moves userData out of stock lameta's directory", () => {
    const app = fakeApp();
    const r = configureApp(app);
    expect(app.getName()).toBe(APP_NAME);
    expect(r.name).toBe("FlexText Metadata");
    expect(app.getPath("userData")).toBe(
      join(app.getPath("appData"), USER_DATA_DIR_NAME)
    );
    expect(app.getPath("userData")).not.toMatch(/[\\/]lameta$/);
    expect(r.userData).toBe(app.getPath("userData"));
  });

  it("also points sessionData (Chromium cache) at the fork's directory", () => {
    const app = fakeApp();
    configureApp(app);
    expect(app.getPath("sessionData")).toBe(app.getPath("userData"));
  });

  it("tolerates an Electron without sessionData", () => {
    const app = fakeApp();
    const original = app.setPath.bind(app);
    app.setPath = (k: string, p: string) => {
      if (k === "sessionData") throw new Error("Failed to get 'sessionData' path");
      original(k, p);
    };
    expect(() => configureApp(app)).not.toThrow();
    expect(app.getPath("userData")).toContain(USER_DATA_DIR_NAME);
  });
});

describe("boot seam: window title", () => {
  it("is the full name crediting lameta", () => {
    expect(windowTitle()).toBe(APP_TITLE);
    expect(windowTitle()).toBe("FlexText Metadata (for lameta)");
  });

  it("brandWindow sets the title and cancels the renderer's title updates", () => {
    const listeners: Record<string, (e: any) => void> = {};
    const setTitle = vi.fn();
    const win = {
      setTitle,
      on: vi.fn((ev: string, l: (e: any) => void) => {
        listeners[ev] = l;
      })
    };
    brandWindow(win as any);
    expect(setTitle).toHaveBeenCalledWith(APP_TITLE);
    const e = { preventDefault: vi.fn() };
    listeners["page-title-updated"](e); // index.html's <title>lameta</title> arriving
    expect(e.preventDefault).toHaveBeenCalled();
    expect(setTitle).toHaveBeenLastCalledWith(APP_TITLE);
  });

  it("a title set from the renderer (project name + lameta version) keeps the brand", () => {
    const setTitle = vi.fn();
    const win = { setTitle, on: vi.fn() };
    brandWindow(win as any);
    win.setTitle("Edolo sample 3.0.22-beta"); // what lameta's HomePage does on render
    expect(setTitle).toHaveBeenLastCalledWith(`Edolo sample 3.0.22-beta – ${APP_TITLE}`);
    win.setTitle("lameta");
    expect(setTitle).toHaveBeenLastCalledWith(APP_TITLE);
    expect(brandedTitle(`x – ${APP_TITLE}`)).toBe(`x – ${APP_TITLE}`);
    expect(brandedTitle("")).toBe(APP_TITLE);
  });
});
