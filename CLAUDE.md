# FlexText Metadata (for lameta): fork guide for Claude / LLMs

> **Two layers.** This section is the FORK's rules, and they take precedence where they differ.
> Upstream lameta's own agent instructions follow unchanged at the end (`@AGENTS.md`).

This is **Seth Johnston's fork of lameta** (`rulingAnts/lameta`, forked from `onset/lameta`). The
work lives on branch **`flextext-metadata`**. Read **`docs/flextext-metadata/PLAN.md`** before
anything else: it is the design, the decisions, and the phase list.

In one line: lameta, rebranded **FlexText Metadata (for lameta)**, Windows x64 desktop only, plus:
- the corpus checklist (`docs/flextext-metadata/checklist-model/`);
- FLEx access through a bundled **flexicon** Python helper (PyInstaller `--onedir`, JSON-RPC 2.0
  over stdio, FLEx in shared mode);
- **rclone** backup of the whole project folder to S3-compatible storage;
- cooperation with the FlexText Researcher Panel's lameta-device agent (the open marker,
  PLAN §5).

## 🚩 Branches: the rules that protect this fork

- **Work on `flextext-metadata`**, or on a `claude/*` branch made from it.
- ⚠ **Never push `master`, `V2`, `beta`, `release` or `V3` to this fork.** Upstream's inherited
  `.github/workflows/main.yml` ("Build/release") **builds and PUBLISHES A GITHUB RELEASE** on pushes
  to those names. It was disabled on the fork on 2026-10-09; never rely on that.
- ⚠ **Never push to `onset/lameta`, and never open a pull request against it.** In a fork,
  `gh pr create` defaults to the upstream repo. Any PR from this work names
  `--repo rulingAnts/lameta` explicitly. Features meant for upstream (e.g. the issue #74 checklist)
  go later as clean per-feature branches made from upstream, without the rebrand or this file.
- **`master` mirrors upstream's `master`.** Keep it untouched. Sync this branch from `upstream/V3`
  deliberately, by merge, and never rewrite published history.

## ⚠️ GitHub costs: ask before anything billable (firm policy, 2026-07-07)

**Never trigger anything that can incur GitHub charges without Seth's explicit approval AND a stated
cost estimate first.**

- **FREE, always:** Actions on public repos with standard GitHub-hosted runners; self-hosted
  runners; Pages.
- **METERED** (free monthly quota, then paid): Actions in private repos (Windows counts 2×, macOS
  10×); Codespaces; Packages; Git LFS.
- **ALWAYS billable, even on public repos:** larger or GPU runners.
- **This fork is public, so `windows-latest` / `ubuntu-latest` jobs are free.** Without Seth's
  explicit OK (and a cost), never:
  - use a non-standard `runs-on:`;
  - add a `schedule:` trigger;
  - use Codespaces, LFS or Packages;
  - change plans or budgets.
- **When the cost is established as zero** (public repo + standard runner + no schedule), workflow
  changes may go ahead. The relaxation covers COST only: a workflow that publishes releases or
  otherwise changes what reaches users still needs Seth.
- **This branch's own workflow builds artifacts only:** `--publish never`, no releases, no secrets,
  artifacts kept 14 days.

## Platform facts (don't rediscover them)

- **Builds:** Windows **x64 on GitHub `windows-latest`**. Not on Seth's Parallels VM: on Apple
  silicon it is Windows on ARM, and Electron/PyInstaller would build arm64. The VM can *test* x64
  builds under emulation.
- **A cloud session is Linux.** It can build and unit-test the TypeScript and the Python helper
  with fakes. It **cannot** run FLEx, LCM, flexicon, PyInstaller for Windows, or the installer.
  Mark any Windows/FLEx behaviour you could not run as **"unverified on Windows"**; never claim it
  works.
- **Toolchain:** Node **22.16.0**, Yarn **1.22.19** (pinned via Volta in `package.json`).
  - `yarn install --frozen-lockfile`, then upstream's own commands (AGENTS.md, below):
    `yarn tsc --noEmit`, `yarn eslint src`, `yarn vitest run`, `yarn build`.
  - If install fails downloading the Electron binary, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: unit tests
    don't need it.
  - Record the baseline test result BEFORE changing anything, so new failures are distinguishable
    from inherited ones.
- **flexicon** = PyPI `pyflexicon` ≥4.12,<5 (LGPL-2.1-or-later, Windows only, pythonnet ≥3.0.3,<3.2).
  `import flexicon`, never `flexlibs2`. Python 3.12 x64; the architecture must match FieldWorks.

## Child processes: the rule that exists because Electron failed before

Seth's bulk_audio_normalizer began in Electron and was rewritten in Python. On Windows,
`taskkill /T /F` missed children, ffmpeg outlived the app, and process groups were unreliable.
So (PLAN §1):
- **ONE long-lived helper per app session**, spawned from the **main process only**: `shell:false`,
  `windowsHide:true`, not `detached`. Never a process per item.
- **Cancel by message, not kill.** The helper exits when its stdin closes, and has a parent-PID
  watchdog.
- **Python supervises the only grandchild (rclone)** inside a Windows Job Object with
  `KILL_ON_JOB_CLOSE`.
- **`--onedir`, never `--onefile`.**
- **stdout is protocol only:** UTF-8, flushed per line. Logs go to stderr, which is always drained.

## Licence, privacy, wording

- **New files carry `// SPDX-License-Identifier: AGPL-3.0-or-later`** (Seth, 2026-10-09). lameta's
  own files keep MIT and its notice; never edit `LICENSE` or remove the upstream attribution.
- **Telemetry stays OFF.** Upstream's Sentry (`src/other/errorHandling.ts`) and Segment
  (`src/other/analytics.ts`) must send nothing from this fork, and nothing new that phones home is
  added. This app holds the language, voices and consent records of indigenous communities, and
  the privacy and research-ethics obligations that come with that are the reason. Describe security
  work by what it protects; never speculate in writing about who it protects against.
- **No secrets in the repo.** S3 credentials live in Electron `safeStorage` and reach rclone through
  its environment; never a plaintext config file.
- **No real project data, recordings, speaker names or consent records** in tests or fixtures.
  Synthesize them.

## Upstream conventions to leave alone

Upstream uses beads for issues (`.beads/`, `.claude/skills/beads/`) and its own Playwright e2e
suite. Don't modify them. Keep changes to upstream files minimal and well-separated (new modules
over edits), so that merging new upstream releases stays cheap.

---

## Upstream lameta's own instructions (unchanged; imported)

@AGENTS.md
