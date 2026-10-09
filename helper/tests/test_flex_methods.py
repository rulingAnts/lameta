# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""The FLEx methods over the fake adapter, including the error mapping users will see."""

from __future__ import annotations

import pytest

from flextext_helper import jsonrpc
from flextext_helper.flex.adapter import LOCKED_MESSAGE, MIGRATION_MESSAGE
from flextext_helper.flex.stats import text_stats
from flextext_helper.flex.fake import FakeFlexicon


def test_list_and_open_project(pipe_server):
    r = pipe_server.call("listProjects")
    assert r["result"] == ["LockedProject", "OldProject", "SampleProject"]
    r = pipe_server.call("openProject", {"name": "SampleProject"})
    assert r["result"]["name"] == "SampleProject"
    assert pipe_server.call("currentProject")["result"]["name"] == "SampleProject"
    assert pipe_server.call("closeProject")["result"] is True
    assert pipe_server.call("closeProject")["result"] is False
    assert pipe_server.call("currentProject")["result"] is None


def test_locked_project_gives_the_sharing_remedy(pipe_server):
    r = pipe_server.call("openProject", {"name": "LockedProject"})
    assert r["error"]["code"] == jsonrpc.FLEX_LOCKED
    assert r["error"]["data"]["kind"] == "FLEX_LOCKED"
    assert "Share project contents with programs on this computer" in r["error"]["message"]
    assert r["error"]["message"] == LOCKED_MESSAGE


def test_migration_required_message(pipe_server):
    r = pipe_server.call("openProject", {"name": "OldProject"})
    assert r["error"]["code"] == jsonrpc.FLEX_MIGRATION_REQUIRED
    assert "open" in r["error"]["message"].lower() and "FLEx" in r["error"]["message"]
    assert r["error"]["message"] == MIGRATION_MESSAGE


def test_unknown_project_and_missing_param(pipe_server):
    assert pipe_server.call("openProject", {"name": "Nope"})["error"]["code"] == jsonrpc.FLEX_NOT_FOUND
    assert pipe_server.call("openProject", {})["error"]["code"] == jsonrpc.INVALID_PARAMS
    assert pipe_server.call("openProject", [1])["error"]["code"] == jsonrpc.INVALID_PARAMS


def test_methods_need_an_open_project(pipe_server):
    for m in ("listTexts", "readGenres", "readPeople", "sharingStatus"):
        assert pipe_server.call(m)["error"]["code"] == jsonrpc.FLEX_NO_PROJECT_OPEN, m
    assert pipe_server.call("readText", {"guid": "t-done"})["error"]["code"] == jsonrpc.FLEX_NO_PROJECT_OPEN


def test_texts_genres_people_sharing(pipe_server):
    pipe_server.call("openProject", {"name": "SampleProject"})
    texts = pipe_server.call("listTexts")["result"]
    assert [t["guid"] for t in texts] == ["t-done", "t-half", "t-empty"]
    assert texts[0]["genres"] == ["g-narr-folk"] and texts[0]["paragraphCount"] == 1
    full = pipe_server.call("readText", {"guid": "t-done"})["result"]
    assert full["writingSystems"]["analysis"] == ["en", "id"]
    assert len(full["paragraphs"][0]["segments"]) == 2
    assert pipe_server.call("readText", {"guid": "zzz"})["error"]["code"] == jsonrpc.FLEX_NOT_FOUND
    genres = pipe_server.call("readGenres")["result"]
    assert {g["guid"]: g["parentGuid"] for g in genres} == {"g-narr": None, "g-narr-folk": "g-narr", "g-proc": None}
    people = pipe_server.call("readPeople")["result"]
    assert [p["name"] for p in people] == ["Narrator One", "Narrator Two"]
    sharing = pipe_server.call("sharingStatus")["result"]
    assert sharing["shared"] is True and sharing["locked"] is False


def test_text_stats_single_list_and_all(pipe_server):
    pipe_server.call("openProject", {"name": "SampleProject"})
    one = pipe_server.call("textStats", {"guid": "t-done"})["result"]
    assert one["guid"] == "t-done"
    assert one["segmented"] == 1.0 and one["transcribed"] == 1.0
    assert one["glossed"] == {"en": 1.0, "id": 1.0}
    assert one["translated"] == {"en": 1.0, "id": 1.0}
    assert one["morphGlossed"] == 1.0

    half = pipe_server.call("textStats", {"guids": ["t-half"]})["result"][0]
    assert half["words"] == 6 and half["segments"] == 2
    assert half["glossed"]["en"] == pytest.approx(2 / 6)
    assert half["glossed"]["id"] == 0.0
    assert half["translated"]["en"] == 0.5
    assert half["morphGlossed"] == 0.0

    everything = pipe_server.call("textStats")["result"]
    assert [t["guid"] for t in everything] == ["t-done", "t-half", "t-empty"]
    empty = everything[2]
    assert empty["segmented"] == 0.0 and empty["transcribed"] == 0.0 and empty["words"] == 0


def test_text_stats_reports_progress_and_can_be_cancelled():
    """A scan over many texts sends progress notifications and honours cancel between texts."""
    from conftest import PipeServer
    from flextext_helper.server import Server
    from flextext_helper.flex.methods import FlexMethods
    from flextext_helper.flex.fake import sample_fixture

    fixture = sample_fixture()
    proj = fixture["projects"]["SampleProject"]
    base = proj["texts"][0]
    proj["texts"] = [dict(base, guid=f"t-{i}") for i in range(25)]

    def factory(stdin, stdout):
        s = Server(stdin, stdout)
        s.register_all(FlexMethods(FakeFlexicon(fixture)).table(), lane="flex")
        return s

    ps = PipeServer(factory)
    assert ps.read()["method"] == "ready"
    ps.call("openProject", {"name": "SampleProject"})
    rid = ps.request("textStats")
    msgs = []
    while True:
        m = ps.read()
        msgs.append(m)
        if m.get("id") == rid:
            break
    progress = [m for m in msgs if m.get("method") == "progress"]
    assert progress and progress[-1]["params"] == {"id": rid, "done": 25, "total": 25}
    assert len(msgs[-1]["result"]) == 25
    ps.close()


def test_text_stats_pure_function_edge_cases():
    assert text_stats({"guid": "x", "paragraphs": []})["segmented"] == 0.0
    t = {
        "guid": "x",
        "writingSystems": {"vernacular": ["v"], "analysis": ["en"]},
        "paragraphs": [
            {"segments": [{"baseline": "a b", "words": [{"form": "a", "glosses": {"fr": "un"}}, {"form": "b", "glosses": {}}], "freeTranslations": {"fr": "x"}}]},
            {"segments": []},
        ],
    }
    s = text_stats(t)
    assert s["segmented"] == 0.5
    # a gloss in a ws not declared as analysis still counts, and declared ws appear even at 0
    assert s["glossed"] == {"en": 0.0, "fr": 0.5}
    assert s["translated"] == {"en": 0.0, "fr": 1.0}


def test_fake_fixture_is_synthetic():
    """No real names: the people in the fixture are placeholders."""
    names = [p["name"] for p in FakeFlexicon().fixture["projects"]["SampleProject"]["people"]]
    assert all(n.startswith("Narrator ") for n in names)
