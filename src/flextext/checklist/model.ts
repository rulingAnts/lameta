// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The checklist's pure functions, ported from checklist-functions.reference.js with the two
// globals (`S.data`, `S.targetId`) turned into parameters: `data` (the Dataset) and `target`.
// Rules pinned by checklist.spec.ts:
//   - counts are set unions, never sums of siblings; tagging a genre implies its ancestors;
//   - an import never lowers a stored state;
//   - step ids are stable forever (a rename changes label/full only);
//   - per-language steps are minted as gloss-<code> / ft-<code> and inserted after ft-en.

import seedJson from "./seed.json";
import {
  DONE,
  IN_PROGRESS,
  NOT_STARTED,
  FX_DONE_BAR,
  Dataset,
  Genre,
  Rule,
  Seed,
  Step,
  StepState,
  Target,
  TextRecord,
  WsRoles
} from "./types";

export const SEED: Seed = seedJson as unknown as Seed;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

let uidCounter = 0;
export function uid(): string {
  uidCounter++;
  return `t${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------- step state

export function stepState(t: Pick<TextRecord, "steps">, id: string): StepState {
  const v = t.steps ? t.steps[id] : undefined;
  if (v === true) return DONE;
  if (v === false || v === undefined || v === null) return NOT_STARTED;
  const n = Number(v) || NOT_STARTED;
  return (n >= DONE ? DONE : n <= NOT_STARTED ? NOT_STARTED : IN_PROGRESS) as StepState;
}
export const isDone = (t: Pick<TextRecord, "steps">, id: string): boolean => stepState(t, id) === DONE;
export const isPart = (t: Pick<TextRecord, "steps">, id: string): boolean => stepState(t, id) === IN_PROGRESS;

/** Raises a step to `state` if that is higher; never lowers (monotonic). Returns true if changed. */
export function raiseStep(t: TextRecord, id: string, state: StepState): boolean {
  if (stepState(t, id) >= state) return false;
  t.steps = t.steps || {};
  t.steps[id] = state;
  return true;
}

/** Sets a step to exactly `state`: a person's decision, which may lower. 0 deletes the key. */
export function setStep(t: TextRecord, id: string, state: StepState): void {
  t.steps = t.steps || {};
  if (state === NOT_STARTED) delete t.steps[id];
  else t.steps[id] = state;
}

export function migrateSteps(d: Pick<Dataset, "texts">): boolean {
  let changed = false;
  for (const t of d.texts || []) {
    if (!t.steps) {
      t.steps = {};
      continue;
    }
    for (const k of Object.keys(t.steps)) {
      const v = t.steps[k];
      if (v === true) {
        t.steps[k] = DONE;
        changed = true;
      } else if (v === false) {
        delete t.steps[k];
        changed = true;
      }
    }
  }
  return changed;
}

/** Backfills anything missing from the seed. Returns the keys that were filled. */
export function ensureDefinitions(d: Partial<Dataset>, seed: Seed = SEED): string[] {
  const filled: string[] = [];
  const dd = d as Dataset;
  for (const k of ["steps", "genres", "facets", "targets"] as const) {
    if (!Array.isArray(dd[k]) || !(dd[k] as unknown[]).length) {
      (dd as any)[k] = clone(seed[k]);
      filled.push(k);
    }
  }
  if (!dd.project) dd.project = { language: "", iso: "", variety: "", wordsPerPage: 250 };
  if (!dd.checklistState) dd.checklistState = {};
  if (!Array.isArray(dd.people)) dd.people = [];
  if (!Array.isArray(dd.customFields)) dd.customFields = [];
  if (!Array.isArray(dd.stimuli)) dd.stimuli = clone(seed.stimuli || []);
  if (!dd.ui) dd.ui = {};
  if (!Array.isArray(dd.texts)) dd.texts = [];
  for (const t of dd.texts) {
    const legacy = t as any;
    if (legacy.speakerId && !t.authorId) {
      t.authorId = legacy.speakerId;
      delete legacy.speakerId;
    }
  }
  if (typeof dd.seedVersion !== "number") dd.seedVersion = seed.seedVersion;
  if (typeof dd.schemaVersion !== "number") dd.schemaVersion = 1;
  for (const t of dd.texts) {
    t.genres = Array.isArray(t.genres) ? t.genres : [];
    t.facets = t.facets || {};
    t.satisfies = Array.isArray(t.satisfies) ? t.satisfies : [];
    t.steps = t.steps || {};
    t.custom = t.custom || {};
    if (!t.status) t.status = "active";
    if (!t.id) t.id = uid();
  }
  return filled;
}

export function blankData(name?: string, seed: Seed = SEED): Dataset {
  return {
    schemaVersion: 1,
    seedVersion: seed.seedVersion,
    name: name || "Corpus record",
    updatedAt: new Date().toISOString(),
    project: { language: "", iso: "", variety: "", wordsPerPage: 250 },
    steps: clone(seed.steps),
    genres: clone(seed.genres),
    facets: clone(seed.facets),
    targets: clone(seed.targets),
    stimuli: clone(seed.stimuli || []),
    people: [],
    customFields: [],
    texts: [],
    checklistState: {}
  };
}

// ---------------------------------------------------------------- genres

export const G = {
  byId(d: Pick<Dataset, "genres">): Map<string, Genre> {
    const m = new Map<string, Genre>();
    for (const g of d.genres) m.set(g.id, g);
    return m;
  },
  children(d: Pick<Dataset, "genres">, id: string): Genre[] {
    return d.genres.filter((g) => g.parent === id);
  },
  roots(d: Pick<Dataset, "genres">): Genre[] {
    return d.genres.filter((g) => g.parent === null);
  },
  /** The genre and every descendant. */
  subtree(d: Pick<Dataset, "genres">, id: string): Set<string> {
    const out = new Set<string>([id]);
    const walk = (p: string) =>
      G.children(d, p).forEach((c) => {
        out.add(c.id);
        walk(c.id);
      });
    walk(id);
    return out;
  },
  /** The genre and every ancestor up to the root: what tagging a genre implies. */
  ancestors(d: Pick<Dataset, "genres">, id: string): string[] {
    const m = G.byId(d);
    const out: string[] = [];
    let cur = m.get(id);
    while (cur) {
      out.push(cur.id);
      cur = cur.parent ? m.get(cur.parent) : undefined;
    }
    return out;
  },
  depth(d: Pick<Dataset, "genres">, g: Genre): number {
    let depth = 0;
    let cur: Genre | undefined = g;
    const m = G.byId(d);
    while (cur && cur.parent) {
      depth++;
      cur = m.get(cur.parent);
    }
    return depth;
  },
  /** depth-first, stable */
  ordered(d: Pick<Dataset, "genres">): Array<[Genre, number]> {
    const out: Array<[Genre, number]> = [];
    const walk = (p: string, depth: number) =>
      G.children(d, p).forEach((c) => {
        out.push([c, depth]);
        walk(c.id, depth + 1);
      });
    G.roots(d).forEach((r) => {
      out.push([r, 0]);
      walk(r.id, 1);
    });
    return out;
  }
};

export function genreLabel(g: Genre): string {
  return g.label || g.id;
}

export function activeTexts(d: Pick<Dataset, "texts">): TextRecord[] {
  return (d.texts || []).filter((t) => t.status !== "withdrawn");
}

/** Texts tagged with the genre or any descendant: a SET, so a text tagged with two children of
 * one parent counts once for the parent. */
export function textsIn(d: Pick<Dataset, "genres" | "texts">, genreId: string): TextRecord[] {
  const sub = G.subtree(d, genreId);
  return activeTexts(d).filter((t) => (t.genres || []).some((g) => sub.has(g)));
}

/** Set-union count under a genre: `textsIn(...).length`, never a sum over children. */
export function countIn(d: Pick<Dataset, "genres" | "texts">, genreId: string): number {
  return textsIn(d, genreId).length;
}

// ---------------------------------------------------------------- people / custom fields

export function personName(d: Pick<Dataset, "people">, id?: string): string {
  if (!id) return "";
  const p = (d.people || []).find((x) => x.id === id);
  return p ? p.name : "";
}

const ROLES: Array<[keyof TextRecord, string]> = [
  ["authorId", "author"],
  ["transcriberId", "transcriber"],
  ["backTranslatorId", "back-translator"]
];

export const cfSlug = (f: { label?: string }): string => String(f.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
export const cfValue = (t: TextRecord, f: { id: string }): string => (t.custom || {})[f.id] ?? "";
export const cfText = (t: TextRecord, f: { id: string }): string => String(cfValue(t, f) ?? "");

export function stimulusLabel(d: Pick<Dataset, "stimuli">, id?: string): string {
  if (!id) return "";
  const s = (d.stimuli || []).find((x) => x.id === id);
  return s ? s.label : id;
}

// ---------------------------------------------------------------- query language

interface Token {
  t: "AND" | "OR" | "NOT" | "(" | ")" | "W";
  v?: string;
}

export function qTokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const isWord = (c: string) => /[^\s()]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: c });
      i++;
      continue;
    }
    let buf = "";
    let quoted = false;
    while (i < src.length && (quoted || isWord(src[i]))) {
      const ch = src[i];
      if (ch === '"') {
        quoted = !quoted;
        i++;
        continue;
      }
      if (ch === "/" && !quoted) {
        // /regex/flags — may contain spaces
        let j = i + 1;
        let esc = false;
        while (j < src.length && (esc || src[j] !== "/")) {
          esc = !esc && src[j] === "\\";
          j++;
        }
        if (j < src.length) {
          let k = j + 1;
          while (k < src.length && /[a-z]/i.test(src[k])) k++;
          buf += src.slice(i, k);
          i = k;
          continue;
        }
      }
      buf += ch;
      i++;
    }
    if (!buf) {
      i++;
      continue;
    }
    const up = buf.toUpperCase();
    if (up === "AND" || buf === "&&") out.push({ t: "AND" });
    else if (up === "OR" || buf === "||") out.push({ t: "OR" });
    else if (up === "NOT" || buf === "!") out.push({ t: "NOT" });
    else out.push({ t: "W", v: buf });
  }
  return out;
}

function qMatcher(val: string): { test: (s: string) => boolean } {
  const m = /^\/(.*)\/([a-z]*)$/i.exec(val);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
      return { test: (s) => re.test(s || "") };
    } catch {
      /* fall through to substring */
    }
  }
  const needle = val.toLowerCase();
  return { test: (s) => (s || "").toLowerCase().includes(needle) };
}

const Q_STATE: Record<string, StepState> = {
  "2": DONE,
  done: DONE,
  yes: DONE,
  "1": IN_PROGRESS,
  part: IN_PROGRESS,
  partial: IN_PROGRESS,
  started: IN_PROGRESS,
  "0": NOT_STARTED,
  no: NOT_STARTED,
  none: NOT_STARTED,
  todo: NOT_STARTED
};

export function qFieldValue(d: Dataset, t: TextRecord, name: string): string {
  const pn = (id?: string) => personName(d, id);
  switch ((name || "").toLowerCase()) {
    case "genre":
    case "tag":
      return (t.genres || []).join(" ");
    case "author":
    case "narrator":
    case "speaker":
      return pn(t.authorId);
    case "transcriber":
      return pn(t.transcriberId);
    case "translator":
    case "backtranslator":
    case "back-translator":
      return pn(t.backTranslatorId);
    case "person":
    case "name":
      return ROLES.map(([k]) => pn(t[k] as string | undefined)).join("").trim();
    case "source":
      return (t.facets || {}).source || "";
    case "stimulus":
    case "prompt":
      return (t.facets || {}).stimulus || "";
    case "status":
      return t.status || "";
    case "title":
      return `${t.title || ""}${t.titleLwc || ""}`;
    case "abbrev":
      return t.abbrev || "";
    case "notes":
      return t.notes || "";
    case "date":
    case "year":
      return t.date || t.year || "";
    case "words":
      return t.wordCount == null ? "" : String(t.wordCount);
    case "sent":
    case "sentences":
      return t.sentenceCount == null ? "" : String(t.sentenceCount);
    case "titlelwc":
    case "title-lwc":
      return t.titleLwc || "";
    case "village":
      return t.village || "";
    case "purpose":
      return t.purpose || "";
    case "elicitation":
      return t.elicitation || "";
    case "audience":
      return [t.audienceType, t.audienceSize, t.audienceResponse].filter((v) => v != null && v !== "").join(" ");
    case "duration":
      return t.durationSec == null ? "" : String(t.durationSec);
    case "archiveid":
    case "archive":
      return t.archiveId || "";
    case "datatype":
      return t.dataType || "";
    case "primary":
    case "primarygenre":
      return t.primaryGenre || "";
    case "satisfies":
      return (t.satisfies || []).join(" ");
    case "consenthold":
    case "hold":
      return t.consentHold ? t.consentHold.reason || "held" : "";
    default: {
      const want = (name || "").toLowerCase();
      const cf = (d.customFields || []).find((x) => x.id.toLowerCase() === want || cfSlug(x) === want);
      if (cf) return cfText(t, cf);
      const f = (d.facets || []).find((x) => x.id.toLowerCase() === want);
      if (f) return (t.facets || {})[f.id] || "";
      return "";
    }
  }
}

function qIsEmpty(d: Dataset, t: TextRecord, field: string): boolean {
  return qFieldValue(d, t, field).trim() === "";
}

type Pred = (t: TextRecord) => boolean;

export function qClause(d: Dataset, word: string): Pred {
  const pn = (id?: string) => personName(d, id);
  const c = word.indexOf(":");
  if (c < 0) {
    const m = qMatcher(word);
    return (t) =>
      m.test([t.title, t.titleLwc, t.abbrev, t.notes, pn(t.authorId), pn(t.transcriberId), pn(t.backTranslatorId)].join(" "));
  }
  const field = word.slice(0, c).toLowerCase();
  const val = word.slice(c + 1);

  if (field === "empty" || field === "none" || field === "unset") return (t) => qIsEmpty(d, t, val);
  if (field === "any" || field === "has") return (t) => !qIsEmpty(d, t, val);

  const VALUELESS = new Set(["untagged", "held", "natural", "prompted"]);
  if (val === "" && !VALUELESS.has(field)) return (t) => !qIsEmpty(d, t, field);

  const numeric = (get: (t: TextRecord) => unknown): Pred => {
    const m = val.match(/^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return () => false;
    const op = m[1] || "=";
    const n = Number(m[2]);
    return (t) => {
      const v = Number(get(t));
      if (Number.isNaN(v)) return false;
      return op === ">" ? v > n : op === "<" ? v < n : op === ">=" ? v >= n : op === "<=" ? v <= n : v === n;
    };
  };

  switch (field) {
    case "genre":
    case "tag": {
      const node = G.byId(d).get(val);
      if (node) {
        const sub = G.subtree(d, val);
        return (t) => (t.genres || []).some((g) => sub.has(g));
      }
      const m = qMatcher(val);
      const ids = d.genres.filter((g) => m.test(g.id) || m.test(g.label)).map((g) => g.id);
      const all = new Set(ids.flatMap((id) => [...G.subtree(d, id)]));
      return (t) => (t.genres || []).some((g) => all.has(g));
    }
    case "untagged":
      return (t) => !(t.genres || []).length;
    case "step":
    case "state": {
      const [id, want] = val.split(/(?:!=|=)/);
      const neg = val.includes("!=");
      const wantState = want === undefined ? DONE : Q_STATE[String(want).toLowerCase()];
      const m = qMatcher(id);
      const ids = d.steps.filter((st) => m.test(st.id) || m.test(st.label)).map((st) => st.id);
      if (!ids.length) return () => false;
      return (t) => {
        const hit = ids.some((k) => stepState(t, k) === wantState);
        return neg ? !hit : hit;
      };
    }
    case "author":
    case "narrator": {
      const m = qMatcher(val);
      return (t) => m.test(pn(t.authorId));
    }
    case "transcriber": {
      const m = qMatcher(val);
      return (t) => m.test(pn(t.transcriberId));
    }
    case "translator":
    case "backtranslator":
    case "back-translator": {
      const m = qMatcher(val);
      return (t) => m.test(pn(t.backTranslatorId));
    }
    case "person":
    case "name": {
      const m = qMatcher(val);
      return (t) => ROLES.some(([k]) => m.test(pn(t[k] as string | undefined)));
    }
    case "source": {
      const m = qMatcher(val);
      return (t) => m.test((t.facets || {}).source || "");
    }
    case "stimulus":
    case "prompt": {
      const m = qMatcher(val);
      return (t) => m.test(stimulusLabel(d, (t.facets || {}).stimulus)) || m.test((t.facets || {}).stimulus || "");
    }
    case "natural":
      return (t) => /natural/i.test((t.facets || {}).source || "");
    case "prompted":
      return (t) => /prompt|elicit/i.test((t.facets || {}).source || "");
    case "status": {
      const m = qMatcher(val);
      return (t) => m.test(t.status || "active");
    }
    case "title": {
      const m = qMatcher(val);
      return (t) => m.test(`${t.title || ""} ${t.titleLwc || ""}`);
    }
    case "abbrev": {
      const m = qMatcher(val);
      return (t) => m.test(t.abbrev || "");
    }
    case "notes": {
      const m = qMatcher(val);
      return (t) => m.test(t.notes || "");
    }
    case "date":
    case "year": {
      const m = qMatcher(val);
      return (t) => m.test(`${t.date || ""} ${t.year || ""}`);
    }
    case "words":
      return numeric((t) => t.wordCount);
    case "sent":
    case "sentences":
      return numeric((t) => t.sentenceCount);
    case "held":
      return (t) => !!t.consentHold;
    case "facet": {
      const [fk, fv] = val.split("=");
      const m = qMatcher(fv ?? "");
      return (t) =>
        Object.entries(t.facets || {}).some(([k, v]) => k.toLowerCase() === (fk || "").toLowerCase() && (fv === undefined || m.test(v)));
    }
    default: {
      const known =
        (d.facets || []).some((x) => x.id.toLowerCase() === field) ||
        (d.customFields || []).some((x) => x.id.toLowerCase() === field || cfSlug(x) === field) ||
        [
          "titlelwc",
          "village",
          "purpose",
          "elicitation",
          "audience",
          "duration",
          "archiveid",
          "archive",
          "datatype",
          "primary",
          "primarygenre",
          "satisfies",
          "consenthold",
          "hold"
        ].includes(field);
      if (known) {
        const m = qMatcher(val);
        return (t) => m.test(qFieldValue(d, t, field));
      }
      const m = qMatcher(word);
      return (t) => m.test([t.title, t.abbrev, t.notes].join(" "));
    }
  }
}

/** Parses a query into a predicate; null for an empty query. Throws on a syntax error. */
export function qParse(d: Dataset, src: string): Pred | null {
  const tk = qTokenize(src);
  let i = 0;
  const peek = () => tk[i];
  function factor(): Pred {
    if (peek() && peek().t === "NOT") {
      i++;
      const f = factor();
      return (t) => !f(t);
    }
    if (peek() && peek().t === "(") {
      i++;
      const e = expr();
      if (peek() && peek().t === ")") i++;
      else throw new Error("missing )");
      return e;
    }
    const w = tk[i++];
    if (!w || w.t !== "W") throw new Error("unexpected " + (w ? w.t : "end"));
    return qClause(d, w.v!);
  }
  function term(): Pred {
    let left = factor();
    while (peek() && (peek().t === "W" || peek().t === "(" || peek().t === "AND" || peek().t === "NOT")) {
      if (peek().t === "AND") i++;
      if (!peek() || peek().t === "OR" || peek().t === ")") break;
      const right = factor();
      const l = left;
      left = (t) => l(t) && right(t);
    }
    return left;
  }
  function expr(): Pred {
    let left = term();
    while (peek() && peek().t === "OR") {
      i++;
      const right = term();
      const l = left;
      left = (t) => l(t) || right(t);
    }
    return left;
  }
  if (!tk.length) return null;
  const fn = expr();
  if (i < tk.length) throw new Error("unexpected " + (tk[i].v || tk[i].t));
  return fn;
}

// ---------------------------------------------------------------- scope and targets

export const hasAll = (t: TextRecord, steps?: string[]): boolean => (steps || []).every((s) => isDone(t, s));

export function inScope(d: Pick<Dataset, "genres">, t: TextRecord, scope?: { genre?: string; minSentences?: number }): boolean {
  if (!scope) return true;
  if (scope.genre) {
    const sub = G.subtree(d, scope.genre);
    if (!(t.genres || []).some((g) => sub.has(g))) return false;
  }
  if (scope.minSentences && !(Number(t.sentenceCount) >= scope.minSentences)) return false;
  return true;
}

export function requiredSteps(target: Target | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const r of target?.rules || []) (r.requiredSteps || []).forEach((s) => set.add(s));
  return set;
}

export function visibleSteps(d: Pick<Dataset, "steps">, target: Target | null | undefined): Step[] {
  const req = requiredSteps(target);
  return d.steps.filter((s) => !s.hidden || req.has(s.id)).sort((a, b) => a.order - b.order);
}

export function stepLabel(s: Step, target: Target | null | undefined): string {
  const a = target && s.aliases && s.aliases[target.id];
  return a || s.label;
}

export interface RuleResult {
  kind: Rule["kind"] | "?";
  met: boolean;
  text: string;
  n?: number;
  min?: number | null;
  rows?: any[];
  words?: number;
  sub?: string;
}

export function evalRule(d: Dataset, r: Rule): RuleResult {
  const req = r.requiredSteps || [];
  const active = activeTexts(d);
  if (r.kind === "count") {
    const pool = active.filter((t) => inScope(d, t, r.scope));
    const n = pool.filter((t) => (req.length ? hasAll(t, req) : true)).length;
    return {
      kind: "count",
      n,
      min: r.min,
      met: r.min == null ? n > 0 : n >= r.min,
      text: r.min == null ? `${n} texts` : `${n} / ${r.min}`
    };
  }
  if (r.kind === "eachChild") {
    const nodes = (r.childrenOfRoots ? G.roots(d).flatMap((x) => G.children(d, x.id)) : G.children(d, r.childrenOf!)).filter(
      (g) => !r.onlyIfOccurs || g.occurs !== false
    );
    const rows = nodes.map((g) => {
      const n = textsIn(d, g.id).filter((t) => (req.length ? hasAll(t, req) : true)).length;
      return { g, n, ok: n >= r.minEach };
    });
    const met = rows.filter((x) => x.ok).length;
    return { kind: "eachChild", rows, min: r.minEach, met: met === rows.length && rows.length > 0, text: `${met} of ${rows.length} genres met` };
  }
  if (r.kind === "named") {
    const rows = (r.items || [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((it) => {
        const label = (it.label || "").toLowerCase();
        const alts = (it.alternatives || []).map((a) => a.toLowerCase());
        const rank = (x: TextRecord): [number, string | null] | null => {
          if ((x.satisfies || []).includes(it.id)) return [0, "linked"];
          const stim = (x.facets || {}).stimulus;
          if (stim) {
            const sl = stimulusLabel(d, stim).toLowerCase();
            if (stim === it.id || sl === label) return [1, null];
            if (alts.includes(sl)) return [2, stimulusLabel(d, stim)];
          }
          const ti = (x.title || "").toLowerCase();
          if (ti && label && ti.includes(label)) return [3, "title"];
          const ai = alts.findIndex((a) => ti && ti.includes(a));
          if (ai >= 0) return [4, it.alternatives![ai]];
          return null;
        };
        let t: TextRecord | null = null;
        let via: string | null = null;
        let bestRank = Infinity;
        for (const x of active) {
          const r2 = rank(x);
          if (r2 && r2[0] < bestRank) {
            bestRank = r2[0];
            t = x;
            via = r2[1];
            if (bestRank === 0) break;
          }
        }
        return { it, t, via, done: !!t, steps: t ? req.filter((s) => isDone(t!, s)).length : 0 };
      });
    const met = rows.filter((x) => x.done).length;
    return { kind: "named", rows, met: met === rows.length, text: `${met} / ${rows.length}` };
  }
  if (r.kind === "coverage") {
    const byId = G.byId(d);
    const rows = (r.items || []).map((id) => {
      const g = byId.get(id);
      return { id, label: g ? genreLabel(g) : id, n: g ? textsIn(d, id).length : 0 };
    });
    const covered = rows.filter((x) => x.n > 0).length;
    return { kind: "coverage", rows, met: r.min == null ? covered > 0 : covered >= r.min, text: `${covered} of ${rows.length} covered` };
  }
  if (r.kind === "quantity") {
    const wpp = Number(d.project.wordsPerPage) || 250;
    const words = active.reduce((a, t) => a + (Number((t as any)[r.field]) || 0), 0);
    const pages = Math.round(words / wpp);
    return {
      kind: "quantity",
      n: pages,
      min: r.min,
      words,
      met: r.min == null ? pages > 0 : pages >= r.min,
      text: r.min == null ? `${pages} ${r.unit}s` : `${pages} / ${r.min} ${r.unit}s`,
      sub: `${words.toLocaleString()} words ÷ ${wpp}`
    };
  }
  if (r.kind === "checklist") {
    const st = d.checklistState || {};
    const rows = (r.items || []).map((it) => ({ it, done: !!st[it.id] }));
    const met = rows.filter((x) => x.done).length;
    return { kind: "checklist", rows, met: met === rows.length, text: `${met} / ${rows.length}` };
  }
  return { kind: "?", text: "—", met: false };
}

export function evalTarget(d: Dataset, target: Target): Array<{ rule: Rule; result: RuleResult }> {
  return target.rules.map((rule) => ({ rule, result: evalRule(d, rule) }));
}

export function quotaFor(d: Dataset, target: Target | null | undefined, genreId: string): number | null {
  let need: number | null = null;
  for (const r of target?.rules || []) {
    if (r.kind === "eachChild") {
      const nodes = (r.childrenOfRoots ? G.roots(d).flatMap((x) => G.children(d, x.id)) : G.children(d, r.childrenOf!)).filter(
        (g) => !r.onlyIfOccurs || g.occurs !== false
      );
      if (nodes.some((g) => g.id === genreId)) need = Math.max(need ?? 0, r.minEach);
    }
    if (r.kind === "count" && r.scope && r.scope.genre === genreId && r.min != null) need = Math.max(need ?? 0, r.min);
  }
  return need;
}

/** "What to do next" for a target: the unmet rules, with their shortfall where it is a number. */
export function nextSteps(d: Dataset, target: Target): Array<{ rule: Rule; result: RuleResult; shortfall: number | null }> {
  return evalTarget(d, target)
    .filter((x) => !x.result.met)
    .map((x) => ({
      ...x,
      shortfall: x.result.min != null && x.result.n != null ? Math.max(0, x.result.min - x.result.n) : null
    }));
}

// ---------------------------------------------------------------- FLEx-derived states

export const fxCode = (c?: string): string =>
  (c || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 12) || "x";

/** Which pair of steps a given analysis writing system feeds. */
export function fxStepIds(code: string, role: string): { gloss: string; ft: string } | null {
  if (role === "lwc") return { gloss: "gloss-lwc", ft: "ft-lwc" };
  if (role === "en") return { gloss: "gloss-en", ft: "ft-en" };
  if (role === "own") {
    const c = fxCode(code);
    return { gloss: `gloss-${c}`, ft: `ft-${c}` };
  }
  return null; // 'ignore'
}

export function fxExtraSteps(roles: WsRoles): Array<Pick<Step, "id" | "label" | "full">> {
  return Object.entries(roles)
    .filter(([, r]) => r === "own")
    .flatMap(([code]) => {
      const c = fxCode(code);
      return [
        { id: `gloss-${c}`, label: `Gloss (${code})`, full: `Word gloss in ${code}` },
        { id: `ft-${c}`, label: `FT (${code})`, full: `Free translation in ${code}` }
      ];
    });
}

/** Mints gloss-<code> / ft-<code> steps for "own" writing systems, inserted after ft-en; returns the new ids. */
export function fxAddSteps(d: Pick<Dataset, "steps">, roles: WsRoles): string[] {
  const extra = fxExtraSteps(roles).filter((st) => !d.steps.some((x) => x.id === st.id));
  if (!extra.length) return [];
  let at = d.steps.findIndex((x) => x.id === "ft-en");
  at = at < 0 ? d.steps.length : at + 1;
  for (const st of extra) d.steps.splice(at++, 0, { ...st, hidden: false, order: 0 });
  d.steps.forEach((x, i) => {
    x.order = i;
  });
  return extra.map((x) => x.id);
}

/** The helper's textStats shape (helper/flextext_helper/flex/stats.py). */
export interface FlexTextStats {
  guid?: string;
  title?: string;
  paragraphs: number;
  segments: number;
  words: number;
  segmented: number;
  transcribed: number;
  glossed: Record<string, number>;
  morphGlossed: number;
  translated: Record<string, number>;
}

function stateFromFraction(c: number): StepState {
  return c >= FX_DONE_BAR ? DONE : c > 0 ? IN_PROGRESS : NOT_STARTED;
}

/** Step states derived from textStats (the fork's replacement for parseFlexText + fxSteps). */
export function fxStepsFromStats(stats: FlexTextStats, roles: WsRoles): Record<string, StepState> {
  const steps: Record<string, StepState> = { flex: DONE }; // it came out of FLEx, so it is in FLEx
  const set = (id: string, c: number) => {
    const v = stateFromFraction(c);
    if (v && (steps[id] || NOT_STARTED) < v) steps[id] = v;
  };
  if (stats.paragraphs) set("segment", stats.segmented);
  if (stats.segments) set("transcribe", stats.transcribed);
  for (const [code, role] of Object.entries(roles)) {
    const ids = fxStepIds(code, role);
    if (!ids) continue;
    if (stats.words) set(ids.gloss, stats.glossed[code] ?? 0);
    if (stats.segments) set(ids.ft, stats.translated[code] ?? 0);
  }
  if (stats.words) set("morph", stats.morphGlossed);
  return steps;
}

export const fxNorm = (s?: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Matches a FLEx text to a record: by guid, then abbreviation, then title. */
export function fxMatch(t: { guid?: string; abbrev?: string; title?: string }, existing: TextRecord[]): TextRecord | undefined {
  if (t.guid) {
    const g = existing.find((x) => x.flexGuid === t.guid);
    if (g) return g;
  }
  const a = fxNorm(t.abbrev);
  if (a) {
    const m = existing.find((x) => fxNorm(x.abbrev) === a);
    if (m) return m;
  }
  const n = fxNorm(t.title);
  return n ? existing.find((x) => fxNorm(x.title) === n) : undefined;
}

/** Applies derived states to a record, never lowering a stored state; fills blank identity fields. */
export function fxApplyTo(
  target: TextRecord,
  derived: Record<string, StepState>,
  fields: { guid?: string; abbrev?: string; titleLwc?: string; wordCount?: number; sentenceCount?: number; source?: string; comment?: string } = {}
): string[] {
  const raised: string[] = [];
  target.steps = target.steps || {};
  for (const [k, v] of Object.entries(derived)) if (raiseStep(target, k, v)) raised.push(k);
  if (fields.guid && !target.flexGuid) target.flexGuid = fields.guid;
  for (const [k, v] of [
    ["abbrev", fields.abbrev],
    ["titleLwc", fields.titleLwc],
    ["wordCount", fields.wordCount],
    ["sentenceCount", fields.sentenceCount]
  ] as Array<[keyof TextRecord, unknown]>) {
    if (v !== "" && v != null && !target[k]) (target as any)[k] = v;
  }
  const note = [fields.source && `source: ${fields.source}`, fields.comment].filter(Boolean).join(" · ");
  if (note && !(target.notes || "").includes(note)) target.notes = [target.notes, note].filter(Boolean).join("\n");
  return raised;
}

/** Merges an imported record into a stored one: states never go down; blanks are filled. */
export function mergeImportedText(stored: TextRecord, imported: Partial<TextRecord>): void {
  for (const [k, v] of Object.entries(imported.steps || {})) {
    raiseStep(stored, k, stepState({ steps: { [k]: v } }, k));
  }
  for (const g of imported.genres || []) if (!stored.genres.includes(g)) stored.genres.push(g);
  for (const s of imported.satisfies || []) if (!stored.satisfies.includes(s)) stored.satisfies.push(s);
  stored.facets = { ...(imported.facets || {}), ...(stored.facets || {}) };
  stored.custom = { ...(imported.custom || {}), ...(stored.custom || {}) };
  for (const k of ["title", "titleLwc", "abbrev", "notes", "flexGuid", "primaryGenre", "authorId", "transcriberId", "backTranslatorId", "wordCount", "sentenceCount"] as const) {
    if ((stored as any)[k] == null || (stored as any)[k] === "") {
      if (imported[k] != null && imported[k] !== "") (stored as any)[k] = imported[k];
    }
  }
}
