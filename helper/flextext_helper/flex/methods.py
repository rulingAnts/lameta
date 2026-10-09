# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The FLEx JSON-RPC methods (PLAN §2, read-only): ping is in the server; here are
listProjects, openProject, closeProject, currentProject, listTexts, readText, textStats,
readGenres, readPeople, sharingStatus, flexInfo. All run on the "flex" lane.

Error mapping (adapter.FlexError subclasses -> JSON-RPC codes, with the plain user message):
    FlexLocked            -> -32010  "enable Sharing in FLEx Project Properties"
    FlexMigrationRequired -> -32011  "open the project in FLEx once first"
    FlexNotInstalled      -> -32012
    FlexNoProjectOpen     -> -32013
    FlexNotFound          -> -32014
    other FlexError       -> -32019
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from .. import jsonrpc
from ..jsonrpc import RpcError
from ..server import Context
from .adapter import (
    FlexAdapter,
    FlexError,
    FlexLocked,
    FlexMigrationRequired,
    FlexNoProjectOpen,
    FlexNotFound,
    FlexNotInstalled,
)
from .stats import text_stats

_CODES = {
    FlexLocked: jsonrpc.FLEX_LOCKED,
    FlexMigrationRequired: jsonrpc.FLEX_MIGRATION_REQUIRED,
    FlexNotInstalled: jsonrpc.FLEX_NOT_INSTALLED,
    FlexNoProjectOpen: jsonrpc.FLEX_NO_PROJECT_OPEN,
    FlexNotFound: jsonrpc.FLEX_NOT_FOUND,
}


def to_rpc_error(e: FlexError) -> RpcError:
    for cls, code in _CODES.items():
        if isinstance(e, cls):
            return RpcError(code, str(e) or cls.__name__, {"kind": e.code})
    return RpcError(jsonrpc.FLEX_ERROR, str(e) or "FLEx error", {"kind": e.code})


def _params(params: Any) -> Dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise RpcError(jsonrpc.INVALID_PARAMS, "params must be an object")
    return params


def _require(params: Dict[str, Any], key: str) -> Any:
    v = params.get(key)
    if v is None or v == "":
        raise RpcError(jsonrpc.INVALID_PARAMS, f"missing param: {key}")
    return v


class FlexMethods:
    def __init__(self, adapter: FlexAdapter):
        self.adapter = adapter

    # every handler goes through this, so adapter errors become RPC errors in one place
    def _wrap(self, fn: Callable[[Context, Dict[str, Any]], Any]) -> Callable[[Context, Any], Any]:
        def handler(ctx: Context, params: Any) -> Any:
            try:
                return fn(ctx, _params(params))
            except FlexError as e:
                raise to_rpc_error(e) from None

        handler.__name__ = fn.__name__
        return handler

    def table(self) -> Dict[str, Callable[[Context, Any], Any]]:
        return {
            "flexInfo": self._wrap(self.flex_info),
            "listProjects": self._wrap(self.list_projects),
            "openProject": self._wrap(self.open_project),
            "closeProject": self._wrap(self.close_project),
            "currentProject": self._wrap(self.current_project),
            "listTexts": self._wrap(self.list_texts),
            "readText": self._wrap(self.read_text),
            "textStats": self._wrap(self.text_stats),
            "readGenres": self._wrap(self.read_genres),
            "readPeople": self._wrap(self.read_people),
            "sharingStatus": self._wrap(self.sharing_status),
        }

    def close(self) -> None:
        try:
            if self.adapter.is_open():
                self.adapter.close_project()
        except Exception:  # noqa: BLE001
            pass

    # -- handlers --------------------------------------------------------------------------

    def flex_info(self, ctx: Context, p: Dict[str, Any]) -> Any:
        return self.adapter.version_info()

    def list_projects(self, ctx: Context, p: Dict[str, Any]) -> Any:
        return self.adapter.list_projects()

    def open_project(self, ctx: Context, p: Dict[str, Any]) -> Any:
        name = _require(p, "name")
        if self.adapter.is_open():
            self.adapter.close_project()
        return self.adapter.open_project(str(name))

    def close_project(self, ctx: Context, p: Dict[str, Any]) -> Any:
        was_open = self.adapter.is_open()
        if was_open:
            self.adapter.close_project()
        return was_open

    def current_project(self, ctx: Context, p: Dict[str, Any]) -> Any:
        return self.adapter.current_project()

    def list_texts(self, ctx: Context, p: Dict[str, Any]) -> Any:
        if p.get("refresh"):
            self.adapter.refresh()
        return self.adapter.list_texts()

    def read_text(self, ctx: Context, p: Dict[str, Any]) -> Any:
        guid = _require(p, "guid")
        return self.adapter.read_text(str(guid))

    def text_stats(self, ctx: Context, p: Dict[str, Any]) -> Any:
        """textStats for one guid, a list of guids, or (no params) every text. Long scans
        report progress and honour cancel between texts."""
        if p.get("refresh"):
            self.adapter.refresh()
        guids: List[str]
        if "guid" in p:
            guids = [str(p["guid"])]
        elif "guids" in p:
            guids = [str(g) for g in p["guids"]]
        else:
            guids = [t["guid"] for t in self.adapter.list_texts()]
        out = []
        for i, g in enumerate(guids):
            ctx.check_cancelled()
            out.append(text_stats(self.adapter.read_text(g)))
            if len(guids) > 1 and (i % 10 == 9 or i == len(guids) - 1):
                ctx.progress(done=i + 1, total=len(guids))
        return out[0] if "guid" in p else out

    def read_genres(self, ctx: Context, p: Dict[str, Any]) -> Any:
        return self.adapter.read_genres()

    def read_people(self, ctx: Context, p: Dict[str, Any]) -> Any:
        return self.adapter.read_people()

    def sharing_status(self, ctx: Context, p: Dict[str, Any]) -> Any:
        """Never toggles the setting (PLAN §2): it reports, and the remedy text travels with
        a locked result so the UI can show it."""
        try:
            status = self.adapter.sharing_status()
        except FlexLocked as e:
            return {"shared": False, "locked": True, "remedy": str(e)}
        status.setdefault("locked", False)
        return status
