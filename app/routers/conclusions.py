"""Router for the Висновки (Analytical Conclusions) page."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.config import settings
from app.core.db import get_conn

router = APIRouter(tags=["conclusions"])


def _normalize_delta_identification(value: object) -> str:
    """Map any legacy value to one of two canonical states ('Ворожий' / 'Дружній').

    Single source of truth = 'Ворожий' checkbox in conclusion-type card.
    Empty/NULL → 'Ворожий' (system default for not-yet-edited types).
    Anything else that isn't literally 'Ворожий' → 'Дружній'
    (handles legacy 'Невизначений', 'Невідомий', etc.).
    """
    v = str(value or "").strip()
    if v == "Ворожий" or v == "":
        return "Ворожий"
    return "Дружній"


def _now_sql() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_filter_dt(value: str, default_time: str) -> str:
    """Accept either a plain date ('YYYY-MM-DD') or a datetime-local
    ('YYYY-MM-DDTHH:MM' / 'YYYY-MM-DDTHH:MM:SS') and normalise to
    space-separated 'YYYY-MM-DD HH:MM:SS' (matches DB storage format)."""
    today = datetime.now().date().isoformat()
    if not value:
        return f"{today} {default_time}"
    v = value.strip().replace("T", " ")
    if " " not in v:
        return f"{v} {default_time}"
    date_part, time_part = v.split(" ", 1)
    # pad to HH:MM:SS
    time_part = (time_part + ":00:00")[:8]
    return f"{date_part} {time_part}"


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


@router.get("/conclusions/map", response_class=HTMLResponse)
def conclusions_map_page(request: Request):
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "conclusions_map.html",
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

    wheres = ["REPLACE(ac.created_at,'T',' ') >= ?", "REPLACE(ac.created_at,'T',' ') <= ?"]
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
                ac.sended,
                ct.type   AS type_label,
                ct.color  AS type_color,
                n.frequency,
                n.mask,
                n.unit,
                msg.body_text,
                msg.net_description
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
            "net_description": r["net_description"] or "",
            "mgrs":            mgrs,
            "type_id":         int(r["type_id"]) if r["type_id"] is not None else 0,
            "type_label":      r["type_label"] or "невідомо",
            "type_color":      r["type_color"] or "#6b7280",
            "frequency":       r["frequency"] or "",
            "mask":            r["mask"] or "",
            "unit":            r["unit"] or "",
            "sended":          int(r["sended"]) if r["sended"] is not None else 0,
        })

    return {"ok": True, "rows": out, "total": len(out)}


# ---------------------------------------------------------------------------
# Cross-group conclusion comparison ("Аналітика 63" vs "Батальйони 63")
# ---------------------------------------------------------------------------

@router.get("/api/conclusions/compare")
def api_conclusions_compare(date_from: str = "", date_to: str = ""):
    """Compare analytical conclusions from the two source groups over a period.

    Conclusions are matched by the intercept they reference — the key is
    (network_id, created_at), i.e. the intercept's frequency + datetime.
    "Аналітика 63" rows come from `analytical_conclusions`; "Батальйони 63"
    rows from the isolated `battalion_conclusions` table.

    date_from / date_to filter on the intercept datetime. When omitted they
    default to (now − 8h) … now. One row is returned per unique intercept that
    has at least one conclusion, sorted by intercept datetime ascending, with a
    `category`:
        "only_one" — conclusion present in only one group;
        "match"    — both groups, identical MGRS set;
        "diff"     — both groups, at least one differing MGRS coordinate.
    """
    now = datetime.now()
    start = _parse_filter_dt(date_from, "00:00:00") if date_from \
        else (now - timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")
    end = _parse_filter_dt(date_to, "23:59:59") if date_to \
        else now.strftime("%Y-%m-%d %H:%M:%S")

    rows: Dict[tuple, Dict[str, Any]] = {}

    def _slot(network_id, created_at, freq, unit) -> Dict[str, Any]:
        key = (
            int(network_id) if network_id is not None else 0,
            str(created_at or "").replace("T", " "),
        )
        if key not in rows:
            rows[key] = {
                "created_at":      key[1],
                "frequency":       freq or "",
                "unit":            unit or "",
                "net_description": "",
                "body_text":       "",
                "intercept_text":  "",
                "analytics":       [],
                "battalions":      [],
            }
        return rows[key]

    def _mgrs(raw) -> list:
        try:
            return json.loads(raw or "[]")
        except Exception:
            return []

    with get_conn() as conn:
        a_rows = conn.execute(
            """
            SELECT ac.network_id, ac.created_at, ac.conclusion_text, ac.mgrs_json,
                   msg.body_text, msg.net_description, n.frequency, n.unit
            FROM analytical_conclusions ac
            LEFT JOIN messages msg ON msg.id = ac.message_id
            LEFT JOIN networks n   ON n.id   = ac.network_id
            WHERE REPLACE(ac.created_at,'T',' ') >= ?
              AND REPLACE(ac.created_at,'T',' ') <= ?
            """,
            (start, end),
        ).fetchall()
        b_rows = conn.execute(
            """
            SELECT bc.network_id, bc.created_at, bc.conclusion_text, bc.mgrs_json,
                   bc.intercept_text, bc.source_marker, n.frequency, n.unit
            FROM battalion_conclusions bc
            LEFT JOIN networks n ON n.id = bc.network_id
            WHERE REPLACE(bc.created_at,'T',' ') >= ?
              AND REPLACE(bc.created_at,'T',' ') <= ?
            """,
            (start, end),
        ).fetchall()

    for r in a_rows:
        slot = _slot(r["network_id"], r["created_at"], r["frequency"], r["unit"])
        slot["analytics"].append({
            "conclusion_text": r["conclusion_text"] or "",
            "mgrs":            _mgrs(r["mgrs_json"]),
        })
        if not slot["net_description"] and not slot["body_text"]:
            slot["net_description"] = r["net_description"] or ""
            slot["body_text"]       = r["body_text"] or ""

    for r in b_rows:
        slot = _slot(r["network_id"], r["created_at"], r["frequency"], r["unit"])
        slot["battalions"].append({
            "conclusion_text": r["conclusion_text"] or "",
            "mgrs":            _mgrs(r["mgrs_json"]),
            "source_marker":   r["source_marker"] or "",
        })
        if not slot["intercept_text"]:
            slot["intercept_text"] = r["intercept_text"] or ""

    out: List[Dict[str, Any]] = []
    for slot in rows.values():
        a, b = slot["analytics"], slot["battalions"]
        a_set = {m for c in a for m in c["mgrs"]}
        b_set = {m for c in b for m in c["mgrs"]}
        if a and b:
            category = "match" if a_set == b_set else "diff"
        else:
            category = "only_one"

        parts = [p for p in (slot["net_description"], slot["body_text"]) if p]
        intercept = "\n\n".join(parts) if parts else slot["intercept_text"]

        out.append({
            "created_at":     slot["created_at"],
            "frequency":      slot["frequency"],
            "unit":           slot["unit"],
            "intercept_text": intercept,
            "analytics":      a,
            "battalions":     b,
            "category":       category,
        })

    out.sort(key=lambda x: x["created_at"])
    return {
        "ok": True,
        "rows": out,
        "total": len(out),
        "date_from": start,
        "date_to": end,
    }


# ---------------------------------------------------------------------------
# Manual conclusion save (from the Висновок editor modal)
# ---------------------------------------------------------------------------

def _classify_conclusion(conn, conclusion_text: str) -> int:
    """Pick the best-matching conclusion type_id by keyword hits (0 = невідомо)."""
    text = (conclusion_text or "").lower()
    rows = conn.execute(
        "SELECT id, keywords_json FROM conclusion_types WHERE id > 0 "
        "ORDER BY sort_order ASC, id ASC"
    ).fetchall()
    best_id, best_score = 0, 0
    for r in rows:
        try:
            kws = json.loads(r["keywords_json"] or "[]")
        except Exception:
            kws = []
        score = sum(1 for kw in kws if kw and kw.lower() in text)
        if score > best_score:
            best_score, best_id = score, int(r["id"])
    return best_id


@router.post("/api/conclusions")
async def api_conclusion_save(request: Request):
    """Create or update an analytical conclusion for a given intercept.

    Body: { message_id:int, conclusion_text:str, mgrs:[str], intercept_text?:str }

    The conclusion is bound to the intercept's message; network_id and created_at
    are derived server-side from that message (not trusted from the client).
    Because analytical_conclusions.message_id is UNIQUE, this upserts: if a
    conclusion already exists for the message it is overwritten. The conclusion
    is auto-classified by keyword, exactly like the ingest path, so a manually
    saved conclusion behaves like any other "Аналітика 63" conclusion.
    """
    payload: Dict[str, Any] = await request.json()

    try:
        message_id = int(payload.get("message_id"))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "message_id обовʼязковий"}, status_code=400)

    conclusion_text = (payload.get("conclusion_text") or "").strip()
    mgrs_list = [str(m).strip() for m in (payload.get("mgrs") or []) if str(m).strip()]

    missing = []
    if not conclusion_text:
        missing.append("Висновок")
    if not mgrs_list:
        missing.append("Координати")
    if missing:
        return JSONResponse(
            {"ok": False, "error": "Не заповнено: " + ", ".join(missing), "missing": missing},
            status_code=400,
        )

    mgrs_json = json.dumps(mgrs_list, ensure_ascii=False)

    with get_conn() as conn:
        msg = conn.execute(
            "SELECT id, network_id, created_at FROM messages WHERE id = ?", (message_id,)
        ).fetchone()
        if not msg:
            return JSONResponse({"ok": False, "error": "Перехоплення не знайдено"}, status_code=404)

        network_id = int(msg["network_id"])
        created_at = msg["created_at"]
        type_id = _classify_conclusion(conn, conclusion_text)

        existing = conn.execute(
            "SELECT id FROM analytical_conclusions WHERE message_id = ?", (message_id,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE analytical_conclusions "
                "SET conclusion_text = ?, mgrs_json = ?, type_id = ?, "
                "    network_id = ?, created_at = ? "
                "WHERE message_id = ?",
                (conclusion_text, mgrs_json, type_id, network_id, created_at, message_id),
            )
            ac_id = int(existing["id"])
            created = False
        else:
            cur = conn.execute(
                "INSERT INTO analytical_conclusions "
                "(message_id, network_id, created_at, conclusion_text, mgrs_json, type_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (message_id, network_id, created_at, conclusion_text, mgrs_json, type_id),
            )
            ac_id = int(cur.lastrowid)
            created = True
        conn.commit()

        t = conn.execute(
            "SELECT type, color FROM conclusion_types WHERE id = ?", (type_id,)
        ).fetchone()

    return {
        "ok": True,
        "id": ac_id,
        "created": created,
        "type_id": type_id,
        "type_label": (t["type"] if t else "невідомо"),
        "type_color": (t["color"] if t else "#6b7280"),
    }


# ---------------------------------------------------------------------------
# Conclusion types CRUD
# ---------------------------------------------------------------------------

@router.get("/api/conclusions/types")
def api_conclusion_types():
    """Return all conclusion types ordered by sort_order (user-defined), then id."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, type, keywords_json, color, sort_order,"
            "       delta_auto_send, delta_type, delta_identification,"
            "       delta_source, delta_presence, icon_filename, icon_sidc "
            "FROM conclusion_types ORDER BY sort_order ASC, id ASC"
        ).fetchall()

    out = []
    for r in rows:
        try:
            kws = json.loads(r["keywords_json"] or "[]")
        except Exception:
            kws = []
        out.append({
            "id":                   int(r["id"]),
            "type":                 r["type"] or "",
            "keywords":             kws,
            "color":                r["color"] or "",
            "sort_order":           int(r["sort_order"]) if r["sort_order"] is not None else 0,
            "delta_auto_send":      bool(r["delta_auto_send"]) if r["delta_auto_send"] is not None else True,
            "delta_type":           r["delta_type"] or "",
            "delta_identification": _normalize_delta_identification(r["delta_identification"]),
            "delta_source":         r["delta_source"] or "Радіорозвідка (РР)",
            "delta_presence":       r["delta_presence"] or "присутній",
            "icon_filename":        r["icon_filename"] or "",
            "icon_sidc":            r["icon_sidc"] or "",
        })
    return {"ok": True, "rows": out}


