"""Shared helper for auto-classifying analytical conclusions by keyword.

The first line of an analytical conclusion is normally the LOCATION header,
e.g. ``р-н ЛИМАН - СЕРЕБРЯНСЬКИЙ ЛІС``. Marker keywords must NOT be searched
there, otherwise place names create false hits — e.g. ``реб`` matches inside
``СеРЕБрянський`` and the conclusion is wrongly tagged «РЕБ».

Rule (per operator request): skip the first line from keyword matching when it
contains ``р-н`` OR a CAPS word (Caps Lock present) — i.e. when it looks like a
location header.
"""

from __future__ import annotations


def _is_location_header(line: str) -> bool:
    """True if *line* looks like a location header: has ``р-н`` or a CAPS word."""
    if "р-н" in (line or "").lower():
        return True
    # CAPS word = слово з ≥2 літер, усі великі (кирилиця/латиниця/укр.).
    return any(len(w) >= 2 and w.isupper() for w in (line or "").split())


def conclusion_match_text(conclusion_text: str) -> str:
    """Lowercased text used for keyword matching, with the location header
    (first line) excluded when it is a location header."""
    raw = conclusion_text or ""
    lines = raw.split("\n")
    if lines and _is_location_header(lines[0]):
        lines = lines[1:]
    return "\n".join(lines).lower()
