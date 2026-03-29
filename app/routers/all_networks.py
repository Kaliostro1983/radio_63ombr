"""UI router for viewing all networks with filters.

This router renders the `/all_networks` page, which provides a filtered
listing of all radio networks. It supports filtering by:

- status
- chat
- group

The router reads from SQLite using `get_conn` and renders a Jinja template.
It is a presentation-focused module (no ingest/network-resolution logic).
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Form
from fastapi.responses import HTMLResponse

from app.core.db import get_conn

router = APIRouter()


def _status_has_colors(conn) -> bool:
    """Return True if `statuses` table supports bg/border color columns."""
    cols = conn.execute("PRAGMA table_info(statuses)").fetchall()
    col_names = [c[1] for c in cols]
    return "bg_color" in col_names and "border_color" in col_names


def _all_filters(conn):
    """Load filter reference data for the UI (statuses, chats, groups)."""
    statuses = conn.execute(
        "SELECT id, name FROM statuses ORDER BY id"
    ).fetchall()

    chats = conn.execute(
        "SELECT id, name FROM chats ORDER BY name"
    ).fetchall()

    groups = conn.execute(
        "SELECT id, name FROM groups ORDER BY name"
    ).fetchall()

    return statuses, chats, groups


def _all_networks_list(conn, status_ids, chat_ids, group_ids):
    """List networks applying optional filter lists.

    Args:
        conn: SQLite connection.
        status_ids: list of status ids from form.
        chat_ids: list of chat ids from form.
        group_ids: list of group ids from form.

    Returns:
        list: SQLite rows for template rendering.
    """
    has_colors = _status_has_colors(conn)

    select_colors = (
        "s.bg_color, s.border_color"
        if has_colors
        else "NULL as bg_color, NULL as border_color"
    )

    base_sql = f"""
    SELECT
        n.id,
        n.frequency,
        n.mask,
        n.unit,
        n.zone,
        c.name AS chat_name,
        g.name AS group_name,
        s.name AS status_name,
        {select_colors}
    FROM networks n
    JOIN chats c    ON c.id = n.chat_id
    JOIN groups g   ON g.id = n.group_id
    JOIN statuses s ON s.id = n.status_id
    """

    clauses = []
    params = []

    def add_in(field, values):
        """Add an `IN (...)` clause to the WHERE conditions if values exist.

        Special UI rule:
            Value `0` is treated as "All" and disables the filter.
        """
        if not values:
            return
        # '0' використовується як спеціальне значення 'Усі' (фільтр не застосовувати)
        values = [int(v) for v in values if int(v) != 0]
        if not values:
            return
        placeholders = ",".join(["?"] * len(values))
        clauses.append(f"{field} IN ({placeholders})")
        params.extend(values)

    add_in("n.status_id", status_ids)
    add_in("n.chat_id", chat_ids)
    add_in("n.group_id", group_ids)

    if clauses:
        base_sql += " WHERE " + " AND ".join(clauses)

    base_sql += " ORDER BY n.frequency ASC"

    return conn.execute(base_sql, params).fetchall()


@router.get("/all_networks", response_class=HTMLResponse)
def all_networks_get(request: Request):
    """Render the page with default filters applied."""
    with get_conn() as conn:
        statuses, chats, groups = _all_filters(conn)

        default_statuses = conn.execute("""
            SELECT id FROM statuses
            WHERE name = 'Спостерігається'
        """).fetchall()

        status_ids = [r[0] for r in default_statuses]
        rows = _all_networks_list(conn, status_ids, [0], [0])

    return request.app.state.templates.TemplateResponse(
        "all_networks.html",
        {
            "request": request,
            "rows": rows,
            "statuses": statuses,
            "chats": chats,
            "groups": groups,
            "selected_statuses": status_ids if status_ids else [0],
            "selected_chats": [0],
            "selected_groups": [0],
        },
    )


@router.post("/all_networks", response_class=HTMLResponse)
def all_networks_post(
    request: Request,
    status_ids: list[int] = Form(default=[]),
    chat_ids: list[int] = Form(default=[]),
    group_ids: list[int] = Form(default=[]),
):
    """Apply filters and render the page."""
    with get_conn() as conn:
        statuses, chats, groups = _all_filters(conn)
        rows = _all_networks_list(conn, status_ids, chat_ids, group_ids)

    return request.app.state.templates.TemplateResponse(
        "all_networks.html",
        {
            "request": request,
            "rows": rows,
            "statuses": statuses,
            "chats": chats,
            "groups": groups,
            "selected_statuses": status_ids,
            "selected_chats": chat_ids,
            "selected_groups": group_ids,
        },
    )