@router.get("/api/conclusions/icons")
def api_conclusion_icons():
    """Return a list of available SVG icon filenames from the static/icons folder."""
    icons_dir = os.path.join(os.path.dirname(__file__), "..", "static", "icons")
    icons_dir = os.path.normpath(icons_dir)
    try:
        files = sorted(f for f in os.listdir(icons_dir) if f.lower().endswith(".svg"))
    except FileNotFoundError:
        files = []
    return {"ok": True, "icons": files}


@router.put("/api/conclusions/types/order")
async def api_conclusion_types_reorder(request: Request):
    """Persist a new sort order.  Body: [{id, sort_order}, ...]"""
    payload = await request.json()
    if not isinstance(payload, list):
        return JSONResponse({"ok": False, "error": "expected array"}, status_code=400)
    with get_conn() as conn:
        for item in payload:
            conn.execute(
                "UPDATE conclusion_types SET sort_order = ? WHERE id = ?",
                (int(item["sort_order"]), int(item["id"])),
            )
    return {"ok": True}


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

        # Delta fields (optional)
        delta_fields: Dict[str, Any] = {}
        if "delta_auto_send" in payload:
            delta_fields["delta_auto_send"] = 1 if payload["delta_auto_send"] else 0
        if "delta_type" in payload:
            delta_fields["delta_type"] = str(payload["delta_type"]).strip()
        if "delta_identification" in payload:
            delta_fields["delta_identification"] = _normalize_delta_identification(payload["delta_identification"])
        if "delta_source" in payload:
            delta_fields["delta_source"] = str(payload["delta_source"]).strip()
        if "delta_presence" in payload:
            delta_fields["delta_presence"] = str(payload["delta_presence"]).strip()
        if "icon_filename" in payload:
            delta_fields["icon_filename"] = str(payload["icon_filename"]).strip()
        if "icon_sidc" in payload:
            delta_fields["icon_sidc"] = str(payload["icon_sidc"]).strip()

        set_parts = "type = ?, keywords_json = ?, color = ?"
        params: List[Any] = [new_name, kws_json, new_color or None]
        for col, val in delta_fields.items():
            set_parts += f", {col} = ?"
            params.append(val)
        params.append(type_id)

        conn.execute(f"UPDATE conclusion_types SET {set_parts} WHERE id = ?", params)
        conn.commit()

    return {"ok": True, "id": type_id, "type": new_name, "color": new_color}


