"""UI and API router for callsign management.

This router serves the callsigns UI page and provides JSON APIs used by the
frontend to:

- list and create callsign statuses and sources;
- fetch callsigns by frequency/mask (recently seen within N days);
- search callsigns by name/comment;
- fetch a single callsign by id;
- create/update callsigns and their metadata.

The router performs direct SQLite queries and keeps logic close to the UI
needs. System-level invariants for graph edges are enforced in the service
layer during ingest; this router focuses on CRUD and lookup views.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.db import get_conn
from app.core.normalize import normalize_freq


router = APIRouter(tags=["callsigns"])


def _now_sql() -> str:
    """Return current local datetime as ISO string with seconds precision."""
    return datetime.now().isoformat(timespec="seconds")


def _as_int(v: Any, default: int = 0) -> int:
    """Best-effort convert a value to int with a default fallback."""
    try:
        return int(v)
    except Exception:
        return default


@router.get("/callsigns", response_class=HTMLResponse)
def callsigns_page(request: Request):
    """Render the callsigns UI page."""
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
    """Return list of callsign statuses for UI dropdowns."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name FROM callsign_statuses ORDER BY name"
        ).fetchall()

    return [{"id": int(r["id"]), "name": r["name"]} for r in rows]


@router.post("/api/callsigns/statuses")
async def api_status_create(request: Request):
    """Create a new callsign status (if not already present).

    Expects JSON: `{ "name": "..." }`.
    """
    payload: Dict[str, Any] = await request.json()
    name = (payload.get("name") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)

    with get_conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM callsign_statuses WHERE lower(name)=lower(?) LIMIT 1",
            (name,),
        ).fetchone()
        if exists:
            return JSONResponse({"ok": False, "error": "Статус вже існує"}, status_code=400)

        try:
            conn.execute("INSERT INTO callsign_statuses(name) VALUES (?)", (name,))
            new_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            conn.commit()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    return {"ok": True, "id": new_id, "name": name}


