from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.config import settings
from app.core.db import get_conn

router = APIRouter()


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _normalize_keyword(value: str) -> str:
    parts = [p for p in (value or "").strip().split() if p]
    return " ".join(parts).lower()


def _location_kind_from_wkt(wkt: str) -> str:
    """Infer geometry kind from WKT prefix (used for UI + storage)."""
    s = (wkt or "").strip().upper()
    if s.startswith("POINT"):
        return "point"
    if s.startswith("POLYGON"):
        return "polygon"
    if s.startswith("MULTIPOINT"):
        return "multipoint"
    if s.startswith("MULTIPOLYGON"):
        return "multipolygon"
    if s.startswith("LINESTRING"):
        return "linestring"
    if s.startswith("MULTILINESTRING"):
        return "multilinestring"
    return "other"


def _parse_int_opt(v: Any) -> int | None:
    if v is None:
        return None
    vv = str(v).strip()
    if not vv or vv == "0":
        return None
    try:
        return int(vv)
    except Exception:
        return None


def _unknown_landmark_type_id(conn) -> int:
    """Return id_type that represents an 'unspecified' landmark type.

    In current DB data this is typically the first type row with name 'сп'.
    """
    row = conn.execute(
        """
        SELECT id
        FROM landmark_types
        WHERE lower(name) = lower(?)
        ORDER BY id
        LIMIT 1
        """,
        ("сп",),
    ).fetchone()
    if row:
        return int(row["id"])

    # Fallback: minimal landmark_type id (so the app can still work).
    row2 = conn.execute("SELECT id FROM landmark_types ORDER BY id LIMIT 1").fetchone()
    if not row2:
        raise HTTPException(status_code=500, detail="Немає жодних landmark_types у БД")
    return int(row2["id"])


@router.get("/landmarks", response_class=HTMLResponse)
def landmarks_page(request: Request):
    """Render landmarks management page."""
    return request.app.state.templates.TemplateResponse(
        "landmarks.html",
        {
            "request": request,
        },
    )


@router.get("/api/landmarks/reference")
def api_landmarks_reference():
    """Fetch reference lists (groups, landmark types)."""
    with get_conn() as conn:
        groups = conn.execute("SELECT id, name FROM groups ORDER BY name").fetchall()
        types = conn.execute("SELECT id, name FROM landmark_types ORDER BY name").fetchall()
        unknown_type_id = _unknown_landmark_type_id(conn)

    return JSONResponse(
        {
            "ok": True,
            "unknown_type_id": int(unknown_type_id),
            "groups": [
                {"id": int(r["id"]), "name": str(r["name"])} for r in groups if r and r["id"] is not None
            ],
            "types": [
                {"id": int(r["id"]), "name": str(r["name"])} for r in types if r and r["id"] is not None
            ],
        }
    )


