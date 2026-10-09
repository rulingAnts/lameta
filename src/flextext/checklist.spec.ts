// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// Pins the checklist rules (checklist-model/README.md "Pin these rules with tests"): set-union
// counts, a tagged genre implying its ancestors, an import never lowering a state, stable step
// ids, per-language steps minted after ft-en; plus the query language, every rule kind, the
// Stage_* mirror with the Status rule, and the storage round trips.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  SEED,
  blankData,
  countIn,
  evalRule,
  evalTarget,
  fxAddSteps,
  fxApplyTo,
  fxMatch,
  fxStepsFromStats,
  G,
  mergeImportedText,
  nextSteps,
  qParse,
  quotaFor,
  raiseStep,
  setStep,
  stepState,
  textsIn,
  visibleSteps,
  stepLabel,
  ensureDefinitions
} from "./checklist/model";
import {
  DEFAULT_STATUS_CONFIG,
  deriveStatus,
  isValidStepId,
  languageSuffix,
  mergeStepsMonotonic,
  mirrorStagesToFields,
  parseStageValue,
  readStagesFromFields,
  stageKey,
  SessionFields
} from "./checklist/stages";
import {
  buildDataset,
  defaultChecklistFile,
  defaultStepsFile,
  readChecklistFile,
  readSessionProgress,
  readStepsFile,
  writeChecklistFile,
  writeSessionProgress,
  writeStepsFile,
  progressFromText,
  loadDataset
} from "./checklist/storage";
import { saveSessionProgress, readSessionStages } from "./checklist/sessionMirror";
import { DONE, IN_PROGRESS, NOT_STARTED, Dataset, TextRecord } from "./checklist/types";
import { Session } from "../model/Project/Session/Session";
import { EncounteredVocabularyRegistry } from "../model/Project/EncounteredVocabularyRegistry";

function text(id: string, over: Partial<TextRecord> = {}): TextRecord {
  return { id, title: id, genres: [], facets: {}, satisfies: [], steps: {}, custom: {}, status: "active", ...over };
}

function data(texts: TextRecord[]): Dataset {
  const d = blankData("test");
  d.texts = texts;
  return d;
}

// ---------------------------------------------------------------- counts and genres

describe("genre counts", () => {
  it("counts are set unions, never sums of siblings", () => {
    const d = data([text("a", { genres: ["narr-folktale", "narr-legend"] }), text("b", { genres: ["narr-myth"] })]);
    expect(countIn(d, "narr-folktale")).toBe(1);
    expect(countIn(d, "narr-legend")).toBe(1);
    expect(countIn(d, "narr-traditional")).toBe(2); // not 3
    expect(countIn(d, "narrative")).toBe(2);
    expect(countIn(d, "events")).toBe(2);
  });

  it("tagging a genre implies its ancestors", () => {
    const d = data([text("a", { genres: ["narr-folktale"] })]);
    expect(G.ancestors(d, "narr-folktale")).toEqual(["narr-folktale", "narr-traditional", "narrative", "events"]);
    for (const anc of G.ancestors(d, "narr-folktale")) expect(textsIn(d, anc).map((t) => t.id)).toEqual(["a"]);
    expect(textsIn(d, "things")).toEqual([]);
  });

  it("withdrawn texts never count", () => {
    const d = data([text("a", { genres: ["narrative"], status: "withdrawn" })]);
    expect(countIn(d, "narrative")).toBe(0);
  });
});

// ---------------------------------------------------------------- monotonic import

