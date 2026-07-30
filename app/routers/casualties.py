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

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import List, Optional

from app.core.access import current_device_mask
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


# ═══════════════════════════════════════════════════════════════════════════════
# «Втрати 2» — записи втрат, привʼязані до перехоплень (окремо від ручного талію).
#   casualties           — записи-контейнери (статус 200/300, к-сть, причина…)
#   casualty_reasons     — редагований довідник причин
#   casualty_callsigns   — звʼязок запис↔позивний (виставляє life_status позивного)
# ═══════════════════════════════════════════════════════════════════════════════

def _norm_status(s) -> str:
    return "200" if str(s or "").strip() == "200" else "300"


# ── Довідник причин ────────────────────────────────────────────────────────────

@router.get("/api/casualty-reasons")
def cas_reasons_list():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name FROM casualty_reasons WHERE is_active = 1 ORDER BY sort_order, id"
        ).fetchall()
    return {"ok": True, "reasons": [{"id": r["id"], "name": r["name"]} for r in rows]}


class ReasonBody(BaseModel):
    name: str


@router.post("/api/casualty-reasons")
def cas_reason_add(body: ReasonBody):
    name = (body.name or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name required"}, status_code=400)
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM casualty_reasons WHERE name = ?", (name,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE casualty_reasons SET is_active = 1 WHERE id = ?", (existing["id"],)
            )
            return {"ok": True, "id": existing["id"]}
        mx = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM casualty_reasons"
        ).fetchone()[0]
        row = conn.execute(
            "INSERT INTO casualty_reasons (name, sort_order) VALUES (?, ?) RETURNING id",
            (name, int(mx) + 1),
        ).fetchone()
    return {"ok": True, "id": row["id"]}


# ── Записи втрат ───────────────────────────────────────────────────────────────

def _casualty_dict(conn, r) -> dict:
    """Серіалізує рядок casualties (з join reason_name/unit_name) + позивні."""
    cs = conn.execute(
        "SELECT c.id, c.name FROM casualty_callsigns cc "
        "JOIN callsigns c ON c.id = cc.callsign_id WHERE cc.casualty_id = ?",
        (r["id"],),
    ).fetchall()
    keys = r.keys()
    unit_name = r["unit_name"] if "unit_name" in keys else None
    return {
        "id": r["id"],
        "message_id": r["message_id"],
        "status": r["status"],
        "count": r["count"],
        "reason_id": r["reason_id"],
        "reason": (r["reason_name"] if "reason_name" in keys else None),
        "unit_id": r["unit_id"],
        "unit": (unit_name or r["unit_text"] or ""),
        "unit_text": r["unit_text"],
        "accounted": bool(r["accounted"]),
        "comment": r["comment"] or "",
        "created_at": r["created_at"],
        "created_by": r["created_by"],
        "last_edited_by": r["last_edited_by"],
        "last_edited_at": r["last_edited_at"],
        "callsigns": [{"id": x["id"], "name": x["name"]} for x in cs],
    }


_SELECT_CASUALTY = (
    "SELECT cas.*, r.name AS reason_name, u.name AS unit_name "
    "FROM casualties cas "
    "LEFT JOIN casualty_reasons r ON r.id = cas.reason_id "
    "LEFT JOIN cas_units u        ON u.id = cas.unit_id "
)


def _apply_callsign_casualty(conn, callsign_id: int, status: str,
                             message_id: int, editor: str, ts: str) -> None:
    """Прив'язаному позивному виставляє life_status (200/300) і дописує
    згадку перехоплення в коментар (без дублювання)."""
    row = conn.execute("SELECT comment FROM callsigns WHERE id = ?", (callsign_id,)).fetchone()
    if not row:
        return
    comment = row["comment"] or ""
    marker = f"[втрати {status}] перехоплення #{message_id}"
    if marker not in comment:
        comment = (comment + ("\n" if comment.strip() else "") + marker).strip()
    conn.execute(
        "UPDATE callsigns SET life_status = ?, comment = ?, "
        "last_edited_by = ?, last_edited_at = ? WHERE id = ?",
        (status, comment, editor, ts, callsign_id),
    )


@router.get("/api/casualties")
def cas_records_list(
    message_id: int = Query(default=0),
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
):
    """Записи втрат: для конкретного перехоплення (message_id) або за періодом."""
    wheres = ["cas.is_valid = 1"]
    params: list = []
    if message_id:
        wheres.append("cas.message_id = ?"); params.append(message_id)
    if date_from:
        wheres.append("cas.created_at >= ?"); params.append(date_from)
    if date_to:
        wheres.append("cas.created_at <= ?"); params.append(date_to)
    sql = _SELECT_CASUALTY + "WHERE " + " AND ".join(wheres) + \
        " ORDER BY cas.created_at DESC, cas.id DESC"
    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        out = [_casualty_dict(conn, r) for r in rows]
    return {"ok": True, "records": out}