@router.get("/api/callsigns/sources")
def api_sources():
    """Return list of callsign sources for UI dropdowns."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name FROM callsign_sources ORDER BY name"
        ).fetchall()

    return [{"id": int(r["id"]), "name": r["name"]} for r in rows]


def _find_network_id(conn, frequency_or_mask: str) -> Optional[int]:
    """Resolve network id by frequency or mask (helper for callsigns views)."""
    q_raw = (frequency_or_mask or "").strip()
    q = normalize_freq(q_raw) or q_raw
    if not q:
        return None

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
    """List callsigns for a network resolved by frequency/mask.

    Args:
        frequency: string containing frequency, mask, or `freq/mask` pair.
        days: how many days back to consider `last_seen_dt`.

    Returns:
        dict: payload including `rows` and network metadata; `rows` include
        callsign fields plus status/source labels.
    """
    q_raw = (frequency or "").strip()
    days = max(1, min(_as_int(days, 7), 365))
    start_dt = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")

    freq_part = q_raw
    mask_part: Optional[str] = None
    # Support `freq/mask` input in a single field.
    if "/" in q_raw:
        parts = [p.strip() for p in q_raw.split("/", 1)]
        freq_part = parts[0] or ""
        mask_part = parts[1] or None

    freq_norm = (normalize_freq(freq_part) or freq_part).strip()
    mask_norm = (normalize_freq(mask_part) or mask_part).strip() if mask_part else None

    if not freq_norm and not mask_norm:
        return {"ok": True, "rows": [], "network_id": None, "message": "Вкажіть частоту."}

    with get_conn() as conn:
        if mask_norm:
            nrow = conn.execute(
                """
                SELECT id, frequency, mask, unit
                FROM networks
                WHERE (frequency = ? OR CAST(frequency AS REAL) = CAST(? AS REAL))
                  AND (mask = ? OR CAST(mask AS REAL) = CAST(? AS REAL))
                LIMIT 1
                """,
                (freq_norm, freq_norm, mask_norm, mask_norm),
            ).fetchone()
        else:
            nrow = conn.execute(
                """
                SELECT id, frequency, mask, unit
                FROM networks
                WHERE frequency = ?
                   OR mask = ?
                   OR CAST(frequency AS REAL) = CAST(? AS REAL)
                   OR CAST(mask AS REAL) = CAST(? AS REAL)
                LIMIT 1
                """,
                (freq_norm, freq_norm, freq_norm, freq_norm),
            ).fetchone()

        if not nrow:
            return {
                "ok": True,
                "rows": [],
                "network_id": None,
                "message": "Радіомережу з такою частотою/маскою не знайдено.",
            }

        network_id = int(nrow["id"])

        total_all = conn.execute(
            "SELECT COUNT(1) AS cnt FROM callsigns WHERE network_id = ?",
            (network_id,),
        ).fetchone()
        total_all_cnt = int(total_all["cnt"]) if total_all else 0

        rows = conn.execute(
            """
            SELECT
                c.id,
                c.network_id,
                c.name,
                c.comment,
                c.callsign_status_id,
                c.source_id,
                c.last_seen_dt,
                s.name AS status_label,
                src.name AS source_label
            FROM callsigns c
            LEFT JOIN callsign_statuses s ON s.id = c.callsign_status_id
            LEFT JOIN callsign_sources src ON src.id = c.source_id
            WHERE c.network_id = ?
              AND c.last_seen_dt IS NOT NULL
              AND c.last_seen_dt >= ?
            ORDER BY c.name COLLATE NOCASE
            """,
            (network_id, start_dt),
        ).fetchall()

    out_rows: List[Dict[str, Any]] = []
    for idx, r in enumerate(rows, start=1):
        out_rows.append(
            {
                "n": idx,
                "callsign_id": int(r["id"]),
                "network_id": int(r["network_id"]) if r["network_id"] else None,
                "name": r["name"] or "",
                "comment": r["comment"] or "",
                "status_id": int(r["callsign_status_id"]) if r["callsign_status_id"] else None,
                "status_label": r["status_label"] or "",
                "source_id": int(r["source_id"]) if r["source_id"] else None,
                "source_label": r["source_label"] or "",
                "last_seen_dt": r["last_seen_dt"],
            }
        )

    message = ""
    if not out_rows:
        if total_all_cnt > 0:
            message = (
                f"За останні {days} днів у цій р/м позивних не зафіксовано. "
                f"Загалом за весь час: {total_all_cnt}."
            )
        else:
            message = "У цій р/м поки що немає позивних у базі."

    return {
        "ok": True,
        "network_id": network_id,
        "network": {
            "id": network_id,
            "frequency": nrow["frequency"],
            "mask": nrow["mask"],
            "unit": nrow["unit"],
        },
        "days": days,
        "total_all": total_all_cnt,
        "rows": out_rows,
        "message": message,
    }


@router.get("/api/callsigns/search")
def api_callsigns_search(q: str):
    """Search callsigns by name or comment (case-insensitive LIKE)."""
    query = (q or "").strip()
    if not query:
        return {"ok": True, "rows": []}

    like = f"%{query}%"
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                c.id,
                c.network_id,
                c.name,
                c.comment,
                c.callsign_status_id,
                c.source_id,
                s.name AS status_label,
                src.name AS source_label,
                COALESCE(n.frequency, 'Невідомо') AS frequency,
                COALESCE(n.unit, 'Невідомо') AS unit
            FROM callsigns c
            LEFT JOIN callsign_statuses s ON s.id = c.callsign_status_id
            LEFT JOIN callsign_sources src ON src.id = c.source_id
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

    out_rows: List[Dict[str, Any]] = []
    for idx, r in enumerate(rows, start=1):
        out_rows.append(
            {
                "n": idx,
                "callsign_id": int(r["id"]),
                "network_id": int(r["network_id"]) if r["network_id"] else None,
                "name": r["name"] or "",
                "comment": r["comment"] or "",
                "status_id": int(r["callsign_status_id"]) if r["callsign_status_id"] else None,
                "status_label": r["status_label"] or "",
                "source_id": int(r["source_id"]) if r["source_id"] else None,
                "source_label": r["source_label"] or "",
                "frequency": r["frequency"] or "Невідомо",
                "unit": r["unit"] or "Невідомо",
            }
        )

    return {"ok": True, "rows": out_rows}


@router.get("/api/callsigns/by-id")
def api_callsign_by_id(id: int):
    """Fetch a callsign row by id with related network/status/source info."""
    cid = _as_int(id, 0)
    if not cid:
        return JSONResponse({"ok": False, "error": "id is required"}, status_code=400)

    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT
                c.id AS callsign_id,
                c.name AS name,
                c.comment AS comment,
                c.network_id AS network_id,
                c.callsign_status_id AS status_id,
                c.source_id AS source_id,
                s.name AS status_label,
                src.name AS source_label,
                n.frequency AS frequency,
                n.unit AS unit
            FROM callsigns c
            LEFT JOIN callsign_statuses s ON s.id = c.callsign_status_id
            LEFT JOIN callsign_sources src ON src.id = c.source_id
            LEFT JOIN networks n ON n.id = c.network_id
            WHERE c.id = ?
            LIMIT 1
            """,
            (cid,),
        ).fetchone()

    if not row:
        return JSONResponse({"ok": True, "row": None})

    return {
        "ok": True,
        "row": {
            "callsign_id": int(row["callsign_id"]),
            "name": row["name"] or "",
            "comment": row["comment"] or "",
            "network_id": int(row["network_id"]) if row["network_id"] else None,
            "status_id": int(row["status_id"]) if row["status_id"] else None,
            "status_label": row["status_label"] or "",
            "source_id": int(row["source_id"]) if row["source_id"] else None,
            "source_label": row["source_label"] or "",
            "frequency": row["frequency"] or "Невідомо",
            "unit": row["unit"] or "Невідомо",
        },
    }


