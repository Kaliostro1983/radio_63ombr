"""UI and API router for managing radio networks.

This router serves:

- HTML pages for viewing/searching/editing networks (`/networks`);
- small JSON API helpers used by frontend code for lookups.

The router is primarily a presentation layer: it loads reference data
(statuses/chats/groups/tags), renders templates, and executes simple SQL
updates. Complex domain rules such as network resolution during ingest are
handled in service modules (see `app.services.network_service`).
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, date, timedelta
from typing import List, Optional

from app.services.network_search import search_network_rows

from fastapi import APIRouter, Depends, Request, Form
from fastapi.responses import RedirectResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

from app.core.db import get_conn
from app.core.normalize import normalize_freq, normalize_freq_or_mask
from app.core.auth_context import get_actor

router = APIRouter()


class NetworkAliasCreateIn(BaseModel):
    network_id: int
    alias_text: str


class NetworkAliasUpdateIn(BaseModel):
    alias_text: str
    network_id: Optional[int] = None


class NetworkVerifyIn(BaseModel):
    items: list[str]


def _clean_alias_text(raw: str) -> str:
    """Trim trailing whitespace from user-entered alias (preserve leading for rare cases)."""
    return (raw or "").rstrip()


def _status_has_colors(conn) -> bool:
    """Return True if `statuses` table supports bg/border color columns."""
    cols = conn.execute("PRAGMA table_info(statuses)").fetchall()
    col_names = [c[1] for c in cols]
    return "bg_color" in col_names and "border_color" in col_names


def _all_networks_list(conn, status_ids, chat_ids, group_ids):
    """List networks for the "Усі р/м" tab with optional filters."""
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
        {select_colors},
        e.updated_at AS etalon_updated_at
    FROM networks n
    JOIN chats c    ON c.id = n.chat_id
    JOIN groups g   ON g.id = n.group_id
    JOIN statuses s ON s.id = n.status_id
    LEFT JOIN etalons e ON e.network_id = n.id
    """

    clauses = []
    params = []

    def add_in(field, values):
        if not values:
            return
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


def _default_all_status_ids(conn) -> list[int]:
    rows = conn.execute(
        """
        SELECT id
        FROM statuses
        WHERE name = 'Спостерігається'
        """
    ).fetchall()
    return [int(r[0]) for r in rows] if rows else [0]


@router.get("/api/networks/{network_id}/callsign-graph")
def api_network_callsign_graph(network_id: int, days: int = 14):
    """Return callsign graph (nodes+edges) for a network within last N days."""
    try:
        nid = int(network_id)
    except Exception:
        return {"ok": False, "error": "invalid network_id"}

    try:
        days_n = int(days)
        if days_n < 1:
            days_n = 1
        if days_n > 365:
            days_n = 365
    except Exception:
        days_n = 14

    start_dt = (datetime.now() - timedelta(days=days_n)).isoformat(timespec="seconds")

    with get_conn() as conn:
        # Nodes: callsigns seen in the period.
        node_rows = conn.execute(
            """
            SELECT
              c.id,
              c.name,
              COALESCE(c.callsign_status_id, c.status_id) AS status_id
            FROM callsigns c
            WHERE c.network_id = ?
              AND COALESCE(c.last_seen_dt, '') >= ?
              AND c.name <> 'НВ'
            ORDER BY c.name
            """,
            (nid, start_dt),
        ).fetchall()

        node_ids = [int(r["id"]) for r in node_rows]
        if not node_ids:
            return {"ok": True, "nodes": [], "edges": [], "meta": {"days": days_n}}

        placeholders = ",".join(["?"] * len(node_ids))

        edge_rows = conn.execute(
            f"""
            SELECT
              a_callsign_id AS a_id,
              b_callsign_id AS b_id,
              cnt,
              last_seen_dt
            FROM callsign_edges
            WHERE network_id = ?
              AND last_seen_dt >= ?
              AND a_callsign_id IN ({placeholders})
              AND b_callsign_id IN ({placeholders})
            ORDER BY cnt DESC, last_seen_dt DESC
            """,
            (nid, start_dt, *node_ids, *node_ids),
        ).fetchall()

    nodes = []
    for r in node_rows:
        sid = r["status_id"]
        sid_num = int(sid) if sid is not None and str(sid).strip() != "" else None
        icon = f"/static/icons/callsign_statuses/{sid_num}.svg" if sid_num else "/static/icons/callsign_statuses/_default.svg"
        nodes.append(
            {
                "id": int(r["id"]),
                "name": r["name"] or "",
                "status_id": sid_num,
                "icon": icon,
            }
        )

    edges = []
    for r in edge_rows:
        edges.append(
            {
                "source": int(r["a_id"]),
                "target": int(r["b_id"]),
                "cnt": int(r["cnt"] or 0),
            }
        )

    return {"ok": True, "nodes": nodes, "edges": edges, "meta": {"days": days_n, "start_dt": start_dt}}


