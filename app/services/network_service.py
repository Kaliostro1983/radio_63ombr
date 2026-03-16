from __future__ import annotations

from typing import Optional

from app.core.logging import get_logger
from app.core.normalize import normalize_freq_or_mask

log = get_logger("network_service")


class NetworkNotFoundError(ValueError):
    def __init__(
        self,
        *,
        frequency: Optional[str],
        mask: Optional[str],
        unit: Optional[str],
        zone: Optional[str],
    ) -> None:
        self.frequency = frequency
        self.mask = mask
        self.unit = unit
        self.zone = zone

        parts = []
        if frequency:
            parts.append(f"frequency={frequency}")
        if mask:
            parts.append(f"mask={mask}")
        if unit:
            parts.append(f"unit={unit}")
        if zone:
            parts.append(f"zone={zone}")

        msg = "network not found"
        if parts:
            msg += ": " + ", ".join(parts)

        super().__init__(msg)


def ensure_network(
    cur,
    frequency: Optional[str],
    mask: Optional[str],
    now_dt: str,
    unit: Optional[str],
    zone: Optional[str],
) -> int:
    def norm_s(v: Optional[str]) -> Optional[str]:
        v = (v or "").strip()
        return v or None

    raw_frequency = norm_s(frequency)
    raw_mask = norm_s(mask)
    unit = norm_s(unit)
    zone = norm_s(zone)

    normalized_frequency, detected_mask = normalize_freq_or_mask(raw_frequency)
    frequency = normalized_frequency
    mask = raw_mask or detected_mask

    if frequency:
        row = cur.execute(
            "SELECT id FROM networks WHERE frequency = ? LIMIT 1",
            (frequency,),
        ).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    if mask:
        row = cur.execute(
            "SELECT id FROM networks WHERE mask = ? LIMIT 1",
            (mask,),
        ).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    raise NetworkNotFoundError(
        frequency=frequency,
        mask=mask,
        unit=unit,
        zone=zone,
    )