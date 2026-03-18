"""UI and API router for intercept search and exploration.

This router provides:

- HTML pages for intercept search (`/intercepts`) and explorer (`/intercepts-explorer`);
- message detail page (`/messages/{message_id}`);
- JSON APIs used by the explorer UI to list messages, fetch details,
  update message comments, and manage message↔callsign links.

The ingest pipeline (parsing, deduplication, network resolution) is handled
by the service layer. This router focuses on read/search functionality and
manual review/editing workflows.
"""

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from app.core.normalize import normalize_freq_or_mask

router = APIRouter()

DB_PATH = Path("database/radio.db")


def get_conn():
    """Open a SQLite connection for this router.

    Note:
        This router currently opens a direct sqlite3 connection using a
        hardcoded DB_PATH. Other parts of the application use
        `app.core.db.get_conn`.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_callsign_role(role: str) -> str:
    """Normalize and validate callsign role for explorer operations."""
    value = (role or "").strip().lower()
    if value not in {"caller", "callee", "mentioned"}:
        raise HTTPException(status_code=400, detail="Invalid callsign role")
    return value


def _rebuild_message_edges(conn: sqlite3.Connection, message_id: int):
    """Rebuild callsign edges for a specific message after manual edits.

    The explorer UI can change message_callsigns manually. This helper
    adjusts `callsign_edges` to reflect the current caller/callees for that
    message.
    """
    message_row = conn.execute(
        """
        SELECT id, network_id
        FROM messages
        WHERE id = ?
        """,
        (message_id,),
    ).fetchone()

    if not message_row:
        raise HTTPException(status_code=404, detail="Intercept not found")

    network_id = int(message_row["network_id"])

    rows = conn.execute(
        """
        SELECT callsign_id, role
        FROM message_callsigns
        WHERE message_id = ?
        ORDER BY rowid ASC
        """,
        (message_id,),
    ).fetchall()

    caller_ids = [int(row["callsign_id"]) for row in rows if row["role"] == "caller"]
    callee_ids = [int(row["callsign_id"]) for row in rows if row["role"] == "callee"]

    # Best-effort cleanup: delete existing edges that correspond to callsigns
    # linked to this message, then re-insert/update based on current roles.
    conn.execute(
        """
        DELETE FROM callsign_edges
        WHERE network_id = ?
          AND id IN (
              SELECT ce.id
              FROM callsign_edges ce
              JOIN message_callsigns mc_a
                ON mc_a.callsign_id = ce.a_callsign_id
               AND mc_a.message_id = ?
              JOIN message_callsigns mc_b
                ON mc_b.callsign_id = ce.b_callsign_id
               AND mc_b.message_id = ?
              WHERE ce.network_id = ?
          )
        """,
        (network_id, message_id, message_id, network_id),
    )

    if not caller_ids or not callee_ids:
        return

    caller_id = caller_ids[0]

    for callee_id in callee_ids:
        if callee_id == caller_id:
            continue

        a_callsign_id = min(caller_id, callee_id)
        b_callsign_id = max(caller_id, callee_id)

        existing = conn.execute(
            """
            SELECT id, cnt, first_seen_dt, last_seen_dt
            FROM callsign_edges
            WHERE network_id = ?
              AND a_callsign_id = ?
              AND b_callsign_id = ?
            """,
            (network_id, a_callsign_id, b_callsign_id),
        ).fetchone()

        now_iso = datetime.utcnow().isoformat()

        if existing:
            new_cnt = int(existing["cnt"] or 0) + 1
            conn.execute(
                """
                UPDATE callsign_edges
                SET cnt = ?, last_seen_dt = ?
                WHERE id = ?
                """,
                (new_cnt, now_iso, existing["id"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO callsign_edges (
                    network_id,
                    a_callsign_id,
                    b_callsign_id,
                    first_seen_dt,
                    last_seen_dt,
                    cnt
                )
                VALUES (?, ?, ?, ?, ?, 1)
                """,
                (network_id, a_callsign_id, b_callsign_id, now_iso, now_iso),
            )


