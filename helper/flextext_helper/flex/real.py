# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""RealFlexicon: the FlexAdapter backed by flexicon (PyPI pyflexicon >=4.12,<5, LGPL-2.1-or-later,
Windows only). `import flexicon` happens lazily, in `_ensure()`, never at import time, so this
module loads anywhere and the helper starts even where FieldWorks is absent.

UNVERIFIED ON WINDOWS. Written on Linux against flexicon 4.12.0's source and the LCM property
names (as fdat's sidecar was). Expect to adjust details at the S1 spike (PLAN §7): the shared-mode
open while FLEx has the project, `Texts.GetAll()`, the segment / analysis walk, the backend-type
probe in sharing_status().

Shared mode (PLAN §2): the project is opened read-only; `refresh()` calls flexicon's
`RefreshFromDisk()` so FLEx's commits become visible (LCM shows a peer's edits only on commit).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from .adapter import (
    LOCKED_MESSAGE,
    MIGRATION_MESSAGE,
    NOT_INSTALLED_MESSAGE,
    FlexAdapter,
    FlexError,
    FlexLocked,
    FlexMigrationRequired,
    FlexNoProjectOpen,
    FlexNotFound,
    FlexNotInstalled,
)

log = logging.getLogger("flextext.flex.real")


class RealFlexicon(FlexAdapter):
    def __init__(self) -> None:
        self._flexicon = None
        self._initialised = False
        self._project = None  # flexicon.FLExProject
        self._name: Optional[str] = None
        self._ITsString = None

    # -- lazy import -----------------------------------------------------------------------

    def _ensure(self):
        if self._flexicon is not None:
            return self._flexicon
        if os.name != "nt":
            raise FlexNotInstalled(NOT_INSTALLED_MESSAGE + " (flexicon runs on Windows only)")
        try:
            import flexicon  # noqa: PLC0415  - deliberately lazy; never `flexlibs2`
        except Exception as e:  # noqa: BLE001  - ImportError, or pythonnet failing to load the CLR
            raise FlexNotInstalled(f"{NOT_INSTALLED_MESSAGE} ({type(e).__name__}: {e})") from None
        major = int(str(getattr(flexicon, "version", "0")).split(".")[0] or 0)
        if major != 4:
            raise FlexNotInstalled(f"flexicon {getattr(flexicon, 'version', '?')} found; this build needs 4.x")
        if not self._initialised:
            flexicon.FLExInitialize()
            self._initialised = True
        try:
            from SIL.LCModel.Core.KernelInterfaces import ITsString  # type: ignore

            self._ITsString = ITsString
        except Exception:  # noqa: BLE001
            self._ITsString = None
        self._flexicon = flexicon
        return flexicon

    def _tss(self, value: Any) -> str:
        """Text of an ITsString / multi-string alternative, or ''."""
        if value is None:
            return ""
        try:
            if self._ITsString is not None:
                return self._ITsString(value).Text or ""
        except Exception:  # noqa: BLE001
            pass
        try:
            return value.Text or ""
        except Exception:  # noqa: BLE001
            return str(value) if value is not None else ""

    def _translate(self, e: Exception) -> FlexError:
        fx = self._flexicon
        if fx is not None:
            if isinstance(e, fx.FP_FileLockedError):
                return FlexLocked(LOCKED_MESSAGE)
            if isinstance(e, fx.FP_MigrationRequired):
                return FlexMigrationRequired(MIGRATION_MESSAGE)
            if isinstance(e, getattr(fx, "FP_FileNotFoundError", ())):
                return FlexNotFound(str(e))
        return FlexError(f"{type(e).__name__}: {e}")

    # -- projects --------------------------------------------------------------------------

    def list_projects(self) -> List[str]:
        fx = self._ensure()
        try:
            return sorted(str(n) for n in fx.AllProjectNames())
        except Exception as e:  # noqa: BLE001
            raise self._translate(e) from None

    def open_project(self, name: str) -> Dict[str, Any]:
        fx = self._ensure()
        self.close_project()
        project = fx.FLExProject()
        try:
            # read-only; writes come later in short non-undoable windows (PLAN §2)
            project.OpenProject(name, writeEnabled=False)
        except Exception as e:  # noqa: BLE001
            raise self._translate(e) from None
        self._project = project
        self._name = name
        return {"name": name, "path": self._project_path()}

    def _project_path(self) -> Optional[str]:
        try:
            return str(self._project.project.ProjectId.Path)
        except Exception:  # noqa: BLE001
            return None

    def close_project(self) -> None:
        if self._project is not None:
            try:
                self._project.CloseProject()
            except Exception as e:  # noqa: BLE001
                log.warning("CloseProject failed: %s", e)
            finally:
                self._project = None
                self._name = None

    def is_open(self) -> bool:
        return self._project is not None

    def current_project(self) -> Optional[Dict[str, Any]]:
        if self._project is None:
            return None
        return {"name": self._name, "path": self._project_path()}

    def refresh(self) -> None:
        if self._project is None:
            return
        try:
            self._project.RefreshFromDisk()
        except Exception as e:  # noqa: BLE001
            log.warning("RefreshFromDisk failed: %s", e)

    def _p(self):
        if self._project is None:
            raise FlexNoProjectOpen("no project is open")
        return self._project

    # -- texts -----------------------------------------------------------------------------

    def _text_summary(self, t: Any) -> Dict[str, Any]:
        p = self._p()
        try:
            title = p.Texts.GetTitle(t) or ""
        except Exception:  # noqa: BLE001
            title = self._tss(getattr(getattr(t, "Name", None), "BestVernacularAnalysisAlternative", None))
        try:
            abbreviation = p.Texts.GetAbbreviation(t) or ""
        except Exception:  # noqa: BLE001
            abbreviation = ""
        try:
            genres = [str(g.Guid) for g in t.GenresRC]
        except Exception:  # noqa: BLE001
            genres = []
        try:
            paragraph_count = t.ContentsOA.ParagraphsOS.Count if t.ContentsOA is not None else 0
        except Exception:  # noqa: BLE001
            paragraph_count = 0
        return {
            "guid": str(t.Guid),
            "title": title,
            "abbreviation": abbreviation,
            "genres": genres,
            "paragraphCount": paragraph_count,
        }

    def list_texts(self) -> List[Dict[str, Any]]:
        p = self._p()
        try:
            return [self._text_summary(t) for t in p.Texts.GetAll()]
        except FlexError:
            raise
        except Exception as e:  # noqa: BLE001
            raise self._translate(e) from None

    def _find_text(self, guid: str):
        p = self._p()
        for t in p.Texts.GetAll():
            if str(t.Guid).lower() == guid.lower():
                return t
        raise FlexNotFound(f"text not found: {guid}")

    def _writing_systems(self) -> Dict[str, List[str]]:
        lp = self._p().lp
        try:
            vern = [ws.Id for ws in lp.CurrentVernacularWritingSystems]
            anal = [ws.Id for ws in lp.CurrentAnalysisWritingSystems]
            return {"vernacular": list(vern), "analysis": list(anal)}
        except Exception:  # noqa: BLE001
            return {"vernacular": [], "analysis": []}

    def _ws_handles(self, ws_ids: List[str]) -> Dict[str, int]:
        """analysis ws id -> handle, for get_String(ws)."""
        out: Dict[str, int] = {}
        try:
            wsf = self._p().project.WritingSystemFactory
            for ws in ws_ids:
                try:
                    out[ws] = wsf.GetWsFromStr(ws)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
        return out

    def _word(self, analysis: Any, handles: Dict[str, int]) -> Dict[str, Any]:
        form = ""
        glosses: Dict[str, str] = {}
        morph = False
        try:
            wf = analysis.Wordform
            form = self._tss(wf.Form.BestVernacularAlternative) if wf is not None else ""
        except Exception:  # noqa: BLE001
            pass
        try:
            cls = analysis.ClassName
            if cls == "WfiGloss":
                for ws, h in handles.items():
                    g = self._tss(analysis.Form.get_String(h))
                    if g:
                        glosses[ws] = g
                owner = analysis.Owner  # the WfiAnalysis
                morph = any(self._tss(getattr(mb, "Gloss", None) and mb.Gloss.BestAnalysisAlternative) for mb in owner.MorphBundlesOS)
            elif cls == "WfiAnalysis":
                meanings = list(analysis.MeaningsOC)
                if meanings:
                    for ws, h in handles.items():
                        g = self._tss(meanings[0].Form.get_String(h))
                        if g:
                            glosses[ws] = g
                morph = any(self._tss(getattr(mb, "Gloss", None) and mb.Gloss.BestAnalysisAlternative) for mb in analysis.MorphBundlesOS)
        except Exception:  # noqa: BLE001
            pass
        return {"form": form, "glosses": glosses, "morphGlossed": morph}

    def read_text(self, guid: str) -> Dict[str, Any]:
        t = self._find_text(guid)
        wss = self._writing_systems()
        handles = self._ws_handles(wss["analysis"])
        paragraphs = []
        try:
            paras = list(t.ContentsOA.ParagraphsOS) if t.ContentsOA is not None else []
            for para in paras:
                segments = []
                for seg in para.SegmentsOS:
                    baseline = self._tss(seg.BaselineText)
                    words = [self._word(a, handles) for a in seg.AnalysesRS if getattr(a, "ClassName", "") != "PunctuationForm"]
                    fts: Dict[str, str] = {}
                    for ws, h in handles.items():
                        ft = self._tss(seg.FreeTranslation.get_String(h))
                        if ft:
                            fts[ws] = ft
                    segments.append({"baseline": baseline, "words": words, "freeTranslations": fts})
                paragraphs.append({"segments": segments})
        except Exception as e:  # noqa: BLE001
            raise self._translate(e) from None
        return {**self._text_summary(t), "writingSystems": wss, "paragraphs": paragraphs}

    # -- lists -----------------------------------------------------------------------------

    def read_genres(self) -> List[Dict[str, Any]]:
        p = self._p()
        out: List[Dict[str, Any]] = []
        try:
            lst = p.lp.GenreListOA
            if lst is None:
                return out

            def walk(items, parent: Optional[str]):
                for it in items:
                    out.append(
                        {
                            "guid": str(it.Guid),
                            "name": self._tss(it.Name.BestAnalysisVernacularAlternative),
                            "abbreviation": self._tss(it.Abbreviation.BestAnalysisVernacularAlternative),
                            "parentGuid": parent,
                        }
                    )
                    walk(it.SubPossibilitiesOS, str(it.Guid))

            walk(lst.PossibilitiesOS, None)
        except Exception as e:  # noqa: BLE001
            raise self._translate(e) from None
        return out

    def read_people(self) -> List[Dict[str, Any]]:
        p = self._p()
        try:
            return [
                {"guid": str(person.Guid), "name": self._tss(person.Name.BestAnalysisVernacularAlternative)}
                for person in p.People.GetAll()
            ]
        except Exception as e:  # noqa: BLE001
            raise self._translate(e) from None

    def sharing_status(self) -> Dict[str, Any]:
        """Reports the LCM backend the open project uses: LCM promotes a shared project to its
        SharedXML backend (PLAN §2), so a backend name containing "Shared" means sharing is on.
        Never toggles anything."""
        p = self._p()
        backend = None
        try:
            from SIL.LCModel.Infrastructure import IDataSetup  # type: ignore

            setup = p.project.ServiceLocator.GetInstance[IDataSetup]()
            backend = type(setup).__name__
        except Exception as e:  # noqa: BLE001
            log.info("backend probe unavailable: %s", e)
        folder = None
        try:
            folder = str(p.project.ProjectId.ProjectFolder)
        except Exception:  # noqa: BLE001
            pass
        return {
            "projectFolder": folder,
            "backend": backend,
            "shared": (("Shared" in backend) if backend else None),
        }

    def version_info(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {"adapter": "RealFlexicon", "flexicon": None, "fieldworks": None}
        try:
            fx = self._ensure()
            info["flexicon"] = str(getattr(fx, "version", ""))
            try:
                from SIL.FieldWorks.Common.FwUtils import FwUtils  # type: ignore

                info["fieldworks"] = str(FwUtils.SuiteVersion)
            except Exception:  # noqa: BLE001
                pass
        except FlexNotInstalled as e:
            info["error"] = str(e)
        return info
