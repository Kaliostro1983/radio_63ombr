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
    return request.app.state.templates.TemplateResponse(
        "home.html",
        {"request": request},
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
    start_dt = start_dt_obj.isoformat(timespec="seconds")
    end_dt = end_dt_obj.isoformat(timespec="seconds")

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
                          AND m.created_at >= ?
                          AND m.created_at <= ?
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

        placeholders = ",".join(["?"] * len(network_ids))
        cnt_rows = conn.execute(
            f"""
            SELECT
                m.network_id,
                substr(m.created_at, 1, 10) AS day,
                COUNT(1) AS cnt
            FROM messages m
            WHERE m.is_valid = 1
              AND m.created_at >= ?
              AND m.created_at <= ?
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