class InterceptsExplorerAddCallsignPayload(BaseModel):
    """Payload for adding a single callsign link to a message."""
    name: str
    role: str


class InterceptsExplorerCommentPayload(BaseModel):
    """Payload for updating a message comment."""
    comment: str = ""


class InterceptsExplorerCallsignItemPayload(BaseModel):
    """Single callsign link item used for bulk update."""
    callsign_id: int
    role: str = ""


class InterceptsExplorerCallsignsPayload(BaseModel):
    """Bulk callsign links payload used for replacing all message_callsigns."""
    items: list[InterceptsExplorerCallsignItemPayload] = []


@router.get("/messages/{message_id}", response_class=HTMLResponse)
def message_detail_page(request: Request, message_id: int):
    """Render a message detail page with raw ingest context if available."""
    templates = request.app.state.templates

    conn = get_conn()
    try:
        row = conn.execute(
            """
            SELECT
                m.id,
                m.created_at,
                m.received_at,
                m.net_description,
                m.body_text,
                m.comment,
                m.parse_confidence,
                m.is_valid,
                n.frequency,
                n.mask,
                n.unit,
                n.zone,
                im.raw_text,
                im.source_chat_name,
                im.source_message_id
            FROM messages m
            JOIN networks n ON n.id = m.network_id
            LEFT JOIN ingest_messages im ON im.id = m.ingest_id
            WHERE m.id = ?
            """,
            (message_id,),
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Message not found")

        return templates.TemplateResponse(
            "message_detail.html",
            {
                "request": request,
                "app_name": request.app.state.app_name,
                "m": dict(row),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.get("/intercepts")
def intercepts_page(request: Request):
    """Render intercept search page UI."""
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "intercepts_search.html",
        {
            "request": request,
            "app_name": request.app.state.app_name,
        },
    )


@router.get("/intercepts-explorer")
def intercepts_explorer_page(request: Request):
    """Render intercept explorer page UI."""
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "intercepts_explorer.html",
        {
            "request": request,
            "app_name": request.app.state.app_name,
        },
    )


@router.get("/api/intercepts/search")
def intercepts_search(
    phrase: str | None = Query(None),
    frequency: str | None = Query(None),
    days: int = Query(7, ge=1, le=365),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Search intercepts by phrase and/or network frequency/mask."""
    phrase = (phrase or "").strip()
    frequency_raw = (frequency or "").strip()

    if not phrase and not frequency_raw:
        return JSONResponse(
            {
                "warning": "Вкажи слово або частоту/маску для пошуку.",
                "total": 0,
                "items": [],
            }
        )

    conn = get_conn()
    try:
        since = (datetime.utcnow() - timedelta(days=days)).isoformat()

        where = ["m.created_at >= ?", "m.is_valid = 1"]
        params: list[object] = [since]
        warning = None

        if phrase:
            words = [w.strip() for w in phrase.split() if w.strip()]
            words = [w for w in words if len(w) >= 2]

            for word in words:
                where.append("m.body_text LIKE ?")
                params.append(f"%{word}%")

        exact_freq, freq_mask = normalize_freq_or_mask(frequency_raw)

        if frequency_raw:
            if exact_freq:
                freq_count = conn.execute(
                    "SELECT COUNT(*) FROM networks WHERE frequency = ?",
                    (exact_freq,),
                ).fetchone()[0]

                if freq_count == 0:
                    return JSONResponse(
                        {
                            "warning": f"Частоту/маску {exact_freq} не знайдено.",
                            "total": 0,
                            "items": [],
                        }
                    )

                where.append("n.frequency = ?")
                params.append(exact_freq)

            elif freq_mask:
                freq_count = conn.execute(
                    "SELECT COUNT(*) FROM networks WHERE frequency LIKE ?",
                    (freq_mask,),
                ).fetchone()[0]

                if freq_count == 0:
                    return JSONResponse(
                        {
                            "warning": f"Частоту/маску {freq_mask} не знайдено.",
                            "total": 0,
                            "items": [],
                        }
                    )

                where.append("n.frequency LIKE ?")
                params.append(freq_mask)

        where_sql = " AND ".join(where)

        total = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM messages m
            JOIN networks n ON n.id = m.network_id
            WHERE {where_sql}
            """,
            params,
        ).fetchone()[0]

        rows = conn.execute(
            f"""
            SELECT
                m.id,
                m.created_at,
                m.body_text,
                m.net_description,
                n.frequency
            FROM messages m
            JOIN networks n ON n.id = m.network_id
            WHERE {where_sql}
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()

        items = [
            {
                "id": row["id"],
                "created_at": row["created_at"],
                "frequency": row["frequency"],
                "net_description": row["net_description"],
                "text": row["body_text"] or "",
            }
            for row in rows
        ]

        return JSONResponse(
            {
                "warning": warning,
                "total": total,
                "items": items,
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.get("/api/intercepts-explorer")
def intercepts_explorer_list(
    start_dt: str | None = Query(None),
    end_dt: str | None = Query(None),
    network: str | None = Query(None),
    callsign: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    debug: int = Query(0),
):
    """List intercepts for explorer UI with optional datetime/network filters.

    When `debug=1`, the response includes rendered SQL and preview rows to
    simplify troubleshooting.
    """
    network_raw = (network or "").strip()
    callsign_raw = (callsign or "").strip()

    def parse_browser_dt(value: str | None) -> str | None:
        """Parse browser-provided ISO datetime into DB comparison format."""
        if not value:
            return None

        raw = value.strip()
        if not raw:
            return None

        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid datetime: {value}")

        return dt.strftime("%Y-%m-%dT%H:%M:%S")

    def sql_quote(value: object) -> str:
        if value is None:
            return "NULL"
        if isinstance(value, (int, float)):
            return str(value)
        return "'" + str(value).replace("'", "''") + "'"

    def render_sql(sql: str, params: list[object]) -> str:
        """Render a parameterized SQL string for debug output."""
        rendered = sql
        for value in params:
            rendered = rendered.replace("?", sql_quote(value), 1)
        return rendered

    start_dt_norm = parse_browser_dt(start_dt)
    end_dt_norm = parse_browser_dt(end_dt)

    conn = get_conn()
    try:
        message_dt_sql = """
        replace(
            substr(
                coalesce(nullif(m.created_at, ''), nullif(m.received_at, '')),
                1,
                19
            ),
            ' ',
            'T'
        )
        """

        where = ["COALESCE(m.is_valid, 1) = 1"]
        params: list[object] = []

        if start_dt_norm:
            where.append(f"({message_dt_sql}) >= ?")
            params.append(start_dt_norm)

        if end_dt_norm:
            where.append(f"({message_dt_sql}) <= ?")
            params.append(end_dt_norm)

        exact_freq, freq_mask = normalize_freq_or_mask(network_raw)

        if network_raw:
            if exact_freq:
                where.append("(COALESCE(n.frequency, '') = ? OR COALESCE(n.mask, '') = ?)")
                params.extend([exact_freq, exact_freq])
            elif freq_mask:
                where.append("(COALESCE(n.frequency, '') LIKE ? OR COALESCE(n.mask, '') LIKE ?)")
                params.extend([freq_mask, freq_mask])
            else:
                like_value = f"%{network_raw}%"
                where.append(
                    """
                    (
                        COALESCE(n.frequency, '') LIKE ?
                        OR COALESCE(n.mask, '') LIKE ?
                        OR COALESCE(n.unit, '') LIKE ?
                        OR COALESCE(n.zone, '') LIKE ?
                        OR COALESCE(m.net_description, '') LIKE ?
                    )
                    """
                )
                params.extend([like_value, like_value, like_value, like_value, like_value])

        if callsign_raw:
            where.append(
                """
                EXISTS (
                    SELECT 1
                    FROM message_callsigns mc
                    JOIN callsigns c ON c.id = mc.callsign_id
                    WHERE mc.message_id = m.id
                      AND lower(c.name) = lower(?)
                )
                """
            )
            params.append(callsign_raw)

        where_sql = " AND ".join(where)

        count_sql = f"""
        SELECT COUNT(*) AS total
        FROM messages m
        LEFT JOIN networks n ON n.id = m.network_id
        WHERE {where_sql}
        """

        preview_sql = f"""
        SELECT
            m.id,
            m.created_at,
            m.received_at,
            {message_dt_sql} AS normalized_dt,
            m.is_valid,
            m.network_id,
            n.frequency,
            n.mask,
            m.net_description
        FROM messages m
        LEFT JOIN networks n ON n.id = m.network_id
        WHERE {where_sql}
        ORDER BY ({message_dt_sql}) DESC, m.id DESC
        LIMIT 10
        """

        rows_sql = f"""
        SELECT
            m.id,
            m.network_id,
            m.created_at,
            m.received_at,
            m.body_text,
            m.comment,
            m.net_description,
            n.frequency,
            n.mask,
            n.unit,
            n.zone
        FROM messages m
        LEFT JOIN networks n ON n.id = m.network_id
        WHERE {where_sql}
        ORDER BY ({message_dt_sql}) DESC, m.id DESC
        LIMIT ? OFFSET ?
        """

        total_row = conn.execute(count_sql, params).fetchone()
        preview_rows = conn.execute(preview_sql, params).fetchall()
        rows = conn.execute(rows_sql, params + [limit, offset]).fetchall()

        items = [
            {
                "id": row["id"],
                "network_id": row["network_id"],
                "created_at": row["created_at"] or "",
                "received_at": row["received_at"] or "",
                "text": row["body_text"] or "",
                "comment": row["comment"] or "",
                "net_description": row["net_description"] or "",
                "network": {
                    "frequency": row["frequency"] or "",
                    "mask": row["mask"] or "",
                    "unit": row["unit"] or "",
                    "zone": row["zone"] or "",
                },
            }
            for row in rows
        ]

        payload = {
            "total": int(total_row["total"] or 0),
            "items": items,
        }

        if debug == 1:
            payload["_debug"] = {
                "route_hit": True,
                "input": {
                    "start_dt": start_dt,
                    "end_dt": end_dt,
                    "network": network,
                    "callsign": callsign,
                    "limit": limit,
                    "offset": offset,
                },
                "normalized": {
                    "start_dt_norm": start_dt_norm,
                    "end_dt_norm": end_dt_norm,
                    "network_raw": network_raw,
                    "exact_freq": exact_freq,
                    "freq_mask": freq_mask,
                },
                "count_sql": render_sql(count_sql, params),
                "preview_sql": render_sql(preview_sql, params),
                "rows_sql": render_sql(rows_sql, params + [limit, offset]),
                "preview_rows": [dict(r) for r in preview_rows],
            }

        return JSONResponse(payload)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"intercepts_explorer_list failed: {e}",
        )
    finally:
        conn.close()


@router.get("/api/intercepts-explorer/{message_id}")
def intercepts_explorer_detail(message_id: int):
    """Fetch full intercept detail including callsigns for explorer UI."""
    conn = get_conn()
    try:
        message_row = conn.execute(
            """
            SELECT
                m.id,
                m.network_id,
                m.created_at,
                m.received_at,
                m.body_text,
                m.comment,
                m.net_description,
                n.frequency,
                n.mask,
                n.unit,
                n.zone
            FROM messages m
            JOIN networks n ON n.id = m.network_id
            WHERE m.id = ? AND m.is_valid = 1
            """,
            (message_id,),
        ).fetchone()

        if not message_row:
            raise HTTPException(status_code=404, detail="Intercept not found")

        callsign_rows = conn.execute(
            """
            SELECT
                c.id,
                c.name,
                c.comment,
                c.callsign_status_id AS status_id,
                mc.role
            FROM message_callsigns mc
            JOIN callsigns c ON c.id = mc.callsign_id
            WHERE mc.message_id = ?
            ORDER BY mc.rowid ASC, c.id ASC
            """,
            (message_id,),
        ).fetchall()

        return JSONResponse(
            {
                "item": {
                    "id": message_row["id"],
                    "network_id": message_row["network_id"],
                    "created_at": message_row["created_at"],
                    "received_at": message_row["received_at"],
                    "text": message_row["body_text"] or "",
                    "comment": message_row["comment"] or "",
                    "net_description": message_row["net_description"] or "",
                    "network": {
                        "frequency": message_row["frequency"] or "",
                        "mask": message_row["mask"] or "",
                        "unit": message_row["unit"] or "",
                        "zone": message_row["zone"] or "",
                    },
                    "callsigns": [
                        {
                            "id": row["id"],
                            "name": row["name"] or "",
                            "comment": row["comment"] or "",
                            "status_id": row["status_id"],
                            "role": row["role"] or "",
                        }
                        for row in callsign_rows
                    ],
                }
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.put("/api/intercepts-explorer/{message_id}/comment")
def intercepts_explorer_update_comment(
    message_id: int,
    payload: InterceptsExplorerCommentPayload,
):
    """Update message comment field (manual review workflow)."""
    conn = get_conn()
    try:
        row = conn.execute(
            """
            SELECT id
            FROM messages
            WHERE id = ? AND is_valid = 1
            """,
            (message_id,),
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Intercept not found")

        comment = (payload.comment or "").strip()

        conn.execute(
            """
            UPDATE messages
            SET comment = ?
            WHERE id = ?
            """,
            (comment, message_id),
        )
        conn.commit()

        return JSONResponse(
            {
                "ok": True,
                "message_id": message_id,
                "comment": comment,
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.put("/api/intercepts-explorer/{message_id}/callsigns")
def intercepts_explorer_update_callsigns(
    message_id: int,
    payload: InterceptsExplorerCallsignsPayload,
):
    """Replace all message_callsigns links for a message.

    The function validates callsign ids and roles, rewrites the link table,
    and returns the resulting callsigns list.
    """
    conn = get_conn()
    try:
        message_row = conn.execute(
            """
            SELECT id
            FROM messages
            WHERE id = ? AND is_valid = 1
            """,
            (message_id,),
        ).fetchone()

        if not message_row:
            raise HTTPException(status_code=404, detail="Intercept not found")

        items: list[InterceptsExplorerCallsignItemPayload] = payload.items or []

        cleaned_items: list[dict[str, object]] = []
        seen_keys: set[tuple[int, str]] = set()

        for item in items:
            callsign_id = int(item.callsign_id)
            role = (item.role or "").strip().lower()

            if callsign_id <= 0:
                raise HTTPException(status_code=400, detail="Invalid callsign_id")

            if not role:
                raise HTTPException(status_code=400, detail="Role is required")

            key = (callsign_id, role)
            if key in seen_keys:
                continue

            seen_keys.add(key)
            cleaned_items.append(
                {
                    "callsign_id": callsign_id,
                    "role": role,
                }
            )

        if cleaned_items:
            callsign_ids = [item["callsign_id"] for item in cleaned_items]
            placeholders = ",".join(["?"] * len(callsign_ids))

            existing_rows = conn.execute(
                f"""
                SELECT id
                FROM callsigns
                WHERE id IN ({placeholders})
                """,
                callsign_ids,
            ).fetchall()

            existing_ids = {int(row["id"]) for row in existing_rows}

            for callsign_id in callsign_ids:
                if callsign_id not in existing_ids:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Callsign {callsign_id} not found",
                    )

        conn.execute(
            """
            DELETE FROM message_callsigns
            WHERE message_id = ?
            """,
            (message_id,),
        )

        if cleaned_items:
            conn.executemany(
                """
                INSERT INTO message_callsigns (message_id, callsign_id, role)
                VALUES (?, ?, ?)
                """,
                [
                    (message_id, item["callsign_id"], item["role"])
                    for item in cleaned_items
                ],
            )

        conn.commit()

        rows = conn.execute(
            """
            SELECT
                c.id,
                c.name,
                c.comment,
                c.callsign_status_id AS status_id,
                mc.role
            FROM message_callsigns mc
            JOIN callsigns c ON c.id = mc.callsign_id
            WHERE mc.message_id = ?
            ORDER BY mc.rowid ASC, c.id ASC
            """,
            (message_id,),
        ).fetchall()

        return JSONResponse(
            {
                "ok": True,
                "message_id": message_id,
                "callsigns": [
                    {
                        "id": row["id"],
                        "name": row["name"] or "",
                        "comment": row["comment"] or "",
                        "status_id": row["status_id"],
                        "role": row["role"] or "",
                    }
                    for row in rows
                ],
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


def _normalize_callsign_role(role: str) -> str:
    value = (role or "").strip().lower()
    if value not in {"caller", "callee", "mentioned"}:
        raise HTTPException(status_code=400, detail="Invalid callsign role")
    return value


def _rebuild_message_edges(conn: sqlite3.Connection, message_id: int):
    message_row = conn.execute(
        """
        SELECT id, network_id
        FROM messages
        WHERE id = ?
        """,
        (message_id,),
    ).fetchone()

    if not message_row:
        raise HTTPException(status_code=404, detail="Intercept not found")

    network_id = int(message_row["network_id"])

    rows = conn.execute(
        """
        SELECT callsign_id, role
        FROM message_callsigns
        WHERE message_id = ?
        ORDER BY rowid ASC
        """,
        (message_id,),
    ).fetchall()

    caller_ids = [int(row["callsign_id"]) for row in rows if row["role"] == "caller"]
    callee_ids = [int(row["callsign_id"]) for row in rows if row["role"] == "callee"]

    conn.execute(
        """
        DELETE FROM callsign_edges
        WHERE network_id = ?
          AND id IN (
              SELECT ce.id
              FROM callsign_edges ce
              JOIN message_callsigns mc_a
                ON mc_a.callsign_id = ce.a_callsign_id
               AND mc_a.message_id = ?
              JOIN message_callsigns mc_b
                ON mc_b.callsign_id = ce.b_callsign_id
               AND mc_b.message_id = ?
              WHERE ce.network_id = ?
          )
        """,
        (network_id, message_id, message_id, network_id),
    )

    if not caller_ids or not callee_ids:
        return

    caller_id = caller_ids[0]

    for callee_id in callee_ids:
        if callee_id == caller_id:
            continue

        a_callsign_id = min(caller_id, callee_id)
        b_callsign_id = max(caller_id, callee_id)

        existing = conn.execute(
            """
            SELECT id, cnt, first_seen_dt, last_seen_dt
            FROM callsign_edges
            WHERE network_id = ?
              AND a_callsign_id = ?
              AND b_callsign_id = ?
            """,
            (network_id, a_callsign_id, b_callsign_id),
        ).fetchone()

        now_iso = datetime.utcnow().isoformat()

        if existing:
            new_cnt = int(existing["cnt"] or 0) + 1
            conn.execute(
                """
                UPDATE callsign_edges
                SET cnt = ?, last_seen_dt = ?
                WHERE id = ?
                """,
                (new_cnt, now_iso, existing["id"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO callsign_edges (
                    network_id,
                    a_callsign_id,
                    b_callsign_id,
                    first_seen_dt,
                    last_seen_dt,
                    cnt
                )
                VALUES (?, ?, ?, ?, ?, 1)
                """,
                (network_id, a_callsign_id, b_callsign_id, now_iso, now_iso),
            )


@router.post("/api/intercepts-explorer/{message_id}/callsigns")
def intercepts_explorer_add_callsign(
    message_id: int,
    payload: InterceptsExplorerAddCallsignPayload,
):
    conn = get_conn()
    try:
        message_row = conn.execute(
            """
            SELECT id, network_id
            FROM messages
            WHERE id = ? AND is_valid = 1
            """,
            (message_id,),
        ).fetchone()

        if not message_row:
            raise HTTPException(status_code=404, detail="Intercept not found")

        role = _normalize_callsign_role(payload.role)
        name = _normalize_callsign_name(payload.name)

        if not name:
            raise HTTPException(status_code=400, detail="Callsign name is required")

        callsign_row = conn.execute(
            """
            SELECT id
            FROM callsigns
            WHERE UPPER(name) = ?
            LIMIT 1
            """,
            (name,),
        ).fetchone()

        if callsign_row:
            callsign_id = int(callsign_row["id"])
        else:
            now_iso = datetime.utcnow().isoformat()
            cursor = conn.execute(
                """
                INSERT INTO callsigns (
                    network_id,
                    name,
                    status_id,
                    comment,
                    updated_at,
                    last_seen_dt,
                    callsign_status_id,
                    source_id
                )
                VALUES (?, ?, NULL, '', ?, ?, NULL, NULL)
                """,
                (message_row["network_id"], name, now_iso, now_iso),
            )
            callsign_id = int(cursor.lastrowid)

        if role == "caller":
            conn.execute(
                """
                DELETE FROM message_callsigns
                WHERE message_id = ? AND role = 'caller'
                """,
                (message_id,),
            )

        duplicate = conn.execute(
            """
            SELECT 1
            FROM message_callsigns
            WHERE message_id = ? AND callsign_id = ? AND role = ?
            LIMIT 1
            """,
            (message_id, callsign_id, role),
        ).fetchone()

        if duplicate:
            rows = conn.execute(
                """
                SELECT
                    c.id,
                    c.name,
                    c.comment,
                    c.callsign_status_id AS status_id,
                    mc.role
                FROM message_callsigns mc
                JOIN callsigns c ON c.id = mc.callsign_id
                WHERE mc.message_id = ?
                ORDER BY
                    CASE mc.role
                        WHEN 'caller' THEN 1
                        WHEN 'callee' THEN 2
                        WHEN 'mentioned' THEN 3
                        ELSE 9
                    END,
                    mc.rowid ASC,
                    c.id ASC
                """,
                (message_id,),
            ).fetchall()

            return JSONResponse(
                {
                    "ok": True,
                    "message_id": message_id,
                    "callsigns": [
                        {
                            "id": row["id"],
                            "name": row["name"] or "",
                            "comment": row["comment"] or "",
                            "status_id": row["status_id"],
                            "role": row["role"] or "",
                        }
                        for row in rows
                    ],
                }
            )

        now_iso = datetime.utcnow().isoformat()

        conn.execute(
            """
            INSERT INTO message_callsigns (message_id, callsign_id, role)
            VALUES (?, ?, ?)
            """,
            (message_id, callsign_id, role),
        )

        conn.execute(
            """
            UPDATE callsigns
            SET updated_at = ?, last_seen_dt = ?
            WHERE id = ?
            """,
            (now_iso, now_iso, callsign_id),
        )

        _rebuild_message_edges(conn, message_id)
        conn.commit()

        rows = conn.execute(
            """
            SELECT
                c.id,
                c.name,
                c.comment,
                c.callsign_status_id AS status_id,
                mc.role
            FROM message_callsigns mc
            JOIN callsigns c ON c.id = mc.callsign_id
            WHERE mc.message_id = ?
            ORDER BY
                CASE mc.role
                    WHEN 'caller' THEN 1
                    WHEN 'callee' THEN 2
                    WHEN 'mentioned' THEN 3
                    ELSE 9
                END,
                mc.rowid ASC,
                c.id ASC
            """,
            (message_id,),
        ).fetchall()

        return JSONResponse(
            {
                "ok": True,
                "message_id": message_id,
                "callsigns": [
                    {
                        "id": row["id"],
                        "name": row["name"] or "",
                        "comment": row["comment"] or "",
                        "status_id": row["status_id"],
                        "role": row["role"] or "",
                    }
                    for row in rows
                ],
            }
        )
    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.delete("/api/intercepts-explorer/{message_id}/callsigns/{callsign_id}")
def intercepts_explorer_delete_callsign(
    message_id: int,
    callsign_id: int,
    role: str = Query(...),
):
    conn = get_conn()
    try:
        role_value = (role or "").strip().lower()

        if role_value not in {"caller", "callee", "mentioned"}:
            raise HTTPException(status_code=400, detail="Invalid role")

        message_row = conn.execute(
            """
            SELECT id
            FROM messages
            WHERE id = ? AND is_valid = 1
            """,
            (message_id,),
        ).fetchone()

        if not message_row:
            raise HTTPException(status_code=404, detail="Intercept not found")

        conn.execute(
            """
            DELETE FROM message_callsigns
            WHERE message_id = ?
              AND callsign_id = ?
              AND role = ?
            """,
            (message_id, callsign_id, role_value),
        )

        conn.commit()

        rows = conn.execute(
            """
            SELECT
                c.id,
                c.name,
                c.comment,
                c.callsign_status_id AS status_id,
                mc.role
            FROM message_callsigns mc
            JOIN callsigns c ON c.id = mc.callsign_id
            WHERE mc.message_id = ?
            ORDER BY
                CASE mc.role
                    WHEN 'caller' THEN 1
                    WHEN 'callee' THEN 2
                    WHEN 'mentioned' THEN 3
                    ELSE 9
                END,
                mc.rowid ASC
            """,
            (message_id,),
        ).fetchall()

        return JSONResponse(
            {
                "ok": True,
                "callsigns": [
                    {
                        "id": row["id"],
                        "name": row["name"] or "",
                        "comment": row["comment"] or "",
                        "status_id": row["status_id"],
                        "role": row["role"] or "",
                    }
                    for row in rows
                ],
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.get("/api/callsigns/autocomplete")
def callsigns_autocomplete(
    q: str = Query(..., min_length=2),
    network_id: int | None = Query(None),
    limit: int = Query(10, ge=1, le=30),
):
    conn = get_conn()
    try:
        query = _normalize_callsign_name(q)

        if len(query) < 2:
            return JSONResponse({"items": []})

        where = ["UPPER(name) LIKE ?"]
        params: list[object] = [f"{query}%"]

        if network_id is not None:
            where.append("network_id = ?")
            params.append(network_id)

        where_sql = " AND ".join(where)

        rows = conn.execute(
            f"""
            SELECT
                id,
                name,
                status_id
            FROM callsigns
            WHERE {where_sql}
            ORDER BY
                CASE
                    WHEN UPPER(name) = ? THEN 0
                    WHEN UPPER(name) LIKE ? THEN 1
                    ELSE 9
                END,
                last_seen_dt DESC,
                name ASC
            LIMIT ?
            """,
            params + [query, f"{query}%", limit],
        ).fetchall()

        return JSONResponse(
            {
                "items": [
                    {
                        "id": row["id"],
                        "name": row["name"] or "",
                        "status_id": row["status_id"],
                    }
                    for row in rows
                ]
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()



def _normalize_callsign_name(value: str) -> str:
    parts = [part for part in (value or "").strip().split() if part]
    normalized = " ".join(parts).upper()
    return normalized
