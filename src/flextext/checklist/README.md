# Checklist module

SPDX-License-Identifier: AGPL-3.0-or-later. Copyright (C) 2026 Seth Johnston.

The TypeScript port of `docs/flextext-metadata/checklist-model/` (PLAN §4). `seed.json` is a
copy of the published seed (seedVersion 3); the docs copy stays the reference and is not imported.

| file | what |
|---|---|
| `types.ts` | the model: steps, genre tree, facets, stimuli, targets with the six rule kinds, text records, the dataset |
| `model.ts` | the pure functions with `data` and `target` as parameters: step state, the query language, genre set-union counts, target evaluation, "what next", FLEx-derived states from the helper's `textStats`, monotonic merges |
| `stages.ts` | the `Stage_*` custom-field mirror and the Status rule (lameta-progress-spec v1) |
| `storage.ts` | `progress-steps.json` (v2), `flextext-checklist.json`, `Sessions/<id>/flextext/progress.json`, dataset assembly |
| `sessionMirror.ts` | binds storage + mirror to a lameta Session (duck-typed) |

No UI yet: `checklist.spec.ts` pins the rules; a Checklist tab registers through
`src/flextext/workspaceTabs.tsx` when built.
