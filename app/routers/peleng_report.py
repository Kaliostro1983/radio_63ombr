"""Peleng record helpers for report generation (router-local).

This module duplicates a small set of record-building helpers used to
generate peleng report records from database rows.

Usage in the system:
    `app.services.peleng_report_service` imports `build_records_from_db`
    from this module for historical reasons.

Note:
    A similar implementation also exists in `app.core.peleng_records`.
    Both produce the same record shape: `{freq_or_mask, unit_desc, dt, mgrs}`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable, Mapping

FALLBACK_UNIT_DESC = "УКХ р/м НВ підрозділу, н.п. УТОЧНЮЄТЬСЯ"


def _fmt_event_dt(event_dt: str) -> str:
    """Format a raw DB event_dt string as 'dd.mm.yyyy\nHH:MM' for report cells."""
    try:
        s = str(event_dt).replace("T", " ").strip()
        dt = datetime.fromisoformat(s)
        return dt.strftime("%d.%m.%Y\n%H:%M")
    except Exception:
        return str(event_dt)

def build_unit_desc(unit: str | None, zone: str | None) -> str:
    """Build the unit description string used in peleng report rows."""
    unit = (unit or "").strip()
    zone = (zone or "").strip()
    if unit and zone:
        return f"УКХ р/м {unit}, {zone}"
    return FALLBACK_UNIT_DESC

def build_records_from_db(
    batches: Iterable[Mapping],
    points: Iterable[Mapping],
    net_by_freq: Mapping[str, Mapping],
) -> list[dict]:
    """Build report record dicts from `peleng_batches` and `peleng_points`.

    Args:
        batches: rows for peleng batches.
        points: rows for peleng points.
        net_by_freq: mapping from frequency to network metadata (`unit`, `zone`).

    Returns:
        list[dict]: list of record dicts used by DOCX generator.
    """
    # Index batches by id for fast lookup.
    batch_by_id = {int(b["id"]): b for b in batches}

    records: list[dict] = []
    for p in points:
        bid = int(p["batch_id"])
        b = batch_by_id.get(bid)
        if not b:
            continue

        freq = str(b["frequency"])
        net = net_by_freq.get(freq) or {}
        unit_desc = build_unit_desc(net.get("unit"), net.get("zone"))

        records.append({
            "freq_or_mask": freq,
            "unit_desc": unit_desc,
            "dt": _fmt_event_dt(str(b["event_dt"])),
            "mgrs": str(p["mgrs"]),
        })

    return records