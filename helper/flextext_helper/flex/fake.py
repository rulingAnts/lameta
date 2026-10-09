# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""FakeFlexicon: an in-memory FlexAdapter for tests and for running the helper on a machine
without FieldWorks (Linux CI, the §1.9 process-cleanup test).

Its data is SYNTHETIC: invented titles, invented names, nonsense glosses. No real project data,
recordings, speaker names or consent records belong here (CLAUDE.md).

Select it with FLEXTEXT_FLEX_ADAPTER=fake (see __main__.py). A JSON fixture can be loaded with
FLEXTEXT_FAKE_FIXTURE=<path> for richer scenarios; otherwise the built-in sample is used.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .adapter import (
    LOCKED_MESSAGE,
    MIGRATION_MESSAGE,
    FlexAdapter,
    FlexLocked,
    FlexMigrationRequired,
    FlexNoProjectOpen,
    FlexNotFound,
)


def _segment(baseline: str, words: List[Dict[str, Any]], ft: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    return {"baseline": baseline, "words": words, "freeTranslations": ft or {}}


def _word(form: str, glosses: Optional[Dict[str, str]] = None, morph: bool = False) -> Dict[str, Any]:
    return {"form": form, "glosses": glosses or {}, "morphGlossed": morph}


def sample_fixture() -> Dict[str, Any]:
    """A small synthetic project: three texts at different stages, a genre tree, two people."""
    return {
        "projects": {
            "SampleProject": {
                "path": "C:/FakeProjects/SampleProject/SampleProject.fwdata",
                "shared": True,
                "writingSystems": {"vernacular": ["qaa"], "analysis": ["en", "id"]},
                "genres": [
                    {"guid": "g-narr", "name": "Narrative", "abbreviation": "narr", "parentGuid": None},
                    {"guid": "g-narr-folk", "name": "Folktale", "abbreviation": "folk", "parentGuid": "g-narr"},
                    {"guid": "g-proc", "name": "Procedural", "abbreviation": "proc", "parentGuid": None},
                ],
                "people": [
                    {"guid": "p-1", "name": "Narrator One"},
                    {"guid": "p-2", "name": "Narrator Two"},
                ],
                "texts": [
                    {
                        "guid": "t-done",
                        "title": "The lizard and the moon",
                        "abbreviation": "LIZ",
                        "genres": ["g-narr-folk"],
                        "paragraphs": [
                            {
                                "segments": [
                                    _segment(
                                        "ka mo ti",
                                        [
                                            _word("ka", {"en": "the", "id": "si"}, True),
                                            _word("mo", {"en": "lizard", "id": "kadal"}, True),
                                            _word("ti", {"en": "sat", "id": "duduk"}, True),
                                        ],
                                        {"en": "The lizard sat.", "id": "Kadal itu duduk."},
                                    ),
                                    _segment(
                                        "ka pu lo",
                                        [
                                            _word("ka", {"en": "the", "id": "si"}, True),
                                            _word("pu", {"en": "moon", "id": "bulan"}, True),
                                            _word("lo", {"en": "rose", "id": "terbit"}, True),
                                        ],
                                        {"en": "The moon rose.", "id": "Bulan terbit."},
                                    ),
                                ]
                            }
                        ],
                    },
                    {
                        "guid": "t-half",
                        "title": "How to weave a mat",
                        "abbreviation": "MAT",
                        "genres": ["g-proc"],
                        "paragraphs": [
                            {
                                "segments": [
                                    _segment(
                                        "we ne sa",
                                        [
                                            _word("we", {"en": "take"}),
                                            _word("ne", {"en": "leaf"}),
                                            _word("sa", {}),
                                        ],
                                        {"en": "Take a leaf."},
                                    ),
                                    _segment(
                                        "we ne ra",
                                        [_word("we", {}), _word("ne", {}), _word("ra", {})],
                                        {},
                                    ),
                                ]
                            }
                        ],
                    },
                    {
                        "guid": "t-empty",
                        "title": "Untitled recording",
                        "abbreviation": "",
                        "genres": [],
                        "paragraphs": [{"segments": []}],
                    },
                ],
            },
            "LockedProject": {"path": None, "locked": True},
            "OldProject": {"path": None, "migrationRequired": True},
        }
    }


class FakeFlexicon(FlexAdapter):
    def __init__(self, fixture: Optional[Dict[str, Any]] = None):
        self.fixture = fixture or sample_fixture()
        self._open: Optional[str] = None
        self.refresh_count = 0

    @classmethod
    def from_file(cls, path: str) -> "FakeFlexicon":
        with open(path, "r", encoding="utf-8") as f:
            return cls(json.load(f))

    # -- projects --------------------------------------------------------------------------

    def list_projects(self) -> List[str]:
        return sorted(self.fixture["projects"].keys())

    def open_project(self, name: str) -> Dict[str, Any]:
        p = self.fixture["projects"].get(name)
        if p is None:
            raise FlexNotFound(f"project not found: {name}")
        if p.get("locked"):
            raise FlexLocked(LOCKED_MESSAGE)
        if p.get("migrationRequired"):
            raise FlexMigrationRequired(MIGRATION_MESSAGE)
        self._open = name
        return {"name": name, "path": p.get("path")}

    def close_project(self) -> None:
        self._open = None

    def is_open(self) -> bool:
        return self._open is not None

    def current_project(self) -> Optional[Dict[str, Any]]:
        if self._open is None:
            return None
        return {"name": self._open, "path": self.fixture["projects"][self._open].get("path")}

    def refresh(self) -> None:
        self.refresh_count += 1

    def _project(self) -> Dict[str, Any]:
        if self._open is None:
            raise FlexNoProjectOpen("no project is open")
        return self.fixture["projects"][self._open]

    # -- texts -----------------------------------------------------------------------------

    def list_texts(self) -> List[Dict[str, Any]]:
        return [
            {
                "guid": t["guid"],
                "title": t.get("title", ""),
                "abbreviation": t.get("abbreviation", ""),
                "genres": list(t.get("genres", [])),
                "paragraphCount": len(t.get("paragraphs", [])),
            }
            for t in self._project().get("texts", [])
        ]

    def read_text(self, guid: str) -> Dict[str, Any]:
        p = self._project()
        for t in p.get("texts", []):
            if t["guid"] == guid:
                return {
                    "guid": t["guid"],
                    "title": t.get("title", ""),
                    "abbreviation": t.get("abbreviation", ""),
                    "genres": list(t.get("genres", [])),
                    "paragraphCount": len(t.get("paragraphs", [])),
                    "writingSystems": p.get("writingSystems", {"vernacular": [], "analysis": []}),
                    "paragraphs": t.get("paragraphs", []),
                }
        raise FlexNotFound(f"text not found: {guid}")

    def read_genres(self) -> List[Dict[str, Any]]:
        return list(self._project().get("genres", []))

    def read_people(self) -> List[Dict[str, Any]]:
        return list(self._project().get("people", []))

    def sharing_status(self) -> Dict[str, Any]:
        p = self._project()
        return {
            "projectFolder": p.get("path"),
            "backend": "FakeSharedBackend" if p.get("shared") else "FakeBackend",
            "shared": bool(p.get("shared")),
        }

    def version_info(self) -> Dict[str, Any]:
        return {"adapter": "FakeFlexicon", "flexicon": None, "fieldworks": None}