describe("import never lowers a stored state", () => {
  it("raiseStep / fxApplyTo / mergeImportedText are monotonic; setStep is a person's decision", () => {
    const t = text("a", { steps: { transcribe: DONE, "gloss-en": IN_PROGRESS } });
    expect(raiseStep(t, "transcribe", IN_PROGRESS)).toBe(false);
    expect(stepState(t, "transcribe")).toBe(DONE);
    expect(raiseStep(t, "gloss-en", DONE)).toBe(true);

    const t2 = text("b", { steps: { transcribe: DONE } });
    fxApplyTo(t2, { transcribe: IN_PROGRESS, segment: IN_PROGRESS, flex: DONE }, { guid: "g-1" });
    expect(t2.steps).toEqual({ transcribe: DONE, segment: IN_PROGRESS, flex: DONE });
    expect(t2.flexGuid).toBe("g-1");

    const stored = text("c", { steps: { record: DONE }, genres: ["narrative"] });
    mergeImportedText(stored, { steps: { record: IN_PROGRESS, consent: true as any }, genres: ["narrative", "proc-howto"], title: "ignored" });
    expect(stored.steps).toEqual({ record: DONE, consent: DONE });
    expect(stored.genres).toEqual(["narrative", "proc-howto"]);
    expect(stored.title).toBe("c");

    expect(mergeStepsMonotonic({ a: DONE, b: IN_PROGRESS }, { a: IN_PROGRESS, b: DONE, c: 0 })).toEqual({ a: DONE, b: DONE });

    setStep(stored, "record", NOT_STARTED); // lowering by hand is allowed
    expect(stored.steps.record).toBeUndefined();
  });

  it("legacy boolean states migrate", () => {
    const t = text("a", { steps: { x: true as any, y: false as any } });
    expect(stepState(t, "x")).toBe(DONE);
    expect(stepState(t, "y")).toBe(NOT_STARTED);
  });
});

// ---------------------------------------------------------------- stable ids / per-language steps

describe("step ids", () => {
  it("are stable forever: the seed's ids, valid, never containing 'date'", () => {
    expect(SEED.steps.map((s) => s.id)).toEqual([
      "consent", "metadata", "record", "segment", "transcribe", "gloss-lwc", "ft-lwc", "flex", "gloss-en", "ft-en",
      "morph", "tagging", "charting", "para", "vern-edit", "author-review", "published", "release-forms",
      "archive-submitted", "archive-approved"
    ]);
    for (const s of SEED.steps) expect(isValidStepId(s.id), s.id).toBe(true);
    expect(isValidStepId("update-date")).toBe(false);
    expect(isValidStepId("Bad")).toBe(false);
    // a rename changes label/full only
    const d = blankData();
    const before = d.steps.map((s) => s.id);
    d.steps[2].label = "Audio";
    d.steps[2].full = "Audio recording made";
    expect(d.steps.map((s) => s.id)).toEqual(before);
    expect(stepLabel({ ...d.steps[2], aliases: { idb: "Rec." } }, SEED.targets[1])).toBe("Rec.");
    expect(stepLabel(d.steps[2], SEED.targets[0])).toBe("Audio");
  });

  it("per-language steps are minted as gloss-<code> / ft-<code> after ft-en", () => {
    const d = blankData();
    const added = fxAddSteps(d, { en: "en", id: "lwc", fr: "own", xx: "ignore" });
    expect(added).toEqual(["gloss-fr", "ft-fr"]);
    const ids = d.steps.map((s) => s.id);
    const ftEn = ids.indexOf("ft-en");
    expect(ids.slice(ftEn, ftEn + 3)).toEqual(["ft-en", "gloss-fr", "ft-fr"]);
    expect(d.steps.map((s) => s.order)).toEqual(d.steps.map((_, i) => i));
    expect(fxAddSteps(d, { fr: "own" })).toEqual([]); // idempotent
    expect(fxAddSteps({ steps: [] }, { "tpi-x": "own" })).toEqual(["gloss-tpi-x", "ft-tpi-x"]);
  });

  it("visibleSteps hides hidden steps unless the target requires them", () => {
    const d = blankData();
    expect(visibleSteps(d, null).map((s) => s.id)).toHaveLength(14);
    const idb = SEED.targets.find((t) => t.id === "idb")!;
    const vis = visibleSteps(d, idb).map((s) => s.id);
    expect(vis).toContain("published");
    expect(vis).not.toContain("archive-approved");
  });
});

// ---------------------------------------------------------------- FLEx-derived states

