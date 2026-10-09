# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""Platform guards: the job object is a no-op off Windows, the real adapter imports flexicon
lazily and fails with the plain message where it is absent, the watchdog sees a live parent."""

from __future__ import annotations

import os
import sys

import pytest

from flextext_helper.jobobject import assign_self_to_kill_on_close_job
from flextext_helper.flex.adapter import FlexNotInstalled
from flextext_helper.flex.real import RealFlexicon
from flextext_helper.watchdog import parent_is_alive


def test_job_object_is_guarded_off_windows():
    if sys.platform == "win32":
        assert assign_self_to_kill_on_close_job() in (True, False)
    else:
        assert assign_self_to_kill_on_close_job() is False


def test_real_adapter_module_imports_without_flexicon():
    """`import flexicon` must be lazy: constructing the adapter never imports it."""
    assert "flexicon" not in sys.modules
    a = RealFlexicon()
    assert "flexicon" not in sys.modules
    assert a.is_open() is False and a.current_project() is None


@pytest.mark.skipif(sys.platform == "win32", reason="on Windows flexicon may be installed")
def test_real_adapter_reports_not_installed_plainly():
    a = RealFlexicon()
    with pytest.raises(FlexNotInstalled) as ei:
        a.list_projects()
    assert "FieldWorks" in str(ei.value)
    info = a.version_info()
    assert info["adapter"] == "RealFlexicon" and "error" in info


def test_watchdog_sees_live_parent():
    assert parent_is_alive(os.getppid()) is True
    assert parent_is_alive(0) is True
    if sys.platform != "win32":
        # our own pid is not our parent: on POSIX the getppid() check says so
        assert parent_is_alive(os.getpid()) is False
