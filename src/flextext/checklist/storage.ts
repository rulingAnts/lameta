// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Checklist storage (PLAN §4, progress spec v2 extending lameta-progress-spec.md v1):
//
//   <project>/progress-steps.json              v1's file plus full / order / hidden / aliases
//   <project>/flextext-checklist.json          genres, facets, targets, stimuli, custom fields,
//                                              collection checklist state, project info
//   <project>/Sessions/<id>/flextext/progress.json
//        { steps {id: 0|1|2}, status, consentHold, genres[], primaryGenre, facets, satisfies[], custom{} }
//
// The Stage_* CustomFields mirror (stages.ts) is applied on every save by the model layer, so
// stock lameta and corpus-keeper still see progress. Unknown keys in every file are preserved.
// Files in the project root are loaded but never displayed or saved by lameta, so they are safe.

import * as fs from "fs";
import * as path from "path";
import { SEED, ensureDefinitions, migrateSteps } from "./model";
import { StatusConfig, DEFAULT_STATUS_CONFIG, isValidStepId } from "./stages";
import { CustomFieldDef, Dataset, Facet, Genre, ProjectInfo, Step, StepState, Stimulus, Target, TextRecord } from "./types";

export const STEPS_FILE = "progress-steps.json";
export const CHECKLIST_FILE = "flextext-checklist.json";
export const SESSION_PROGRESS_DIR = "flextext";
export const SESSION_PROGRESS_FILE = "progress.json";

// ---------------------------------------------------------------- progress-steps.json (v2)

export interface StepsFile {
  version: 2;
  steps: Step[];
  status?: StatusConfig;
  [extra: string]: unknown;
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function defaultStepsFile(): StepsFile {
  return {
    version: 2,
    steps: SEED.steps.map((s) => ({ ...s })),
    status: { ...DEFAULT_STATUS_CONFIG }
  };
}

/** Reads v1 or v2; v1 steps get order/hidden filled from the seed where ids match. Missing file = defaults. */
export function readStepsFile(projectDir: string): StepsFile {
  const raw = readJson(path.join(projectDir, STEPS_FILE));
  if (!raw || !Array.isArray(raw.steps)) return defaultStepsFile();
  const seedById = new Map(SEED.steps.map((s) => [s.id, s]));
  const steps: Step[] = raw.steps
    .filter((s: any) => s && typeof s.id === "string" && isValidStepId(s.id))
    .map((s: any, i: number) => {
      const seed = seedById.get(s.id);
      return {
        ...s,
        id: s.id,
        label: typeof s.label === "string" ? s.label : seed?.label ?? s.id,
        full: typeof s.full === "string" ? s.full : seed?.full,
        order: typeof s.order === "number" ? s.order : i,
        hidden: typeof s.hidden === "boolean" ? s.hidden : raw.version === 1 ? false : seed?.hidden ?? false,
        aliases: s.aliases && typeof s.aliases === "object" ? s.aliases : undefined
      } as Step;
    });
  // a v1 file lists only the visible steps: keep the seed's hidden ones so targets can require them
  if (raw.version === 1 || raw.version === undefined) {
    for (const s of SEED.steps) if (s.hidden && !steps.some((x) => x.id === s.id)) steps.push({ ...s, order: steps.length });
  }
  steps.sort((a, b) => a.order - b.order).forEach((s, i) => (s.order = i));
  const { version: _v, steps: _s, ...rest } = raw;
  return { ...rest, version: 2, steps, status: raw.status && typeof raw.status === "object" ? raw.status : { ...DEFAULT_STATUS_CONFIG } };
}

export function writeStepsFile(projectDir: string, file: StepsFile): void {
  for (const s of file.steps) if (!isValidStepId(s.id)) throw new Error(`invalid step id: ${s.id}`);
  const ids = file.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate step ids");
  writeJsonAtomic(path.join(projectDir, STEPS_FILE), { ...file, version: 2 });
}

// ---------------------------------------------------------------- flextext-checklist.json

export interface ChecklistFile {
  version: 1;
  seedVersion: number;
  project: ProjectInfo;
  genres: Genre[];
  facets: Facet[];
  targets: Target[];
  stimuli: Stimulus[];
  customFields: CustomFieldDef[];
  checklistState: Record<string, boolean>;
  selectedTargetId?: string;
  [extra: string]: unknown;
}

export function defaultChecklistFile(): ChecklistFile {
  return {
    version: 1,
    seedVersion: SEED.seedVersion,
    project: { language: "", iso: "", variety: "", wordsPerPage: 250 },
    genres: JSON.parse(JSON.stringify(SEED.genres)),
    facets: JSON.parse(JSON.stringify(SEED.facets)),
    targets: JSON.parse(JSON.stringify(SEED.targets)),
    stimuli: JSON.parse(JSON.stringify(SEED.stimuli)),
    customFields: [],
    checklistState: {}
  };
}

export function readChecklistFile(projectDir: string): ChecklistFile {
  const raw = readJson(path.join(projectDir, CHECKLIST_FILE));
  const d = defaultChecklistFile();
  if (!raw || typeof raw !== "object") return d;
  const merged: ChecklistFile = { ...raw, version: 1 } as ChecklistFile;
  ensureDefinitions(merged as any); // backfills empty genres/facets/targets/stimuli from the seed
  merged.project = { ...d.project, ...(raw.project || {}) };
  merged.customFields = Array.isArray(raw.customFields) ? raw.customFields : [];
  merged.checklistState = raw.checklistState && typeof raw.checklistState === "object" ? raw.checklistState : {};
  merged.seedVersion = typeof raw.seedVersion === "number" ? raw.seedVersion : SEED.seedVersion;
  // ensureDefinitions adds dataset-only keys; drop them from the file shape
  for (const k of ["steps", "texts", "people", "ui", "schemaVersion"]) delete (merged as any)[k];
  return merged;
}

export function writeChecklistFile(projectDir: string, file: ChecklistFile): void {
  writeJsonAtomic(path.join(projectDir, CHECKLIST_FILE), { ...file, version: 1 });
}

// ---------------------------------------------------------------- Sessions/<id>/flextext/progress.json

export interface SessionProgress {
  steps: Record<string, StepState>;
  status?: "active" | "withdrawn" | string;
  consentHold?: { reason?: string } | null;
  genres: string[];
  primaryGenre?: string;
  facets: Record<string, string>;
  satisfies: string[];
  custom: Record<string, string>;
  flexGuid?: string;
  [extra: string]: unknown;
}

export function emptySessionProgress(): SessionProgress {
  return { steps: {}, status: "active", consentHold: null, genres: [], facets: {}, satisfies: [], custom: {} };
}

export function sessionProgressPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_PROGRESS_DIR, SESSION_PROGRESS_FILE);
}

