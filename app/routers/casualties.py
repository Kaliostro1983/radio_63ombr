"""HTTP router for the Casualties (Втрати) feature.

Exposes:
- GET  /api/cas/units              → ordered list of units
- POST /api/cas/units              → add a new unit
- DELETE /api/cas/units/{id}       → remove a unit (cascades entries)
- POST /api/cas/units/reorder      → update sort order
- GET  /api/cas/entries            → current (undated) working values
- POST /api/cas/entry              → upsert a single entry (no date)
- POST /api/cas/clear-column       → zero one column (no date)
- POST /api/cas/snapshot           → save daily total with date to cas_report_snapshots
- GET  /api/cas/image              → PNG screenshot (date used for header only)
"""

from __future__ import annotations

from datetime import date as _date

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import List

from app.core.db import get_conn
from app.core.time_utils import now_sql

router = APIRouter(tags=["casualties"])


# ── Units ─────────────────────────────────────────────────────────────────────

@router.get("/api/cas/units")
def get_units():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, sort_order FROM cas_units ORDER BY sort_order, id"
        ).fetchall()
        return {
            "ok": True,
            "units": [{"id": r["id"], "name": r["name"], "sort_order": r["sort_order"]} for r in rows],
        }


class AddUnitBody(BaseModel):
    name: str


@router.post("/api/cas/units")
def add_unit(body: AddUnitBody):
    name = (body.name or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name required"}, status_code=400)
    with get_conn() as conn:
        max_ord = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM cas_units"
        ).fetchone()[0]
        try:
            row = conn.execute(
                "INSERT INTO cas_units (name, sort_order, created_at) VALUES (?,?,?) RETURNING id",
                (name, int(max_ord) + 1, now_sql()),
            ).fetchone()
            return {"ok": True, "id": row["id"]}
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)


@router.delete("/api/cas/units/{unit_id}")
def delete_unit(unit_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM cas_units WHERE id = ?", (unit_id,))
        return {"ok": True}


class ReorderBody(BaseModel):
    order: List[int]


@router.post("/api/cas/units/reorder")
def reorder_units(body: ReorderBody):
    with get_conn() as conn:
        for idx, uid in enumerate(body.order):
            conn.execute("UPDATE cas_units SET sort_order = ? WHERE id = ?", (idx, uid))
        return {"ok": True}


# ── Entries (undated working values) ──────────────────────────────────────────

@router.get("/api/cas/entries")
def get_entries():
    """Return current working values for all units (no date binding)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT unit_id, category, morning, night FROM cas_entries"
        ).fetchall()
        entries = {}
        for r in rows:
            entries[f"{r['category']}_{r['unit_id']}"] = {
                "morning": r["morning"],
                "night":   r["night"],
            }
        return {"ok": True, "entries": entries}


class ClearColumnBody(BaseModel):
    column: str   # "morning" | "night"


@router.post("/api/cas/clear-column")
def clear_column(body: ClearColumnBody):
    if body.column not in ("morning", "night"):
        return JSONResponse({"ok": False, "error": "column must be morning or night"}, status_code=400)
    with get_conn() as conn:
        conn.execute(f"UPDATE cas_entries SET {body.column} = 0")
        return {"ok": True}


class SaveEntryBody(BaseModel):
    unit_id:  int
    category: str   # "irr" | "san"
    morning:  int = 0
    night:    int = 0


@router.post("/api/cas/entry")
def save_entry(body: SaveEntryBody):
    if body.category not in ("irr", "san"):
        return JSONResponse({"ok": False, "error": "category must be irr or san"}, status_code=400)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO cas_entries (unit_id, category, morning, night)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(unit_id, category)
            DO UPDATE SET morning = excluded.morning, night = excluded.night
            """,
            (body.unit_id, body.category, body.morning, body.night),
        )
        return {"ok": True}


# ── Snapshot (daily total saved with date) ────────────────────────────────────

class SnapshotBody(BaseModel):
    date: str = ""


@router.post("/api/cas/snapshot")
def save_snapshot(body: SnapshotBody):
    """Persist the current working totals (morning+night) to cas_report_snapshots
    under the given date.  Called when the 16-08 report button is pressed.
    Pressing multiple times for the same date overwrites with latest values.
    """
    report_date = (body.date or "").strip() or _date.today().isoformat()
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT e.unit_id, u.name AS unit_name, e.category,
                   COALESCE(e.morning, 0) + COALESCE(e.night, 0) AS total
            FROM cas_entries e
            JOIN cas_units u ON u.id = e.unit_id
            """,
        ).fetchall()
        ts = now_sql()
        for r in rows:
            conn.execute(
                """
                INSERT INTO cas_report_snapshots
                    (report_date, unit_id, unit_name, category, total, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(report_date, unit_id, category)
                DO UPDATE SET
                    unit_name  = excluded.unit_name,
                    total      = excluded.total,
                    created_at = excluded.created_at
                """,
                (report_date, r["unit_id"], r["unit_name"],
                 r["category"], r["total"], ts),
            )
    return {"ok": True, "date": report_date}


# ── Image ─────────────────────────────────────────────────────────────────────

@router.get("/api/cas/image")
def get_cas_image(date: str = Query(default=""), mode: str = Query(default="morning")):
    if mode not in ("morning", "night"):
        return JSONResponse({"ok": False, "error": "mode must be morning or night"}, status_code=400)

    from app.services.cas_image import build_cas_image

    entry_date = (date or "").strip() or _date.today().isoformat()

    with get_conn() as conn:
        unit_rows = conn.execute(
            "SELECT id, name FROM cas_units ORDER BY sort_order, id"
        ).fetchall()
        # Entries are no longer date-keyed — fetch current working values
        entry_rows = conn.execute(
            "SELECT unit_id, category, morning, night FROM cas_entries"
        ).fetchall()

    units = [{"id": r["id"], "name": r["name"]} for r in unit_rows]
    entries_map = {
        f"{r['category']}_{r['unit_id']}": (r["morning"] or 0, r["night"] or 0)
        for r in entry_rows
    }

    buf = build_cas_image(units, entries_map, mode, entry_date)
    filename = f"vtrata-{mode}-{entry_date}.png"
    return StreamingResponse(
        buf,
        media_type="image/png",
        headers={"Content-Disposition": f"inline; filename={filename}"},
    )
