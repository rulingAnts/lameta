# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""JSON-RPC 2.0 message helpers and the helper's error codes."""

from __future__ import annotations

import json
from typing import Any

# Standard JSON-RPC 2.0 codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
SERVER_ERROR = -32000

# Helper-specific codes (the -32000..-32099 range is reserved for servers)
CANCELLED = -32001
SHUTTING_DOWN = -32002
FLEX_LOCKED = -32010
FLEX_MIGRATION_REQUIRED = -32011
FLEX_NOT_INSTALLED = -32012
FLEX_NO_PROJECT_OPEN = -32013
FLEX_NOT_FOUND = -32014
FLEX_ERROR = -32019
RCLONE_NOT_RUNNING = -32020
RCLONE_ERROR = -32021


class RpcError(Exception):
    """An error to send back to the caller as a JSON-RPC error object."""

    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_dict(self) -> dict:
        d: dict = {"code": self.code, "message": self.message}
        if self.data is not None:
            d["data"] = self.data
        return d


class Cancelled(RpcError):
    def __init__(self, message: str = "cancelled"):
        super().__init__(CANCELLED, message)


def response(req_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def error_response(req_id: Any, err: RpcError | Exception) -> dict:
    if isinstance(err, RpcError):
        e = err.to_dict()
    else:
        e = {"code": SERVER_ERROR, "message": f"{type(err).__name__}: {err}"}
    return {"jsonrpc": "2.0", "id": req_id, "error": e}


def notification(method: str, params: Any = None) -> dict:
    msg: dict = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def encode(msg: dict) -> str:
    """One line, no embedded newlines, ASCII-safe is NOT required: stdout is UTF-8."""
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":"))


def parse_request(line: str) -> dict:
    """Parses one request line. Raises RpcError(PARSE_ERROR / INVALID_REQUEST)."""
    try:
        msg = json.loads(line)
    except json.JSONDecodeError as e:
        raise RpcError(PARSE_ERROR, f"parse error: {e}") from None
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        raise RpcError(INVALID_REQUEST, "not a JSON-RPC 2.0 request")
    method = msg.get("method")
    if not isinstance(method, str) or not method:
        raise RpcError(INVALID_REQUEST, "missing method")
    params = msg.get("params")
    if params is not None and not isinstance(params, (dict, list)):
        raise RpcError(INVALID_REQUEST, "params must be an object or array")
    return msg
