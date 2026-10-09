# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The FlexText Metadata helper: FLEx (via flexicon) and rclone, behind JSON-RPC 2.0 on stdio.

One long-lived helper per app session (docs/flextext-metadata/PLAN.md §1, §2):

* stdout carries protocol only (UTF-8, one JSON object per line, flushed per line);
  logs go to stderr;
* a stdin reader thread plus ONE worker thread that owns every FLEx/LCM call;
* cancel is a message, exit happens when stdin closes, with a parent-PID watchdog behind that;
* on Windows the process puts itself in a Job Object with KILL_ON_JOB_CLOSE, so rclone, the
  only grandchild, dies with it.
"""

__version__ = "0.1.0"
