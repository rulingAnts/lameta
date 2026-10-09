# Corpus checklist model (reference for the port)

Seth's corpus checklist is a single-page app in a private repository. Seth decided (2026-10-09) to
publish its **model only** here, for porting into this fork as a TypeScript module plus UI
(`../PLAN.md` §4). Nothing in this folder is imported by the app.

| file | what it is |
|---|---|
| `seed.json` | The definitions (`seedVersion` 3), all **generic**:<br>• 20 workflow steps (14 visible, 6 shown only when a target requires them);<br>• the 32-node genre tree, two axes (events / things) × purpose, each node with an OLAC code;<br>• 5 facets;<br>• 12 standard elicitation stimuli;<br>• 3 targets (SIL Indonesia Branch Handbook §4.1, SIL PNG's *Collecting Texts*, a workshop minimum) built from the six rule kinds |
| `checklist-functions.reference.js` | The original's **pure functions**, copied verbatim:<br>• step state: `stepState`, `isDone`, `isPart`, `migrateSteps`, `ensureDefinitions`, `blankData`;<br>• the query language: `qTokenize`, `qParse`, `qClause`, `qFieldValue`;<br>• genre helpers (`G`, `textsIn`), scope and target evaluation: `inScope`, `hasAll`, `requiredSteps`, `visibleSteps`, `stepLabel`, `evalRule`, `quotaFor`;<br>• FLEx-derived states: `parseFlexText`, `fxCode`, `fxStepIds`, `fxExtraSteps`, `fxAddSteps`, `fxSteps`, `fxMatch`, `fxApplyTo`, at the `FX_DONE_BAR` 0.95 bar |

**What was deliberately left out:** the page itself, its persistence and sync code, its hosting
details, and every list of texts or people. Only definitions and logic are here.

## Porting notes

- **Remove the globals.** The functions read a global `S.data` (the dataset) and `S.targetId`
  (the selected target). The port makes both **parameters**, so every function is pure and
  unit-testable.
- **Add the missing constants.** `DONE` / `IN_PROGRESS` are the step states 2 / 1; 0 or a missing
  key means not started.
- **Pin these rules with tests:**
  - **Counts are set unions,** never sums of siblings; tagging a genre implies its ancestors.
  - **An import never lowers a stored state.**
  - **Step ids are stable forever.** A rename changes `label` / `full` only.
  - **Per-language steps** are minted as `gloss-<code>` / `ft-<code>` and inserted after `ft-en`.
- **Fill in the `.crpck` gaps.** Import keys are `format: "corpus-progress-checklist"`,
  `schemaVersion: 1`, `seedVersion`, `steps`, `genres`, `facets`, `targets`, `stimuli`, `people`,
  `customFields`, `texts`, `checklistState`. A text record's people roles are `authorId`,
  `transcriberId` and `backTranslatorId` (older files say `speakerId`, which means `authorId`).
- **Live state comes from FLEx.** The `fx*` functions derive states from a parsed `.flextext`; in
  this app the flexicon helper's `textStats` replaces the parse step.

SPDX-License-Identifier: AGPL-3.0-or-later. Copyright (C) 2026 Seth Johnston.