describe("fxStepsFromStats", () => {
  it("applies the 0.95 bar per step and writing-system role", () => {
    const stats = {
      paragraphs: 2, segments: 10, words: 100, segmented: 1, transcribed: 0.96,
      glossed: { en: 0.5, id: 1, fr: 0.2 }, morphGlossed: 0, translated: { en: 1, id: 0.9 }
    };
    expect(fxStepsFromStats(stats, { en: "en", id: "lwc", fr: "own" })).toEqual({
      flex: DONE, segment: DONE, transcribe: DONE, "gloss-en": IN_PROGRESS, "ft-en": DONE,
      "gloss-lwc": DONE, "ft-lwc": IN_PROGRESS, "gloss-fr": IN_PROGRESS
    });
    expect(fxStepsFromStats({ ...stats, words: 0, segments: 0, paragraphs: 0 }, { en: "en" })).toEqual({ flex: DONE });
  });

  it("matches by guid, then abbreviation, then title", () => {
    const existing = [text("a", { flexGuid: "g1", abbrev: "AAA", title: "Alpha" }), text("b", { abbrev: "BBB", title: "Beta" })];
    expect(fxMatch({ guid: "g1", title: "Beta" }, existing)!.id).toBe("a");
    expect(fxMatch({ abbrev: "bbb" }, existing)!.id).toBe("b");
    expect(fxMatch({ title: "BETA" }, existing)!.id).toBe("b");
    expect(fxMatch({ title: "Gamma" }, existing)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- targets

describe("target rules", () => {
  const done = (ids: string[]) => Object.fromEntries(ids.map((i) => [i, DONE]));
  it("count, with scope and required steps", () => {
    const d = data([
      text("a", { genres: ["narr-folktale"], sentenceCount: 30, steps: done(["charting"]) }),
      text("b", { genres: ["narr-legend"], sentenceCount: 10, steps: done(["charting"]) }),
      text("c", { genres: ["proc-howto"], sentenceCount: 40, steps: done(["charting"]) })
    ]);
    const r = evalRule(d, { id: "x", kind: "count", label: "", min: 3, scope: { genre: "narrative", minSentences: 20 }, requiredSteps: ["charting"] });
    expect(r).toMatchObject({ n: 1, min: 3, met: false, text: "1 / 3" });
    expect(evalRule(d, { id: "y", kind: "count", label: "", min: null })).toMatchObject({ n: 3, met: true, text: "3 texts" });
  });

  it("eachChild over the roots' children, skipping genres that do not occur", () => {
    const d = data([text("a", { genres: ["narr-folktale"] }), text("b", { genres: ["narr-myth"] })]);
    d.genres.find((g) => g.id === "expressive")!.occurs = false;
    const r = evalRule(d, { id: "x", kind: "eachChild", label: "", minEach: 2, childrenOfRoots: true, onlyIfOccurs: true });
    const rows = (r.rows as any[]).map((x) => [x.g.id, x.n, x.ok]);
    expect(rows).toContainEqual(["narrative", 2, true]);
    expect(rows.map((x) => x[0])).not.toContain("expressive");
    expect(r.met).toBe(false);
    expect(quotaFor(d, { id: "t", label: "", rules: [{ id: "x", kind: "eachChild", label: "", minEach: 2, childrenOfRoots: true }] }, "narrative")).toBe(2);
    expect(quotaFor(d, SEED.targets[1], "narr-folktale")).toBeNull();
  });

  it("named: stimulus beats alternative beats title", () => {
    const d = data([
      text("alt", { title: "Staged Events 1a session", facets: { stimulus: "se-1a" } }), // alternative for se-2a
      text("exact", { facets: { stimulus: "se-2a" } }), // the exact stimulus beats the alternative
      text("alt2", { facets: { stimulus: "se-1b" } }), // alternative for se-2b
      text("pear", { title: "The Pear Film retold" })
    ]);
    const r = evalRule(d, SEED.targets[0].rules[0]);
    const rows = (r.rows as any[]).map((x) => [x.it.id, x.t?.id ?? null, x.via]);
    expect(rows).toEqual([["pear", "pear", "title"], ["se-2a", "exact", null], ["se-2b", "alt2", "Staged Events 1b"]]);
    expect(r.met).toBe(true);
    d.texts = d.texts.filter((t) => t.id !== "alt2");
    expect(evalRule(d, SEED.targets[0].rules[0]).met).toBe(false);
  });

  it("coverage, quantity and checklist", () => {
    const d = data([text("a", { genres: ["narr-folktale"], wordCount: 2500 }), text("b", { genres: ["hort-proverb"], wordCount: 500 })]);
    d.project.wordsPerPage = 250;
    const cov = evalRule(d, { id: "c", kind: "coverage", label: "", min: 2, items: ["narr-folktale", "hort-proverb", "narr-myth"] });
    expect(cov).toMatchObject({ met: true, text: "2 of 3 covered" });
    const q = evalRule(d, { id: "q", kind: "quantity", label: "", field: "wordCount", unit: "page", min: 200 });
    expect(q).toMatchObject({ n: 12, words: 3000, met: false, text: "12 / 200 pages" });
    d.checklistState = { "png-paper-archive": true };
    const ck = evalRule(d, SEED.targets[2].rules[4]);
    expect(ck.met).toBe(false);
    expect(ck.text).toMatch(/^1 \/ \d$/);
    const next = nextSteps(d, SEED.targets[2]);
    expect(next.find((x) => x.rule.id === "png-pages")!.shortfall).toBe(188);
    expect(evalTarget(d, SEED.targets[1])).toHaveLength(5);
  });
});

// ---------------------------------------------------------------- query language

describe("query language", () => {
  const d = data([
    text("a", { title: "Lizard story", genres: ["narr-folktale"], steps: { transcribe: DONE }, facets: { source: "Naturally occurring" }, wordCount: 300 }),
    text("b", { title: "Mat weaving", genres: ["proc-howto"], steps: { transcribe: IN_PROGRESS }, facets: { source: "Elicited" }, wordCount: 50, consentHold: { reason: "awaiting" } })
  ]);
  d.people = [{ id: "p1", name: "Narrator One" }];
  d.texts[0].authorId = "p1";
  const ids = (q: string) => d.texts.filter(qParse(d, q)!).map((t) => t.id);
  it("fields, genres with subtree, steps, numbers, booleans, people", () => {
    expect(ids("lizard")).toEqual(["a"]);
    expect(ids("genre:narrative")).toEqual(["a"]);
    expect(ids("genre:events")).toEqual(["a", "b"]);
    expect(ids("step:transcribe")).toEqual(["a"]);
    expect(ids("step:transcribe=part")).toEqual(["b"]);
    expect(ids("step:transcribe!=done")).toEqual(["b"]);
    expect(ids("words:>100")).toEqual(["a"]);
    expect(ids("natural:")).toEqual(["a"]);
    expect(ids("prompted:")).toEqual(["b"]);
    expect(ids("held:")).toEqual(["b"]);
    expect(ids("author:narrator")).toEqual(["a"]);
    expect(ids("empty:author")).toEqual(["b"]);
    expect(ids("NOT genre:narrative")).toEqual(["b"]);
    expect(ids("(lizard OR mat) AND step:transcribe")).toEqual(["a"]);
    expect(ids("title:/^mat/")).toEqual(["b"]);
    expect(ids("source:elicit")).toEqual(["b"]);
    expect(qParse(d, "")).toBeNull();
    expect(() => qParse(d, "(lizard")).toThrow(/missing/);
  });
});

// ---------------------------------------------------------------- Stage_* mirror and Status

describe("Stage_* mirror (lameta-progress-spec v1)", () => {
  function fakeFields(initial: Record<string, string> = {}) {
    const store = { ...initial };
    const f: SessionFields & { store: Record<string, string> } = {
      store,
      getText: (k) => store[k] ?? "",
      setCustomText: (k, v) => {
        if (v === "") delete store[k];
        else store[k] = v;
      },
      customKeys: () => Object.keys(store).filter((k) => k.startsWith("Stage_"))
    };
    return f;
  }
  it("derives keys as the spec says", () => {
    expect(stageKey("record")).toBe("Stage_Record");
    expect(stageKey("gloss-lwc")).toBe("Stage_Gloss_Lwc");
    expect(stageKey("archive-submitted")).toBe("Stage_Archive_Submitted");
    expect(languageSuffix("en")).toBe("En");
    expect(languageSuffix("eng")).toBe("En");
    expect(languageSuffix("id", "id")).toBe("Lwc");
    expect(languageSuffix("fr", "id")).toBe("Fr");
    expect(parseStageValue("In-Progress")).toEqual({ state: IN_PROGRESS });
    expect(parseStageValue("in progress")).toEqual({ state: IN_PROGRESS });
    expect(parseStageValue("DONE")).toEqual({ state: DONE });
    expect(parseStageValue("maybe")).toEqual({ unknown: "maybe" });
    expect(parseStageValue("")).toBeNull();
  });

  it("writes done / in_progress, removes for 0, preserves unknown values and foreign keys", () => {
    const f = fakeFields({ Stage_Segment: "weird", Progress_Other: "x", Stage_Record: "done" });
    const stepIds = SEED.steps.map((s) => s.id);
    const r = mirrorStagesToFields(f, { consent: DONE, metadata: IN_PROGRESS, record: NOT_STARTED, transcribe: true as any }, stepIds);
    expect(f.store).toEqual({ Stage_Consent: "done", Stage_Metadata: "in_progress", Stage_Segment: "weird", Progress_Other: "x", Stage_Transcribe: "done" });
    expect(r.changedKeys.sort()).toEqual(["Stage_Consent", "Stage_Metadata", "Stage_Record", "Stage_Transcribe"]);
    expect(r.status).toBeNull();
    const back = readStagesFromFields(f, stepIds);
    expect(back.steps).toEqual({ consent: DONE, metadata: IN_PROGRESS, transcribe: DONE });
    expect(back.unknown).toEqual({ segment: "weird" });
  });

  it("applies the Status rule only when asked", () => {
    expect(deriveStatus({}, DEFAULT_STATUS_CONFIG, true)).toBe("Skipped");
    expect(deriveStatus({}, DEFAULT_STATUS_CONFIG, false)).toBe("Incoming");
    expect(deriveStatus({ record: DONE }, DEFAULT_STATUS_CONFIG, false)).toBe("In_Progress");
    expect(deriveStatus({ record: DONE, "archive-submitted": DONE }, DEFAULT_STATUS_CONFIG, false)).toBe("Finished");
    expect(deriveStatus({ record: DONE }, undefined, false)).toBeNull();
    const f = fakeFields({ status: "Incoming" });
    const r = mirrorStagesToFields(f, { record: DONE }, ["record"], { applyStatus: true });
    expect(r.status).toBe("In_Progress");
    expect(f.store.status).toBe("In_Progress");
    const f2 = fakeFields({ status: "Incoming" });
    mirrorStagesToFields(f2, { record: DONE }, ["record"]);
    expect(f2.store.status).toBe("Incoming"); // not on load
  });
});

// ---------------------------------------------------------------- storage

describe("storage files", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-checklist-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("progress-steps.json: defaults, v1 upgrade keeping unknown keys, v2 round trip", () => {
    const def = readStepsFile(dir);
    expect(def.version).toBe(2);
    expect(def.steps.map((s) => s.id)).toEqual(SEED.steps.map((s) => s.id));
    expect(def.status).toEqual(DEFAULT_STATUS_CONFIG);

    fs.writeFileSync(path.join(dir, "progress-steps.json"), JSON.stringify({
      version: 1, steps: [{ id: "consent", label: "Consent!" }, { id: "record", label: "Audio recording" }],
      status: { inProgressAfter: "record", finishedAfter: "archive-submitted" }, somebodyElses: 1
    }));
    const v1 = readStepsFile(dir);
    expect(v1.steps.slice(0, 2).map((s) => [s.id, s.label, s.order, s.hidden])).toEqual([["consent", "Consent!", 0, false], ["record", "Audio recording", 1, false]]);
    expect(v1.steps.map((s) => s.id)).toContain("archive-submitted"); // hidden seed steps kept
    expect(v1.somebodyElses).toBe(1);
    writeStepsFile(dir, v1);
    const v2 = JSON.parse(fs.readFileSync(path.join(dir, "progress-steps.json"), "utf8"));
    expect(v2.version).toBe(2);
    expect(v2.somebodyElses).toBe(1);
    expect(() => writeStepsFile(dir, { ...defaultStepsFile(), steps: [{ id: "x-date", label: "", order: 0 }] })).toThrow(/invalid/);
  });

  it("flextext-checklist.json and per-session progress.json round trip; dataset assembly", () => {
    const ck = defaultChecklistFile();
    ck.selectedTargetId = "idb";
    ck.checklistState = { "png-library": true };
    writeChecklistFile(dir, ck);
    const read = readChecklistFile(dir);
    expect(read.selectedTargetId).toBe("idb");
    expect(read.genres.length).toBe(32);
    expect(read.checklistState).toEqual({ "png-library": true });
    fs.writeFileSync(path.join(dir, "flextext-checklist.json"), JSON.stringify({ version: 1, genres: [], extra: true }));
    expect(readChecklistFile(dir).genres.length).toBe(32); // backfilled from the seed

    const s1 = path.join(dir, "Sessions", "S1");
    fs.mkdirpSync(s1);
    expect(readSessionProgress(s1)).toEqual({ steps: {}, status: "active", consentHold: null, genres: [], facets: {}, satisfies: [], custom: {} });
    writeSessionProgress(s1, { steps: { record: DONE, segment: IN_PROGRESS, bogus: 0 as any }, status: "active", genres: ["narr-folktale"], facets: { source: "Naturally occurring" }, satisfies: [], custom: {}, flexGuid: "g1", consentHold: null, mine: "kept" });
    const p = readSessionProgress(s1);
    expect(p.steps).toEqual({ record: DONE, segment: IN_PROGRESS });
    expect(p.flexGuid).toBe("g1");
    expect(p.mine).toBe("kept");
    expect(fs.existsSync(path.join(s1, "flextext", "progress.json"))).toBe(true);

    const { dataset } = loadDataset(dir, [{ id: "S1", title: "First", dir: s1, wordCount: 120 }, { id: "S2", title: "Second", dir: path.join(dir, "Sessions", "S2") }]);
    expect(dataset.texts.map((t) => [t.id, t.title, stepState(t, "record"), t.genres])).toEqual([["S1", "First", DONE, ["narr-folktale"]], ["S2", "Second", NOT_STARTED, []]]);
    expect(countIn(dataset, "narrative")).toBe(1);
    expect(progressFromText(dataset.texts[0]).steps).toEqual({ record: DONE, segment: IN_PROGRESS });
    expect(buildDataset(defaultStepsFile(), defaultChecklistFile(), []).texts).toEqual([]);
    expect(ensureDefinitions({})).toEqual(["steps", "genres", "facets", "targets"]);
  });

  it("mirrors stages into a real lameta Session's custom fields", () => {
    const src = path.resolve("sample data", "Edolo sample", "Sessions", "ETR009");
    const sdir = path.join(dir, "ETR009");
    fs.copySync(src, sdir);
    const session = Session.fromDirectory(sdir, new EncounteredVocabularyRegistry());
    const stepIds = SEED.steps.map((s) => s.id);
    const r = saveSessionProgress(session, { steps: { record: DONE, segment: IN_PROGRESS }, status: "active", genres: [], facets: {}, satisfies: [], custom: {} }, stepIds, { applyStatus: true });
    expect(r.changedKeys).toEqual(["Stage_Record", "Stage_Segment"]);
    expect(r.status).toBe("In_Progress");
    const xml = session.metadataFile!.getXml();
    expect(xml).toContain('<Stage_Record type="string">done</Stage_Record>');
    expect(xml).toContain('<Stage_Segment type="string">in_progress</Stage_Segment>');
    expect(xml).toContain("<CustomFields");
    expect(session.properties.getTextStringOrEmpty("status")).toBe("In_Progress");
    expect(readSessionStages(session, stepIds).steps).toEqual({ record: DONE, segment: IN_PROGRESS });
    expect(fs.existsSync(path.join(sdir, "flextext", "progress.json"))).toBe(true);
    // lowering by hand then mirroring removes the field
    saveSessionProgress(session, { steps: { record: DONE }, status: "active", genres: [], facets: {}, satisfies: [], custom: {} }, stepIds);
    expect(session.metadataFile!.getXml()).not.toContain("Stage_Segment");
  });
});
