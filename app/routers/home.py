from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse

from app.core.db import get_conn
from app.core.normalize import normalize_freq_or_mask


router = APIRouter(tags=["home"])


def _parse_days(value: Any, default: int = 5) -> int:
    try:
        v = int(value)
        if v < 1:
            return default
        if v > 60:
            return 60
        return v
    except Exception:
        return default


def _date_list(end_day: date, days: int) -> list[date]:
    start = end_day - timedelta(days=days - 1)
    return [start + timedelta(days=i) for i in range(days)]


@router.get("/home", response_class=HTMLResponse)
def home_page(request: Request):
    with get_conn() as conn:
        statuses = conn.execute(
            "SELECT id, name FROM statuses ORDER BY id ASC"
        ).fetchall()
    return request.app.state.templates.TemplateResponse(
        "home.html",
        {
            "request": request,
            "statuses": [{"id": int(s["id"]), "name": s["name"]} for s in statuses],
        },
    )


@router.get("/api/home/activity")
def api_home_activity(
    days: int = 5,
    include_today: int = 1,
    advanced: int = 0,
    freqs: str = "",
):
    """Return per-day intercept counts for selected radio networks."""
    days_n = _parse_days(days, default=5)
    include_today_b = bool(int(include_today or 0))
    advanced_b = bool(int(advanced or 0))

    end_day = datetime.now().date() if include_today_b else (datetime.now().date() - timedelta(days=1))
    days_list = _date_list(end_day, days_n)
    day_keys = [d.isoformat() for d in days_list]  # YYYY-MM-DD
    day_labels = [d.strftime("%d.%m") for d in days_list]

    start_dt_obj = datetime.combine(days_list[0], datetime.min.time())
    end_dt_obj = datetime.combine(days_list[-1], datetime.max.time().replace(microsecond=0))
    start_dt = start_dt_obj.strftime("%Y-%m-%d %H:%M:%S")
    end_dt = end_dt_obj.strftime("%Y-%m-%d %H:%M:%S")

    freq_list = [x.strip() for x in (freqs or "").split(",") if x.strip()]

    with get_conn() as conn:
        # Resolve which networks to analyze
        network_rows = []
        if freq_list:
            # User may provide frequencies OR masks. Resolve to a set of network ids.
            resolved_ids: set[int] = set()
            for token in freq_list:
                exact, mask = normalize_freq_or_mask(token)
                if mask:
                    rows = conn.execute(
                        """
                        SELECT id
                        FROM networks
                        WHERE frequency LIKE ? OR mask LIKE ?
                        """,
                        (mask, mask),
                    ).fetchall()
                    for r in rows:
                        resolved_ids.add(int(r["id"]))
                elif exact:
                    row = conn.execute(
                        """
                        SELECT id
                        FROM networks
                        WHERE frequency = ? OR mask = ?
                        LIMIT 1
                        """,
                        (exact, exact),
                    ).fetchone()
                    if row:
                        resolved_ids.add(int(row["id"]))

            if resolved_ids:
                placeholders = ",".join(["?"] * len(resolved_ids))
                network_rows = conn.execute(
                    f"""
                    SELECT
                        n.id,
                        n.frequency,
                        n.mask,
                        n.unit,
                        n.group_id,
                        g.name AS group_name,
                        n.status_id,
                        s.bg_color,
                        s.border_color
                    FROM networks n
                    JOIN statuses s ON s.id = n.status_id
                    LEFT JOIN groups g ON g.id = n.group_id
                    WHERE n.id IN ({placeholders})
                    ORDER BY g.name, n.frequency
                    """,
                    tuple(sorted(resolved_ids)),
                ).fetchall()
        else:
            if advanced_b:
                network_rows = conn.execute(
                    """
                    SELECT
                        n.id,
                        n.frequency,
                        n.mask,
                        n.unit,
                        n.group_id,
                        g.name AS group_name,
                        n.status_id,
                        s.bg_color,
                        s.border_color
                    FROM networks n
                    JOIN statuses s ON s.id = n.status_id
                    LEFT JOIN groups g ON g.id = n.group_id
                    WHERE n.id IN (
                        SELECT DISTINCT m.network_id
                        FROM messages m
                        WHERE m.is_valid = 1
                          AND coalesce(m.content_type, 'intercept') = 'intercept'
                          AND REPLACE(m.created_at, 'T', ' ') >= ?
                          AND REPLACE(m.created_at, 'T', ' ') <= ?
                    )
                    ORDER BY g.name, n.frequency
                    """,
                    (start_dt, end_dt),
                ).fetchall()
            else:
                network_rows = conn.execute(
                    """
                    SELECT
                        n.id,
                        n.frequency,
                        n.mask,
                        n.unit,
                        n.group_id,
                        g.name AS group_name,
                        n.status_id,
                        s.bg_color,
                        s.border_color
                    FROM networks n
                    JOIN statuses s ON s.id = n.status_id
                    LEFT JOIN groups g ON g.id = n.group_id
                    WHERE n.status_id IN (1, 14)
                    ORDER BY g.name, n.frequency
                    """
                ).fetchall()

        network_ids = [int(r["id"]) for r in network_rows]
        if not network_ids:
            return {
                "ok": True,
                "days": day_keys,
                "day_labels": day_labels,
                "summary": [0 for _ in day_keys],
                "groups": [],
            }

        # Load tag ids for each network (for the Home activity table).
        tag_map: dict[int, list[int]] = {}
        placeholders = ",".join(["?"] * len(network_ids))
        tag_rows = conn.execute(
            f"""
            SELECT network_id, tag_id
            FROM network_tag_links
            WHERE network_id IN ({placeholders})
            ORDER BY network_id ASC, tag_id ASC
            """,
            tuple(network_ids),
        ).fetchall()
        for tr in tag_rows:
            nid = int(tr["network_id"])
            tid = int(tr["tag_id"])
            tag_map.setdefault(nid, []).append(tid)

        placeholders = ",".join(["?"] * len(network_ids))
        cnt_rows = conn.execute(
            f"""
            SELECT
                m.network_id,
                substr(m.created_at, 1, 10) AS day,
                COUNT(1) AS cnt
            FROM messages m
            WHERE m.is_valid = 1
              AND coalesce(m.content_type, 'intercept') = 'intercept'
              AND REPLACE(m.created_at, 'T', ' ') >= ?
              AND REPLACE(m.created_at, 'T', ' ') <= ?
              AND m.network_id IN ({placeholders})
            GROUP BY m.network_id, substr(m.created_at, 1, 10)
            """,
            (start_dt, end_dt, *network_ids),
        ).fetchall()

    # Build count map
    count_map: dict[tuple[int, str], int] = {}
    for r in cnt_rows:
        count_map[(int(r["network_id"]), str(r["day"]))] = int(r["cnt"] or 0)

    # Summary totals per day
    summary = []
    for day in day_keys:
        total = 0
        for nid in network_ids:
            total += count_map.get((nid, day), 0)
        summary.append(total)

    # Group networks by group
    grouped: dict[str, dict[str, Any]] = {}
    for r in network_rows:
        gname = (r["group_name"] or "Без групи").strip() or "Без групи"
        g = grouped.get(gname)
        if g is None:
            g = {"group_name": gname, "rows": []}
            grouped[gname] = g

        nid = int(r["id"])
        row_counts = [count_map.get((nid, day), 0) for day in day_keys]
        g["rows"].append(
            {
                "id": nid,
                "frequency": r["frequency"] or "",
                "mask": r["mask"] or "",
                "unit": r["unit"] or "",
                "tag_ids": tag_map.get(nid, []),
                "status_bg": r["bg_color"] or "",
                "status_border": r["border_color"] or "",
                "counts": row_counts,
            }
        )

    groups_out = [grouped[k] for k in sorted(grouped.keys())]

    return {
        "ok": True,
        "days": day_keys,
        "day_labels": day_labels,
        "summary": summary,
        "groups": groups_out,
        "meta": {
            "start_dt": start_dt,
            "end_dt": end_dt,
            "start_human": start_dt_obj.strftime("%d.%m.%Y %H:%M"),
            "end_human": end_dt_obj.strftime("%d.%m.%Y %H:%M"),
            "networks": len(network_ids),
        },
    }


