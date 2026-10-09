# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""S3 backup: the pure request building, the methods against a fake rc server, and (when an
rclone binary is available) an integration test against `rclone serve s3` on loopback."""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List

import pytest

from conftest import PipeServer
from flextext_helper import jsonrpc
from flextext_helper.rclone import backup
from flextext_helper.rclone.methods import RcloneMethods
from flextext_helper.rclone.rc import RcClient, RcError
from flextext_helper.rclone.supervisor import RcloneSupervisor, find_rclone
from flextext_helper.server import Server

SETTINGS = {
    "endpoint": "https://s3.example.test",
    "region": "ap-southeast-1",
    "bucket": "corpus-backups",
    "prefix": "team/lameta",
    "accessKeyId": "AKIAFAKEFAKEFAKE",
    "secretAccessKey": "fake/secret/not/real",
}

# ---------------------------------------------------------------- pure request building


def test_env_carries_credentials_and_nothing_is_written():
    env = backup.rclone_env(SETTINGS)
    assert env["RCLONE_CONFIG_FTS3_TYPE"] == "s3"
    assert env["RCLONE_CONFIG_FTS3_ACCESS_KEY_ID"] == "AKIAFAKEFAKEFAKE"
    assert env["RCLONE_CONFIG_FTS3_SECRET_ACCESS_KEY"] == "fake/secret/not/real"
    assert env["RCLONE_CONFIG_FTS3_ENDPOINT"] == "https://s3.example.test"
    assert env["RCLONE_CONFIG_FTS3_REGION"] == "ap-southeast-1"
    assert env["RCLONE_CONFIG_FTS3_ENV_AUTH"] == "false"


def test_validation():
    with pytest.raises(backup.BackupConfigError, match="missing"):
        backup.validate_settings({**SETTINGS, "secretAccessKey": ""})
    with pytest.raises(backup.BackupConfigError, match="endpoint"):
        backup.validate_settings({**SETTINGS, "endpoint": "s3.example.test"})
    with pytest.raises(backup.BackupConfigError, match="bucket"):
        backup.validate_settings({**SETTINGS, "bucket": "a/b"})
    s = backup.validate_settings({**SETTINGS, "prefix": "/team/x/"})
    assert s["prefix"] == "team/x"


def test_backup_request_is_a_sync_with_backup_dir_and_excludes():
    ts = dt.datetime(2026, 10, 10, 1, 2, 3, tzinfo=dt.timezone.utc)
    req = backup.backup_request(SETTINGS, "/home/me/Documents/lameta/Edolo corpus", ts)
    assert req["srcFs"] == "/home/me/Documents/lameta/Edolo corpus"
    assert req["dstFs"] == "fts3:corpus-backups/team/lameta/Edolo corpus"
    assert req["_async"] is True
    assert req["_config"]["BackupDir"] == "fts3:corpus-backups/team/lameta-history/Edolo corpus/2026-10-10T01-02-03Z"
    assert set(req["_filter"]["ExcludeRule"]) == {"Thumbs.db", "desktop.ini", ".DS_Store", ".flextext-open.json"}


def test_history_without_prefix():
    s = {**SETTINGS, "prefix": ""}
    assert backup.remote_root(s, "P") == "fts3:corpus-backups/P"
    assert backup.history_root(s, "P", dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)) == "fts3:corpus-backups/history/P/2026-01-01T00-00-00Z"


def test_restore_destination_rules(tmp_path):
    proj = tmp_path / "Open"
    proj.mkdir()
    with pytest.raises(backup.BackupConfigError, match="new folder"):
        backup.check_restore_destination(str(proj), str(proj))
    with pytest.raises(backup.BackupConfigError, match="new folder"):
        backup.check_restore_destination(str(proj / "inside"), str(proj))
    with pytest.raises(backup.BackupConfigError, match="new folder"):
        backup.check_restore_destination(str(tmp_path), str(proj))  # a parent of the open project
    full = tmp_path / "Full"
    full.mkdir()
    (full / "x.txt").write_text("x")
    with pytest.raises(backup.BackupConfigError, match="empty"):
        backup.check_restore_destination(str(full), str(proj))
    empty = tmp_path / "Empty"
    empty.mkdir()
    backup.check_restore_destination(str(empty), str(proj))  # ok
    backup.check_restore_destination(str(tmp_path / "New"), str(proj))  # ok, absent
    assert backup.restore_request(SETTINGS, "P", "/tmp/New")["srcFs"] == "fts3:corpus-backups/team/lameta/P"


def test_bwlimit():
    assert backup.bwlimit_request("") == {"rate": "off"}
    assert backup.bwlimit_request("512k") == {"rate": "512k"}


# ---------------------------------------------------------------- fake rc server


class FakeRc:
    """A stand-in for `rclone rcd`: records every call, answers like rclone would."""

    def __init__(self):
        self.calls: List[Dict[str, Any]] = []
        self.user = "u"
        self.password = "p"
        self.jobs: Dict[int, Dict[str, Any]] = {}
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                auth = self.headers.get("Authorization", "")
                fake.calls.append({"path": self.path.lstrip("/"), "body": body, "auth": auth})
                status, reply = fake.handle(self.path.lstrip("/"), body)
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def handle(self, path, body):
        if path == "core/pid":
            return 200, {"pid": 4242}
        if path in ("sync/sync", "sync/copy"):
            jid = len(self.jobs) + 1
            self.jobs[jid] = {"id": jid, "finished": False, "group": body.get("_group")}
            return 200, {"jobid": jid}
        if path == "job/status":
            j = self.jobs.get(body.get("jobid"))
            return (200, j) if j else (500, {"error": "job not found"})
        if path == "job/stop":
            return 200, {}
        if path == "core/stats":
            return 200, {"bytes": 10, "transfers": 1}
        if path == "core/bwlimit":
            return 200, {"rate": body.get("rate")}
        if path == "operations/list":
            return 200, {"list": [{"Name": "ProjA", "IsDir": True}, {"Name": "x.txt", "IsDir": False}]}
        if path == "core/quit":
            return 200, {}
        return 404, {"error": f"no such path {path}"}

    def close(self):
        self.httpd.shutdown()


class FakeSupervisor(RcloneSupervisor):
    """Pretends to start rcd: points the client at the FakeRc."""

    def __init__(self, fake: FakeRc):
        super().__init__("fake-rclone")
        self.fake = fake
        self._running = False
        self.last_env: Dict[str, str] = {}

    def start(self, env_extra=None, timeout=15.0):
        self.last_env = dict(env_extra or {})
        self._running = True
        self.port = self.fake.port
        self.user, self.password = self.fake.user, self.fake.password
        return {"pid": 4242, "port": self.port}

    def stop(self, grace=3.0):
        was = self._running
        self._running = False
        return was

    def is_running(self):
        return self._running

    def pid(self):
        return 4242 if self._running else None


@pytest.fixture
def rc_env():
    fake = FakeRc()
    sup = FakeSupervisor(fake)
    methods = RcloneMethods(supervisor=sup)

    def factory(stdin, stdout):
        s = Server(stdin, stdout)
        s.register_all(methods.table(), lane="general")
        s.on_shutdown(methods.close)
        return s

    ps = PipeServer(factory)
    assert ps.read()["method"] == "ready"
    yield ps, fake, sup
    ps.close()
    fake.close()


def test_backup_methods_against_fake_rc(rc_env, tmp_path):
    ps, fake, sup = rc_env
    assert ps.call("backupStart", {"projectFolder": str(tmp_path)})["error"]["code"] == jsonrpc.RCLONE_NOT_RUNNING

    r = ps.call("backupConfigure", {**SETTINGS, "bwlimit": "1M"})
    assert r["result"]["ok"] is True
    assert sup.last_env["RCLONE_CONFIG_FTS3_SECRET_ACCESS_KEY"] == SETTINGS["secretAccessKey"]
    assert fake.calls[-1]["path"] == "core/bwlimit" and fake.calls[-1]["body"] == {"rate": "1M"}
    assert fake.calls[-1]["auth"].startswith("Basic ")

    t = ps.call("backupTestConnection")["result"]
    assert t["ok"] is True and t["entries"] == 2

    proj = tmp_path / "MyCorpus"
    proj.mkdir()
    r = ps.call("backupStart", {"projectFolder": str(proj)})["result"]
    assert r["jobid"] == 1 and r["dstFs"].endswith("/MyCorpus")
    sync = [c for c in fake.calls if c["path"] == "sync/sync"][0]["body"]
    assert sync["srcFs"] == str(proj) and sync["_async"] is True
    assert ".flextext-open.json" in sync["_filter"]["ExcludeRule"]
    assert "-history/" in sync["_config"]["BackupDir"]

    st = ps.call("backupStatus", {"jobid": 1})["result"]
    assert st["job"]["finished"] is False and st["stats"]["bytes"] == 10
    assert ps.call("backupStop", {"jobid": 1})["result"] is True
    assert ps.call("backupListProjects")["result"] == ["ProjA"]

    # restore only into a new folder
    r = ps.call("backupRestore", {"projectName": "ProjA", "destinationFolder": str(proj), "openProjectFolder": str(proj)})
    assert r["error"]["code"] == jsonrpc.INVALID_PARAMS and "new folder" in r["error"]["message"]
    r = ps.call("backupRestore", {"projectName": "ProjA", "destinationFolder": str(tmp_path / "Restored"), "openProjectFolder": str(proj)})["result"]
    assert r["jobid"] == 2
    copy = [c for c in fake.calls if c["path"] == "sync/copy"][0]["body"]
    assert copy["dstFs"] == str(tmp_path / "Restored") and copy["srcFs"].endswith("/ProjA")

    assert ps.call("backupSetBwLimit", {"rate": ""})["result"] == {"rate": "off"}
    assert ps.call("backupShutdown")["result"] is True
    assert ps.call("backupTestConnection")["error"]["code"] == jsonrpc.RCLONE_NOT_RUNNING


def test_rc_client_errors():
    fake = FakeRc()
    try:
        c = RcClient(f"http://127.0.0.1:{fake.port}", "u", "p")
        with pytest.raises(RcError) as ei:
            c.call("nope/nope")
        assert ei.value.code == 404 and "no such path" in str(ei.value)
        with pytest.raises(RcError) as ei:
            RcClient("http://127.0.0.1:1").call("core/pid", timeout=1)
        assert ei.value.code == 503
    finally:
        fake.close()


# ---------------------------------------------------------------- real rclone (optional)

RCLONE = find_rclone(os.environ.get("FLEXTEXT_RCLONE"))


@pytest.mark.skipif(not RCLONE, reason="no rclone binary (set FLEXTEXT_RCLONE or put rclone on PATH)")
def test_supervisor_starts_and_stops_real_rcd():
    sup = RcloneSupervisor(RCLONE)
    info = sup.start({})
    try:
        assert info["pid"] and sup.is_running()
        assert sup.client().call("core/pid")["pid"] == info["pid"]
        # the random token is required
        with pytest.raises(RcError):
            RcClient(sup.url, "wrong", "wrong").call("core/pid")
    finally:
        assert sup.stop() is True
    assert not sup.is_running()


@pytest.mark.skipif(not RCLONE, reason="no rclone binary (set FLEXTEXT_RCLONE or put rclone on PATH)")
def test_backup_and_restore_against_rclone_serve_s3(tmp_path):
    """End to end on loopback: `rclone serve s3` is the bucket; the helper backs a project folder
    up into it (excluding the open marker), restores it to a new folder, and a second backup
    after a deletion moves the deleted file into the history prefix (PLAN §8)."""
    import hashlib
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s3_port = s.getsockname()[1]
    bucket_root = tmp_path / "s3root"
    (bucket_root / "corpus-backups").mkdir(parents=True)
    key, secret = "testkey", "testsecret"
    s3 = subprocess.Popen(
        [RCLONE, "serve", "s3", "--addr", f"127.0.0.1:{s3_port}", "--auth-key", f"{key},{secret}", str(bucket_root)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(1.0)
        settings = {
            "endpoint": f"http://127.0.0.1:{s3_port}",
            "region": "",
            "bucket": "corpus-backups",
            "prefix": "team",
            "accessKeyId": key,
            "secretAccessKey": secret,
            "forcePathStyle": "true",
        }
        proj = tmp_path / "SyntheticProject"
        (proj / "Sessions" / "S1").mkdir(parents=True)
        (proj / "SyntheticProject.sprj").write_text("<Project/>")
        (proj / "Sessions" / "S1" / "S1.session").write_text("<Session/>")
        (proj / "Sessions" / "S1" / "note.txt").write_text("to be deleted later")
        (proj / ".flextext-open.json").write_text("{}")
        (proj / "Thumbs.db").write_bytes(b"\0")

        methods = RcloneMethods(rclone_path=RCLONE)
        try:
            from flextext_helper.server import Context

            ctx = Context(1, Server(open(os.devnull), open(os.devnull, "w")))
            assert methods.configure(ctx, settings)["ok"]
            assert methods.test_connection(ctx, {})["ok"], "rclone could not list the serve-s3 bucket"

            def wait_job(jobid):
                for _ in range(200):
                    st = methods.status(ctx, {"jobid": jobid})
                    if st["job"].get("finished"):
                        assert st["job"].get("success"), st["job"]
                        return st
                    time.sleep(0.1)
                raise AssertionError("job did not finish")

            jid = methods.start(ctx, {"projectFolder": str(proj)})["jobid"]
            wait_job(jid)
            backed = bucket_root / "corpus-backups" / "team" / "SyntheticProject"
            assert (backed / "SyntheticProject.sprj").exists()
            assert (backed / "Sessions" / "S1" / "note.txt").exists()
            assert not (backed / ".flextext-open.json").exists()
            assert not (backed / "Thumbs.db").exists()

            dest = tmp_path / "Restored"
            jid = methods.restore(ctx, {"projectName": "SyntheticProject", "destinationFolder": str(dest), "openProjectFolder": str(proj)})["jobid"]
            wait_job(jid)
            for rel in ("SyntheticProject.sprj", "Sessions/S1/S1.session", "Sessions/S1/note.txt"):
                a = hashlib.sha256((proj / rel).read_bytes()).hexdigest()
                b = hashlib.sha256((dest / rel).read_bytes()).hexdigest()
                assert a == b, rel

            # delete a file, back up again: the deleted file lands in the history prefix
            (proj / "Sessions" / "S1" / "note.txt").unlink()
            jid = methods.start(ctx, {"projectFolder": str(proj)})["jobid"]
            wait_job(jid)
            assert not (backed / "Sessions" / "S1" / "note.txt").exists()
            history = bucket_root / "corpus-backups" / "team-history" / "SyntheticProject"
            moved = list(history.rglob("note.txt"))
            assert moved, f"deleted file not found under {history}"
        finally:
            methods.close()
    finally:
        s3.terminate()
        try:
            s3.wait(timeout=5)
        except subprocess.TimeoutExpired:
            s3.kill()
