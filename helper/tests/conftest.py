# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""pytest fixtures: an in-process server bound to string pipes, and a subprocess helper."""

from __future__ import annotations

import io
import json
import os
import sys
import threading
from typing import Any, Dict, List

import pytest

HELPER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if HELPER_DIR not in sys.path:
    sys.path.insert(0, HELPER_DIR)

from flextext_helper.server import Server  # noqa: E402
from flextext_helper.flex.fake import FakeFlexicon  # noqa: E402
from flextext_helper.flex.methods import FlexMethods  # noqa: E402


class PipeServer:
    """Runs a Server on an in-memory stdin/stdout so tests can send lines and read replies."""

    def __init__(self, server_factory=None):
        self._in_r, self._in_w = os.pipe()
        self._stdin = os.fdopen(self._in_r, "r", encoding="utf-8")
        self._stdin_w = os.fdopen(self._in_w, "w", encoding="utf-8")
        self._out = io.StringIO()
        self._out_lock = threading.Lock()
        self._lines: List[str] = []
        self._cond = threading.Condition()
        self.server = (server_factory or self._default)(self._stdin, self)
        self._thread = threading.Thread(target=self.server.serve, daemon=True)
        self._thread.start()
        self.next_id = 0

    @staticmethod
    def _default(stdin, stdout):
        s = Server(stdin, stdout)
        fm = FlexMethods(FakeFlexicon())
        s.register_all(fm.table(), lane="flex")
        s.on_shutdown(fm.close)
        return s

    # file-like stdout for the server
    def write(self, s: str) -> None:
        with self._cond:
            for line in s.splitlines():
                if line:
                    self._lines.append(line)
            self._cond.notify_all()

    def flush(self) -> None:
        pass

    def send_raw(self, line: str) -> None:
        self._stdin_w.write(line + "\n")
        self._stdin_w.flush()

    def request(self, method: str, params: Any = None, req_id: Any = None) -> Any:
        if req_id is None:
            self.next_id += 1
            req_id = self.next_id
        msg: Dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        self.send_raw(json.dumps(msg))
        return req_id

    def read(self, timeout: float = 5.0) -> Dict[str, Any]:
        with self._cond:
            if not self._lines:
                self._cond.wait(timeout)
            if not self._lines:
                raise TimeoutError("no output from server")
            return json.loads(self._lines.pop(0))

    def read_response(self, req_id: Any, timeout: float = 5.0) -> Dict[str, Any]:
        """Reads messages until the response with that id arrives (notifications are kept)."""
        import time

        deadline = time.monotonic() + timeout
        kept: List[Dict[str, Any]] = []
        while True:
            msg = self.read(max(0.01, deadline - time.monotonic()))
            if msg.get("id") == req_id and ("result" in msg or "error" in msg):
                with self._cond:
                    self._lines[0:0] = [json.dumps(k) for k in kept]
                return msg
            kept.append(msg)
            if time.monotonic() > deadline:
                raise TimeoutError(f"no response for id {req_id}")

    def call(self, method: str, params: Any = None, timeout: float = 5.0) -> Dict[str, Any]:
        rid = self.request(method, params)
        return self.read_response(rid, timeout)

    def close(self) -> None:
        try:
            self._stdin_w.close()
        except Exception:  # noqa: BLE001
            pass
        self._thread.join(timeout=5)


@pytest.fixture
def pipe_server():
    ps = PipeServer()
    ready = ps.read()
    assert ready["method"] == "ready"
    yield ps
    ps.close()
