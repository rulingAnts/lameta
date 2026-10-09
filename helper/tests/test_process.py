# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The helper as a real subprocess: ready banner, stdout-is-protocol, EOF exit, watchdog."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import psutil
import pytest

HELPER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def spawn(extra_args=(), parent_pid=None):
    args = [sys.executable, "-m", "flextext_helper", "--adapter", "fake", "--no-job-object", *extra_args]
    if parent_pid:
        args += ["--parent-pid", str(parent_pid)]
    env = dict(os.environ, PYTHONPATH=HELPER_DIR, PYTHONIOENCODING="utf-8")
    return subprocess.Popen(
        args,
        cwd=HELPER_DIR,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


def test_subprocess_ready_ping_and_eof_exit():
    p = spawn()
    try:
        ready = json.loads(p.stdout.readline())
        assert ready["method"] == "ready" and ready["params"]["pid"] == p.pid
        assert "textStats" in ready["params"]["methods"]
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n")
        p.stdin.flush()
        assert json.loads(p.stdout.readline())["result"] == "pong"
        # every stdout line so far was JSON: logs went to stderr
        p.stdin.close()
        p.wait(timeout=10)
        assert p.returncode == 0
        rest = p.stdout.read()
        for line in rest.splitlines():
            json.loads(line)
        err = p.stderr.read()
        assert "helper starting" in err
    finally:
        if p.poll() is None:
            p.kill()


def test_shutdown_method_exits_cleanly():
    p = spawn()
    try:
        p.stdout.readline()
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "shutdown"}) + "\n")
        p.stdin.flush()
        assert json.loads(p.stdout.readline())["result"] is True
        p.wait(timeout=10)
        assert p.returncode == 0
    finally:
        if p.poll() is None:
            p.kill()


@pytest.mark.skipif(sys.platform == "win32", reason="uses a python sleeper as the fake parent; CI's Windows test covers the real app")
def test_watchdog_exits_when_parent_dies():
    """Start a throwaway 'parent', point the helper at it with the pipe held open, kill the
    parent: the helper must exit on its own within a few seconds."""
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    p = spawn(parent_pid=parent.pid)
    try:
        p.stdout.readline()
        parent.kill()
        parent.wait()
        t0 = time.monotonic()
        p.wait(timeout=8)
        assert time.monotonic() - t0 < 8
    finally:
        if p.poll() is None:
            p.kill()


def test_helper_is_a_single_process_with_no_children_when_idle():
    p = spawn()
    try:
        p.stdout.readline()
        assert psutil.Process(p.pid).children(recursive=True) == []
    finally:
        p.stdin.close()
        p.wait(timeout=10)