export function readSessionProgress(sessionDir: string): SessionProgress {
  const raw = readJson(sessionProgressPath(sessionDir));
  const e = emptySessionProgress();
  if (!raw || typeof raw !== "object") return e;
  const steps: Record<string, StepState> = {};
  for (const [k, v] of Object.entries(raw.steps || {})) {
    const n = v === true ? 2 : v === false ? 0 : Number(v);
    if (n === 1 || n === 2) steps[k] = n;
  }
  return {
    ...raw,
    steps,
    status: typeof raw.status === "string" ? raw.status : "active",
    consentHold: raw.consentHold && typeof raw.consentHold === "object" ? raw.consentHold : null,
    genres: Array.isArray(raw.genres) ? raw.genres.filter((g: unknown) => typeof g === "string") : [],
    primaryGenre: typeof raw.primaryGenre === "string" ? raw.primaryGenre : undefined,
    facets: raw.facets && typeof raw.facets === "object" ? raw.facets : {},
    satisfies: Array.isArray(raw.satisfies) ? raw.satisfies : [],
    custom: raw.custom && typeof raw.custom === "object" ? raw.custom : {},
    flexGuid: typeof raw.flexGuid === "string" ? raw.flexGuid : undefined
  };
}

export function writeSessionProgress(sessionDir: string, p: SessionProgress): void {
  const steps: Record<string, StepState> = {};
  for (const [k, v] of Object.entries(p.steps || {})) if (v === 1 || v === 2) steps[k] = v;
  writeJsonAtomic(sessionProgressPath(sessionDir), { ...p, steps });
}

// ---------------------------------------------------------------- the dataset

export interface SessionSource {
  id: string;
  title?: string;
  dir: string;
  wordCount?: number;
  sentenceCount?: number;
}

/** Assembles the pure-model Dataset from the three files plus one record per session. */
export function buildDataset(stepsFile: StepsFile, checklist: ChecklistFile, sessions: SessionSource[], readProgress: (dir: string) => SessionProgress = readSessionProgress): Dataset {
  const texts: TextRecord[] = sessions.map((s) => {
    const p = readProgress(s.dir);
    const { steps, status, consentHold, genres, primaryGenre, facets, satisfies, custom, flexGuid, ...rest } = p;
    return {
      ...rest,
      id: s.id,
      title: s.title ?? s.id,
      wordCount: s.wordCount,
      sentenceCount: s.sentenceCount,
      steps,
      status: status || "active",
      consentHold: consentHold ?? null,
      genres,
      primaryGenre,
      facets,
      satisfies,
      custom,
      flexGuid
    };
  });
  const d: Dataset = {
    schemaVersion: 1,
    seedVersion: checklist.seedVersion,
    project: checklist.project,
    steps: stepsFile.steps,
    genres: checklist.genres,
    facets: checklist.facets,
    targets: checklist.targets,
    stimuli: checklist.stimuli,
    people: [],
    customFields: checklist.customFields,
    texts,
    checklistState: checklist.checklistState
  };
  ensureDefinitions(d);
  migrateSteps(d);
  return d;
}

/** Loads everything for a project directory, given its sessions. */
export function loadDataset(projectDir: string, sessions: SessionSource[]): { dataset: Dataset; stepsFile: StepsFile; checklist: ChecklistFile } {
  const stepsFile = readStepsFile(projectDir);
  const checklist = readChecklistFile(projectDir);
  return { dataset: buildDataset(stepsFile, checklist, sessions), stepsFile, checklist };
}

/** The per-session part of a TextRecord, for writing back. */
export function progressFromText(t: TextRecord): SessionProgress {
  const steps: Record<string, StepState> = {};
  for (const k of Object.keys(t.steps || {})) {
    const v = t.steps[k];
    const n = v === true ? 2 : v === false ? 0 : Number(v);
    if (n === 1 || n === 2) steps[k] = n;
  }
  return {
    steps,
    status: t.status || "active",
    consentHold: t.consentHold ?? null,
    genres: [...(t.genres || [])],
    primaryGenre: t.primaryGenre,
    facets: { ...(t.facets || {}) },
    satisfies: [...(t.satisfies || [])],
    custom: { ...(t.custom || {}) },
    flexGuid: t.flexGuid
  };
}
