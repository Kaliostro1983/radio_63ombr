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
    filename: str
    content: bytes

class PelengReportService:
    def __init__(self, conn: sqlite3.Connection):
        self.repo = PelengRepo(conn)

    def build_report_by_period(self, from_dt: str, to_dt: str) -> ReportResult:
        batches = self.repo.list_batches(from_dt, to_dt)
        batch_ids = [b.id for b in batches]
        points = self.repo.list_points(batch_ids)

        freqs = sorted({b.frequency for b in batches})
        net_map = self.repo.latest_networks_by_frequency(freqs)

        # адаптуємо NetworkRow -> dict для domain
        net_by_freq = {k: {"unit": v.unit, "zone": v.zone} for k, v in net_map.items()}

        # batches/points -> mappings для domain
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