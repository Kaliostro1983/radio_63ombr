"""HTTP router for the Import/Export page.

Exposes:
- GET  /import-export            → renders the page (XLSX + Chatbot tabs)
- GET  /api/ingest/errors        → list of rejected ingest_messages rows
- POST /api/ingest/{id}/dismiss  → mark an error row as reviewed
- POST /api/ingest/{id}/retry    → re-run the pipeline on a rejected row
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.core.db import get_conn
from app.core.time_utils import now_sql

router = APIRouter(tags=["import_export"])


@router.get("/import-export", response_class=HTMLResponse)
def import_export_page(request: Request):
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "import_export.html",
        {"request": request, "app_name": request.app.state.app_name},
    )


@router.get("/api/ingest/errors")
def get_ingest_errors(
    filter: str = "unreviewed",   # all | unreviewed
    limit: int = 200,
    offset: int = 0,
):
    """Return rejected ingest_messages rows for the error queue UI."""
    with get_conn() as conn:
        base = "parse_status IN ('parse_error', 'skipped_unknown_format')"
        if filter == "unreviewed":
            base += " AND reviewed_at IS NULL"

        total_row = conn.execute(
            f"SELECT COUNT(*) AS c FROM ingest_messages WHERE {base}"
        ).fetchone()
        total = int(total_row["c"] or 0)

        unreviewed_row = conn.execute(
            "SELECT COUNT(*) AS c FROM ingest_messages "
            "WHERE parse_status IN ('parse_error','skipped_unknown_format') AND reviewed_at IS NULL"
        ).fetchone()
        unreviewed = int(unreviewed_row["c"] or 0)

        rows = conn.execute(
            f"""
            SELECT id, platform, source_chat_name, source_message_id,
                   received_at, message_format, parse_status, parse_error,
                   raw_text, reviewed_at
            FROM ingest_messages
            WHERE {base}
            ORDER BY reviewed_at IS NULL DESC, received_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()

        items = [
            {
                "id": r["id"],
                "platform": r["platform"],
                "source_chat_name": r["source_chat_name"],
                "source_message_id": r["source_message_id"],
                "received_at": r["received_at"],
                "message_format": r["message_format"],
                "parse_status": r["parse_status"],
                "parse_error": r["parse_error"],
                "raw_text": r["raw_text"],
                "reviewed_at": r["reviewed_at"],
            }
            for r in rows
        ]

        return {
            "ok": True,
            "total": total,
            "unreviewed": unreviewed,
            "items": items,
        }


@router.post("/api/ingest/{ingest_id}/dismiss")
def dismiss_ingest_error(ingest_id: int):
    """Mark an ingest error row as reviewed/dismissed."""
    with get_conn() as conn:
        result = conn.execute(
            """
            UPDATE ingest_messages
            SET reviewed_at = ?
            WHERE id = ?
              AND parse_status IN ('parse_error', 'skipped_unknown_format')
            """,
            (now_sql(), ingest_id),
        )
        if result.rowcount == 0:
            return JSONResponse({"ok": False, "error": "not found or not an error row"}, status_code=404)
        return {"ok": True, "dismissed": True}


@router.post("/api/ingest/{ingest_id}/retry")
def retry_ingest_error(ingest_id: int):
    """Re-run the ingest pipeline on a rejected ingest_messages row."""
    from app.services.ingest_service import reprocess_ingest_message

    result = reprocess_ingest_message(ingest_id)
    if not result.get("ok") and result.get("error"):
        return JSONResponse(result, status_code=400)
    return result
