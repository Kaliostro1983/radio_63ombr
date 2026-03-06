from __future__ import annotations

from typing import Iterable, Mapping

FALLBACK_UNIT_DESC = "УКХ р/м НВ підрозділу, н.п. УТОЧНЮЄТЬСЯ"

def build_unit_desc(unit: str | None, zone: str | None) -> str:
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
    # index batches by id for fast lookup
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