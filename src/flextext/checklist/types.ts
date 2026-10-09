// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The corpus checklist model (PLAN §4), ported from docs/flextext-metadata/checklist-model/.
// Step states: 2 = done, 1 = in progress, 0 or absent = not started. Step ids are stable forever
// (a rename changes label/full only) and never contain "date" (lameta force-parses such tags).

export const NOT_STARTED = 0;
export const IN_PROGRESS = 1;
export const DONE = 2;
export type StepState = 0 | 1 | 2;

/** ≥95% of the units carrying a line counts as done (the checklist's FX_DONE_BAR). */
export const FX_DONE_BAR = 0.95;

export interface Step {
  id: string;
  label: string;
  full?: string;
  order: number;
  hidden?: boolean;
  /** per-target label overrides: { [targetId]: label } */
  aliases?: Record<string, string>;
}

export interface Genre {
  id: string;
  label: string;
  parent: string | null;
  /** false = this genre does not occur in the language (eachChild rules with onlyIfOccurs skip it) */
  occurs?: boolean;
  olac?: string;
  purpose?: string;
  sequential?: boolean;
  longacre?: string;
  note?: string;
}

export interface Facet {
  id: string;
  label: string;
  values: string[];
}

export interface Stimulus {
  id: string;
  label: string;
}

export interface CustomFieldDef {
  id: string;
  label: string;
  type?: string;
}

export interface Scope {
  genre?: string;
  minSentences?: number;
}

export interface CountRule {
  id: string;
  kind: "count";
  label: string;
  min: number | null;
  scope?: Scope;
  requiredSteps?: string[];
  note?: string;
}
export interface EachChildRule {
  id: string;
  kind: "eachChild";
  label: string;
  minEach: number;
  childrenOf?: string;
  childrenOfRoots?: boolean;
  onlyIfOccurs?: boolean;
  requiredSteps?: string[];
  note?: string;
}
export interface NamedItem {
  id: string;
  label: string;
  order: number;
  alternatives?: string[];
  recommended?: boolean;
}
export interface NamedRule {
  id: string;
  kind: "named";
  label: string;
  items: NamedItem[];
  requiredSteps?: string[];
  note?: string;
}
export interface CoverageRule {
  id: string;
  kind: "coverage";
  label: string;
  min: number | null;
  items: string[]; // genre ids
  requiredSteps?: string[];
  note?: string;
}
export interface QuantityRule {
  id: string;
  kind: "quantity";
  label: string;
  field: "wordCount" | "sentenceCount" | string;
  unit: string;
  min: number | null;
  requiredSteps?: string[];
  note?: string;
}
export interface ChecklistItem {
  id: string;
  label: string;
}
export interface ChecklistRule {
  id: string;
  kind: "checklist";
  label: string;
  items: ChecklistItem[];
  requiredSteps?: string[];
  note?: string;
}
export type Rule = CountRule | EachChildRule | NamedRule | CoverageRule | QuantityRule | ChecklistRule;

export interface Target {
  id: string;
  label: string;
  short?: string;
  accent?: string;
  source?: string;
  rules: Rule[];
}

export interface Person {
  id: string;
  name: string;
}

export interface ConsentHold {
  reason?: string;
}

/** One text (in this app: one lameta session). */
export interface TextRecord {
  id: string;
  title?: string;
  titleLwc?: string;
  abbrev?: string;
  notes?: string;
  status?: "active" | "withdrawn" | string;
  genres: string[];
  primaryGenre?: string;
  facets: Record<string, string>;
  satisfies: string[];
  steps: Record<string, StepState | boolean>;
  custom: Record<string, string>;
  consentHold?: ConsentHold | null;
  flexGuid?: string;
  authorId?: string;
  transcriberId?: string;
  backTranslatorId?: string;
  wordCount?: number;
  sentenceCount?: number;
  date?: string;
  year?: string;
  village?: string;
  purpose?: string;
  elicitation?: string;
  audienceType?: string;
  audienceSize?: string;
  audienceResponse?: string;
  durationSec?: number;
  archiveId?: string;
  dataType?: string;
  [extra: string]: unknown;
}

export interface ProjectInfo {
  language: string;
  iso: string;
  variety: string;
  wordsPerPage: number;
}

export interface Dataset {
  schemaVersion: number;
  seedVersion: number;
  name?: string;
  updatedAt?: string;
  project: ProjectInfo;
  steps: Step[];
  genres: Genre[];
  facets: Facet[];
  targets: Target[];
  stimuli: Stimulus[];
  people: Person[];
  customFields: CustomFieldDef[];
  texts: TextRecord[];
  checklistState: Record<string, boolean>;
  ui?: Record<string, unknown>;
}

export interface Seed {
  seedVersion: number;
  steps: Step[];
  genres: Genre[];
  facets: Facet[];
  stimuli: Stimulus[];
  targets: Target[];
}

/** The analysis writing systems' roles for fx* functions: which step pair a ws feeds. */
export type WsRole = "lwc" | "en" | "own" | "ignore";
export type WsRoles = Record<string, WsRole>;