@router.get("/api/landmarks/autocomplete")
def api_landmarks_autocomplete(
    q: str = Query(default="", min_length=0, max_length=200),
):
    """Autocomplete for landmarks by name substring."""
    query = (q or "").strip()
    if len(query) < 2:
        return {"ok": True, "rows": []}

    key = _normalize_keyword(query)
    if not key:
        return {"ok": True, "rows": []}

    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, name
            FROM landmarks
            WHERE is_active = 1
              AND key_word LIKE '%' || ? || '%'
            ORDER BY name
            LIMIT 25
            """,
            (key,),
        ).fetchall()

    return {
        "ok": True,
        "rows": [{"id": int(r["id"]), "name": str(r["name"])} for r in rows],
    }


@router.get("/api/landmarks/search")
def api_landmarks_search(
    name: str = Query(default="", max_length=200),
    group_id: str | None = Query(default=None),
    type_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Search landmarks with lazy pagination.

    If all filters are empty, returns all active landmarks.
    """
    name_q = (name or "").strip()
    group_id_opt = _parse_int_opt(group_id)
    type_id_opt = _parse_int_opt(type_id)

    where = ["l.is_active = 1"]
    params: list[Any] = []

    if name_q:
        key = _normalize_keyword(name_q)
        if key:
            where.append("l.key_word LIKE '%' || ? || '%'")
            params.append(key)
    if group_id_opt is not None:
        where.append("l.id_group = ?")
        params.append(group_id_opt)
    if type_id_opt is not None:
        where.append("l.id_type = ?")
        params.append(type_id_opt)

    where_sql = " AND ".join(where) if where else "1=1"

    with get_conn() as conn:
        unknown_type_id = _unknown_landmark_type_id(conn)

        total = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM landmarks l
            WHERE {where_sql}
            """,
            params,
        ).fetchone()[0]

        rows = conn.execute(
            f"""
            SELECT
                l.id,
                l.name,
                l.id_type,
                lt.name AS type_name,
                l.id_group,
                g.name AS group_name
            FROM landmarks l
            JOIN landmark_types lt ON lt.id = l.id_type
            LEFT JOIN groups g ON g.id = l.id_group
            WHERE {where_sql}
            ORDER BY lt.name, l.name
            LIMIT ? OFFSET ?
            """,
            [*params, int(limit), int(offset)],
        ).fetchall()

    items = []
    for r in rows:
        type_name = str(r["type_name"] or "")
        if int(r["id_type"]) == unknown_type_id:
            type_name = "—"

        items.append(
            {
                "id": int(r["id"]),
                "type_name": type_name,
                "name": str(r["name"] or ""),
                "group_name": str(r["group_name"] or "") if r["id_group"] is not None else None,
                "group_id": int(r["id_group"]) if r["id_group"] is not None else None,
                "type_id": int(r["id_type"]),
            }
        )

    return {
        "ok": True,
        "items": items,
        "meta": {
            "total": int(total or 0),
            "offset": int(offset),
            "limit": int(limit),
            "has_more": int(offset) + int(limit) < int(total or 0),
        },
    }


@router.get("/api/landmarks/{landmark_id}")
def api_landmark_get(landmark_id: int):
    with get_conn() as conn:
        unknown_type_id = _unknown_landmark_type_id(conn)

        row = conn.execute(
            """
            SELECT
                l.id,
                l.name,
                l.id_group,
                l.id_type,
                l.location_wkt,
                l.location_kind,
                l.comment,
                l.is_active,
                lt.name AS type_name,
                g.name AS group_name
            FROM landmarks l
            JOIN landmark_types lt ON lt.id = l.id_type
            LEFT JOIN groups g ON g.id = l.id_group
            WHERE l.id = ? AND l.is_active = 1
            LIMIT 1
            """,
            (landmark_id,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Орієнтир не знайдено")

    type_name = str(row["type_name"] or "")
    if int(row["id_type"]) == unknown_type_id:
        type_name = "—"

    return {
        "ok": True,
        "landmark": {
            "id": int(row["id"]),
            "name": str(row["name"] or ""),
            "id_group": int(row["id_group"]) if row["id_group"] is not None else None,
            "group_name": str(row["group_name"]) if row["group_name"] is not None else None,
            "id_type": int(row["id_type"]),
            "type_name": type_name,
            "location_wkt": str(row["location_wkt"] or ""),
            "location_kind": str(row["location_kind"] or ""),
            "comment": str(row["comment"] or ""),
            "is_active": int(row["is_active"]) if row["is_active"] is not None else 1,
        },
    }


@router.post("/api/landmarks/{landmark_id}")
async def api_landmark_update(request: Request, landmark_id: int):
    """Update editable landmark fields (name/type/group/location/comment/active)."""
    payload = await request.json()

    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Назва не може бути порожньою")

    raw_is_active = payload.get("is_active", 1)
    try:
        is_active = 1 if int(raw_is_active) != 0 else 0
    except Exception:
        is_active = 1

    location_wkt = str(payload.get("location_wkt") or "").strip()
    if not location_wkt:
        raise HTTPException(status_code=400, detail="Координати (WKT) обов'язкові")

    id_type = _parse_int_opt(payload.get("id_type"))
    id_group = _parse_int_opt(payload.get("id_group"))
    comment = str(payload.get("comment") or "").strip()

    key_word = _normalize_keyword(name)
    if not key_word:
        raise HTTPException(status_code=400, detail="Некоректна назва")

    location_kind = _location_kind_from_wkt(location_wkt)
    now_iso = _now_iso()

    with get_conn() as conn:
        unknown_type_id = _unknown_landmark_type_id(conn)
        if id_type is None:
            id_type = unknown_type_id

        # Validate type exists.
        type_row = conn.execute("SELECT id FROM landmark_types WHERE id = ? LIMIT 1", (id_type,)).fetchone()
        if not type_row:
            raise HTTPException(status_code=400, detail="Невірний тип орієнтира")

        # Validate group if provided.
        if id_group is not None:
            g_row = conn.execute("SELECT id FROM groups WHERE id = ? LIMIT 1", (id_group,)).fetchone()
            if not g_row:
                raise HTTPException(status_code=400, detail="Невірний підрозділ")

        old_messages = conn.execute(
            """
            SELECT DISTINCT id_message
            FROM message_landmark_matches
            WHERE id_landmark = ?
            """,
            (landmark_id,),
        ).fetchall()
        message_ids = [int(r["id_message"]) for r in old_messages if r and r["id_message"] is not None]

        cur = conn.execute(
            """
            UPDATE landmarks
            SET name = ?,
                key_word = ?,
                location_wkt = ?,
                location_kind = ?,
                id_group = ?,
                id_type = ?,
                comment = ?,
                is_active = ?,
                updated_at = ?
            WHERE id = ? AND is_active = 1
            """,
            (
                name,
                key_word,
                location_wkt,
                location_kind,
                id_group,
                id_type,
                comment,
                is_active,
                now_iso,
                landmark_id,
            ),
        )

        if getattr(cur, "rowcount", 0) == 0:
            raise HTTPException(status_code=404, detail="Орієнтир не знайдено або деактивований")

        if is_active == 0:
            # Remove stale matches so deactivated landmarks disappear in the
            # intercepts explorer.
            conn.execute("DELETE FROM message_landmark_matches WHERE id_landmark = ?", (landmark_id,))
        else:
            # Refresh matching for messages that previously had matches for this landmark.
            # Cap to avoid huge enqueue storms on large datasets.
            from app.services.landmark_match_service import enqueue_message_landmark_match

            cap = 1500
            for mid in message_ids[:cap]:
                enqueue_message_landmark_match(conn=conn, message_id=mid, queued_at=None)

        conn.commit()

    return JSONResponse({"ok": True})


@router.post("/api/landmarks")
async def api_landmark_create(request: Request):
    """Create a new landmark (used by "+ орієнтир" button)."""
    payload = await request.json()

    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Назва не може бути порожньою")

    raw_is_active = payload.get("is_active", 1)
    try:
        is_active = 1 if int(raw_is_active) != 0 else 0
    except Exception:
        is_active = 1

    location_wkt = str(payload.get("location_wkt") or "").strip()
    # For creation only `name` is mandatory.
    # location_wkt can be empty (stored as empty string).

    id_type = _parse_int_opt(payload.get("id_type"))
    id_group = _parse_int_opt(payload.get("id_group"))
    comment = str(payload.get("comment") or "").strip()

    key_word = _normalize_keyword(name)
    if not key_word:
        raise HTTPException(status_code=400, detail="Некоректна назва")

    location_kind = _location_kind_from_wkt(location_wkt)
    now_iso = _now_iso()

    with get_conn() as conn:
        unknown_type_id = _unknown_landmark_type_id(conn)
        if id_type is None:
            id_type = unknown_type_id

        type_row = conn.execute(
            "SELECT id FROM landmark_types WHERE id = ? LIMIT 1",
            (id_type,),
        ).fetchone()
        if not type_row:
            raise HTTPException(status_code=400, detail="Невірний тип орієнтира")

        if id_group is not None:
            g_row = conn.execute("SELECT id FROM groups WHERE id = ? LIMIT 1", (id_group,)).fetchone()
            if not g_row:
                raise HTTPException(status_code=400, detail="Невірний підрозділ")

        cur = conn.execute(
            """
            INSERT INTO landmarks (
                name, key_word, location_wkt, location_kind, comment,
                date_creation, updated_at, id_group, id_type, is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (name, key_word, location_wkt, location_kind, comment, now_iso, now_iso, id_group, id_type, is_active),
        )

        # After creation, optionally enqueue ALL valid messages for background matching
        # so the new keyword is applied to existing intercept history (LANDMARK_AUTO_MATCH).
        if settings.landmark_auto_match_enabled:
            conn.execute(
                """
                INSERT INTO message_landmark_queue (
                    message_id, status, attempts, last_error, queued_at, processed_at, updated_at
                )
                SELECT
                    id,
                    'pending',
                    0,
                    NULL,
                    ?,
                    NULL,
                    ?
                FROM messages
                WHERE COALESCE(is_valid, 1) = 1
                  AND body_text IS NOT NULL
                  AND TRIM(body_text) <> ''
                ON CONFLICT(message_id) DO UPDATE SET
                    status = 'pending',
                    last_error = NULL,
                    queued_at = excluded.queued_at,
                    updated_at = excluded.updated_at
                """,
                (now_iso, now_iso),
            )

        conn.commit()

        return JSONResponse({"ok": True, "landmark_id": int(cur.lastrowid)})


@router.post("/api/landmarks/{landmark_id}/delete")
async def api_landmark_delete(request: Request, landmark_id: int):
    """Deactivate landmark and remove its stale keyword matches."""
    now_iso = _now_iso()
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE landmarks
            SET is_active = 0,
                updated_at = ?
            WHERE id = ? AND is_active = 1
            """,
            (now_iso, landmark_id),
        )
        if getattr(cur, "rowcount", 0) == 0:
            raise HTTPException(status_code=404, detail="Орієнтир не знайдено або вже деактивований")

        conn.execute("DELETE FROM message_landmark_matches WHERE id_landmark = ?", (landmark_id,))
        conn.commit()

    return JSONResponse({"ok": True})

