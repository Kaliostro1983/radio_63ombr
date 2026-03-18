"""Peleng record builders.

Peleng reporting uses two related data sources:

- batches (`peleng_batches`) which contain event datetime and frequency;
- points (`peleng_points`) which contain MGRS coordinates for a batch.

This module provides helpers to convert raw DB rows into the "records"
format expected by the peleng reporting subsystem (DOCX builder).

The service layer typically loads batches/points from the DB, optionally
joins in network metadata by frequency, and then calls `build_records_from_db`.
"""

from __future__ import annotations

from typing import Iterable, Mapping

FALLBACK_UNIT_DESC = "УКХ р/м НВ підрозділу, н.п. УТОЧНЮЄТЬСЯ"

def build_unit_desc(unit: str | None, zone: str | None) -> str:
    """Build the human-readable unit/zone description for a peleng record.

    Args:
        unit: network unit name.
        zone: network zone description.

    Returns:
        str: formatted description string. If unit/zone are missing,
        returns a project-level fallback string.
    """
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
    """Build peleng records from DB rows.

    Args:
        batches: rows from `peleng_batches`.
        points: rows from `peleng_points`.
        net_by_freq: mapping from frequency string to network metadata
            (typically containing `unit` and `zone`).

    Returns:
        list[dict]: list of records with fields used in reporting:
        `freq_or_mask`, `unit_desc`, `dt`, `mgrs`.
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
            "dt": str(b["event_dt"]),
            "mgrs": str(p["mgrs"]),
        })

    return records