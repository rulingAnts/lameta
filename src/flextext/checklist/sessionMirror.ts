// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Binds the checklist storage to a lameta Session: saves a session's progress.json and mirrors
// its stages onto the Stage_* custom fields of the .session file (with the Status rule when a
// stage changed through the fork's UI). Duck-typed over lameta's Session so the pure modules
// stay free of lameta imports.

import { SessionFields, mirrorStagesToFields, MirrorOptions, MirrorResult, readStagesFromFields } from "./stages";
import { SessionProgress, writeSessionProgress } from "./storage";
import { StepState } from "./types";

/** The parts of lameta's Session/File this needs. */
export interface SessionLike {
  directory: string;
  properties: {
    getTextStringOrEmpty(key: string): string;
    setText(key: string, value: string): void;
    containsKey?(key: string): boolean;
    keys?(): string[];
  };
  metadataFile: {
    addTextProperty(key: string, value: string, persist?: boolean, isCustom?: boolean, showOnAutoForm?: boolean): void;
  } | null;
  wasChangeThatMobxDoesNotNotice?: () => void;
}

export function sessionFields(session: SessionLike): SessionFields {
  return {
    getText: (key) => session.properties.getTextStringOrEmpty(key),
    setCustomText: (key, value) => {
      if (key === "status") {
        session.properties.setText("status", value);
        return;
      }
      const exists = session.properties.containsKey ? session.properties.containsKey(key) : session.properties.getTextStringOrEmpty(key) !== "";
      if (exists) session.properties.setText(key, value);
      else if (session.metadataFile) session.metadataFile.addTextProperty(key, value, true, true, false);
      session.wasChangeThatMobxDoesNotNotice?.();
    },
    customKeys: () => (session.properties.keys ? session.properties.keys().filter((k) => k.startsWith("Stage_")) : [])
  };
}

/** Writes progress.json and mirrors the stages. Returns what changed in the .session. */
export function saveSessionProgress(session: SessionLike, progress: SessionProgress, stepIds: string[], opts: MirrorOptions = {}): MirrorResult {
  writeSessionProgress(session.directory, progress);
  return mirrorStagesToFields(sessionFields(session), progress.steps, stepIds, { ...opts, withdrawn: opts.withdrawn ?? progress.status === "withdrawn" });
}

/** Steps as stock lameta / corpus-keeper may have set them in Stage_* fields. */
export function readSessionStages(session: SessionLike, stepIds: string[]): { steps: Record<string, StepState>; unknown: Record<string, string> } {
  return readStagesFromFields(sessionFields(session), stepIds);
}
