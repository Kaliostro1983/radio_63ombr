from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.db import get_conn
from app.core.normalize import normalize_freq


router = APIRouter(tags=["callsigns"])


def _now_sql() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _as_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


@router.get("/callsigns", response_class=HTMLResponse)
def callsigns_page(request: Request):
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "callsigns.html",
        {
            "request": request,
            "app_name": request.app.state.app_name,
        },
    )


@router.get("/api/callsigns/statuses")
def api_statuses():
    with get_conn() as conn:
        rows = conn.execute("SELECT id, name FROM callsign_statuses ORDER BY name").fetchall()
    return [{"id": int(r["id"]), "name": r["name"]} for r in rows]


@router.post("/api/callsigns/statuses")
async def api_status_create(request: Request):
    payload: Dict[str, Any] = await request.json()
    name = (payload.get("name") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)

    with get_conn() as conn:
        # Case-insensitive uniqueness (friendlier than relying on UNIQUE constraint error text)
        exists = conn.execute(
            "SELECT 1 FROM callsign_statuses WHERE lower(name)=lower(?) LIMIT 1", (name,)
        ).fetchone()
        if exists:
            return JSONResponse({"ok": False, "error": "Статус вже існує"}, status_code=400)

        try:
            conn.execute("INSERT INTO callsign_statuses(name) VALUES (?)", (name,))
            new_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    return {"ok": True, "id": new_id, "name": name}


def _find_network_id(conn, frequency_or_mask: str) -> Optional[int]:
    q_raw = (frequency_or_mask or "").strip()
    # Input may be a frequency or a mask. We normalize to the canonical 3+4 format
    # (e.g. 146.025 -> 146.0250) to match how values are stored in DB.
    q = normalize_freq(q_raw) or q_raw
    if not q:
        return None
    # Try strict text match first (fast for TEXT columns), then numeric match
    # to survive legacy DBs where frequency/mask might have different textual formatting.
    row = conn.execute(
        """
        SELECT id
        FROM networks
        WHERE frequency = ?
           OR mask = ?
           OR CAST(frequency AS REAL) = CAST(? AS REAL)
           OR CAST(mask AS REAL) = CAST(? AS REAL)
        LIMIT 1
        """,
        (q, q, q, q),
    ).fetchone()
    if row:
        return int(row["id"])
    return None


@router.get("/api/callsigns/by-frequency")
def api_callsigns_by_frequency(frequency: str, days: int = 7):
    days = max(1, min(_as_int(days, 7), 365))
    start_dt = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")

    with get_conn() as conn:
        network_id = _find_network_id(conn, frequency)
        if not network_id:
            return {"ok": True, "rows": [], "network_id": None}

        # Pull callsigns that were seen in the requested window.
        # We use last_seen_dt (maintained by ingest) for speed.
        rows = conn.execute(
            """
            SELECT id, name, comment, callsign_status_id
            FROM callsigns
            WHERE network_id = ?
              AND (last_seen_dt IS NOT NULL AND last_seen_dt >= ?)
            ORDER BY name COLLATE NOCASE
            """,
            (network_id, start_dt),
        ).fetchall()

        # Single status per callsign (lookup)
        status_lookup: Dict[int, str] = {}
        status_ids = sorted({int(r["callsign_status_id"]) for r in rows if r["callsign_status_id"]})
        if status_ids:
            q_marks = ",".join(["?"] * len(status_ids))
            srows = conn.execute(
                f"SELECT id, name FROM callsign_statuses WHERE id IN ({q_marks})",
                tuple(status_ids),
            ).fetchall()
            status_lookup = {int(sr["id"]): sr["name"] for sr in srows}

    out_rows: List[Dict[str, Any]] = []
    for idx, r in enumerate(rows, start=1):
        cid = int(r["id"])
        sid = int(r["callsign_status_id"]) if r["callsign_status_id"] else None
        sname = status_lookup.get(sid) if sid else None
        out_rows.append(
            {
                "n": idx,
                "callsign_id": cid,
                "network_id": int(r["network_id"]) if r["network_id"] else None,
                "name": r["name"],
                "comment": r["comment"] or "",
                "status_id": sid,
                "status_label": sname or "",
            }
        )

    return {"ok": True, "network_id": int(network_id), "rows": out_rows}


