"""Network resolution service.

This module contains service-layer logic for mapping parsed intercept
fields to an existing `networks` row in the database.

Key system invariant:
    The ingest pipeline must **not** auto-create networks. If a network
    cannot be resolved from the database, ingestion of the message is
    skipped.

Usage in the system:
    `app.services.ingest_service` calls `ensure_network` after parsing a
    template intercept to resolve `network_id` by priority:
    - exact frequency match, then
    - mask match (prefix-like values).
"""

from __future__ import annotations

from typing import Optional

from app.core.logging import get_logger
from app.core.normalize import normalize_freq_or_mask

log = get_logger("network_service")


class NetworkNotFoundError(ValueError):
    """Raised when network resolution fails against the `networks` table."""
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
    """Resolve an existing network id by frequency or mask.

    The function never inserts into `networks`. If no matching network
    exists, it raises `NetworkNotFoundError`.

    Args:
        cur: SQLite cursor.
        frequency: raw frequency value from parser (may be None/dirty).
        mask: raw mask value from parser (may be None).
        now_dt: current timestamp (reserved for future logging/audit).
        unit: parsed unit (currently used only in error context).
        zone: parsed zone (currently used only in error context).

    Returns:
        int: resolved `networks.id`.

    Raises:
        NetworkNotFoundError: when no matching network exists.
    """
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

    # Priority 1: exact frequency match.
    if frequency:
        row = cur.execute(
            "SELECT id FROM networks WHERE frequency = ? LIMIT 1",
            (frequency,),
        ).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    # Priority 2: exact mask match.
    if mask:
        row = cur.execute(
            "SELECT id FROM networks WHERE mask = ? LIMIT 1",
            (mask,),
        ).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

        # Priority 3: prefix-like match using normalized mask (e.g. '300.3010%').
        # This allows networks whose frequency/mask are stored without '%' or
        # with minor formatting differences to still be resolved.
        row = cur.execute(
            "SELECT id FROM networks WHERE frequency LIKE ? OR mask LIKE ? LIMIT 1",
            (mask, mask),
        ).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    # Priority 4: if we have only normalized frequency (no mask), try prefix match.
    if frequency and not mask:
        # Build a simple prefix pattern from normalized frequency.
        like = frequency
        if not like.endswith("%"):
            like = like + "%"
        row = cur.execute(
            "SELECT id FROM networks WHERE frequency LIKE ? OR mask LIKE ? LIMIT 1",
            (like, like),
        ).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    raise NetworkNotFoundError(
        frequency=frequency,
        mask=mask,
        unit=unit,
        zone=zone,
    )