@router.post("/api/callsigns/save")
async def api_callsign_save(request: Request):
    """Create or update a callsign based on JSON payload.

    Payload supports either:
    - creating a new callsign (callsign_id omitted/0), or
    - updating an existing callsign (callsign_id provided).
    """
    payload: Dict[str, Any] = await request.json()

    callsign_id = payload.get("callsign_id")
    callsign_id = _as_int(callsign_id, 0) if callsign_id is not None else 0

    name = (payload.get("name") or "").strip().upper()
    comment = (payload.get("comment") or "").strip() or None

    network_id = payload.get("network_id")
    network_id = _as_int(network_id, 0) if network_id is not None else 0

    status_id = payload.get("status_id")
    status_id = _as_int(status_id, 0) if status_id is not None else 0

    source_id = payload.get("source_id")
    source_id = _as_int(source_id, 0) if source_id is not None else 0

    if not name:
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)

    now_dt = _now_sql()

    with get_conn() as conn:
        if status_id:
            sr = conn.execute(
                "SELECT 1 FROM callsign_statuses WHERE id=? LIMIT 1",
                (status_id,),
            ).fetchone()
            if not sr:
                return JSONResponse({"ok": False, "error": "Некоректний статус"}, status_code=400)

        if source_id:
            src = conn.execute(
                "SELECT 1 FROM callsign_sources WHERE id=? LIMIT 1",
                (source_id,),
            ).fetchone()
            if not src:
                return JSONResponse({"ok": False, "error": "Некоректне джерело"}, status_code=400)

        if not callsign_id:
            dup = conn.execute(
                "SELECT id FROM callsigns WHERE name=? COLLATE NOCASE LIMIT 1",
                (name,),
            ).fetchone()
            if dup:
                return JSONResponse({"ok": False, "error": "Такий позивний вже існує"}, status_code=400)

            try:
                conn.execute(
                    """
                    INSERT INTO callsigns (
                        network_id,
                        name,
                        comment,
                        callsign_status_id,
                        source_id,
                        updated_at,
                        last_seen_dt
                    ) VALUES (?,?,?,?,?,?,?)
                    """,
                    (
                        network_id or None,
                        name,
                        comment,
                        status_id or None,
                        source_id or None,
                        now_dt,
                        None,
                    ),
                )
                callsign_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
                nid = network_id or None
                conn.commit()
            except Exception as e:
                return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        else:
            row = conn.execute(
                "SELECT id, network_id FROM callsigns WHERE id=? LIMIT 1",
                (callsign_id,),
            ).fetchone()
            if not row:
                return JSONResponse({"ok": False, "error": "callsign not found"}, status_code=404)

            nid = network_id if network_id else row["network_id"]

            try:
                conn.execute(
                    """
                    UPDATE callsigns
                    SET network_id=?,
                        name=?,
                        comment=?,
                        callsign_status_id=?,
                        source_id=?,
                        updated_at=?
                    WHERE id=?
                    """,
                    (
                        nid,
                        name,
                        comment,
                        status_id or None,
                        source_id or None,
                        now_dt,
                        callsign_id,
                    ),
                )
                conn.commit()
            except Exception as e:
                return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

        sname = ""
        if status_id:
            sr = conn.execute(
                "SELECT name FROM callsign_statuses WHERE id=? LIMIT 1",
                (status_id,),
            ).fetchone()
            if sr:
                sname = sr["name"]

        source_name = ""
        if source_id:
            src = conn.execute(
                "SELECT name FROM callsign_sources WHERE id=? LIMIT 1",
                (source_id,),
            ).fetchone()
            if src:
                source_name = src["name"]

        freq = "Невідомо"
        unit = "Невідомо"
        if nid:
            nr = conn.execute(
                "SELECT frequency, unit FROM networks WHERE id=? LIMIT 1",
                (int(nid),),
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
        "source_id": int(source_id) if source_id else None,
        "source_label": source_name,
        "frequency": freq,
        "unit": unit,
    }