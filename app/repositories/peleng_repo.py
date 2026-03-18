"""Repository for peleng-related database queries.

This module provides a thin database access layer for:

- listing peleng batches and points from `peleng_batches` / `peleng_points`;
- fetching the latest network metadata by frequency (unit/zone) from `networks`.

Usage in the system:

- `app.services.peleng_report_service.PelengReportService` uses this repo
  to load data for report generation.

The repository returns small dataclasses to keep service code clean while
still being explicit about the fields used.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence
import sqlite3

@dataclass(frozen=True)
class BatchRow:
    """Row shape for `peleng_batches` list queries."""
    id: int
    event_dt: str
    frequency: str

@dataclass(frozen=True)
class PointRow:
    """Row shape for `peleng_points` list queries."""
    batch_id: int
    mgrs: str

@dataclass(frozen=True)
class NetworkRow:
    """Subset of `networks` fields used for report enrichment."""
    frequency: str
    unit: str | None
    zone: str | None

class PelengRepo:
    """Database access wrapper for peleng/report-related data."""
    def __init__(self, conn: sqlite3.Connection):
        """Create repository bound to an existing SQLite connection."""
        self.conn = conn
        self.conn.row_factory = sqlite3.Row

    def list_batches(self, from_dt: str, to_dt: str) -> list[BatchRow]:
        """List peleng batches within the requested period."""
        cur = self.conn.execute(
            """
            SELECT id, event_dt, frequency
            FROM peleng_batches
            WHERE event_dt >= ? AND event_dt <= ?
            ORDER BY event_dt ASC, id ASC
            """,
            (from_dt, to_dt),
        )
        return [BatchRow(int(r["id"]), str(r["event_dt"]), str(r["frequency"])) for r in cur.fetchall()]

    def list_points(self, batch_ids: Sequence[int]) -> list[PointRow]:
        """List peleng points for the provided batch ids."""
        if not batch_ids:
            return []
        placeholders = ",".join(["?"] * len(batch_ids))
        cur = self.conn.execute(
            f"""
            SELECT batch_id, mgrs
            FROM peleng_points
            WHERE batch_id IN ({placeholders})
            ORDER BY batch_id ASC, id ASC
            """,
            tuple(batch_ids),
        )
        return [PointRow(int(r["batch_id"]), str(r["mgrs"])) for r in cur.fetchall()]

    def latest_networks_by_frequency(self, freqs: Sequence[str]) -> dict[str, NetworkRow]:
        """
        A1: latest by updated_at, tie-break by id desc.
        """
        if not freqs:
            return {}

        placeholders = ",".join(["?"] * len(freqs))

        # SQLite window functions (>= 3.25) are used to pick the latest row
        # per frequency by updated_at and then id.
        cur = self.conn.execute(
            f"""
            SELECT frequency, unit, zone
            FROM (
                SELECT
                    id, frequency, unit, zone, updated_at,
                    ROW_NUMBER() OVER (
                        PARTITION BY frequency
                        ORDER BY updated_at DESC, id DESC
                    ) AS rn
                FROM networks
                WHERE frequency IN ({placeholders})
            )
            WHERE rn = 1
            """,
            tuple(freqs),
        )

        out: dict[str, NetworkRow] = {}
        for r in cur.fetchall():
            f = str(r["frequency"])
            out[f] = NetworkRow(frequency=f, unit=r["unit"], zone=r["zone"])
        return out