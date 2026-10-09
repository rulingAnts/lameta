# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""Parent-PID watchdog: if the parent (Electron) disappears, the helper exits.

stdin EOF is the primary exit signal; this is the belt behind those braces, for the case where
the parent died without the pipe closing promptly (or was killed with the pipe inherited).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

log = logging.getLogger("flextext.watchdog")


def parent_is_alive(parent_pid: int) -> bool:
    """True while a process with that PID exists. On POSIX a reparented orphan's getppid()
    changes, which is the most reliable sign there; psutil covers Windows."""
    if parent_pid <= 0:
        return True
    if os.name != "nt":
        try:
            if os.getppid() != parent_pid:
                return False
        except OSError:
            pass
    try:
        import psutil

        return psutil.pid_exists(parent_pid) and psutil.Process(parent_pid).is_running()
    except Exception:
        # psutil missing or the process vanished between the two calls
        try:
            if os.name == "nt":
                return True  # cannot tell; stdin EOF remains the primary signal
            os.kill(parent_pid, 0)
            return True
        except OSError:
            return False


def start_watchdog(parent_pid: int, on_orphaned: Callable[[], None], interval: float = 1.0) -> threading.Thread:
    """Starts a daemon thread that calls on_orphaned() once the parent is gone."""

    def run():
        while True:
            time.sleep(interval)
            if not parent_is_alive(parent_pid):
                log.warning("parent %s is gone; exiting", parent_pid)
                on_orphaned()
                return

    t = threading.Thread(target=run, name="parent-watchdog", daemon=True)
    t.start()
    return t
