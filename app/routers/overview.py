"""API router for the Overview (Огляд) statistics tab."""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.core.db import get_conn

router = APIRouter(tags=["overview"])


@router.get("/api/overview/stats")
def get_overview_stats(
    from_dt: str = Query(..., description="YYYY-MM-DD HH:MM:SS"),
    to_dt: str = Query(..., description="YYYY-MM-DD HH:MM:SS"),
):
    """Return aggregated statistics for the selected period.

    All timestamp comparisons use REPLACE(ts, 'T', ' ') to handle both
    ISO T-format and space-format datetimes stored in SQLite.
    """
    def _norm(col: str) -> str:
        return f"REPLACE({col}, 'T', ' ')"

    with get_conn() as conn:
        # ── Total intercepts ─────────────────────────────────────────────────
        row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM messages
            WHERE content_type = 'intercept'
              AND {_norm('created_at')} >= ?
              AND {_norm('created_at')} <= ?
            """,
            (from_dt, to_dt),
        ).fetchone()
        total_intercepts = int(row[0] or 0)

        # ── Очерет intercepts (via network → chat) ───────────────────────────
        row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM messages m
            JOIN networks n ON n.id = m.network_id
            JOIN chats c ON c.id = n.chat_id
            WHERE m.content_type = 'intercept'
              AND {_norm('m.created_at')} >= ?
              AND {_norm('m.created_at')} <= ?
              AND c.name = 'Очерет'
            """,
            (from_dt, to_dt),
        ).fetchone()
        ocheret_intercepts = int(row[0] or 0)

        # ── Peleng batches ────────────────────────────────────────────────────
        row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM peleng_batches
            WHERE {_norm('event_dt')} >= ?
              AND {_norm('event_dt')} <= ?
            """,
            (from_dt, to_dt),
        ).fetchone()
        peleng_count = int(row[0] or 0)

        # ── Analytical conclusions ────────────────────────────────────────────
        row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM analytical_conclusions
            WHERE {_norm('created_at')} >= ?
              AND {_norm('created_at')} <= ?
            """,
            (from_dt, to_dt),
        ).fetchone()
        analytical_count = int(row[0] or 0)

        # ── Intercepts by network chat ────────────────────────────────────────
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(c.name, '(без чату)') AS chat_name,
                COUNT(*) AS cnt
            FROM messages m
            JOIN networks n ON n.id = m.network_id
            JOIN chats c ON c.id = n.chat_id
            WHERE m.content_type = 'intercept'
              AND {_norm('m.created_at')} >= ?
              AND {_norm('m.created_at')} <= ?
            GROUP BY c.name
            ORDER BY cnt DESC
            """,
            (from_dt, to_dt),
        ).fetchall()
        by_chat = [{"chat_name": r["chat_name"], "count": r["cnt"]} for r in rows]

    return {
        "ok": True,
        "total_intercepts": total_intercepts,
        "ocheret_intercepts": ocheret_intercepts,
        "peleng_count": peleng_count,
        "analytical_count": analytical_count,
        "by_chat": by_chat,
    }