@router.get("/api/callsigns/search")
def api_callsigns_search(q: str):
    query = (q or "").strip()
    if not query:
        return {"ok": True, "rows": []}

    like = f"%{query}%"
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.network_id, c.name, c.comment, c.callsign_status_id,
                   COALESCE(n.frequency, 'Невідомо') AS frequency,
                   COALESCE(n.unit, 'Невідомо') AS unit
            FROM callsigns c
            LEFT JOIN networks n ON n.id = c.network_id
            WHERE c.name LIKE ? COLLATE NOCASE
               OR (c.comment IS NOT NULL AND c.comment LIKE ? COLLATE NOCASE)
            ORDER BY
              CASE WHEN c.last_seen_dt IS NULL THEN 1 ELSE 0 END,
              c.last_seen_dt DESC,
              c.name COLLATE NOCASE
            LIMIT 200
            """,
            (like, like),
        ).fetchall()

        status_lookup: Dict[int, str] = {}
        status_ids = sorted({int(r["callsign_status_id"]) for r in rows if r["callsign_status_id"]})
        if status_ids:
            q_marks = ",".join(["?"] * len(status_ids))
            srows = conn.execute(
                f"SELECT id, name FROM callsign_statuses WHERE id IN ({q_marks})",
                tuple(status_ids),
            ).fetchall()
            status_lookup = {int(sr["id"]): sr["name"] for sr in srows}

    out_rows: List[Dict[str, Any]] = []
    for idx, r in enumerate(rows, start=1):
        cid = int(r["id"])
        sid = int(r["callsign_status_id"]) if r["callsign_status_id"] else None
        sname = status_lookup.get(sid) if sid else None
        out_rows.append(
            {
                "n": idx,
                "callsign_id": cid,
                "network_id": int(r["network_id"]) if r["network_id"] else None,
                "name": r["name"],
                "comment": r["comment"] or "",
                "status_id": sid,
                "status_label": sname or "",
                "frequency": r["frequency"] or "Невідомо",
                "unit": r["unit"] or "Невідомо",
            }
        )

    return {"ok": True, "rows": out_rows}



@router.post("/api/callsigns/save")
async def api_callsign_save(request: Request):
    payload: Dict[str, Any] = await request.json()

    callsign_id = payload.get("callsign_id")
    callsign_id = _as_int(callsign_id, 0) if callsign_id is not None else 0
    name = (payload.get("name") or "").strip().upper()
    comment = (payload.get("comment") or "").strip() or None

    network_id = payload.get("network_id")
    network_id = _as_int(network_id, 0) if network_id is not None else 0

    status_id = payload.get("status_id")
    status_id = _as_int(status_id, 0) if status_id is not None else 0

    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)

    now_dt = _now_sql()

    with get_conn() as conn:
        if not callsign_id:
            dup = conn.execute(
                "SELECT id FROM callsigns WHERE name=? COLLATE NOCASE LIMIT 1",
                (name,),
            ).fetchone()
            if dup:
                return JSONResponse({"ok": False, "error": "Такий позивний вже існує"}, status_code=400)

            conn.execute(
                "INSERT INTO callsigns (network_id, name, comment, callsign_status_id, updated_at, last_seen_dt) VALUES (?,?,?,?,?,?)",
                (network_id or None, name, comment, status_id or None, now_dt, None),
            )
            callsign_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            nid = network_id or None
            conn.commit()
        else:
            row = conn.execute(
                "SELECT id, network_id FROM callsigns WHERE id=? LIMIT 1", (callsign_id,)
            ).fetchone()
            if not row:
                return JSONResponse({"ok": False, "error": "callsign not found"}, status_code=404)

            nid = network_id if network_id else row["network_id"]

            try:
                conn.execute(
                    "UPDATE callsigns SET network_id=?, name=?, comment=?, callsign_status_id=?, updated_at=? WHERE id=?",
                    (nid, name, comment, status_id or None, now_dt, callsign_id),
                )
                conn.commit()
            except Exception as e:
                return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

        sname = ""
        if status_id:
            sr = conn.execute(
                "SELECT name FROM callsign_statuses WHERE id=? LIMIT 1", (status_id,)
            ).fetchone()
            if sr:
                sname = sr["name"]

        freq = "Невідомо"
        unit = "Невідомо"
        if nid:
            nr = conn.execute(
                "SELECT frequency, unit FROM networks WHERE id=? LIMIT 1", (int(nid),)
            ).fetchone()
            if nr:
                freq = nr["frequency"] or "Невідомо"
                unit = nr["unit"] or "Невідомо"

    return {
        "ok": True,
        "callsign_id": int(callsign_id),
        "network_id": int(nid) if nid else None,
        "name": name,
        "comment": comment or "",
        "status_id": int(status_id) if status_id else None,
        "status_label": sname,
        "frequency": freq,
        "unit": unit,
    }