class CasualtyIn(BaseModel):
    message_id: int
    status: str = "300"
    count: int = 1
    reason_id: Optional[int] = None
    unit_id: Optional[int] = None
    unit_text: str = ""
    accounted: bool = False
    comment: str = ""
    callsign_ids: List[int] = []
    # Чи виставляти life_status позивним. Інкрементальне збереження — False
    # (лише фіксуємо звʼязок); застосування статусів — на кнопці «Надіслати».
    apply_status: bool = True


@router.post("/api/casualties")
def cas_record_create(body: CasualtyIn, request: Request):
    if not body.message_id:
        return JSONResponse({"ok": False, "error": "message_id required"}, status_code=400)
    status = _norm_status(body.status)
    editor = current_device_mask(request)
    ts = now_sql()
    with get_conn() as conn:
        new = conn.execute(
            """
            INSERT INTO casualties
                (message_id, status, count, reason_id, unit_id, unit_text, accounted,
                 comment, created_at, created_by, last_edited_at, last_edited_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (body.message_id, status, max(1, int(body.count or 1)), body.reason_id,
             body.unit_id, (body.unit_text or "").strip(), 1 if body.accounted else 0,
             (body.comment or "").strip(), ts, editor, ts, editor),
        ).fetchone()
        cas_id = new["id"]
        for cid in dict.fromkeys(body.callsign_ids or []):
            conn.execute(
                "INSERT OR IGNORE INTO casualty_callsigns (casualty_id, callsign_id) VALUES (?, ?)",
                (cas_id, cid),
            )
            if body.apply_status:
                _apply_callsign_casualty(conn, cid, status, body.message_id, editor, ts)
        r = conn.execute(_SELECT_CASUALTY + "WHERE cas.id = ?", (cas_id,)).fetchone()
        out = _casualty_dict(conn, r)
    return {"ok": True, "record": out}


class CasualtyUpdate(BaseModel):
    status: Optional[str] = None
    count: Optional[int] = None
    reason_id: Optional[int] = None
    unit_id: Optional[int] = None
    unit_text: Optional[str] = None
    accounted: Optional[bool] = None
    comment: Optional[str] = None
    callsign_ids: Optional[List[int]] = None
    apply_status: bool = False   # застосовувати life_status лише на «Надіслати»


@router.put("/api/casualties/{cas_id}")
def cas_record_update(cas_id: int, body: CasualtyUpdate, request: Request):
    editor = current_device_mask(request)
    ts = now_sql()
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT * FROM casualties WHERE id = ? AND is_valid = 1", (cas_id,)
        ).fetchone()
        if not cur:
            return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
        status    = _norm_status(body.status) if body.status is not None else cur["status"]
        count     = max(1, int(body.count)) if body.count is not None else cur["count"]
        reason_id = body.reason_id if body.reason_id is not None else cur["reason_id"]
        unit_id   = body.unit_id if body.unit_id is not None else cur["unit_id"]
        unit_text = (body.unit_text or "").strip() if body.unit_text is not None else cur["unit_text"]
        accounted = (1 if body.accounted else 0) if body.accounted is not None else cur["accounted"]
        comment   = (body.comment or "").strip() if body.comment is not None else cur["comment"]
        conn.execute(
            "UPDATE casualties SET status = ?, count = ?, reason_id = ?, unit_id = ?, "
            "unit_text = ?, accounted = ?, comment = ?, last_edited_at = ?, last_edited_by = ? "
            "WHERE id = ?",
            (status, count, reason_id, unit_id, unit_text, accounted, comment, ts, editor, cas_id),
        )
        if body.callsign_ids is not None:
            conn.execute("DELETE FROM casualty_callsigns WHERE casualty_id = ?", (cas_id,))
            for cid in dict.fromkeys(body.callsign_ids):
                conn.execute(
                    "INSERT OR IGNORE INTO casualty_callsigns (casualty_id, callsign_id) VALUES (?, ?)",
                    (cas_id, cid),
                )
        # Статус позивним застосовуємо лише коли просять (кнопка «Надіслати»).
        if body.apply_status:
            linked = conn.execute(
                "SELECT callsign_id FROM casualty_callsigns WHERE casualty_id = ?", (cas_id,)
            ).fetchall()
            for lr in linked:
                _apply_callsign_casualty(conn, lr["callsign_id"], status, cur["message_id"], editor, ts)
        r = conn.execute(_SELECT_CASUALTY + "WHERE cas.id = ?", (cas_id,)).fetchone()
        out = _casualty_dict(conn, r)
    return {"ok": True, "record": out}


@router.delete("/api/casualties/{cas_id}")
def cas_record_delete(cas_id: int, request: Request):
    """Мʼяке видалення (is_valid=0). Статуси позивних не відкочуємо."""
    editor = current_device_mask(request)
    ts = now_sql()
    with get_conn() as conn:
        conn.execute(
            "UPDATE casualties SET is_valid = 0, last_edited_at = ?, last_edited_by = ? WHERE id = ?",
            (ts, editor, cas_id),
        )
    return {"ok": True}
