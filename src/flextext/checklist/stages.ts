// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The `Stage_*` custom-field mirror and the Status rule, after lameta-progress-spec.md (v1,
// https://raw.githubusercontent.com/rulingAnts/flextext-editor/main/plans/lameta-progress-spec.md):
//
//   key   = "Stage_" + step id with each -/_ part capitalised, joined by "_"
//           record -> Stage_Record, gloss-lwc -> Stage_Gloss_Lwc
//   value = done | in_progress; not started = element ABSENT (lameta drops empty elements)
//   Status: withdrawn -> Skipped; stage(inProgressAfter) != done -> Incoming;
//           stage(finishedAfter) == done -> Finished; otherwise In_Progress
//   Merging is monotonic: a derived value never lowers a stored one.
//   Language suffix: en/eng -> En; the project's non-English analysis language -> Lwc; else the
//   code capitalised (fr -> Fr).

import { DONE, IN_PROGRESS, NOT_STARTED, StepState } from "./types";
import { stepState } from "./model";

export const STAGE_PREFIX = "Stage_";
export const STEP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidStepId(id: string): boolean {
  return STEP_ID_PATTERN.test(id) && !id.toLowerCase().includes("date");
}

export function stageKey(stepId: string): string {
  return STAGE_PREFIX + stepId.split(/[-_]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("_");
}

export function isStageKey(key: string): boolean {
  return key.startsWith(STAGE_PREFIX);
}

/** The step id a Stage_* key came from, if it names a known step (keys are not reversible in general). */
export function stepIdForStageKey(key: string, knownStepIds: string[]): string | undefined {
  return knownStepIds.find((id) => stageKey(id) === key);
}

export function stageValue(state: StepState): "done" | "in_progress" | null {
  return state === DONE ? "done" : state === IN_PROGRESS ? "in_progress" : null;
}

export type ParsedStage = { state: StepState } | { unknown: string } | null;

/** Readers accept in-progress / in progress and any case; writers emit the canonical spelling. */
export function parseStageValue(raw: string | undefined | null): ParsedStage {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const n = v.toLowerCase().replace(/[\s-]+/g, "_");
  if (n === "done") return { state: DONE };
  if (n === "in_progress") return { state: IN_PROGRESS };
  return { unknown: v };
}

export interface StatusConfig {
  inProgressAfter?: string;
  finishedAfter?: string;
}
export const DEFAULT_STATUS_CONFIG: Required<StatusConfig> = { inProgressAfter: "record", finishedAfter: "archive-submitted" };

export type LametaStatus = "Incoming" | "In_Progress" | "Finished" | "Skipped";

export function deriveStatus(steps: Record<string, StepState | boolean>, cfg: StatusConfig | undefined, withdrawn: boolean): LametaStatus | null {
  if (!cfg || (!cfg.inProgressAfter && !cfg.finishedAfter)) return null;
  if (withdrawn) return "Skipped";
  const t = { steps };
  if (cfg.inProgressAfter && stepState(t, cfg.inProgressAfter) !== DONE) return "Incoming";
  if (cfg.finishedAfter && stepState(t, cfg.finishedAfter) === DONE) return "Finished";
  return "In_Progress";
}

/** The Stage_ suffix for an analysis writing system. */
export function languageSuffix(code: string, projectLwc?: string): string {
  const c = (code || "").toLowerCase();
  if (c === "en" || c === "eng") return "En";
  if (projectLwc && c === projectLwc.toLowerCase()) return "Lwc";
  return c.charAt(0).toUpperCase() + c.slice(1).replace(/[^a-z0-9]+/g, "_");
}

/** What the mirror writes to: a session's custom fields and its Status. */
export interface SessionFields {
  getText(key: string): string; // "" when absent
  setCustomText(key: string, value: string): void; // "" removes/empties the field
  customKeys(): string[];
}

export interface MirrorOptions {
  status?: StatusConfig;
  withdrawn?: boolean;
  /** Apply the Status rule (only when a stage changed through the UI/model, never on load). */
  applyStatus?: boolean;
}

export interface MirrorResult {
  changedKeys: string[];
  status: LametaStatus | null;
  statusChanged: boolean;
}

/**
 * Mirrors step states onto Stage_* custom fields (2 -> done, 1 -> in_progress, 0 -> absent),
 * leaving unknown values and keys outside the step list alone, and applies the Status rule
 * when asked.
 */
export function mirrorStagesToFields(fields: SessionFields, steps: Record<string, StepState | boolean>, stepIds: string[], opts: MirrorOptions = {}): MirrorResult {
  const changed: string[] = [];
  for (const id of stepIds) {
    const key = stageKey(id);
    const want = stageValue(stepState({ steps }, id)) ?? "";
    const current = fields.getText(key);
    const parsed = parseStageValue(current);
    if (parsed && "unknown" in parsed && want === "") continue; // an unknown value is preserved
    if ((parsed === null ? "" : "state" in parsed ? stageValue(parsed.state) ?? "" : current) === want) continue;
    fields.setCustomText(key, want);
    changed.push(key);
  }
  let status: LametaStatus | null = null;
  let statusChanged = false;
  if (opts.applyStatus) {
    status = deriveStatus(steps, opts.status ?? DEFAULT_STATUS_CONFIG, !!opts.withdrawn);
    if (status && fields.getText("status") !== status) {
      fields.setCustomText("status", status);
      statusChanged = true;
    }
  }
  return { changedKeys: changed, status, statusChanged };
}

/** Reads step states back from Stage_* fields: known steps only; unknown values are reported. */
export function readStagesFromFields(fields: SessionFields, stepIds: string[]): { steps: Record<string, StepState>; unknown: Record<string, string> } {
  const steps: Record<string, StepState> = {};
  const unknown: Record<string, string> = {};
  for (const id of stepIds) {
    const parsed = parseStageValue(fields.getText(stageKey(id)));
    if (!parsed) continue;
    if ("state" in parsed) steps[id] = parsed.state;
    else unknown[id] = parsed.unknown;
  }
  return { steps, unknown };
}

/** Monotonic merge of two step maps (never lowers). */
export function mergeStepsMonotonic(stored: Record<string, StepState | boolean>, derived: Record<string, StepState | boolean>): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const k of new Set([...Object.keys(stored), ...Object.keys(derived)])) {
    const a = stepState({ steps: stored }, k);
    const b = stepState({ steps: derived }, k);
    const v = Math.max(a, b) as StepState;
    if (v !== NOT_STARTED) out[k] = v;
  }
  return out;
}