@router.get("/api/networks/{network_id}/peleng")
def api_network_peleng(network_id: int, days: int = 7):
    """Return peleng batches/points for a given network.

    Current DB schema stores `network_id` in `peleng_batches`, so we load
    batches directly by `network_id` and join frequency from `networks`.
    """

    try:
        nid = int(network_id)
    except Exception:
        return {"ok": False, "error": "invalid network_id"}

    try:
        days_n = int(days)
        if days_n < 1:
            days_n = 1
        if days_n > 365:
            days_n = 365
    except Exception:
        days_n = 7

    now = datetime.now().replace(microsecond=0)
    to_dt = now.isoformat(timespec="seconds").replace("T", " ")
    from_dt = (now - timedelta(days=days_n)).isoformat(timespec="seconds").replace("T", " ")

    with get_conn() as conn:
        net_row = conn.execute(
            "SELECT id, frequency, mask FROM networks WHERE id=? LIMIT 1",
            (nid,),
        ).fetchone()

        if not net_row:
            return {"ok": False, "error": "network not found"}

        batch_rows = conn.execute(
            """
            SELECT pb.id, pb.event_dt, n.frequency
            FROM peleng_batches pb
            JOIN networks n ON n.id = pb.network_id
            WHERE pb.network_id = ?
              AND pb.event_dt >= ?
              AND pb.event_dt <= ?
            ORDER BY pb.event_dt DESC, pb.id DESC
            LIMIT 80
            """,
            (nid, from_dt, to_dt),
        ).fetchall()

        batch_ids = [int(r["id"]) for r in batch_rows]
        points_rows = []
        if batch_ids:
            placeholders = ",".join(["?"] * len(batch_ids))
            points_rows = conn.execute(
                f"""
                SELECT batch_id, mgrs
                FROM peleng_points
                WHERE batch_id IN ({placeholders})
                ORDER BY batch_id ASC, id ASC
                """,
                tuple(batch_ids),
            ).fetchall()

    points_by_batch: dict[int, list[str]] = {}
    for r in points_rows:
        bid = int(r["batch_id"])
        mgrs = str(r["mgrs"] or "").strip()
        if not mgrs:
            continue
        points_by_batch.setdefault(bid, []).append(mgrs)

    batches_out = []
    points_total = 0
    for br in batch_rows:
        bid = int(br["id"])
        pts = points_by_batch.get(bid, [])
        points_total += len(pts)
        batches_out.append(
            {
                "id": bid,
                "event_dt": str(br["event_dt"] or ""),
                "frequency": str(br["frequency"] or ""),
                "points_count": len(pts),
                "points": pts[:200],  # cap to avoid huge payload
            }
        )

    # Keep payload size bounded: if many points exist in a batch, tell UI.
    for b in batches_out:
        full_cnt = len(points_by_batch.get(b["id"], []))
        b["points_truncated"] = full_cnt > b["points_count"] or b["points_count"] > len(b["points"])

    return {
        "ok": True,
        "batches": batches_out,
        "meta": {"days": days_n, "from_dt": from_dt, "to_dt": to_dt, "points_total": points_total},
    }


@router.get("/api/networks/lookup")
def api_networks_lookup(q: str):
    """Lookup networks matching a query for autocomplete/select widgets.

    Args:
        q: query string (frequency/mask/free text).

    Returns:
        dict: `{"ok": True, "rows": [...]}` where rows contain minimal
        network metadata.
    """

    query = (q or "").strip()
    if not query:
        return {"ok": True, "rows": []}

    with get_conn() as conn:
        rows = search_network_rows(conn, query, limit=60)

    out = []
    for r in rows:
        out.append({
            "id": int(r["id"]),
            "frequency": r["frequency"] or "",
            "mask": r["mask"] or "",
            "unit": r["unit"] or "",
        })

    return {"ok": True, "rows": out}


