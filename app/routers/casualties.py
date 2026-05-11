"""HTTP router for the Casualties (Втрати) feature.

Exposes:
- GET  /api/cas/units              → ordered list of units
- POST /api/cas/units              → add a new unit
- DELETE /api/cas/units/{id}       → remove a unit (cascades entries)
- POST /api/cas/units/reorder      → update sort order
- GET  /api/cas/entries?date=...   → entries for a given date (ISO)
- POST /api/cas/entry              → upsert a single entry
"""

from __future__ import annotations

from datetime import date as _date

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
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


# ── Entries ───────────────────────────────────────────────────────────────────

@router.get("/api/cas/entries")
def get_entries(date: str = Query(default="")):
    entry_date = date or _date.today().isoformat()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT unit_id, category, morning, night FROM cas_entries WHERE entry_date = ?",
            (entry_date,),
        ).fetchall()
        entries = {}
        for r in rows:
            entries[f"{r['category']}_{r['unit_id']}"] = {
                "morning": r["morning"],
                "night": r["night"],
            }
        return {"ok": True, "date": entry_date, "entries": entries}


class ClearColumnBody(BaseModel):
    date: str = ""
    column: str          # "morning" | "night"


@router.post("/api/cas/clear-column")
def clear_column(body: ClearColumnBody):
    if body.column not in ("morning", "night"):
        return JSONResponse({"ok": False, "error": "column must be morning or night"}, status_code=400)
    entry_date = (body.date or "").strip() or _date.today().isoformat()
    col = body.column
    with get_conn() as conn:
        conn.execute(f"UPDATE cas_entries SET {col} = 0 WHERE entry_date = ?", (entry_date,))
        return {"ok": True}


class SaveEntryBody(BaseModel):
    unit_id: int
    date: str = ""
    category: str        # "irr" | "san"
    morning: int = 0
    night: int = 0


@router.post("/api/cas/entry")
def save_entry(body: SaveEntryBody):
    if body.category not in ("irr", "san"):
        return JSONResponse({"ok": False, "error": "category must be irr or san"}, status_code=400)
    entry_date = (body.date or "").strip() or _date.today().isoformat()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO cas_entries (unit_id, entry_date, category, morning, night)
            VALUES (?,?,?,?,?)
            ON CONFLICT(unit_id, entry_date, category)
            DO UPDATE SET morning = excluded.morning, night = excluded.night
            """,
            (body.unit_id, entry_date, body.category, body.morning, body.night),
        )
        return {"ok": True}
