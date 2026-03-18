"""Peleng report orchestration service.

This module builds DOCX reports for peleng (direction finding) data stored
in SQLite.

Usage in the system:

- Routers call `PelengReportService` to generate a report for a selected
  time period.
- The service loads peleng batches/points from the DB, enriches them with
  network metadata (unit/zone), converts them into record format, and
  renders a DOCX using the peleng reporting subsystem.

The report content is returned as bytes together with a suggested filename,
so routers can return it as a downloadable file.
"""

# src/peleng/services/peleng_report_service.py
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import tempfile
import sqlite3

from app.peleng_report.report import build_docx
from app.peleng_report.runner import load_posts
from app.repositories.peleng_repo import PelengRepo
from app.routers.peleng_report import build_records_from_db


@dataclass(frozen=True)
class ReportResult:
    """DOCX report binary payload and suggested filename."""
    filename: str
    content: bytes

class PelengReportService:
    """Service that generates peleng DOCX reports from database data."""
    def __init__(self, conn: sqlite3.Connection):
        """Create service with a DB connection.

        Args:
            conn: SQLite connection to read peleng/network data.
        """
        self.repo = PelengRepo(conn)

    def build_report_by_period(self, from_dt: str, to_dt: str) -> ReportResult:
        """Build a peleng report for a given datetime period.

        Args:
            from_dt: period start (inclusive), in DB-compatible TEXT format.
            to_dt: period end (inclusive), in DB-compatible TEXT format.

        Returns:
            ReportResult: filename + DOCX bytes.

        Raises:
            RuntimeError: if no active posts are configured.
        """
        batches = self.repo.list_batches(from_dt, to_dt)
        batch_ids = [b.id for b in batches]
        points = self.repo.list_points(batch_ids)

        freqs = sorted({b.frequency for b in batches})
        net_map = self.repo.latest_networks_by_frequency(freqs)

        # Adapt repo rows into the record-builder shape.
        net_by_freq = {k: {"unit": v.unit, "zone": v.zone} for k, v in net_map.items()}

        # Convert batches/points into lightweight mappings for the record builder.
        batch_dicts = [{"id": b.id, "event_dt": b.event_dt, "frequency": b.frequency} for b in batches]
        point_dicts = [{"batch_id": p.batch_id, "mgrs": p.mgrs} for p in points]

        records = build_records_from_db(batch_dicts, point_dicts, net_by_freq)

        posts = load_posts(active_only=True)
        if not posts:
            raise RuntimeError("Немає активних постів у posts.json")

        today = datetime.now().strftime("%d.%m.%Y")
        filename = f"форма_1.2.13 {today}.docx"

        with tempfile.TemporaryDirectory() as td:
            out_path = Path(td) / filename
            build_docx(records, out_path, posts=posts)
            content = out_path.read_bytes()

        return ReportResult(filename=filename, content=content)