@router.get("/api/networks/by-id")
def api_network_by_id(id: int):
    """Fetch a single network by id for UI components.

    Args:
        id: network id.

    Returns:
        dict: `{"ok": True, "row": {...}}` or `{"ok": True, "row": None}`.
    """
    try:
        network_id = int(id)
    except Exception:
        return {"ok": False, "error": "invalid id"}

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, frequency, mask, unit FROM networks WHERE id=? LIMIT 1",
            (network_id,),
        ).fetchone()

        if not row:
            return {"ok": True, "row": None}

        return {
            "ok": True,
            "row": {
                "id": int(row["id"]),
                "frequency": row["frequency"] or "",
                "mask": row["mask"] or "",
                "unit": row["unit"] or "",
            },
        }


@router.get("/api/network-aliases")
def api_network_aliases_list(actor=Depends(get_actor)):
    """List active (non-archived) network aliases with linked network frequency."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT na.id, na.network_id, na.alias_text, n.frequency
            FROM network_aliases na
            JOIN networks n ON n.id = na.network_id
            WHERE COALESCE(na.is_archived, 0) = 0
            ORDER BY n.frequency COLLATE NOCASE, na.alias_text COLLATE NOCASE
            """
        ).fetchall()

    out = []
    for r in rows:
        out.append(
            {
                "id": int(r["id"]),
                "network_id": int(r["network_id"]),
                "alias_text": r["alias_text"] or "",
                "frequency": r["frequency"] or "",
            }
        )
    return {"ok": True, "rows": out}


@router.post("/api/network-aliases")
def api_network_aliases_create(body: NetworkAliasCreateIn, actor=Depends(get_actor)):
    """Create a new network alias row."""
    alias_text = _clean_alias_text(body.alias_text)
    if not alias_text.strip():
        return JSONResponse(
            {"ok": False, "error": "Аліас не може бути порожнім."},
            status_code=400,
        )

    try:
        nid = int(body.network_id)
    except Exception:
        return JSONResponse(
            {"ok": False, "error": "Некоректна радіомережа."},
            status_code=400,
        )

    new_id: Optional[int] = None
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM networks WHERE id=? LIMIT 1", (nid,)).fetchone()
        if not row:
            return JSONResponse(
                {"ok": False, "error": "Радіомережу не знайдено."},
                status_code=404,
            )
        try:
            cur = conn.execute(
                "INSERT INTO network_aliases (network_id, alias_text, is_archived) VALUES (?,?,0)",
                (nid, alias_text),
            )
            new_id = int(cur.lastrowid)
        except sqlite3.IntegrityError:
            return JSONResponse(
                {
                    "ok": False,
                    "error": "Такий аліас уже існує або дублюється для цієї мережі.",
                },
                status_code=400,
            )

    return {"ok": True, "id": new_id}


@router.patch("/api/network-aliases/{alias_id}")
def api_network_aliases_update(
    alias_id: int,
    body: NetworkAliasUpdateIn,
    actor=Depends(get_actor),
):
    """Update alias text for an active alias row."""
    alias_text = _clean_alias_text(body.alias_text)
    if not alias_text.strip():
        return JSONResponse(
            {"ok": False, "error": "Аліас не може бути порожнім."},
            status_code=400,
        )

    try:
        aid = int(alias_id)
    except Exception:
        return JSONResponse(
            {"ok": False, "error": "Некоректний ідентифікатор."},
            status_code=400,
        )

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM network_aliases WHERE id=? AND COALESCE(is_archived,0)=0",
            (aid,),
        ).fetchone()
        if not row:
            return JSONResponse(
                {"ok": False, "error": "Запис не знайдено."},
                status_code=404,
            )
        target_network_id = body.network_id
        if target_network_id is not None:
            net_row = conn.execute(
                "SELECT id FROM networks WHERE id=? LIMIT 1",
                (int(target_network_id),),
            ).fetchone()
            if not net_row:
                return JSONResponse(
                    {"ok": False, "error": "Радіомережу не знайдено."},
                    status_code=404,
                )
        try:
            if target_network_id is None:
                conn.execute(
                    "UPDATE network_aliases SET alias_text=? WHERE id=?",
                    (alias_text, aid),
                )
            else:
                conn.execute(
                    "UPDATE network_aliases SET alias_text=?, network_id=? WHERE id=?",
                    (alias_text, int(target_network_id), aid),
                )
        except sqlite3.IntegrityError:
            return JSONResponse(
                {"ok": False, "error": "Такий аліас уже існує."},
                status_code=400,
            )

    return {"ok": True}


