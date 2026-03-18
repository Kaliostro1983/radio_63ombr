"""UI router for managing etalon (reference) network descriptions.

Etalons store human-curated descriptive metadata for a radio network
(`etalons` table). This router provides:

- an HTML page for selecting a network and viewing/editing its etalon;
- search flow to pick a network by frequency/mask;
- save flow to persist etalon fields.

The router uses the session to remember the last selected network id.
"""

# app/routers/etalons.py
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Request, Form, Depends
from fastapi.responses import RedirectResponse, HTMLResponse

from app.core.db import get_conn
from app.core.auth_context import get_actor
from app.services.network_search import search_network_rows

DEFAULT_PURPOSE = "Для безперебійного управління підпорядкованими підрозділами."
DEFAULT_OPERATION_MODE = "Цілодобово, з використанням дуплексного режиму організації зв’язку."
DEFAULT_TRAFFIC_TYPE = "Службовий радіообмін"
DEFAULT_MODULATION = "NFM"

router = APIRouter()


def _fetchone(conn, sql: str, params=()):
    """Fetch one row from SQLite for a query."""
    cur = conn.execute(sql, params)
    return cur.fetchone()


def _ensure_etalon(conn, network_id: int):
    """Ensure an etalon row exists for the network and return it."""
    row = _fetchone(conn, "SELECT * FROM etalons WHERE network_id=?", (int(network_id),))
    if row:
        return row

    now = datetime.utcnow().isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO etalons(network_id, updated_at) VALUES (?,?)",
        (int(network_id), now),
    )
    return _fetchone(conn, "SELECT * FROM etalons WHERE network_id=?", (int(network_id),))


def _build_generated(net, et):
    """Build derived display-only fields for the UI (name/period/etc.)."""
    name = f"УКХ р/м {net['unit']}, {net['zone']}"
    area = net["zone"]
    period = "з невідомої дати по сьогоднішній день"

    if et and et["start_date"]:
        try:
            sd = date.fromisoformat(et["start_date"])
            period = f"з {sd.isoformat()} по сьогоднішній день"
        except Exception:
            pass

    return {
        "name": name,
        "area": area,
        "frequency": net["frequency"],
        "modulation": DEFAULT_MODULATION,
        "period": period,
    }


def _load_callsigns_for_network(conn, network_id: int) -> list[str]:
    """Load callsign names for the given network from DB (callsigns table)."""
    cur = conn.execute(
        "SELECT name FROM callsigns WHERE network_id = ? ORDER BY name",
        (int(network_id),),
    )
    return [row[0] for row in cur.fetchall() if row[0]]


def _load_page_state(conn, network_id: Optional[int]):
    """Load current network + etalon + generated fields + callsigns from DB for rendering."""
    if not network_id:
        return None, None, None, []

    net = _fetchone(conn, "SELECT * FROM networks WHERE id=?", (int(network_id),))
    if not net:
        return None, None, None, []

    et = _ensure_etalon(conn, int(net["id"]))
    gen = _build_generated(net, et)
    callsigns_from_db = _load_callsigns_for_network(conn, int(net["id"]))
    return net, et, gen, callsigns_from_db


def _build_context(
    request: Request,
    actor,
    *,
    msg: str = "",
    q_query: str = "",
    matches=None,
    net=None,
    et=None,
    gen=None,
    callsigns_from_db=None,
):
    """Build Jinja template context for the etalons page."""
    return {
        "request": request,
        "actor": actor,
        "app_name": request.app.state.app_name,
        "msg": msg,
        "q_query": q_query,
        "matches": matches or [],
        "net": net,
        "et": et,
        "gen": gen or {
            "name": "",
            "area": "",
            "frequency": "",
            "modulation": DEFAULT_MODULATION,
            "period": "",
        },
        "callsigns_from_db": callsigns_from_db or [],
        "defaults": {
            "purpose": DEFAULT_PURPOSE,
            "operation_mode": DEFAULT_OPERATION_MODE,
            "traffic_type": DEFAULT_TRAFFIC_TYPE,
        },
    }


