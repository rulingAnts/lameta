# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The JSON-RPC 2.0 server loop: newline-delimited requests on stdin, responses and
notifications on stdout.

Threads:
* the main thread reads stdin and handles the control methods (ping, cancel, shutdown) at once;
* every other method is queued to a worker lane; the "flex" lane is ONE thread that owns all
  FLEx/LCM calls (LCM is not documented as thread-safe), the "general" lane serves the rest
  (rclone, file work) so a long FLEx scan never blocks backup progress;
* a parent-PID watchdog thread.

Cancel is a message: {"method":"cancel","params":{"id":N}}. A queued request is dropped and
answered with error -32001; a running one has its cancel flag set, which long handlers poll.
"""

from __future__ import annotations

import logging
import os
import queue
import sys
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, TextIO

from . import jsonrpc
from .jsonrpc import RpcError

log = logging.getLogger("flextext.server")

Handler = Callable[["Context", Any], Any]


class Context:
    """What a handler sees: its request id, a cancel flag, and a way to send notifications."""

    def __init__(self, req_id: Any, server: "Server"):
        self.id = req_id
        self._server = server
        self._cancel = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def cancel(self) -> None:
        self._cancel.set()

    def check_cancelled(self) -> None:
        if self.cancelled:
            raise jsonrpc.Cancelled()

    def notify(self, method: str, params: Any = None) -> None:
        self._server.send(jsonrpc.notification(method, params))

    def progress(self, **params: Any) -> None:
        self.notify("progress", {"id": self.id, **params})


@dataclass
class Registration:
    handler: Handler
    lane: str = "general"


@dataclass
class _Job:
    req_id: Any
    method: str
    params: Any
    ctx: Context
    dropped: bool = False


@dataclass
class Lane:
    name: str
    q: "queue.Queue[Optional[_Job]]" = field(default_factory=queue.Queue)
    thread: Optional[threading.Thread] = None
    running: Optional[_Job] = None
    lock: threading.Lock = field(default_factory=threading.Lock)


class Server:
    CONTROL_METHODS = ("ping", "cancel", "shutdown")

    def __init__(
        self,
        stdin: TextIO | None = None,
        stdout: TextIO | None = None,
        *,
        parent_pid: int = 0,
        lanes: tuple[str, ...] = ("flex", "general"),
    ):
        self._stdin = stdin or sys.stdin
        self._stdout = stdout or sys.stdout
        self._write_lock = threading.Lock()
        self._methods: Dict[str, Registration] = {}
        self._lanes: Dict[str, Lane] = {name: Lane(name) for name in lanes}
        self._jobs: Dict[Any, _Job] = {}
        self._jobs_lock = threading.Lock()
        self._stopping = threading.Event()
        self._on_shutdown: list[Callable[[], None]] = []
        self.parent_pid = parent_pid

    # -- registration ----------------------------------------------------------------------

    def register(self, method: str, handler: Handler, lane: str = "general") -> None:
        if lane not in self._lanes:
            raise ValueError(f"unknown lane {lane!r}")
        self._methods[method] = Registration(handler, lane)

    def register_all(self, table: Dict[str, Handler], lane: str) -> None:
        for name, h in table.items():
            self.register(name, h, lane)

    def on_shutdown(self, fn: Callable[[], None]) -> None:
        """Runs (in registration order, errors logged) when the server stops."""
        self._on_shutdown.append(fn)

    @property
    def methods(self) -> list[str]:
        return sorted(list(self._methods) + list(self.CONTROL_METHODS))

    # -- output ----------------------------------------------------------------------------

    def send(self, msg: dict) -> None:
        line = jsonrpc.encode(msg)
        with self._write_lock:
            try:
                self._stdout.write(line + "\n")
                self._stdout.flush()
            except (BrokenPipeError, OSError, ValueError):
                # the parent is gone: nothing to talk to any more
                log.warning("stdout closed; stopping")
                self._stopping.set()

    # -- main loop -------------------------------------------------------------------------

    def serve(self) -> None:
        """Reads stdin until EOF or shutdown. Returns when every lane has stopped."""
        for lane in self._lanes.values():
            lane.thread = threading.Thread(target=self._lane_loop, args=(lane,), name=f"lane-{lane.name}", daemon=True)
            lane.thread.start()
        self.send(jsonrpc.notification("ready", {"pid": os.getpid(), "methods": self.methods}))
        try:
            while not self._stopping.is_set():
                line = self._stdin.readline()
                if line == "":
                    log.info("stdin EOF; shutting down")
                    break
                line = line.strip()
                if not line:
                    continue
                self._handle_line(line)
        finally:
            self.stop()

    def stop(self) -> None:
        if self._stopping.is_set() and all(l.thread is None or not l.thread.is_alive() for l in self._lanes.values()):
            return
        self._stopping.set()
        # fail whatever is still queued
        with self._jobs_lock:
            for job in list(self._jobs.values()):
                if not job.dropped and job.ctx is not None:
                    job.ctx.cancel()
        for lane in self._lanes.values():
            lane.q.put(None)
        for lane in self._lanes.values():
            if lane.thread is not None:
                lane.thread.join(timeout=3.0)
        for fn in self._on_shutdown:
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                log.error("shutdown hook failed: %s", e)
        self._on_shutdown.clear()

    def request_stop(self) -> None:
        """Thread-safe: asks the main loop to stop after the next line. It does NOT close
        stdin: a file object cannot be closed from another thread while readline() holds it,
        so a caller that must exit regardless (the watchdog) arms its own hard exit."""
        self._stopping.set()

    # -- dispatch --------------------------------------------------------------------------

    def _handle_line(self, line: str) -> None:
        try:
            req = jsonrpc.parse_request(line)
        except RpcError as e:
            self.send(jsonrpc.error_response(None, e))
            return
        req_id = req.get("id")
        method = req["method"]
        params = req.get("params")

        if method == "ping":
            self._reply(req_id, "pong")
            return
        if method == "cancel":
            self._reply(req_id, self._cancel(params))
            return
        if method == "shutdown":
            self._reply(req_id, True)
            self._stopping.set()
            return

        reg = self._methods.get(method)
        if reg is None:
            self._reply_error(req_id, RpcError(jsonrpc.METHOD_NOT_FOUND, f"unknown method: {method}"))
            return
        if self._stopping.is_set():
            self._reply_error(req_id, RpcError(jsonrpc.SHUTTING_DOWN, "shutting down"))
            return
        if req_id is None:
            # a notification: run it, nobody listens for the result
            req_id = object()
        job = _Job(req_id, method, params, Context(req_id, self))
        with self._jobs_lock:
            self._jobs[req_id] = job
        self._lanes[reg.lane].q.put(job)

    def _cancel(self, params: Any) -> bool:
        target = (params or {}).get("id") if isinstance(params, dict) else None
        with self._jobs_lock:
            job = self._jobs.get(target)
            if job is None:
                return False
            if job.ctx is not None:
                job.ctx.cancel()
            lane = self._lanes[self._methods[job.method].lane]
            with lane.lock:
                if lane.running is not job:
                    job.dropped = True
        if job.dropped:
            with self._jobs_lock:
                self._jobs.pop(target, None)
            self._reply_error(target, jsonrpc.Cancelled("cancelled before it started"))
        return True

    def _lane_loop(self, lane: Lane) -> None:
        while True:
            job = lane.q.get()
            if job is None:
                return
            if job.dropped:
                continue
            with lane.lock:
                lane.running = job
            try:
                if job.ctx.cancelled:
                    raise jsonrpc.Cancelled()
                handler = self._methods[job.method].handler
                result = handler(job.ctx, job.params)
                if not isinstance(job.req_id, object) or not type(job.req_id) is object:
                    self._reply(job.req_id, result)
            except RpcError as e:
                if not type(job.req_id) is object:
                    self._reply_error(job.req_id, e)
            except Exception as e:  # noqa: BLE001 - every failure goes back to the caller
                log.exception("handler %s failed", job.method)
                if not type(job.req_id) is object:
                    self._reply_error(job.req_id, e)
            finally:
                with lane.lock:
                    lane.running = None
                with self._jobs_lock:
                    self._jobs.pop(job.req_id, None)

    def _reply(self, req_id: Any, result: Any) -> None:
        self.send(jsonrpc.response(req_id, result))

    def _reply_error(self, req_id: Any, err: RpcError | Exception) -> None:
        self.send(jsonrpc.error_response(req_id, err))