# ---------------------------------------------------------------------------
# Patch a single conclusion's type (manual override)
# ---------------------------------------------------------------------------

@router.patch("/api/conclusions/{ac_id}/type")
async def api_patch_conclusion_type(ac_id: int, request: Request):
    """Manually set the type_id on a single analytical_conclusion row."""
    payload: Dict[str, Any] = await request.json()
    if "type_id" not in payload:
        return JSONResponse({"ok": False, "error": "type_id required"}, status_code=400)
    type_id = int(payload["type_id"])

    with get_conn() as conn:
        if not conn.execute("SELECT id FROM analytical_conclusions WHERE id=?", (ac_id,)).fetchone():
            return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
        conn.execute("UPDATE analytical_conclusions SET type_id=? WHERE id=?", (type_id, ac_id))
        t = conn.execute("SELECT type, color FROM conclusion_types WHERE id=?", (type_id,)).fetchone()
    return {
        "ok": True,
        "type_id":    type_id,
        "type_label": (t["type"]  if t else "невідомо"),
        "type_color": (t["color"] if t else "#6b7280"),
    }


# ---------------------------------------------------------------------------
# Re-classify a single conclusion by keyword matching
# ---------------------------------------------------------------------------

@router.post("/api/conclusions/{ac_id}/reclassify")
def api_reclassify_conclusion(ac_id: int):
    """Re-score the conclusion text against all conclusion_types keywords and
    assign the best-matching type (most keyword hits). If no type matches,
    type_id stays 0 (невідомо)."""
    with get_conn() as conn:
        ac = conn.execute(
            "SELECT id, conclusion_text, type_id FROM analytical_conclusions WHERE id=?",
            (ac_id,),
        ).fetchone()
        if not ac:
            return JSONResponse({"ok": False, "error": "not found"}, status_code=404)

        types = conn.execute(
            "SELECT id, type, keywords_json, color FROM conclusion_types "
            "WHERE id > 0 ORDER BY sort_order ASC, id ASC"
        ).fetchall()

        text = (ac["conclusion_text"] or "").lower()
        best_id, best_score = 0, 0
        for t in types:
            try:
                kws = json.loads(t["keywords_json"] or "[]")
            except Exception:
                kws = []
            score = sum(1 for kw in kws if kw and kw.lower() in text)
            if score > best_score:
                best_score, best_id = score, int(t["id"])

        conn.execute(
            "UPDATE analytical_conclusions SET type_id=? WHERE id=?", (best_id, ac_id)
        )
        t_row = conn.execute(
            "SELECT type, color FROM conclusion_types WHERE id=?", (best_id,)
        ).fetchone() if best_id else None

    return {
        "ok": True,
        "type_id":    best_id,
        "type_label": (t_row["type"]  if t_row else "невідомо"),
        "type_color": (t_row["color"] if t_row else "#6b7280"),
    }


