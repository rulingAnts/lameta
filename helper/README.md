# The FlexText Metadata helper

SPDX-License-Identifier: AGPL-3.0-or-later. Copyright (C) 2026 Seth Johnston.

A Python 3.12 (x64) process that Electron starts once per app session and talks to over
newline-delimited JSON-RPC 2.0 on stdin/stdout. It owns FLEx access (through
[flexicon](https://github.com/MattGyverLee/flexicon), Windows only) and supervises the one
grandchild, `rclone rcd`, for S3 backup. Design: `docs/flextext-metadata/PLAN.md` §1–§3.

```
flextext_helper/
  __main__.py      entry: python -m flextext_helper [--parent-pid N] [--adapter real|fake]
  server.py        the JSON-RPC loop: stdin reader, one FLEx lane, one general lane, cancel
  jsonrpc.py       message helpers and error codes
  watchdog.py      parent-PID watchdog (exit when Electron is gone)
  jobobject.py     Windows Job Object with KILL_ON_JOB_CLOSE (no-op elsewhere)
  flex/            adapter interface, FakeFlexicon, RealFlexicon (lazy `import flexicon`),
                   textStats, the FLEx methods
  rclone/          supervisor (rcd on loopback, random token), rc client, backup requests,
                   the backup methods
tests/             pytest, all with the fake adapter and fake/real rclone
flextext-helper.spec   PyInstaller --onedir spec
THIRD-PARTY-NOTICES/   licences shipped beside the helper
```

## Protocol

Requests: `{"jsonrpc":"2.0","id":1,"method":"listTexts","params":{}}`, one per line.
Responses and notifications come back one per line. On start the helper sends
`{"jsonrpc":"2.0","method":"ready","params":{"pid":…,"methods":[…]}}`.

Control methods, answered at once on the reader thread: `ping`, `cancel {id}`, `shutdown`.
Everything else is queued to a lane: FLEx methods (`listProjects`, `openProject {name}`,
`closeProject`, `currentProject`, `listTexts`, `readText {guid}`, `textStats {guid | guids | }`,
`readGenres`, `readPeople`, `sharingStatus`, `flexInfo`) run on the single FLEx thread; backup
methods (`backupConfigure`, `backupTestConnection`, `backupStart`, `backupStatus`, `backupStop`,
`backupListProjects`, `backupRestore`, `backupSetBwLimit`, `backupShutdown`, `rcloneInfo`) on
the general lane. Long handlers send `progress` notifications and honour `cancel`.

Error codes: `-32010` project locked (enable FLEx *Project Properties → Sharing → "Share project
contents with programs on this computer"*), `-32011` migration required (open the project in
FLEx once first), `-32012` FLEx/flexicon not installed, `-32013` no project open, `-32014` not
found, `-32001` cancelled, `-32020`/`-32021` rclone not running / rclone error.

## Running from source

```
python -m venv .venv && .venv/Scripts/pip install -r helper/requirements-dev.txt   # Windows
python -m pytest helper/tests                                                     # anywhere
python -m flextext_helper --adapter fake                                          # from helper/
```

Electron runs the frozen `flextext-helper.exe` from `resources/flextext-helper/`; set
`FLEXTEXT_HELPER_CMD="python -m flextext_helper"` (and `cwd` = `helper/`) to run from source
during development. `FLEXTEXT_FLEX_ADAPTER=fake` runs without FieldWorks.

## Building (Windows x64, CI)

```
pip install -r helper/requirements-dev.txt
pyinstaller --noconfirm helper/flextext-helper.spec     # -> helper/dist/flextext-helper/
scripts/flextext/fetch-rclone.sh                        # -> helper/third_party/rclone/
```

Python's architecture must match FieldWorks (x64): a mismatch fails at `import flexicon` with
an unhelpful error.
