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
from app.services.callsign_service import link_message_callsigns


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
    """Search callsigns by callsign name (case-insensitive LIKE).

    Note: we intentionally do NOT search by comment here, because it causes
    confusing matches where the callsign name doesn't contain the query.
    """
    query = (q or "").strip()
    if not query:
        return {"ok": True, "rows": []}

    like = f"%{query}%"
    prefix_like = f"{query}%"
    # Canonical form for callsign matching: remove separators and normalize case.
    q_canon = (
        query.upper()
        .replace("-", "")
        .replace(" ", "")
        .replace("—", "")
        .replace("–", "")
    )
    q_canon_prefix = f"{q_canon}%"

    canon_sql = (
        "replace(replace(replace(replace(replace(upper(c.name), '-', ''), ' ', ''), '—', ''), '–', ''), '_', '')"
    )
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
                COALESCE(n.unit, 'Невідомо') AS unit,
                CASE
                  WHEN upper(c.name) = upper(?) THEN 0
                  WHEN """ + canon_sql + """ = ? THEN 1
                  WHEN """ + canon_sql + """ LIKE ? THEN 2
                  WHEN c.name LIKE ? COLLATE NOCASE THEN 3
                  WHEN c.name LIKE ? COLLATE NOCASE THEN 4
                  ELSE 9
                END AS rank_score
            FROM callsigns c
            LEFT JOIN callsign_statuses s ON s.id = c.callsign_status_id
            LEFT JOIN callsign_sources src ON src.id = c.source_id
            LEFT JOIN networks n ON n.id = c.network_id
            WHERE c.name LIKE ? COLLATE NOCASE
            ORDER BY
              rank_score ASC,
              CASE WHEN c.last_seen_dt IS NULL THEN 1 ELSE 0 END,
              c.last_seen_dt DESC,
              c.name COLLATE NOCASE
            LIMIT 200
            """,
            (query, q_canon, q_canon_prefix, prefix_like, like, like),
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


@router.get("/api/callsigns/{callsign_id}/graph")
def api_callsign_graph(
    callsign_id: int,
    days: int = 14,
    advanced: int = 0,
):
    """Return callsign interaction graph centered on a callsign.

    - advanced=0: 1-hop neighbors (who interacted with the callsign)
    - advanced=1: 2-hop expansion (also include interactions of neighbors)
    """
    cid = _as_int(callsign_id, 0)
    if not cid:
        return JSONResponse({"ok": False, "error": "invalid callsign_id"}, status_code=400)

    try:
        days_n = int(days)
        if days_n < 1:
            days_n = 1
        if days_n > 365:
            days_n = 365
    except Exception:
        days_n = 14

    adv = bool(int(advanced or 0))
    start_dt = (datetime.now() - timedelta(days=days_n)).isoformat(timespec="seconds")

    with get_conn() as conn:
        base = conn.execute(
            """
            SELECT
              id,
              network_id,
              name,
              COALESCE(callsign_status_id, status_id) AS status_id
            FROM callsigns
            WHERE id = ?
            LIMIT 1
            """,
            (cid,),
        ).fetchone()

        if not base:
            return {"ok": True, "nodes": [], "edges": [], "meta": {"days": days_n}}

        network_id = int(base["network_id"]) if base["network_id"] else 0
        if not network_id:
            return {"ok": True, "nodes": [], "edges": [], "meta": {"days": days_n}}

        # 1-hop edges for center
        e1 = conn.execute(
            """
            SELECT a_callsign_id AS a_id, b_callsign_id AS b_id, cnt
            FROM callsign_edges
            WHERE network_id = ?
              AND last_seen_dt >= ?
              AND (a_callsign_id = ? OR b_callsign_id = ?)
            """,
            (network_id, start_dt, cid, cid),
        ).fetchall()

        lvl1: set[int] = set()
        for r in e1:
            a = int(r["a_id"])
            b = int(r["b_id"])
            other = b if a == cid else a
            if other != cid:
                lvl1.add(other)

        nodes_set: set[int] = {cid, *lvl1}
        lvl2: set[int] = set()

        if adv and lvl1:
            placeholders = ",".join(["?"] * len(lvl1))
            e2 = conn.execute(
                f"""
                SELECT a_callsign_id AS a_id, b_callsign_id AS b_id
                FROM callsign_edges
                WHERE network_id = ?
                  AND last_seen_dt >= ?
                  AND (a_callsign_id IN ({placeholders}) OR b_callsign_id IN ({placeholders}))
                """,
                (network_id, start_dt, *sorted(lvl1), *sorted(lvl1)),
            ).fetchall()
            for r in e2:
                a = int(r["a_id"])
                b = int(r["b_id"])
                if a not in nodes_set:
                    lvl2.add(a)
                if b not in nodes_set:
                    lvl2.add(b)
            # cap to avoid huge graphs
            if len(lvl2) > 220:
                lvl2 = set(list(sorted(lvl2))[:220])
            nodes_set |= lvl2

        # Pull edges among the selected node set
        placeholders = ",".join(["?"] * len(nodes_set))
        edges_rows = conn.execute(
            f"""
            SELECT a_callsign_id AS a_id, b_callsign_id AS b_id, cnt
            FROM callsign_edges
            WHERE network_id = ?
              AND last_seen_dt >= ?
              AND a_callsign_id IN ({placeholders})
              AND b_callsign_id IN ({placeholders})
            ORDER BY cnt DESC
            LIMIT 600
            """,
            (network_id, start_dt, *sorted(nodes_set), *sorted(nodes_set)),
        ).fetchall()

        # Load node metadata and exclude technical "НВ"
        meta_rows = conn.execute(
            f"""
            SELECT
              id,
              name,
              COALESCE(callsign_status_id, status_id) AS status_id
            FROM callsigns
            WHERE id IN ({placeholders})
              AND name <> 'НВ'
            """,
            (*sorted(nodes_set),),
        ).fetchall()

    nodes = []
    ok_ids = set()
    for r in meta_rows:
        sid = r["status_id"]
        sid_num = int(sid) if sid is not None and str(sid).strip() != "" else None
        icon = f"/static/icons/callsign_statuses/{sid_num}.svg" if sid_num else "/static/icons/callsign_statuses/_default.svg"
        nid = int(r["id"])
        ok_ids.add(nid)
        level = 0 if nid == cid else (1 if nid in lvl1 else 2)
        nodes.append({"id": nid, "name": r["name"] or "", "status_id": sid_num, "icon": icon, "level": level})

    edges = []
    for r in edges_rows:
        a = int(r["a_id"])
        b = int(r["b_id"])
        if a not in ok_ids or b not in ok_ids:
            continue
        edges.append({"source": a, "target": b, "cnt": int(r["cnt"] or 0)})

    return {
        "ok": True,
        "center_id": cid,
        "nodes": nodes,
        "edges": edges,
        "meta": {"days": days_n, "advanced": 1 if adv else 0, "start_dt": start_dt},
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


@router.post("/api/callsigns/delete")
async def api_callsign_delete(request: Request):
    """Replace a callsign with technical "НВ" across messages and then delete it.

    We avoid FK/cleanup complexity by:
    1) ensuring callsign "НВ" exists for the same network;
    2) updating `message_callsigns` to point to "НВ";
    3) rebuilding `callsign_edges` for the affected network from scratch;
    4) deleting the callsign row and its status mapping.
    """
    payload: Dict[str, Any] = await request.json()
    callsign_id = _as_int(payload.get("callsign_id"), 0)
    if not callsign_id:
        return JSONResponse({"ok": False, "error": "callsign_id is required"}, status_code=400)

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name FROM callsigns WHERE id = ? LIMIT 1",
            (callsign_id,),
        ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "callsign not found"}, status_code=404)

        callsign_name = row["name"] or ""
        network_row = conn.execute(
            "SELECT network_id FROM callsigns WHERE id = ? LIMIT 1",
            (callsign_id,),
        ).fetchone()
        if not network_row or not network_row["network_id"]:
            return JSONResponse(
                {"ok": False, "error": "callsign has no network_id"},
                status_code=400,
            )
        network_id = int(network_row["network_id"])

        tech_name = "НВ"

        # Ensure "НВ" exists in this network.
        nv_row = conn.execute(
            """
            SELECT id FROM callsigns
            WHERE network_id = ?
              AND name = ?
            LIMIT 1
            """,
            (network_id, tech_name),
        ).fetchone()

        now_dt = _now_sql()
        if nv_row:
            nv_id = int(nv_row["id"])
        else:
            cur = conn.execute(
                """
                INSERT INTO callsigns (
                    network_id,
                    name,
                    comment,
                    callsign_status_id,
                    source_id,
                    updated_at,
                    last_seen_dt
                ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
                """,
                (network_id, tech_name, now_dt, None),
            )
            nv_id = int(cur.lastrowid)

        try:
            # Avoid no-op.
            if callsign_id == nv_id:
                return JSONResponse({"ok": True, "callsign_id": callsign_id, "deleted": False, "name": callsign_name})

            affected_messages = conn.execute(
                "SELECT DISTINCT message_id FROM message_callsigns WHERE callsign_id = ?",
                (callsign_id,),
            ).fetchall()
            affected_ids = [int(r["message_id"]) for r in affected_messages if r and r["message_id"] is not None]

            # Replace callsign_id -> nv_id in all message roles.
            # Guard against PK collisions: (message_id, callsign_id, role) is a PK.
            # If a message already has "НВ" for the same role, delete the old row first.
            duplicates = conn.execute(
                """
                SELECT mc_del.message_id, mc_del.role
                FROM message_callsigns mc_del
                JOIN message_callsigns mc_nv
                  ON mc_nv.message_id = mc_del.message_id
                 AND mc_nv.role = mc_del.role
                WHERE mc_del.callsign_id = ?
                  AND mc_nv.callsign_id = ?
                """,
                (callsign_id, nv_id),
            ).fetchall()
            for d in duplicates:
                conn.execute(
                    """
                    DELETE FROM message_callsigns
                    WHERE message_id = ?
                      AND callsign_id = ?
                      AND role = ?
                    """,
                    (int(d["message_id"]), callsign_id, d["role"]),
                )

            conn.execute(
                "UPDATE message_callsigns SET callsign_id = ? WHERE callsign_id = ?",
                (nv_id, callsign_id),
            )

            # Rebuild graph edges for this network from scratch.
            conn.execute("DELETE FROM callsign_edges WHERE network_id = ?", (network_id,))

            if affected_ids:
                cur = conn.cursor()
                # We can rebuild only for affected messages, but safe approach is to replay all messages in network.
                # Since networks are typically manageable, we replay all for correctness.
                message_rows = conn.execute(
                    """
                    SELECT id, created_at, received_at
                    FROM messages
                    WHERE network_id = ?
                    """,
                    (network_id,),
                ).fetchall()

                for mr in message_rows:
                    mid = int(mr["id"])
                    created_at = mr["created_at"]
                    received_at = mr["received_at"]

                    caller_row = conn.execute(
                        """
                        SELECT c.name
                        FROM message_callsigns mc
                        JOIN callsigns c ON c.id = mc.callsign_id
                        WHERE mc.message_id = ?
                          AND mc.role = 'caller'
                        LIMIT 1
                        """,
                        (mid,),
                    ).fetchone()
                    caller_name = caller_row["name"] if caller_row else None

                    callee_rows = conn.execute(
                        """
                        SELECT c.name
                        FROM message_callsigns mc
                        JOIN callsigns c ON c.id = mc.callsign_id
                        WHERE mc.message_id = ?
                          AND mc.role = 'callee'
                        """,
                        (mid,),
                    ).fetchall()
                    callee_names = [r["name"] for r in callee_rows if r and r["name"]]

                    link_message_callsigns(
                        cur=cur,
                        network_id=network_id,
                        message_id=mid,
                        caller=caller_name,
                        callees=callee_names,
                        created_at=created_at,
                        received_at=received_at,
                    )

            # Finally remove old callsign row (no longer referenced by message_callsigns).
            conn.execute("DELETE FROM callsign_status_map WHERE callsign_id = ?", (callsign_id,))
            conn.execute("DELETE FROM callsigns WHERE id = ?", (callsign_id,))
            conn.commit()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    return {
        "ok": True,
        "callsign_id": callsign_id,
        "name": callsign_name,
        "deleted": True,
        "replaced_with": tech_name,
    }