@router.get("/api/home/analytical-summary")
def api_home_analytical_summary(
    start_dt: str | None = None,
    end_dt: str | None = None,
    frequency: str = "",
):
    """Return analytical messages stats with period/frequency filters."""

    def _parse_dt_opt(value: str | None) -> str | None:
        if not value:
            return None
        raw = str(value).strip()
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid datetime: {value}")
        return dt.strftime("%Y-%m-%d %H:%M:%S")

    start_norm = _parse_dt_opt(start_dt)
    end_norm = _parse_dt_opt(end_dt)
    freq_raw = str(frequency or "").strip()
    exact_freq, freq_mask = normalize_freq_or_mask(freq_raw)

    where = [
        "COALESCE(m.is_valid, 1) = 1",
        "coalesce(m.content_type, 'intercept') = 'analytical'",
    ]
    params: list[object] = []

    if start_norm:
        where.append("REPLACE(m.created_at, 'T', ' ') >= ?")
        params.append(start_norm)
    if end_norm:
        where.append("REPLACE(m.created_at, 'T', ' ') <= ?")
        params.append(end_norm)

    if freq_raw:
        if exact_freq:
            where.append("(COALESCE(n.frequency, '') = ? OR COALESCE(n.mask, '') = ?)")
            params.extend([exact_freq, exact_freq])
        elif freq_mask:
            where.append("(COALESCE(n.frequency, '') LIKE ? OR COALESCE(n.mask, '') LIKE ?)")
            params.extend([freq_mask, freq_mask])
        else:
            like_value = f"%{freq_raw}%"
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

    where_sql = " AND ".join(where)

    with get_conn() as conn:
        total_row = conn.execute(
            f"""
            SELECT COUNT(*) AS total
            FROM messages m
            LEFT JOIN networks n ON n.id = m.network_id
            WHERE {where_sql}
            """,
            params,
        ).fetchone()

        by_day_rows = conn.execute(
            f"""
            SELECT substr(m.created_at, 1, 10) AS day, COUNT(*) AS cnt
            FROM messages m
            LEFT JOIN networks n ON n.id = m.network_id
            WHERE {where_sql}
            GROUP BY substr(m.created_at, 1, 10)
            ORDER BY day ASC
            """,
            params,
        ).fetchall()

        by_network_rows = conn.execute(
            f"""
            SELECT
                m.network_id,
                COALESCE(n.frequency, '') AS frequency,
                COALESCE(n.mask, '') AS mask,
                COALESCE(n.unit, '') AS unit,
                COUNT(*) AS cnt
            FROM messages m
            LEFT JOIN networks n ON n.id = m.network_id
            WHERE {where_sql}
            GROUP BY m.network_id, n.frequency, n.mask, n.unit
            ORDER BY cnt DESC, n.frequency ASC
            """,
            params,
        ).fetchall()

    return {
        "ok": True,
        "filters": {
            "start_dt": start_norm,
            "end_dt": end_norm,
            "frequency": freq_raw,
        },
        "total": int((total_row["total"] if total_row else 0) or 0),
        "by_day": [
            {"day": str(r["day"] or ""), "count": int(r["cnt"] or 0)}
            for r in by_day_rows
        ],
        "by_network": [
            {
                "network_id": int(r["network_id"]) if r["network_id"] is not None else None,
                "frequency": str(r["frequency"] or ""),
                "mask": str(r["mask"] or ""),
                "unit": str(r["unit"] or ""),
                "count": int(r["cnt"] or 0),
            }
            for r in by_network_rows
        ],
    }


