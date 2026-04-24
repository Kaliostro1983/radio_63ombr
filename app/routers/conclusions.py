"""Router for the Висновки (Analytical Conclusions) page."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Dict, List

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.db import get_conn

router = APIRouter(tags=["conclusions"])


def _now_sql() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_filter_dt(value: str, default_time: str) -> str:
    """Accept either a plain date ('YYYY-MM-DD') or a datetime-local
    ('YYYY-MM-DDTHH:MM' / 'YYYY-MM-DDTHH:MM:SS') and normalise to
    an ISO-8601 datetime with seconds."""
    today = datetime.now().date().isoformat()
    if not value:
        return f"{today}T{default_time}"
    v = value.strip()
    if "T" in v:
        date_part, time_part = v.split("T", 1)
        # pad to HH:MM:SS
        time_part = (time_part + ":00:00")[:8]
        return f"{date_part}T{time_part}"
    return f"{v}T{default_time}"


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------

@router.get("/conclusions", response_class=HTMLResponse)
def conclusions_page(request: Request):
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "conclusions.html",
        {"request": request, "app_name": request.app.state.app_name},
    )


# ---------------------------------------------------------------------------
# Helper: networks list for filter dropdown
# ---------------------------------------------------------------------------

@router.get("/api/conclusions/networks")
def api_conclusions_networks():
    """Return all networks (id, frequency, mask, unit) for the filter dropdown."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, frequency, mask, unit FROM networks ORDER BY frequency ASC, mask ASC"
        ).fetchall()
    return {
        "ok": True,
        "rows": [
            {
                "id":        int(r["id"]),
                "frequency": r["frequency"] or "",
                "mask":      r["mask"] or "",
                "unit":      r["unit"] or "",
            }
            for r in rows
        ],
    }


# ---------------------------------------------------------------------------
# Conclusions list
# ---------------------------------------------------------------------------

@router.get("/api/conclusions")
def api_conclusions_list(
    date_from: str = "",
    date_to: str = "",
    network_id: int = 0,
    type_id: int = -1,
):
    """Return analytical conclusions with optional filters.

    date_from / date_to accept either 'YYYY-MM-DD' (plain date) or
    'YYYY-MM-DDTHH:MM' / 'YYYY-MM-DDTHH:MM:SS' (datetime-local from browser).
    """
    start = _parse_filter_dt(date_from, "00:00:00")
    end   = _parse_filter_dt(date_to,   "23:59:59")

    wheres = ["ac.created_at >= ?", "ac.created_at <= ?"]
    params: List[Any] = [start, end]

    if network_id:
        wheres.append("ac.network_id = ?")
        params.append(network_id)
    if type_id >= 0:
        wheres.append("ac.type_id = ?")
        params.append(type_id)

    where_sql = " AND ".join(wheres)

    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT
                ac.id,
                ac.message_id,
                ac.network_id,
                ac.created_at,
                ac.conclusion_text,
                ac.mgrs_json,
                ac.type_id,
                ct.type   AS type_label,
                ct.color  AS type_color,
                n.frequency,
                n.mask,
                n.unit,
                msg.body_text
            FROM analytical_conclusions ac
            LEFT JOIN conclusion_types ct  ON ct.id  = ac.type_id
            LEFT JOIN networks n           ON n.id   = ac.network_id
            LEFT JOIN messages msg         ON msg.id = ac.message_id
            WHERE {where_sql}
            ORDER BY ac.created_at DESC
            LIMIT 500
            """,
            params,
        ).fetchall()

    out = []
    for r in rows:
        try:
            mgrs = json.loads(r["mgrs_json"] or "[]")
        except Exception:
            mgrs = []
        out.append({
            "id":              int(r["id"]),
            "message_id":      int(r["message_id"]),
            "network_id":      int(r["network_id"]) if r["network_id"] else None,
            "created_at":      r["created_at"] or "",
            "conclusion_text": r["conclusion_text"] or "",
            "body_text":       r["body_text"] or "",
            "mgrs":            mgrs,
            "type_id":         int(r["type_id"]) if r["type_id"] is not None else 0,
            "type_label":      r["type_label"] or "невідомо",
            "type_color":      r["type_color"] or "#6b7280",
            "frequency":       r["frequency"] or "",
            "mask":            r["mask"] or "",
            "unit":            r["unit"] or "",
        })

    return {"ok": True, "rows": out, "total": len(out)}


# ---------------------------------------------------------------------------
# Conclusion types CRUD
# ---------------------------------------------------------------------------

@router.get("/api/conclusions/types")
def api_conclusion_types():
    """Return all conclusion types with their keyword lists and colors."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, type, keywords_json, color FROM conclusion_types ORDER BY id ASC"
        ).fetchall()

    out = []
    for r in rows:
        try:
            kws = json.loads(r["keywords_json"] or "[]")
        except Exception:
            kws = []
        out.append({
            "id":       int(r["id"]),
            "type":     r["type"] or "",
            "keywords": kws,
            "color":    r["color"] or "",
        })
    return {"ok": True, "rows": out}


