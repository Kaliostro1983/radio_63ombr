"""Peleng intercept parser for ingest pipeline.

Parses messages like:
    147.150 / 20.03.2026 06.44
    ...
    37U DQ 25687 30401
    ...

The parser extracts:
- normalized frequency (`DDD.DDDD`);
- normalized datetime text (`DD.MM.YYYY HH:MM:SS`);
- MGRS-like point lines starting with `37`.
"""

from __future__ import annotations

import re
from typing import Any

from app.core.normalize import normalize_freq_or_mask

HEADER_AT_START_RE = re.compile(
    r"""
    ^\s*
    (?P<freq>\d{2,3}(?:[.,]\d{1,4})?)
    \s*[/\\|,:;]\s*
    (?P<date>\d{2}[./-]\d{2}[./-]\d{4})
    \s+
    (?P<time>\d{1,2}[.:]\d{2})
    \b
    """,
    flags=re.IGNORECASE | re.VERBOSE,
)

POINT_LINE_RE = re.compile(r"^\s*37\b", flags=re.IGNORECASE)
POINT_TOKEN_RE = re.compile(r"\b37[0-9A-Z]{0,3}\s+[A-Z]{2}\s+\d{5}\s+\d{5}\b", flags=re.IGNORECASE)


def _normalize_dt_text(date_raw: str, time_raw: str) -> str:
    date_parts = re.split(r"[./-]", date_raw.strip())
    if len(date_parts) != 3:
        raise ValueError("peleng_header_date_invalid")
    dd, mm, yyyy = date_parts
    hh_mm = re.split(r"[.:]", time_raw.strip())
    if len(hh_mm) != 2:
        raise ValueError("peleng_header_time_invalid")
    hh, minute = hh_mm
    return f"{dd.zfill(2)}.{mm.zfill(2)}.{yyyy} {hh.zfill(2)}:{minute.zfill(2)}:00"


def _normalize_point_line(line: str) -> str:
    return re.sub(r"\s+", " ", (line or "").strip()).upper()


def is_peleng_intercept(text: str) -> bool:
    text_s = str(text or "").strip()
    if not text_s:
        return False

    m = HEADER_AT_START_RE.match(text_s)
    if not m:
        return False

    body = text_s[m.end() :]
    if not body:
        return False
    if POINT_TOKEN_RE.search(body):
        return True
    return any(POINT_LINE_RE.match(ln) for ln in body.splitlines())


def parse_peleng_intercept(text: str) -> dict[str, Any]:
    text_s = str(text or "").strip()
    if not text_s:
        return {"ok": False, "error": "peleng_empty"}

    m = HEADER_AT_START_RE.match(text_s)
    if not m:
        return {"ok": False, "error": "peleng_header_invalid"}

    freq_raw = (m.group("freq") or "").strip()
    freq_norm, mask_norm = normalize_freq_or_mask(freq_raw)
    if not freq_norm and not mask_norm:
        return {"ok": False, "error": "peleng_frequency_or_mask_invalid"}

    try:
        published_at_text = _normalize_dt_text(m.group("date"), m.group("time"))
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    body = text_s[m.end() :]
    points: list[str] = []

    # Keep line-based extraction for normal multi-line payloads.
    for ln in body.splitlines():
        if POINT_LINE_RE.match(ln):
            points.append(_normalize_point_line(ln))

    # XLSX rows can flatten message into a single line.
    if not points:
        for token in POINT_TOKEN_RE.findall(body):
            points.append(_normalize_point_line(token))

    if not points:
        return {"ok": False, "error": "peleng_points_missing"}

    return {
        "ok": True,
        "message_format": "peleng_type",
        "frequency": freq_norm,
        "mask": mask_norm,
        "published_at_text": published_at_text,
        "points": points,
    }
