from fastapi import APIRouter, Request, Query
from fastapi.responses import JSONResponse
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse

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
        # ingest_messages може бути відсутня в деяких збірках — але у вашій концепції вона є.
        # Якщо раптом таблиці нема — скажеш, я дам fallback без raw_text.
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

        # Передаємо в template як dict
        data = dict(row)
        return templates.TemplateResponse(
            "message_detail.html",
            {
                "request": request,
                "app_name": request.app.state.app_name,
                "m": data,
            },
        )
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
        }
    )


@router.get("/api/intercepts/search")
def intercepts_search(
    phrase: str | None = Query(None),
    frequency: str | None = Query(None),
    days: int = Query(7),
    limit: int = Query(50),
    offset: int = Query(0),
):
    phrase = (phrase or "").strip()
    frequency = (frequency or "").strip()

    conn = get_conn()

    since = datetime.utcnow() - timedelta(days=days)
    since = since.isoformat()

    warning = None

    freq_exists = False
    if frequency:
        r = conn.execute(
            "SELECT 1 FROM networks WHERE frequency=?",
            (frequency,),
        ).fetchone()

        freq_exists = r is not None

        if not freq_exists:
            warning = f"Частоту {frequency} не знайдено. Показано результати по всіх р/м."

    where = ["m.created_at >= ?", "m.is_valid = 1"]
    params = [since]

    if phrase:
        # AND-пошук по словах: "принял орлан" => LIKE %принял% AND LIKE %орлан%
        words = [w for w in phrase.split() if w.strip()]
        # опційно: відкинути дуже короткі (щоб не робити зайві LIKE)
        words = [w for w in words if len(w) >= 2]

    for w in words:
        where.append("m.body_text LIKE ?")
        params.append(f"%{w}%")

    if frequency and freq_exists:
        where.append("n.frequency=?")
        params.append(frequency)

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

    try:
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    items = []

    for r in rows:
        text = r["body_text"]
        preview = text[:250] + ("…" if len(text) > 250 else "")

        items.append(
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "frequency": r["frequency"],
                "net_description": r["net_description"],
                "preview": preview,
            }
        )

    conn.close()

    return JSONResponse(
        {
            "warning": warning,
            "total": total,
            "items": items,
        }
    )