def _norm_mask_key(m: str) -> str:
    """Pad the decimal part of a mask to exactly 4 digits.

    Ensures that ``200.224`` and ``200.2240`` compare as equal — both
    represent the same radio-network mask prefix, just written differently.
    """
    if "." in m:
        left, right = m.split(".", 1)
        right = (right + "0000")[:4]
        return f"{left}.{right}"
    return m


def _normalize_verify_key(raw: str) -> str:
    """Return a canonical key for a user-entered frequency/mask string.

    Masks (100/200/300 prefix) are normalized and padded to 4 decimal places.
    Regular frequencies are normalized to DDD.DDDD form.
    Falls back to the trimmed raw value if normalization returns nothing.
    """
    freq, mask = normalize_freq_or_mask(raw.strip())
    if mask:
        return _norm_mask_key(mask.rstrip("%"))
    if freq:
        return freq
    return raw.strip()


@router.post("/api/networks/verify")
def api_networks_verify(body: NetworkVerifyIn):
    """Compare a user-supplied list of frequencies/masks against
    networks that have chat='Очерет' AND status='Спостерігається'.

    Returns two lists:
    - ``not_in_input``: DB networks not covered by the supplied list.
    - ``not_in_db``:    Input items that have no matching DB network.
    """
    raw_items = [l.strip() for l in (body.items or []) if l.strip()]

    with get_conn() as conn:
        db_rows = conn.execute(
            """
            SELECT n.id, n.frequency,
                   COALESCE(n.mask, '')  AS mask,
                   COALESCE(n.unit, '')  AS unit,
                   COALESCE(n.zone, '')  AS zone
            FROM networks n
            JOIN chats    c ON c.id = n.chat_id
            JOIN statuses s ON s.id = n.status_id
            WHERE c.name = 'Очерет' AND s.name = 'Спостерігається'
            ORDER BY n.frequency
            """
        ).fetchall()

    # Build lookup: canonical_key -> network dict index.
    # A network registers under its frequency AND (if set) its mask.
    db_networks: list[dict] = []
    db_key_to_idx: dict[str, int] = {}

    for row in db_rows:
        net = {
            "id":        int(row["id"]),
            "frequency": row["frequency"] or "",
            "mask":      row["mask"] or "",
            "unit":      row["unit"] or "",
            "zone":      row["zone"] or "",
        }
        idx = len(db_networks)
        db_networks.append(net)
        if net["frequency"] and net["frequency"] not in db_key_to_idx:
            db_key_to_idx[net["frequency"]] = idx
        if net["mask"]:
            # Normalize DB mask to 4-decimal key so it matches input like
            # "200.224" (→ "200.2240") against stored "200.2240" correctly.
            norm_mk = _norm_mask_key(net["mask"])
            if norm_mk not in db_key_to_idx:
                db_key_to_idx[norm_mk] = idx

    # Normalize each input line to a comparable key.
    input_pairs: list[tuple[str, str]] = [
        (raw, _normalize_verify_key(raw)) for raw in raw_items
    ]

    # DB networks matched by at least one input item.
    matched_db_ids: set[int] = set()
    for _, norm in input_pairs:
        if norm in db_key_to_idx:
            matched_db_ids.add(db_networks[db_key_to_idx[norm]]["id"])

    not_in_input = [n for n in db_networks if n["id"] not in matched_db_ids]
    not_in_db    = [raw for raw, norm in input_pairs if norm not in db_key_to_idx]

    return {
        "ok":           True,
        "db_count":     len(db_networks),
        "not_in_input": not_in_input,
        "not_in_db":    not_in_db,
    }


def _fetchall(conn, sql: str, params=()):
    """Fetch all rows for a query (small helper for this router)."""
    cur = conn.execute(sql, params)
    return cur.fetchall()


def _fetchone(conn, sql: str, params=()):
    """Fetch a single row for a query (small helper for this router)."""
    cur = conn.execute(sql, params)
    return cur.fetchone()


