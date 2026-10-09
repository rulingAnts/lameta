// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Renderer-side access to the helper, after the pattern of src/mainProcess/MainProcessApiAccess.ts:
// ipcRenderer.invoke wrappers, a mock in unit tests. (lameta runs with contextIsolation:false, so
// there is no contextBridge; the main process registers ipcMain.handle in
// src/flextext/main/helper/registerHelper.ts.)
//
//   import { helperApi } from "../flextext/helper/HelperApiAccess";
//   const texts = await helperApi.call<TextSummary[]>("listTexts");

export interface HelperCallError {
  kind: "rpc" | "unavailable" | "error";
  code: number;
  message: string;
  data?: unknown;
}

export class HelperCallFailed extends Error {
  constructor(public readonly detail: HelperCallError) {
    super(detail.message);
    this.name = "HelperCallFailed";
  }
  /** The plain remedy for a locked FLEx project (code -32010), else undefined. */
  get remedy(): string | undefined {
    return this.detail.code === -32010 ? this.detail.message : undefined;
  }
}

export interface HelperApi {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  cancel(id: number): Promise<boolean>;
  status(): Promise<unknown>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
}

const IPC = {
  call: "FlexText.helper.call",
  cancel: "FlexText.helper.cancel",
  status: "FlexText.helper.status",
  notification: "FlexText.helper.notification"
};

let mock: HelperApi | null = null;

/** Tests install a fake here. */
export function setHelperApiForTests(api: HelperApi | null): void {
  mock = api;
}

function createIpcApi(): HelperApi {
  const { ipcRenderer } = require("electron");
  return {
    async call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      const r = await ipcRenderer.invoke(IPC.call, method, params, timeoutMs);
      if (r && r.error) throw new HelperCallFailed(r.error as HelperCallError);
      return r.result as T;
    },
    cancel: (id: number) => ipcRenderer.invoke(IPC.cancel, id),
    status: () => ipcRenderer.invoke(IPC.status),
    onNotification(listener) {
      const handler = (_event: unknown, method: string, params: unknown) =>
        listener(method, params);
      ipcRenderer.on(IPC.notification, handler);
      return () => ipcRenderer.removeListener(IPC.notification, handler);
    }
  };
}

let cached: HelperApi | null = null;

export const helperApi: HelperApi = new Proxy({} as HelperApi, {
  get(_t, prop: keyof HelperApi) {
    if (mock) return mock[prop];
    if (!cached) cached = createIpcApi();
    return cached[prop];
  }
});

// -- the helper's result shapes the UI uses -------------------------------------------------

export interface TextSummary {
  guid: string;
  title: string;
  abbreviation: string;
  genres: string[];
  paragraphCount: number;
}

export interface TextStats {
  guid: string;
  title: string;
  paragraphs: number;
  segments: number;
  words: number;
  segmented: number;
  transcribed: number;
  glossed: Record<string, number>;
  morphGlossed: number;
  translated: Record<string, number>;
}

export interface SharingStatus {
  shared: boolean | null;
  locked: boolean;
  remedy?: string;
  projectFolder?: string | null;
  backend?: string | null;
}
