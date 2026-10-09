# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""Starts, watches and stops ONE `rclone rcd` child: the only grandchild of the app (PLAN §1).

* loopback only, a random port, a random user/password for every start;
* credentials reach rclone ONLY through its environment (RCLONE_CONFIG_<REMOTE>_*), so there is
  never a plaintext rclone.conf; RCLONE_CONFIG points at a path that is never written;
* stop = `core/quit` over rc, then psutil terminate, then kill; and on Windows the Job Object
  (jobobject.py) kills it anyway if this process dies.
"""

from __future__ import annotations

import logging
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from typing import Dict, Optional

import psutil

from .rc import RcClient, RcError

log = logging.getLogger("flextext.rclone")

#: the remote name used in RCLONE_CONFIG_<NAME>_* variables and in "<name>:bucket/prefix"
REMOTE_NAME = "fts3"


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_rclone(explicit: Optional[str] = None) -> Optional[str]:
    """The rclone executable: an explicit path, FLEXTEXT_RCLONE, beside the frozen helper
    (<resources>/rclone/rclone.exe, as electron-builder.flextext.json5 lays it out), or PATH."""
    exe = "rclone.exe" if os.name == "nt" else "rclone"
    candidates = []
    if explicit:
        candidates.append(explicit)
    env = os.environ.get("FLEXTEXT_RCLONE")
    if env:
        candidates.append(env)
    if getattr(sys, "frozen", False):
        here = os.path.dirname(sys.executable)  # <resources>/flextext-helper
        candidates.append(os.path.join(os.path.dirname(here), "rclone", exe))
        candidates.append(os.path.join(here, "rclone", exe))
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    import shutil

    return shutil.which(exe)


class RcloneSupervisor:
    def __init__(self, rclone_path: Optional[str] = None):
        self.rclone_path = rclone_path
        self.proc: Optional[psutil.Popen] = None
        self.port: int = 0
        self.user: str = ""
        self.password: str = ""
        self.env_extra: Dict[str, str] = {}
        self._drain: Optional[threading.Thread] = None
        self._lock = threading.RLock()
        self._tmpdir = tempfile.mkdtemp(prefix="flextext-rclone-")

    # -- state -----------------------------------------------------------------------------

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def client(self) -> RcClient:
        if not self.is_running():
            raise RcError("rclone is not running", code=503)
        return RcClient(self.url, self.user, self.password)

    def is_running(self) -> bool:
        with self._lock:
            return self.proc is not None and self.proc.is_running() and self.proc.poll() is None

    def pid(self) -> Optional[int]:
        with self._lock:
            return self.proc.pid if self.is_running() else None

    # -- lifecycle -------------------------------------------------------------------------

    def start(self, env_extra: Optional[Dict[str, str]] = None, timeout: float = 15.0) -> Dict[str, object]:
        """(Re)starts rcd with the given extra environment (the remote's credentials)."""
        with self._lock:
            self.stop()
            path = find_rclone(self.rclone_path)
            if not path:
                raise RcError("rclone executable not found", code=404)
            self.env_extra = dict(env_extra or {})
            self.port = free_loopback_port()
            self.user = "fts-" + secrets.token_urlsafe(8)
            self.password = secrets.token_urlsafe(32)
            env = {k: v for k, v in os.environ.items() if not k.startswith("RCLONE_")}
            env.update(self.env_extra)
            env["RCLONE_CONFIG"] = os.path.join(self._tmpdir, "never-written.conf")
            args = [
                path,
                "rcd",
                "--rc-addr", f"127.0.0.1:{self.port}",
                "--rc-user", self.user,
                "--rc-pass", self.password,
                "--rc-no-auth=false",
                "--log-level", "INFO",
                "--use-json-log",
            ]
            kwargs: Dict[str, object] = {}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            self.proc = psutil.Popen(
                args,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                **kwargs,
            )
            self._drain = threading.Thread(target=self._drain_stderr, args=(self.proc,), name="rclone-stderr", daemon=True)
            self._drain.start()
            log.info("rclone rcd pid=%s port=%s", self.proc.pid, self.port)
        # wait until rc answers
        deadline = time.monotonic() + timeout
        last: Optional[Exception] = None
        while time.monotonic() < deadline:
            if not self.is_running():
                raise RcError("rclone exited during startup", code=500)
            try:
                info = self.client().call("core/pid", {}, timeout=2.0)
                return {"pid": info.get("pid", self.pid()), "port": self.port}
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(0.1)
        self.stop()
        raise RcError(f"rclone rc did not answer: {last}", code=504)

    def _drain_stderr(self, proc: psutil.Popen) -> None:
        try:
            assert proc.stderr is not None
            for raw in proc.stderr:
                line = raw.decode("utf-8", "replace").rstrip()
                if line:
                    log.info("rclone: %s", line)
        except Exception:  # noqa: BLE001
            pass

    def stop(self, grace: float = 3.0) -> bool:
        """Asks rclone to quit, then terminates, then kills. Returns True if a process was stopped."""
        with self._lock:
            proc = self.proc
            self.proc = None
        if proc is None:
            return False
        if proc.poll() is None:
            try:
                RcClient(self.url, self.user, self.password).call("core/quit", {}, timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.wait(timeout=grace)
            except psutil.TimeoutExpired:
                log.warning("rclone did not quit; terminating")
                self._kill_tree(proc)
        try:
            if proc.stderr:
                proc.stderr.close()
        except Exception:  # noqa: BLE001
            pass
        return True

    @staticmethod
    def _kill_tree(proc: psutil.Popen) -> None:
        """psutil reliably finds and kills every child (PLAN §1): the reason rclone is supervised
        from Python rather than from Node."""
        try:
            children = proc.children(recursive=True)
        except psutil.Error:
            children = []
        for p in [*children, proc]:
            try:
                p.terminate()
            except psutil.Error:
                pass
        _, alive = psutil.wait_procs([*children, proc], timeout=2.0)
        for p in alive:
            try:
                p.kill()
            except psutil.Error:
                pass