@router.get("/api/home/movement-count")
def api_movement_count(period: str = "day", words: str = "мот,квадр,короб,вел"):
    """Count intercept messages on 144.8250 matching movement keywords.

    Args:
        period: "day"   → today    08:00–16:00
                "night" → yesterday 08:00 – today 08:00
        words:  comma-separated stems to search in lower(body_text).
    """
    now = datetime.now()
    today = now.date()

    if period == "night":
        start_dt = datetime.combine(today - timedelta(days=1), datetime.min.time().replace(hour=8))
        end_dt   = datetime.combine(today, datetime.min.time().replace(hour=8))
    else:  # day
        start_dt = datetime.combine(today, datetime.min.time().replace(hour=8))
        end_dt   = datetime.combine(today, datetime.min.time().replace(hour=16))

    stem_list = [w.strip().lower() for w in (words or "").split(",") if w.strip()]
    if not stem_list:
        return {"ok": True, "count": 0, "period_start": start_dt.isoformat(), "period_end": end_dt.isoformat()}

    with get_conn() as conn:
        # Resolve network id for frequency 144.8250
        net_row = conn.execute(
            "SELECT id FROM networks WHERE frequency = '144.8250' LIMIT 1"
        ).fetchone()
        if not net_row:
            return {"ok": False, "error": "Мережу 144.8250 не знайдено"}

        network_id = int(net_row["id"])

        # Build LIKE conditions on lowercased body_text
        like_clauses = " OR ".join(["lower(m.body_text) LIKE ?" for _ in stem_list])
        like_params  = [f"%{s}%" for s in stem_list]

        row = conn.execute(
            f"""
            SELECT COUNT(*) AS cnt
            FROM messages m
            WHERE m.network_id = ?
              AND m.is_valid = 1
              AND REPLACE(m.created_at, 'T', ' ') >= ?
              AND REPLACE(m.created_at, 'T', ' ') < ?
              AND ({like_clauses})
            """,
            (network_id, start_dt.strftime("%Y-%m-%d %H:%M:%S"), end_dt.strftime("%Y-%m-%d %H:%M:%S"), *like_params),
        ).fetchone()

    return {
        "ok": True,
        "count": int(row["cnt"] or 0),
        "period_start": start_dt.strftime("%d.%m %H:%M"),
        "period_end":   end_dt.strftime("%d.%m %H:%M"),
    }

