# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The adapter interface between the JSON-RPC methods and FLEx.

Everything crossing this boundary is plain Python data (dicts, lists, str, int), so the fake
and the real adapter are interchangeable and the methods are testable without FieldWorks.

Shapes (all keys always present):

    project   {"name": str, "path": str|None}
    text      {"guid": str, "title": str, "abbreviation": str, "genres": [guid...],
               "paragraphCount": int}
    fullText  text + {"writingSystems": {"vernacular": [ws...], "analysis": [ws...]},
                      "paragraphs": [{"segments": [segment...]}]}
    segment   {"baseline": str,
               "words": [{"form": str, "glosses": {ws: str}, "morphGlossed": bool}],
               "freeTranslations": {ws: str}}
    genre     {"guid": str, "name": str, "abbreviation": str, "parentGuid": str|None}
    person    {"guid": str, "name": str}
    sharing   {"projectFolder": str|None, "backend": str|None, "shared": bool|None}
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class FlexError(Exception):
    """Base of every adapter error. `code` maps to a JSON-RPC error code in methods.py."""

    code = "FLEX_ERROR"


class FlexNotInstalled(FlexError):
    code = "FLEX_NOT_INSTALLED"


class FlexLocked(FlexError):
    """The project is open in FieldWorks and sharing is off."""

    code = "FLEX_LOCKED"


class FlexMigrationRequired(FlexError):
    code = "FLEX_MIGRATION_REQUIRED"


class FlexNoProjectOpen(FlexError):
    code = "FLEX_NO_PROJECT_OPEN"


class FlexNotFound(FlexError):
    code = "FLEX_NOT_FOUND"


# The plain messages users see (PLAN §2). Kept here, in one place, for both adapters.
LOCKED_MESSAGE = (
    "This FieldWorks project is open in FLEx and not shared. In FLEx, open Project Properties, "
    "choose the Sharing tab, and turn on \"Share project contents with programs on this "
    "computer\". Then try again."
)
MIGRATION_MESSAGE = (
    "This FieldWorks project must be opened in FLEx once first, so FLEx can update it to the "
    "current version."
)
NOT_INSTALLED_MESSAGE = (
    "FieldWorks Language Explorer (FLEx) was not found on this computer, or the FLEx library "
    "could not be loaded."
)


class FlexAdapter:
    """Interface. Subclasses implement every method; all may raise FlexError subclasses."""

    def list_projects(self) -> List[str]:
        raise NotImplementedError

    def open_project(self, name: str) -> Dict[str, Any]:
        raise NotImplementedError

    def close_project(self) -> None:
        raise NotImplementedError

    def is_open(self) -> bool:
        raise NotImplementedError

    def current_project(self) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def refresh(self) -> None:
        """Pick up commits made by FLEx (shared mode): no-op when unsupported."""

    def list_texts(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def read_text(self, guid: str) -> Dict[str, Any]:
        raise NotImplementedError

    def read_genres(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def read_people(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def sharing_status(self) -> Dict[str, Any]:
        raise NotImplementedError

    def version_info(self) -> Dict[str, Any]:
        return {"adapter": type(self).__name__}
