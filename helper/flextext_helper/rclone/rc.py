# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""A minimal client for rclone's remote-control API (https://rclone.org/rc/): POST JSON to
http://127.0.0.1:<port>/<path> with basic auth."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


class RcError(Exception):
    def __init__(self, message: str, code: int = 500, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class RcClient:
    def __init__(self, url: str, user: str = "", password: str = ""):
        self.url = url.rstrip("/")
        self.user = user
        self.password = password

    def call(self, path: str, params: Optional[Dict[str, Any]] = None, timeout: float = 30.0) -> Dict[str, Any]:
        body = json.dumps(params or {}).encode("utf-8")
        req = urllib.request.Request(f"{self.url}/{path.lstrip('/')}", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if self.user:
            token = base64.b64encode(f"{self.user}:{self.password}".encode("utf-8")).decode("ascii")
            req.add_header("Authorization", f"Basic {token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - loopback only
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                data = json.loads(raw)
                message = data.get("error") or raw
            except Exception:  # noqa: BLE001
                data, message = None, raw
            raise RcError(f"rclone {path}: {message}", code=e.code, data=data) from None
        except urllib.error.URLError as e:
            raise RcError(f"rclone {path}: {e.reason}", code=503) from None
        if not raw.strip():
            return {}
        return json.loads(raw)