@router.get("/etalons", response_class=HTMLResponse)
def page(
    request: Request,
    pick: Optional[int] = None,
    actor=Depends(get_actor),
):
    """Render the etalons page for the last-selected (or picked) network."""
    msg = request.query_params.get("msg", "")

    if pick:
        request.session["last_network_id"] = int(pick)

    last_id = request.session.get("last_network_id")

    with get_conn() as conn:
        net, et, gen, callsigns_from_db = _load_page_state(conn, last_id)

    context = _build_context(
        request,
        actor,
        msg=msg if net else "Спочатку обери радіомережу.",
        q_query=(net["frequency"] if net else ""),
        matches=[],
        net=net,
        et=et,
        gen=gen,
        callsigns_from_db=callsigns_from_db,
    )
    return request.app.state.templates.TemplateResponse("etalons.html", context)


@router.post("/etalons/search", response_class=HTMLResponse)
def search(
    request: Request,
    query: str = Form(""),
    actor=Depends(get_actor),
):
    """Search networks and either select a single match or show match list."""
    q_query = (query or "").strip()
    current_id = request.session.get("last_network_id")

    with get_conn() as conn:
        net, et, gen, callsigns_from_db = _load_page_state(conn, current_id)

        if not q_query:
            context = _build_context(
                request,
                actor,
                msg="Введи маску або частоту.",
                q_query="",
                matches=[],
                net=net,
                et=et,
                gen=gen,
                callsigns_from_db=callsigns_from_db,
            )
            return request.app.state.templates.TemplateResponse("etalons.html", context)

        matches = search_network_rows(conn, q_query, limit=50)

        if len(matches) == 1:
            request.session["last_network_id"] = int(matches[0]["id"])
            return RedirectResponse(url=f"/etalons?pick={int(matches[0]['id'])}", status_code=303)

        context = _build_context(
            request,
            actor,
            msg="Знайдено кілька радіомереж. Обери потрібну." if matches else "Нічого не знайдено.",
            q_query=q_query,
            matches=matches,
            net=net,
            et=et,
            gen=gen,
            callsigns_from_db=callsigns_from_db,
        )
        return request.app.state.templates.TemplateResponse("etalons.html", context)


@router.post("/etalons/save")
def save(
    request: Request,
    start_date_str: str = Form(default=""),
    purpose: str = Form(default=""),
    correspondents: str = Form(default=""),
    operation_mode: str = Form(default=""),
    traffic_type: str = Form(default=""),
):
    """Persist etalon fields for the last-selected network."""
    last_id = request.session.get("last_network_id")
    if not last_id:
        return RedirectResponse(url="/etalons?msg=Спочатку обери радіомережу.", status_code=303)

    sd = None
    if start_date_str:
        try:
            sd = date.fromisoformat(start_date_str)
        except Exception:
            sd = None

    sd_str = sd.isoformat() if sd else None
    now = datetime.utcnow().isoformat(timespec="seconds")

    with get_conn() as conn:
        net = _fetchone(conn, "SELECT id FROM networks WHERE id=?", (int(last_id),))
        if not net:
            return RedirectResponse(url="/etalons?msg=Радіомережу не знайдено.", status_code=303)

        row = _fetchone(conn, "SELECT id FROM etalons WHERE network_id=?", (int(net["id"]),))
        if row:
            conn.execute(
                """
                UPDATE etalons SET
                    start_date=?,
                    purpose=?,
                    correspondents=?,
                    operation_mode=?,
                    traffic_type=?,
                    updated_at=?
                WHERE network_id=?
                """,
                (
                    sd_str,
                    purpose.strip() or None,
                    correspondents.strip() or None,
                    operation_mode.strip() or None,
                    traffic_type.strip() or None,
                    now,
                    int(net["id"]),
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO etalons
                    (network_id, start_date, purpose, correspondents, operation_mode, traffic_type, updated_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    int(net["id"]),
                    sd_str,
                    purpose.strip() or None,
                    correspondents.strip() or None,
                    operation_mode.strip() or None,
                    traffic_type.strip() or None,
                    now,
                ),
            )

        conn.commit()

    return RedirectResponse(url="/etalons?msg=Збережено.", status_code=303)