def _lookup(conn):
    """Load reference data used by the networks UI."""
    statuses = _fetchall(conn, "SELECT id, name FROM statuses ORDER BY name")
    chats = _fetchall(conn, "SELECT id, name FROM chats ORDER BY name")
    groups = _fetchall(conn, "SELECT id, name FROM groups ORDER BY name")
    tags = _fetchall(conn, "SELECT id, name FROM network_tags ORDER BY name")

    status_map = {r["id"]: r["name"] for r in statuses}
    chat_map = {r["id"]: r["name"] for r in chats}
    group_map = {r["id"]: r["name"] for r in groups}
    tag_map = {r["id"]: r["name"] for r in tags}

    return statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map


def _get_tag_ids(conn, network_id: int) -> List[int]:
    """Return tag ids currently assigned to a network."""
    rows = _fetchall(conn, "SELECT tag_id FROM network_tag_links WHERE network_id=?", (network_id,))
    return [int(r["tag_id"]) for r in rows]


def _ensure_etalon(conn, network_id: int):
    """Ensure an `etalons` row exists for the given network."""
    row = _fetchone(conn, "SELECT id FROM etalons WHERE network_id=?", (network_id,))
    if row:
        return
    now = datetime.utcnow().isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO etalons(network_id, start_date, end_date, updated_at) VALUES (?,?,?,?)",
        (network_id, None, None, now),
    )
    

def _etalon_row_has_content(conn, network_id: int) -> bool:
    """True if the etalon row has any saved text or dates."""
    row = _fetchone(
        conn,
        """
        SELECT correspondents, start_date, end_date
        FROM etalons
        WHERE network_id = ?
        """,
        (int(network_id),),
    )
    if not row:
        return False

    def nz(col: str) -> bool:
        try:
            v = row[col]
        except Exception:
            return False
        return bool(v is not None and str(v).strip())

    if nz("correspondents"):
        return True
    try:
        if row["start_date"] or row["end_date"]:
            return True
    except Exception:
        pass
    return False


def _get_etalon_dates(conn, network_id: int) -> tuple[Optional[date], Optional[date]]:
    """Return (start_date, end_date) for a network, if set and parseable."""
    row = _fetchone(conn, "SELECT start_date, end_date FROM etalons WHERE network_id=?", (network_id,))
    if not row:
        return None, None

    def parse_d(v) -> Optional[date]:
        if not v:
            return None
        try:
            return date.fromisoformat(str(v))
        except Exception:
            return None

    return parse_d(row["start_date"]), parse_d(row["end_date"])
    

def _load_network_card(conn, network_id: int):
    """Load a network card: current network row + selected tags + etalon date."""
    current = _fetchone(conn, "SELECT * FROM networks WHERE id=?", (int(network_id),))
    if not current:
        return None, [], None

    selected_tags = _get_tag_ids(conn, int(current["id"]))
    _ensure_etalon(conn, int(current["id"]))
    start_date_val, end_date_val = _get_etalon_dates(conn, int(current["id"]))
    return current, selected_tags, (start_date_val, end_date_val)


def _build_networks_context(
    request: Request,
    actor,
    statuses,
    chats,
    groups,
    tags,
    status_map,
    chat_map,
    group_map,
    tag_map,
    *,
    q_query: str = "",
    current=None,
    matches=None,
    match_tags=None,
    selected_tags=None,
    start_date_val: Optional[date] = None,
    end_date_val: Optional[date] = None,
    message: str = "",
    all_rows=None,
    all_selected_statuses=None,
    all_selected_chats=None,
    all_selected_groups=None,
    active_tab: str = "card",
    etalon_exists: bool = False,
):
    """Build Jinja template context for the networks page."""
    return dict(
        request=request,
        actor=actor,
        q_query=q_query,
        q_freq=current["frequency"] if current else "",
        q_mask=current["mask"] if current else "",
        matches=matches or [],
        match_tags=match_tags or {},
        current=current,
        statuses=statuses,
        chats=chats,
        groups=groups,
        tags=tags,
        status_map=status_map,
        chat_map=chat_map,
        group_map=group_map,
        tag_map=tag_map,
        selected_tags=selected_tags or [],
        start_date=start_date_val,
        end_date=end_date_val,
        message=message,
        all_rows=all_rows or [],
        all_selected_statuses=all_selected_statuses or [],
        all_selected_chats=all_selected_chats or [],
        all_selected_groups=all_selected_groups or [],
        active_tab=active_tab or "card",
        etalon_exists=bool(etalon_exists),
    )