@router.post("/api/conclusions/types")
async def api_conclusion_type_create(request: Request):
    """Create a new conclusion type. Body: {type: str}"""
    payload: Dict[str, Any] = await request.json()
    name = (payload.get("type") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "type is required"}, status_code=400)

    color = str(payload.get("color") or "").strip() or None

    with get_conn() as conn:
        dup = conn.execute(
            "SELECT id FROM conclusion_types WHERE type = ? COLLATE NOCASE LIMIT 1", (name,)
        ).fetchone()
        if dup:
            return JSONResponse({"ok": False, "error": "Такий тип вже існує"}, status_code=400)
        cur = conn.execute(
            "INSERT INTO conclusion_types (type, keywords_json, color) VALUES (?, '[]', ?)",
            (name, color),
        )
        new_id = int(cur.lastrowid)
        conn.commit()

    return {"ok": True, "id": new_id, "type": name, "keywords": [], "color": color or ""}


@router.patch("/api/conclusions/types/{type_id}")
async def api_conclusion_type_update(type_id: int, request: Request):
    """Update a conclusion type name, keywords, and/or color.
    Body: {type?: str, keywords?: [str], color?: str}
    Note: for type_id=0 ('невідомо') only color can be changed.
    """
    payload: Dict[str, Any] = await request.json()

    # System type: name and keywords are immutable, color is allowed.
    if type_id == 0 and ("type" in payload or "keywords" in payload):
        return JSONResponse(
            {"ok": False, "error": "Тип 'невідомо' не можна перейменувати або змінити ключові слова"},
            status_code=400,
        )

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, type, keywords_json, color FROM conclusion_types WHERE id = ? LIMIT 1",
            (type_id,),
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Тип не знайдено"}, status_code=404)

        new_name = (payload.get("type") or "").strip() or row["type"]
        if "keywords" in payload:
            kws = [str(k).strip() for k in (payload["keywords"] or []) if str(k).strip()]
            kws_json = json.dumps(kws, ensure_ascii=False)
        else:
            kws_json = row["keywords_json"]

        new_color = (
            str(payload["color"]).strip() if "color" in payload else (row["color"] or "")
        )

        conn.execute(
            "UPDATE conclusion_types SET type = ?, keywords_json = ?, color = ? WHERE id = ?",
            (new_name, kws_json, new_color or None, type_id),
        )
        conn.commit()

    return {"ok": True, "id": type_id, "type": new_name, "color": new_color}


# ---------------------------------------------------------------------------
# Quick conclusions + quick points
# ---------------------------------------------------------------------------

@router.get("/api/quick-conclusions")
def api_quick_conclusions():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, text FROM quick_conclusions ORDER BY id ASC"
        ).fetchall()
    return {
        "ok": True,
        "rows": [{"id": int(r["id"]), "name": r["name"] or "", "text": r["text"] or ""} for r in rows],
    }


