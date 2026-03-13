# intercepts.py
# заміни файл повністю

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.normalize import normalize_freq_or_mask

router = APIRouter()

DB_PATH = Path("database/radio.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@router.get("/messages/{message_id}", response_class=HTMLResponse)
def message_detail_page(request: Request, message_id: int):
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
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "intercepts_search.html",
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