def _get_tag_ids_for_networks(conn, network_ids: List[int]) -> dict[int, List[int]]:
    """Return mapping: network_id -> list[tag_id]."""
    net_ids = [int(x) for x in (network_ids or []) if x is not None]
    if not net_ids:
        return {}

    placeholders = ",".join(["?"] * len(net_ids))
    rows = conn.execute(
        f"""
        SELECT network_id, tag_id
        FROM network_tag_links
        WHERE network_id IN ({placeholders})
        """,
        tuple(net_ids),
    ).fetchall()

    out: dict[int, List[int]] = {}
    for r in rows:
        nid = int(r["network_id"])
        tid = int(r["tag_id"])
        out.setdefault(nid, []).append(tid)
    return out


@router.get("/networks", response_class=HTMLResponse)
def networks_page(
    request: Request,
    id: Optional[int] = None,
    pick: Optional[int] = None,
    actor=Depends(get_actor),
):
    """Render networks page (initial view or when selecting a network)."""
    network_id = pick or id

    with get_conn() as conn:
        statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map = _lookup(conn)
        all_selected_statuses = _default_all_status_ids(conn)
        all_selected_chats = [c["id"] for c in chats]
        all_selected_groups = [g["id"] for g in groups]
        all_rows = _all_networks_list(conn, all_selected_statuses, all_selected_chats, all_selected_groups)

        current = None
        selected_tags: List[int] = []
        start_date_val: Optional[date] = None
        end_date_val: Optional[date] = None
        q_query = ""
        message = request.query_params.get("msg", "")
        draft = request.session.pop("network_save_draft", None)

        etalon_exists = False
        if network_id:
            current, selected_tags, dates = _load_network_card(conn, int(network_id))
            if dates:
                start_date_val, end_date_val = dates
            if current:
                q_query = current["frequency"] or current["mask"] or ""
                etalon_exists = _etalon_row_has_content(conn, int(current["id"]))
        elif draft:
            q_query = draft.get("frequency", "") or draft.get("mask", "")
            start_date_raw = draft.get("start_date_str", "")
            if start_date_raw:
                try:
                    start_date_val = date.fromisoformat(start_date_raw)
                except Exception:
                    start_date_val = None
            end_date_raw = draft.get("end_date_str", "")
            if end_date_raw:
                try:
                    end_date_val = date.fromisoformat(end_date_raw)
                except Exception:
                    end_date_val = None
            selected_tags = draft.get("tag_ids") or []

    tab_raw = (request.query_params.get("tab") or "card").lower()
    if tab_raw not in ("card", "all", "etalons", "akademik"):
        tab_raw = "card"

    context = _build_networks_context(
        request,
        actor,
        statuses,
        chats,
        groups,
        tags,
        status_map,
        chat_map,
        group_map,
        tag_map,
        q_query=q_query,
        current=current,
        matches=[],
        selected_tags=selected_tags,
        start_date_val=start_date_val,
        end_date_val=end_date_val,
        message=message,
        all_rows=all_rows,
        all_selected_statuses=all_selected_statuses,
        all_selected_chats=all_selected_chats,
        all_selected_groups=all_selected_groups,
        active_tab=tab_raw,
        etalon_exists=etalon_exists,
    )
    if draft and not current:
        context["draft"] = draft
    return request.app.state.templates.TemplateResponse("networks.html", context)


@router.post("/networks/search", response_class=HTMLResponse)
def networks_search(
    request: Request,
    query: str = Form(""),
    actor=Depends(get_actor),
):
    """Search networks and render results in the networks page template."""
    q_query = (query or "").strip()

    with get_conn() as conn:
        statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map = _lookup(conn)
        all_selected_statuses = _default_all_status_ids(conn)
        all_selected_chats = [0]
        all_selected_groups = [0]
        all_rows = _all_networks_list(conn, all_selected_statuses, all_selected_chats, all_selected_groups)

        current = None
        matches = []
        selected_tags: List[int] = []
        start_date_val: Optional[date] = None
        end_date_val: Optional[date] = None
        message = ""
        etalon_exists = False

        if not q_query:
            message = "Введи маску або частоту."
        else:
            matches = search_network_rows(conn, q_query, limit=100)

            if len(matches) == 1:
                current, selected_tags, dates = _load_network_card(conn, int(matches[0]["id"]))
                if dates:
                    start_date_val, end_date_val = dates
                if current:
                    etalon_exists = _etalon_row_has_content(conn, int(current["id"]))
            elif len(matches) == 0:
                message = "Не знайдено. Заповни картку і тисни “Зберегти”."

        match_ids: List[int] = []
        for r in matches or []:
            try:
                if r and r["id"] is not None:
                    match_ids.append(int(r["id"]))
            except Exception:
                continue
        match_tags = _get_tag_ids_for_networks(conn, match_ids) if match_ids else {}

        context = _build_networks_context(
            request,
            actor,
            statuses,
            chats,
            groups,
            tags,
            status_map,
            chat_map,
            group_map,
            tag_map,
            q_query=q_query,
            current=current,
            matches=matches,
            match_tags=match_tags,
            selected_tags=selected_tags,
            start_date_val=start_date_val,
            end_date_val=end_date_val,
            message=message,
            all_rows=all_rows,
            all_selected_statuses=all_selected_statuses,
            all_selected_chats=all_selected_chats,
            all_selected_groups=all_selected_groups,
            active_tab="card",
            etalon_exists=etalon_exists,
        )
        return request.app.state.templates.TemplateResponse("networks.html", context)