@router.post("/api/quick-conclusions")
async def api_quick_conclusions_create(request: Request):
    payload = await request.json()
    name = (payload.get("name") or "").strip()
    text = (payload.get("text") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)
    with get_conn() as conn:
        dup = conn.execute(
            "SELECT id FROM quick_conclusions WHERE name = ? COLLATE NOCASE LIMIT 1", (name,)
        ).fetchone()
        if dup:
            return JSONResponse({"ok": False, "error": "Така назва вже існує"}, status_code=400)
        cur = conn.execute(
            "INSERT INTO quick_conclusions (name, text) VALUES (?, ?)", (name, text)
        )
        new_id = int(cur.lastrowid)
        conn.commit()
    return {"ok": True, "id": new_id, "name": name, "text": text}


@router.patch("/api/quick-conclusions/{item_id}")
async def api_quick_conclusions_update(item_id: int, request: Request):
    payload = await request.json()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, text FROM quick_conclusions WHERE id = ? LIMIT 1", (item_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        new_name = (payload.get("name") or "").strip() or row["name"]
        new_text = payload.get("text", row["text"]) or ""
        conn.execute(
            "UPDATE quick_conclusions SET name = ?, text = ? WHERE id = ?",
            (new_name, new_text, item_id),
        )
        conn.commit()
    return {"ok": True, "id": item_id, "name": new_name, "text": new_text}


@router.delete("/api/quick-conclusions/{item_id}")
def api_quick_conclusions_delete(item_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM quick_conclusions WHERE id = ? LIMIT 1", (item_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        conn.execute("DELETE FROM quick_conclusions WHERE id = ?", (item_id,))
        conn.commit()
    return {"ok": True}


@router.get("/api/quick-points")
def api_quick_points():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, point FROM quick_points ORDER BY id ASC"
        ).fetchall()
    return {
        "ok": True,
        "rows": [{"id": int(r["id"]), "name": r["name"] or "", "point": r["point"] or ""} for r in rows],
    }


@router.post("/api/quick-points")
async def api_quick_points_create(request: Request):
    payload = await request.json()
    name  = (payload.get("name")  or "").strip()
    point = (payload.get("point") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)
    with get_conn() as conn:
        dup = conn.execute(
            "SELECT id FROM quick_points WHERE name = ? COLLATE NOCASE LIMIT 1", (name,)
        ).fetchone()
        if dup:
            return JSONResponse({"ok": False, "error": "Така назва вже існує"}, status_code=400)
        cur = conn.execute(
            "INSERT INTO quick_points (name, point) VALUES (?, ?)", (name, point)
        )
        new_id = int(cur.lastrowid)
        conn.commit()
    return {"ok": True, "id": new_id, "name": name, "point": point}


@router.patch("/api/quick-points/{item_id}")
async def api_quick_points_update(item_id: int, request: Request):
    payload = await request.json()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, point FROM quick_points WHERE id = ? LIMIT 1", (item_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        new_name  = (payload.get("name")  or "").strip() or row["name"]
        new_point = payload.get("point", row["point"]) or ""
        conn.execute(
            "UPDATE quick_points SET name = ?, point = ? WHERE id = ?",
            (new_name, new_point, item_id),
        )
        conn.commit()
    return {"ok": True, "id": item_id, "name": new_name, "point": new_point}


@router.delete("/api/quick-points/{item_id}")
def api_quick_points_delete(item_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM quick_points WHERE id = ? LIMIT 1", (item_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        conn.execute("DELETE FROM quick_points WHERE id = ?", (item_id,))
        conn.commit()
    return {"ok": True}


@router.delete("/api/conclusions/types/{type_id}")
def api_conclusion_type_delete(type_id: int):
    """Delete a conclusion type; reassigns its conclusions to type 0."""
    if type_id == 0:
        return JSONResponse({"ok": False, "error": "Тип 'невідомо' не можна видалити"}, status_code=400)

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM conclusion_types WHERE id = ? LIMIT 1", (type_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Тип не знайдено"}, status_code=404)

        conn.execute(
            "UPDATE analytical_conclusions SET type_id = 0 WHERE type_id = ?", (type_id,)
        )
        conn.execute("DELETE FROM conclusion_types WHERE id = ?", (type_id,))
        conn.commit()

    return {"ok": True}
