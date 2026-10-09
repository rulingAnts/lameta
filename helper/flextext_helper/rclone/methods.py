# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The backup JSON-RPC methods (PLAN §3), on the "general" lane:

    backupConfigure {endpoint, region, bucket, prefix, accessKeyId, secretAccessKey,
                     bwlimit?, forcePathStyle?}   -> starts rcd with the credentials in its env
    backupTestConnection {}                        -> lists the bucket root
    backupStart {projectFolder}                    -> async sync/sync; returns {jobid, ...}
    backupStatus {jobid}                           -> job/status + core/stats
    backupStop {jobid}                             -> job/stop
    backupListProjects {}                          -> project names present under the prefix
    backupRestore {projectName, destinationFolder, openProjectFolder?} -> async sync/copy to a NEW folder
    backupSetBwLimit {rate}                        -> core/bwlimit
    backupShutdown {}                              -> stops rcd (credentials leave memory)
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

from .. import jsonrpc
from ..jsonrpc import RpcError
from ..server import Context
from . import backup
from .rc import RcError
from .supervisor import RcloneSupervisor

log = logging.getLogger("flextext.rclone.methods")


def _params(params: Any) -> Dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise RpcError(jsonrpc.INVALID_PARAMS, "params must be an object")
    return params


class RcloneMethods:
    def __init__(self, rclone_path: Optional[str] = None, supervisor: Optional[RcloneSupervisor] = None):
        self.supervisor = supervisor or RcloneSupervisor(rclone_path)
        self.settings: Optional[Dict[str, Any]] = None

    def _wrap(self, fn: Callable[[Context, Dict[str, Any]], Any]) -> Callable[[Context, Any], Any]:
        def handler(ctx: Context, params: Any) -> Any:
            try:
                return fn(ctx, _params(params))
            except backup.BackupConfigError as e:
                raise RpcError(jsonrpc.INVALID_PARAMS, str(e)) from None
            except RcError as e:
                code = jsonrpc.RCLONE_NOT_RUNNING if e.code in (404, 503) else jsonrpc.RCLONE_ERROR
                raise RpcError(code, str(e), e.data) from None

        handler.__name__ = fn.__name__
        return handler

    def table(self) -> Dict[str, Callable[[Context, Any], Any]]:
        return {
            "backupConfigure": self._wrap(self.configure),
            "backupTestConnection": self._wrap(self.test_connection),
            "backupStart": self._wrap(self.start),
            "backupStatus": self._wrap(self.status),
            "backupStop": self._wrap(self.stop),
            "backupListProjects": self._wrap(self.list_projects),
            "backupRestore": self._wrap(self.restore),
            "backupSetBwLimit": self._wrap(self.set_bwlimit),
            "backupShutdown": self._wrap(self.shutdown),
            "rcloneInfo": self._wrap(self.info),
        }

    def close(self) -> None:
        try:
            self.supervisor.stop()
        except Exception:  # noqa: BLE001
            pass

    def _rc(self):
        if not self.supervisor.is_running():
            raise RcError("backup is not configured (rclone not running)", code=503)
        return self.supervisor.client()

    def _settings(self) -> Dict[str, Any]:
        if self.settings is None:
            raise RpcError(jsonrpc.RCLONE_NOT_RUNNING, "backup is not configured")
        return self.settings

    # -- handlers --------------------------------------------------------------------------

    def info(self, ctx: Context, p: Dict[str, Any]) -> Any:
        from .supervisor import find_rclone

        return {"rclone": find_rclone(self.supervisor.rclone_path), "running": self.supervisor.is_running(), "pid": self.supervisor.pid()}

    def configure(self, ctx: Context, p: Dict[str, Any]) -> Any:
        settings = backup.validate_settings(p)
        env = backup.rclone_env(settings)
        started = self.supervisor.start(env)
        self.settings = settings
        if settings.get("bwlimit"):
            self.supervisor.client().call("core/bwlimit", backup.bwlimit_request(settings["bwlimit"]))
        return {"ok": True, "rclonePid": started.get("pid"), "port": started.get("port")}

    def test_connection(self, ctx: Context, p: Dict[str, Any]) -> Any:
        s = self._settings()
        fs = f"{backup.REMOTE_NAME}:{s['bucket']}"
        remote = s.get("prefix", "")
        try:
            r = self._rc().call("operations/list", {"fs": fs, "remote": remote, "opt": {"recurse": False}}, timeout=30.0)
        except RcError as e:
            return {"ok": False, "message": str(e)}
        entries = r.get("list", [])
        return {"ok": True, "entries": len(entries), "sample": [e.get("Name") for e in entries[:10]]}

    def start(self, ctx: Context, p: Dict[str, Any]) -> Any:
        s = self._settings()
        folder = p.get("projectFolder")
        if not folder:
            raise RpcError(jsonrpc.INVALID_PARAMS, "missing param: projectFolder")
        req = backup.backup_request(s, str(folder))
        r = self._rc().call("sync/sync", req)
        return {"jobid": r.get("jobid"), "dstFs": req["dstFs"], "backupDir": req["_config"]["BackupDir"], "group": req["_group"]}

    def status(self, ctx: Context, p: Dict[str, Any]) -> Any:
        jobid = p.get("jobid")
        if jobid is None:
            raise RpcError(jsonrpc.INVALID_PARAMS, "missing param: jobid")
        rc = self._rc()
        job = rc.call("job/status", {"jobid": jobid})
        stats: Dict[str, Any] = {}
        try:
            stats = rc.call("core/stats", {"group": job.get("group") or f"job/{jobid}"})
        except RcError:
            pass
        return {"job": job, "stats": stats}

    def stop(self, ctx: Context, p: Dict[str, Any]) -> Any:
        jobid = p.get("jobid")
        if jobid is None:
            raise RpcError(jsonrpc.INVALID_PARAMS, "missing param: jobid")
        self._rc().call("job/stop", {"jobid": jobid})
        return True

    def list_projects(self, ctx: Context, p: Dict[str, Any]) -> Any:
        s = self._settings()
        fs = f"{backup.REMOTE_NAME}:{s['bucket']}"
        r = self._rc().call("operations/list", {"fs": fs, "remote": s.get("prefix", ""), "opt": {"recurse": False, "dirsOnly": True}})
        return [e.get("Name") for e in r.get("list", []) if e.get("IsDir")]

    def restore(self, ctx: Context, p: Dict[str, Any]) -> Any:
        s = self._settings()
        name = p.get("projectName")
        dest = p.get("destinationFolder")
        if not name or not dest:
            raise RpcError(jsonrpc.INVALID_PARAMS, "missing param: projectName / destinationFolder")
        backup.check_restore_destination(str(dest), p.get("openProjectFolder"))
        req = backup.restore_request(s, str(name), str(dest))
        r = self._rc().call("sync/copy", req)
        return {"jobid": r.get("jobid"), "srcFs": req["srcFs"], "destinationFolder": dest, "group": req["_group"]}

    def set_bwlimit(self, ctx: Context, p: Dict[str, Any]) -> Any:
        return self._rc().call("core/bwlimit", backup.bwlimit_request(str(p.get("rate", ""))))

    def shutdown(self, ctx: Context, p: Dict[str, Any]) -> Any:
        stopped = self.supervisor.stop()
        self.settings = None
        return stopped