@router.post("/networks/all", response_class=HTMLResponse)
def networks_all_tab(
    request: Request,
    status_ids: list[int] = Form(default=[]),
    chat_ids: list[int] = Form(default=[]),
    group_ids: list[int] = Form(default=[]),
    actor=Depends(get_actor),
):
    """Apply filters for the "Усі р/м" tab within `/networks` page."""
    with get_conn() as conn:
        statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map = _lookup(conn)
        rows = _all_networks_list(conn, status_ids, chat_ids, group_ids)

    context = _build_networks_context(
        request,
        actor,
        statuses,
        chats,
        groups,
        tags,
        status_map,
        chat_map,
        group_map,
        tag_map,
        q_query="",
        current=None,
        matches=[],
        match_tags={},
        selected_tags=[],
        start_date_val=None,
        end_date_val=None,
        message="",
        all_rows=rows,
        all_selected_statuses=status_ids,
        all_selected_chats=chat_ids,
        all_selected_groups=group_ids,
        active_tab="all",
    )
    return request.app.state.templates.TemplateResponse("networks.html", context)


def _set_tags(conn, network_id: int, tag_ids: List[int]):
    """Replace network tags with the provided tag id list."""
    conn.execute("DELETE FROM network_tag_links WHERE network_id=?", (network_id,))
    for tid in sorted(set(int(x) for x in tag_ids or [])):
        conn.execute(
            "INSERT OR IGNORE INTO network_tag_links(network_id, tag_id) VALUES (?,?)",
            (network_id, tid),
        )
        
        
