# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""textStats: the segmented / transcribed / glossed / translated fractions of one text
(PLAN §2), computed from the adapter's neutral text shape, so the same code serves the fake and
the real adapter and is unit-tested without FieldWorks.

Definitions (each a fraction 0..1, 0 when the denominator is 0):
* segmented   paragraphs that have at least one segment / paragraphs
* transcribed segments with a non-empty baseline / segments
* glossed[ws] words with a non-empty gloss in that analysis writing system / words
* morphGlossed words whose morphemes carry a gloss / words
* translated[ws] segments with a non-empty free translation in ws / segments

The checklist (src/flextext/checklist) turns these into step states at its 0.95 bar.
"""

from __future__ import annotations

from typing import Any, Dict


def _frac(n: int, d: int) -> float:
    return (n / d) if d else 0.0


def text_stats(text: Dict[str, Any]) -> Dict[str, Any]:
    paragraphs = text.get("paragraphs", [])
    segments = [s for p in paragraphs for s in p.get("segments", [])]
    words = [w for s in segments for w in s.get("words", [])]

    analysis_ws = list((text.get("writingSystems") or {}).get("analysis") or [])
    gloss_ws = set(analysis_ws)
    ft_ws = set(analysis_ws)
    for w in words:
        gloss_ws.update(k for k, v in (w.get("glosses") or {}).items() if v)
    for s in segments:
        ft_ws.update(k for k, v in (s.get("freeTranslations") or {}).items() if v)

    glossed = {
        ws: _frac(sum(1 for w in words if (w.get("glosses") or {}).get(ws)), len(words))
        for ws in sorted(gloss_ws)
    }
    translated = {
        ws: _frac(sum(1 for s in segments if (s.get("freeTranslations") or {}).get(ws)), len(segments))
        for ws in sorted(ft_ws)
    }
    return {
        "guid": text.get("guid"),
        "title": text.get("title", ""),
        "paragraphs": len(paragraphs),
        "segments": len(segments),
        "words": len(words),
        "segmented": _frac(sum(1 for p in paragraphs if p.get("segments")), len(paragraphs)),
        "transcribed": _frac(sum(1 for s in segments if (s.get("baseline") or "").strip()), len(segments)),
        "glossed": glossed,
        "morphGlossed": _frac(sum(1 for w in words if w.get("morphGlossed")), len(words)),
        "translated": translated,
    }