@router.post("/api/conclusions/{ac_id}/mark-sended")
def api_mark_sended(ac_id: int):
    """Mark an analytical conclusion as Delta-sent (sended=1)."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE analytical_conclusions SET sended=1 WHERE id=?", (ac_id,)
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# App settings (global key-value store)
# ---------------------------------------------------------------------------

@router.get("/api/settings")
def api_get_settings(keys: str = ""):
    """Return app_settings rows.  Pass ?keys=k1,k2 to filter."""
    key_list = [k.strip() for k in keys.split(",") if k.strip()]
    with get_conn() as conn:
        if key_list:
            placeholders = ",".join("?" * len(key_list))
            rows = conn.execute(
                f"SELECT key, value FROM app_settings WHERE key IN ({placeholders})",
                key_list,
            ).fetchall()
        else:
            rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    return {"ok": True, "settings": {r["key"]: r["value"] for r in rows}}


@router.put("/api/settings")
async def api_put_settings(request: Request):
    """Upsert one or more app_settings rows.  Body: {key: value, ...}"""
    data = await request.json()
    with get_conn() as conn:
        for key, value in data.items():
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(key), str(value)),
            )
    return {"ok": True}


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


# ---------------------------------------------------------------------------
# Map labels CRUD
# ---------------------------------------------------------------------------

@router.get("/api/map-labels")
def api_map_labels():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, mgrs FROM map_labels ORDER BY name ASC"
        ).fetchall()
    return {
        "ok": True,
        "rows": [{"id": int(r["id"]), "name": r["name"] or "", "mgrs": r["mgrs"] or ""} for r in rows],
    }


@router.post("/api/map-labels")
async def api_map_labels_create(request: Request):
    payload = await request.json()
    name = (payload.get("name") or "").strip()
    mgrs = (payload.get("mgrs") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO map_labels (name, mgrs) VALUES (?, ?)", (name, mgrs)
        )
        new_id = int(cur.lastrowid)
        conn.commit()
    return {"ok": True, "id": new_id, "name": name, "mgrs": mgrs}


@router.patch("/api/map-labels/{item_id}")
async def api_map_labels_update(item_id: int, request: Request):
    payload = await request.json()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, mgrs FROM map_labels WHERE id = ? LIMIT 1", (item_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        new_name = (payload.get("name") or "").strip() or row["name"]
        new_mgrs = payload.get("mgrs", row["mgrs"]) or ""
        conn.execute(
            "UPDATE map_labels SET name = ?, mgrs = ? WHERE id = ?",
            (new_name, new_mgrs, item_id),
        )
        conn.commit()
    return {"ok": True, "id": item_id, "name": new_name, "mgrs": new_mgrs}


@router.delete("/api/map-labels/{item_id}")
def api_map_labels_delete(item_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM map_labels WHERE id = ? LIMIT 1", (item_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        conn.execute("DELETE FROM map_labels WHERE id = ?", (item_id,))
        conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Publish to chat-bot service
# ---------------------------------------------------------------------------

@router.post("/api/publish")
async def api_publish(request: Request):
    """Forward text + optional map image to the chat-bot service on port 3001.

    Body: { "text": str, "image_b64": str }
      text      — conclusion text (required)
      image_b64 — base-64 PNG from the map screenshot (optional, may be empty)

    The bot service URL is read from PUBLISH_BOT_URL in config.env.
    The bot must have a "FastAPI → chat" automation configured; our request
    simply delivers the payload — the target group is resolved by the bot.
    """
    if not settings.publish_bot_url:
        return JSONResponse(
            {"ok": False, "error": "PUBLISH_BOT_URL не налаштовано в config.env"},
            status_code=503,
        )

    payload: Dict[str, Any] = await request.json()
    text = (payload.get("text") or "").strip()
    image_b64 = (payload.get("image_b64") or "").strip()

    if not text:
        return JSONResponse({"ok": False, "error": "Текст порожній"}, status_code=400)

    bot_body = json.dumps(
        {"text": text, "image_base64": image_b64},
        ensure_ascii=False,
    ).encode()

    req = urllib.request.Request(
        settings.publish_bot_url,
        data=bot_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()          # consume body, check for errors
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode(errors="replace")[:200]
        except Exception:
            detail = ""
        return JSONResponse(
            {"ok": False, "error": f"Bot HTTP {exc.code}: {detail}"},
            status_code=502,
        )
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)

    return {"ok": True}


# ---------------------------------------------------------------------------
# Delta "Тип" options — user-configurable list shared across all types
# ---------------------------------------------------------------------------

@router.get("/api/delta/type-options")
def api_delta_type_options():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, value FROM delta_type_options ORDER BY sort_order ASC, id ASC"
        ).fetchall()
    return {"ok": True, "rows": [{"id": r["id"], "value": r["value"]} for r in rows]}


@router.post("/api/delta/type-options")
async def api_delta_type_option_add(request: Request):
    payload: Dict[str, Any] = await request.json()
    value = (payload.get("value") or "").strip()
    if not value:
        return JSONResponse({"ok": False, "error": "Значення порожнє"}, status_code=400)
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM delta_type_options WHERE value = ? COLLATE NOCASE LIMIT 1", (value,)
        ).fetchone()
        if existing:
            return JSONResponse({"ok": False, "error": "Такий варіант вже існує"}, status_code=409)
        cur = conn.execute("INSERT INTO delta_type_options (value) VALUES (?)", (value,))
        conn.commit()
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id, "value": value}


@router.delete("/api/delta/type-options/{option_id}")
def api_delta_type_option_delete(option_id: int):
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM delta_type_options WHERE id=?", (option_id,)).fetchone():
            return JSONResponse({"ok": False, "error": "Не знайдено"}, status_code=404)
        conn.execute("DELETE FROM delta_type_options WHERE id=?", (option_id,))
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


# --------------------------------------------------------------------------- #
#  Shared conclusion templates (server-side, replaces per-browser localStorage)
# --------------------------------------------------------------------------- #

_TMPL_KEY_DATA    = "concl_templates_json"
_TMPL_KEY_AUTODET = "concl_templates_autodetect"
_TMPL_KEY_DEFAULT = "concl_default_template"

_DEFAULT_TMPL_TEXT = (
    "%ЛОКАЦІЯ\nПротивник зі складу %ПІДРОЗДІЛ здійснює переміщення в р-ні точки:"
)


def _app_setting_get(conn, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row["value"])


def _app_setting_set(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


@router.get("/api/conclusion-templates")
def api_conclusion_templates_get():
    """Return shared conclusion templates, autodetect flag and default text."""
    with get_conn() as conn:
        raw = _app_setting_get(conn, _TMPL_KEY_DATA)
        autodet = _app_setting_get(conn, _TMPL_KEY_AUTODET)
        default_text = _app_setting_get(conn, _TMPL_KEY_DEFAULT)

    try:
        templates = json.loads(raw) if raw else None
    except (ValueError, TypeError):
        templates = None

    return {
        "ok": True,
        "templates": templates,                       # None → клієнт підставить дефолтні категорії
        "autodetect": autodet == "1",
        "default_text": _DEFAULT_TMPL_TEXT if default_text is None else default_text,
    }


@router.post("/api/conclusion-templates")
async def api_conclusion_templates_save(request: Request):
    """Persist shared conclusion templates (whole-blob save)."""
    payload = await request.json()
    templates = payload.get("templates")
    autodetect = payload.get("autodetect")
    default_text = payload.get("default_text")

    with get_conn() as conn:
        if templates is not None:
            _app_setting_set(conn, _TMPL_KEY_DATA, json.dumps(templates, ensure_ascii=False))
        if autodetect is not None:
            _app_setting_set(conn, _TMPL_KEY_AUTODET, "1" if autodetect else "0")
        if default_text is not None:
            _app_setting_set(conn, _TMPL_KEY_DEFAULT, str(default_text))
        conn.commit()

    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Shared monitor tags (keyword-based filters under Monitoring playlist)
# --------------------------------------------------------------------------- #

_MON_TAGS_KEY = "monitor_tags_json"


@router.get("/api/monitor-tags")
def api_monitor_tags_get():
    """Return shared monitor tags (or null → клієнт підставить DEFAULTS)."""
    with get_conn() as conn:
        raw = _app_setting_get(conn, _MON_TAGS_KEY)
    try:
        tags = json.loads(raw) if raw else None
    except (ValueError, TypeError):
        tags = None
    return {"ok": True, "tags": tags}


@router.post("/api/monitor-tags")
async def api_monitor_tags_save(request: Request):
    """Persist shared monitor tags (whole-list save)."""
    payload = await request.json()
    tags = payload.get("tags")
    if tags is None or not isinstance(tags, list):
        return JSONResponse({"ok": False, "error": "tags must be a list"}, status_code=400)
    with get_conn() as conn:
        _app_setting_set(conn, _MON_TAGS_KEY, json.dumps(tags, ensure_ascii=False))
        conn.commit()
    return {"ok": True}
