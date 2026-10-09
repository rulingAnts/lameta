# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The JSON-RPC loop: framing, control methods, lanes, cancel, EOF."""

from __future__ import annotations

import json
import threading
import time

from conftest import PipeServer
from flextext_helper.server import Server
from flextext_helper import jsonrpc


def test_ping_and_unknown_method(pipe_server):
    assert pipe_server.call("ping")["result"] == "pong"
    r = pipe_server.call("noSuchMethod")
    assert r["error"]["code"] == jsonrpc.METHOD_NOT_FOUND


def test_parse_error_and_invalid_request(pipe_server):
    pipe_server.send_raw("{not json")
    r = pipe_server.read()
    assert r["error"]["code"] == jsonrpc.PARSE_ERROR and r["id"] is None
    pipe_server.send_raw(json.dumps({"id": 5, "method": "ping"}))  # no jsonrpc field
    r = pipe_server.read()
    assert r["error"]["code"] == jsonrpc.INVALID_REQUEST


def test_blank_lines_are_ignored(pipe_server):
    pipe_server.send_raw("")
    pipe_server.send_raw("   ")
    assert pipe_server.call("ping")["result"] == "pong"


def test_unicode_round_trip(pipe_server):
    """stdout is UTF-8 and not ASCII-escaped: a title with non-Latin text comes back intact."""
    pipe_server.call("openProject", {"name": "SampleProject"})
    r = pipe_server.call("listTexts")
    assert any(t["title"] == "The lizard and the moon" for t in r["result"])
    # the encoder keeps non-ASCII as is
    assert jsonrpc.encode({"t": "bulan ☾"}) == '{"t":"bulan ☾"}'


def _slow_server(stdin, stdout):
    s = Server(stdin, stdout)
    started = threading.Event()

    def slow(ctx, params):
        started.set()
        for _ in range(200):
            ctx.check_cancelled()
            time.sleep(0.01)
        return "finished"

    def quick(ctx, params):
        return "quick"

    s.register("slow", slow, lane="flex")
    s.register("quick", quick, lane="general")
    s.register("slowGeneral", slow, lane="general")
    s._test_started = started  # type: ignore[attr-defined]
    return s


def test_cancel_running_request():
    ps = PipeServer(_slow_server)
    assert ps.read()["method"] == "ready"
    rid = ps.request("slow")
    assert ps.server._test_started.wait(2)  # type: ignore[attr-defined]
    cid = ps.request("cancel", {"id": rid})
    cancel_reply = ps.read_response(cid)
    assert cancel_reply["result"] is True
    slow_reply = ps.read_response(rid)
    assert slow_reply["error"]["code"] == jsonrpc.CANCELLED
    ps.close()


def test_cancel_queued_request_before_it_starts():
    ps = PipeServer(_slow_server)
    assert ps.read()["method"] == "ready"
    first = ps.request("slow")
    assert ps.server._test_started.wait(2)  # type: ignore[attr-defined]
    second = ps.request("slow")  # queued behind the first on the flex lane
    cid = ps.request("cancel", {"id": second})
    replies = {}
    for _ in range(2):
        m = ps.read()
        replies[m["id"]] = m
    assert replies[cid]["result"] is True
    assert replies[second]["error"]["code"] == jsonrpc.CANCELLED
    # the first keeps running; cancel it too so the test ends quickly
    ps.request("cancel", {"id": first})
    ps.close()


def test_cancel_unknown_id_is_false():
    ps = PipeServer(_slow_server)
    assert ps.read()["method"] == "ready"
    assert ps.call("cancel", {"id": 12345})["result"] is False
    ps.close()


def test_lanes_do_not_block_each_other():
    ps = PipeServer(_slow_server)
    assert ps.read()["method"] == "ready"
    slow_id = ps.request("slow")
    assert ps.server._test_started.wait(2)  # type: ignore[attr-defined]
    quick_id = ps.request("quick")
    first = ps.read()
    assert first["id"] == quick_id and first["result"] == "quick"
    ps.request("cancel", {"id": slow_id})
    ps.close()


def test_shutdown_replies_then_stops():
    ps = PipeServer(_slow_server)
    assert ps.read()["method"] == "ready"
    r = ps.call("shutdown")
    assert r["result"] is True
    ps._thread.join(timeout=5)
    assert not ps._thread.is_alive()
    ps.close()


def test_stdin_eof_stops_the_server():
    ps = PipeServer(_slow_server)
    assert ps.read()["method"] == "ready"
    ps._stdin_w.close()
    ps._thread.join(timeout=5)
    assert not ps._thread.is_alive()


def test_shutdown_hooks_run_once():
    calls = []

    def factory(stdin, stdout):
        s = Server(stdin, stdout)
        s.on_shutdown(lambda: calls.append("closed"))
        return s

    ps = PipeServer(factory)
    assert ps.read()["method"] == "ready"
    ps.call("shutdown")
    ps._thread.join(timeout=5)
    ps.server.stop()  # a second stop is harmless
    assert calls == ["closed"]
    ps.close()


def test_handler_exception_becomes_server_error():
    def factory(stdin, stdout):
        s = Server(stdin, stdout)

        def boom(ctx, params):
            raise ValueError("kaboom")

        s.register("boom", boom)
        return s

    ps = PipeServer(factory)
    assert ps.read()["method"] == "ready"
    r = ps.call("boom")
    assert r["error"]["code"] == jsonrpc.SERVER_ERROR
    assert "kaboom" in r["error"]["message"]
    ps.close()


def test_notification_request_without_id_runs_but_gets_no_reply():
    seen = []

    def factory(stdin, stdout):
        s = Server(stdin, stdout)
        s.register("note", lambda ctx, p: seen.append(p))
        return s

    ps = PipeServer(factory)
    assert ps.read()["method"] == "ready"
    ps.send_raw(json.dumps({"jsonrpc": "2.0", "method": "note", "params": {"x": 1}}))
    assert ps.call("ping")["result"] == "pong"
    time.sleep(0.05)
    assert seen == [{"x": 1}]
    ps.close()
