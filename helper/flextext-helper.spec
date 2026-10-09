# -*- mode: python ; coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
#
# PyInstaller spec for the FlexText Metadata helper: --onedir, NEVER --onefile (a onefile exe is
# a bootloader parent plus the real child, and killing the parent orphans the child; PLAN §1.6).
#
#   pyinstaller --noconfirm helper/flextext-helper.spec        (run from the repo root)
#   -> helper/dist/flextext-helper/flextext-helper.exe (+ _internal/)
#
# flexicon is bundled as plain, unmodified .py files (datas, not frozen into the PYZ), so the
# LGPL library stays replaceable (PLAN §2). Its own imports therefore are not traced by
# PyInstaller's analysis: pythonnet / clr_loader are listed as hidden imports.
#
# UNVERIFIED ON WINDOWS: PyInstaller for Windows cannot run in the Linux session that wrote this;
# the CI workflow (.github/workflows/flextext-metadata-windows.yml) is the first real run.

import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

here = os.path.dirname(os.path.abspath(SPEC))  # noqa: F821 - SPEC is provided by PyInstaller

datas = []
hiddenimports = ["psutil"]
excludes = ["tkinter", "unittest", "pydoc", "doctest"]

if sys.platform == "win32":
    try:
        import flexicon  # noqa: F401  - only to see whether it is installed in the build env

        datas += collect_data_files("flexicon", include_py_files=True)
        excludes.append("flexicon")
        excludes.append("flexlibs2")
        hiddenimports += ["clr", "clr_loader", "pythonnet"] + collect_submodules("clr_loader")
        datas += collect_data_files("pythonnet")
    except ImportError:
        print("flextext-helper.spec: flexicon is not installed; building the helper WITHOUT FLEx support", file=sys.stderr)

a = Analysis(  # noqa: F821
    [os.path.join(here, "flextext_helper", "__main__.py")],
    pathex=[here],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="flextext-helper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # a console app: stdio is the protocol; Electron hides the window
    disable_windowed_traceback=False,
    target_arch=None,  # whatever Python this runs under: x64 in CI (must match FieldWorks)
)
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="flextext-helper",
)
