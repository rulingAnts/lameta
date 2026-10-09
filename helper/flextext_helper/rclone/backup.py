# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The pure part of S3 backup (PLAN §3): building rclone's environment and rc requests.
No I/O here, so every rule is unit-tested.

Rules:
* credentials become RCLONE_CONFIG_FTS3_* environment variables, never a config file;
* a backup is `sync/sync` of the whole project folder with `--backup-dir <prefix>-history/<ts>`,
  so whatever a sync would overwrite or delete on the remote is moved aside, never lost;
* OS clutter and the §5 open marker are excluded;
* a restore goes to a NEW (absent or empty) folder, never over the open project.
"""

from __future__ import annotations

import datetime as _dt
import os
import re
from typing import Any, Dict, List, Optional

from .supervisor import REMOTE_NAME

EXCLUDES: List[str] = ["Thumbs.db", "desktop.ini", ".DS_Store", ".flextext-open.json"]

REQUIRED_KEYS = ("endpoint", "bucket", "accessKeyId", "secretAccessKey")


class BackupConfigError(ValueError):
    pass


def validate_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    s = {k: (str(v).strip() if v is not None else "") for k, v in settings.items()}
    missing = [k for k in REQUIRED_KEYS if not s.get(k)]
    if missing:
        raise BackupConfigError("missing backup settings: " + ", ".join(missing))
    if not re.match(r"^https?://", s["endpoint"]):
        raise BackupConfigError("endpoint must start with http:// or https://")
    if "/" in s["bucket"] or ":" in s["bucket"]:
        raise BackupConfigError("bucket must be a bare bucket name")
    s["prefix"] = s.get("prefix", "").strip("/")
    s.setdefault("region", "")
    s.setdefault("provider", "Other")
    return s


def rclone_env(settings: Dict[str, Any]) -> Dict[str, str]:
    """RCLONE_CONFIG_<REMOTE>_* variables defining the S3 remote in rclone's environment."""
    s = validate_settings(settings)
    name = REMOTE_NAME.upper()
    env = {
        f"RCLONE_CONFIG_{name}_TYPE": "s3",
        f"RCLONE_CONFIG_{name}_PROVIDER": s["provider"] or "Other",
        f"RCLONE_CONFIG_{name}_ENV_AUTH": "false",
        f"RCLONE_CONFIG_{name}_ACCESS_KEY_ID": s["accessKeyId"],
        f"RCLONE_CONFIG_{name}_SECRET_ACCESS_KEY": s["secretAccessKey"],
        f"RCLONE_CONFIG_{name}_ENDPOINT": s["endpoint"],
    }
    if s["region"]:
        env[f"RCLONE_CONFIG_{name}_REGION"] = s["region"]
    if s.get("forcePathStyle", "") not in ("", "false", "False", "0"):
        env[f"RCLONE_CONFIG_{name}_FORCE_PATH_STYLE"] = "true"
    return env


def remote_root(settings: Dict[str, Any], project_name: str) -> str:
    s = validate_settings(settings)
    parts = [p for p in (s["prefix"], project_name) if p]
    return f"{REMOTE_NAME}:{s['bucket']}/" + "/".join(parts)


def history_root(settings: Dict[str, Any], project_name: str, timestamp: Optional[_dt.datetime] = None) -> str:
    """`<prefix>-history/<timestamp>`: where a sync moves overwritten or deleted files."""
    s = validate_settings(settings)
    ts = (timestamp or _dt.datetime.now(_dt.timezone.utc)).strftime("%Y-%m-%dT%H-%M-%SZ")
    base = f"{s['prefix']}-history" if s["prefix"] else "history"
    parts = [base, project_name, ts]
    return f"{REMOTE_NAME}:{s['bucket']}/" + "/".join(p for p in parts if p)


def project_name_from_folder(folder: str) -> str:
    name = os.path.basename(os.path.normpath(folder))
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", name) or "project"


def backup_request(settings: Dict[str, Any], project_folder: str, timestamp: Optional[_dt.datetime] = None) -> Dict[str, Any]:
    """The `sync/sync` request body for backing up the whole project folder."""
    name = project_name_from_folder(project_folder)
    return {
        "srcFs": project_folder,
        "dstFs": remote_root(settings, name),
        "createEmptySrcDirs": True,
        "_async": True,
        "_group": f"backup/{name}",
        "_config": {"BackupDir": history_root(settings, name, timestamp)},
        "_filter": {"ExcludeRule": list(EXCLUDES)},
    }


def restore_request(settings: Dict[str, Any], project_name: str, destination_folder: str) -> Dict[str, Any]:
    """The `sync/copy` request restoring a backed-up project into a NEW folder."""
    return {
        "srcFs": remote_root(settings, project_name),
        "dstFs": destination_folder,
        "createEmptySrcDirs": True,
        "_async": True,
        "_group": f"restore/{project_name}",
    }


def check_restore_destination(destination_folder: str, open_project_folder: Optional[str]) -> None:
    """Restore only into a new folder: absent, or present but empty; never the open project or
    anything inside it."""
    dest = os.path.normcase(os.path.abspath(destination_folder))
    if open_project_folder:
        proj = os.path.normcase(os.path.abspath(open_project_folder))
        if dest == proj or dest.startswith(proj.rstrip(os.sep) + os.sep) or proj.startswith(dest.rstrip(os.sep) + os.sep):
            raise BackupConfigError("restore must go to a new folder, not the open project")
    if os.path.exists(destination_folder):
        if not os.path.isdir(destination_folder):
            raise BackupConfigError("restore destination exists and is not a folder")
        if os.listdir(destination_folder):
            raise BackupConfigError("restore destination must be an empty folder")


def bwlimit_request(rate: str) -> Dict[str, Any]:
    """`core/bwlimit`: '' or 'off' lifts the limit; otherwise rclone's rate syntax (e.g. 512k, 2M)."""
    r = (rate or "").strip()
    return {"rate": r if r else "off"}