def _set_etalon_dates(conn, network_id: int, start_date_str: str, end_date_str: str):
    """Update etalon start/end date fields for a network."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    conn.execute(
        "UPDATE etalons SET start_date=?, end_date=?, updated_at=? WHERE network_id=?",
        (start_date_str or None, end_date_str or None, now, network_id),
    )


def _store_network_draft(request: Request, **fields):
    """Store last network form values in session for restore after validation errors."""
    request.session["network_save_draft"] = fields


def _draft_payload(
    frequency: str,
    mask: str,
    unit: str,
    zone: str,
    chat_id: int,
    group_id: int,
    status_id: int,
    comment: str,
    tag_ids: List[int],
    start_date_str: str,
    end_date_str: str,
):
    return {
        "frequency": frequency,
        "mask": mask,
        "unit": unit,
        "zone": zone,
        "chat_id": str(chat_id),
        "group_id": str(group_id),
        "status_id": str(status_id),
        "comment": comment,
        "tag_ids": [int(x) for x in tag_ids or []],
        "start_date_str": start_date_str,
        "end_date_str": end_date_str,
    }


def _missing_fields_message(
    *,
    frequency_ok: bool,
    unit: str,
    zone: str,
    chat_id: int,
    group_id: int,
    status_id: int,
) -> tuple[str, list[str]]:
    missing_labels: list[str] = []
    missing_keys: list[str] = []
    if not frequency_ok:
        missing_labels.append("частоту")
        missing_keys.append("frequency")
    if not (unit or "").strip():
        missing_labels.append("підрозділ")
        missing_keys.append("unit")
    if not (zone or "").strip():
        missing_labels.append("зону функціонування")
        missing_keys.append("zone")
    if not chat_id:
        missing_labels.append("чат (джерело)")
        missing_keys.append("chat_id")
    if not group_id:
        missing_labels.append("групу")
        missing_keys.append("group_id")
    if not status_id:
        missing_labels.append("статус")
        missing_keys.append("status_id")

    if not missing_labels:
        return "", []
    if len(missing_labels) == 1:
        return f"Потрібно вказати {missing_labels[0]}.", missing_keys
    if len(missing_labels) == 2:
        return f"Потрібно вказати {missing_labels[0]} та {missing_labels[1]}.", missing_keys
    return "Потрібно вказати: " + ", ".join(missing_labels[:-1]) + f" та {missing_labels[-1]}.", missing_keys
    
    
@router.post("/networks/save")
def networks_save(
    request: Request,
    frequency: str = Form(...),
    mask: str = Form(""),
    unit: str = Form(""),
    zone: str = Form(""),
    chat_id: int = Form(...),
    group_id: int = Form(...),
    status_id: int = Form(...),
    comment: str = Form(""),
    tag_ids: List[int] = Form(default=[]),
    start_date_str: str = Form(""),
    end_date_str: str = Form(""),
    actor=Depends(get_actor),
):
    """Insert or update a network record from the networks page form."""
    freq_norm = normalize_freq(frequency)

    # Normalize mask using the same rules as ingest/network_service so that
    # values entered on the networks page match tokens parsed from intercepts.
    raw_mask = (mask or "").strip()
    if raw_mask:
        mask_freq, mask_mask = normalize_freq_or_mask(raw_mask)
        # Prefer "mask-like" normalization; fall back to normalized frequency.
        if mask_mask:
            # Store mask in DB without trailing '%' so that users
            # don't see SQL wildcard characters in the UI. The '%'
            # is only needed in query patterns, not in persisted values.
            mask_val = mask_mask[:-1] if mask_mask.endswith("%") else mask_mask
        else:
            mask_val = mask_freq
    else:
        mask_val = None
    unit_val = (unit or "").strip() or None
    zone_val = (zone or "").strip() or None
    comment_val = (comment or "").strip() or None

    message, missing_keys = _missing_fields_message(
        frequency_ok=bool(freq_norm),
        unit=unit_val or "",
        zone=zone_val or "",
        chat_id=chat_id,
        group_id=group_id,
        status_id=status_id,
    )
    if message:
        _store_network_draft(
            request,
            **{
                **_draft_payload(
                frequency=frequency,
                mask=mask,
                unit=unit,
                zone=zone,
                chat_id=chat_id,
                group_id=group_id,
                status_id=status_id,
                comment=comment,
                tag_ids=tag_ids,
                start_date_str=start_date_str,
                end_date_str=end_date_str,
                ),
                "missing_fields": missing_keys,
            },
        )
        return RedirectResponse(url=f"/networks?msg={message}", status_code=303)

    now = datetime.utcnow().isoformat(timespec="seconds")

    with get_conn() as conn:
        existing = _fetchone(conn, "SELECT id FROM networks WHERE frequency=?", (freq_norm,))

        if not existing:
            cur = conn.execute(
                """
                INSERT INTO networks (frequency, mask, unit, zone, chat_id, group_id, status_id, comment, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (freq_norm, mask_val, unit_val, zone_val, int(chat_id), int(group_id), int(status_id), comment_val, now),
            )
            network_id = int(cur.lastrowid)
        else:
            network_id = int(existing["id"])
            conn.execute(
                """
                UPDATE networks
                SET mask=?, unit=?, zone=?, chat_id=?, group_id=?, status_id=?, comment=?, updated_at=?
                WHERE id=?
                """,
                (mask_val, unit_val, zone_val, int(chat_id), int(group_id), int(status_id), comment_val, now, network_id),
            )

        _set_tags(conn, network_id, tag_ids)

        _ensure_etalon(conn, network_id)
        if start_date_str or end_date_str:
            _set_etalon_dates(conn, network_id, start_date_str, end_date_str)

        # When a network is marked "Мертва" it will no longer receive new
        # intercepts, so the callsign correction map becomes irrelevant.
        # Clean it up to avoid stale data.
        dead_status = conn.execute(
            "SELECT id FROM statuses WHERE name = 'Мертва' LIMIT 1"
        ).fetchone()
        if dead_status and int(status_id) == int(dead_status["id"]):
            conn.execute(
                "DELETE FROM callsign_corrections WHERE network_id = ?",
                (network_id,),
            )

        conn.commit()

    request.session.pop("network_save_draft", None)
    return RedirectResponse(url=f"/networks?pick={network_id}", status_code=303)