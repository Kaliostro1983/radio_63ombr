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
    cur = conn.execute(sql, params)
    return cur.fetchone()


def _ensure_etalon(conn, network_id: int):
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


def _load_page_state(conn, network_id: Optional[int]):
    if not network_id:
        return None, None, None

    net = _fetchone(conn, "SELECT * FROM networks WHERE id=?", (int(network_id),))
    if not net:
        return None, None, None

    et = _ensure_etalon(conn, int(net["id"]))
    gen = _build_generated(net, et)
    return net, et, gen


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
):
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
    msg = request.query_params.get("msg", "")

    if pick:
        request.session["last_network_id"] = int(pick)

    last_id = request.session.get("last_network_id")

    with get_conn() as conn:
        net, et, gen = _load_page_state(conn, last_id)

    context = _build_context(
        request,
        actor,
        msg=msg if net else "Спочатку обери радіомережу.",
        q_query=(net["frequency"] if net else ""),
        matches=[],
        net=net,
        et=et,
        gen=gen,
    )
    return request.app.state.templates.TemplateResponse("etalons.html", context)


@router.post("/etalons/search", response_class=HTMLResponse)
def search(
    request: Request,
    query: str = Form(""),
    actor=Depends(get_actor),
):
    q_query = (query or "").strip()
    current_id = request.session.get("last_network_id")

    with get_conn() as conn:
        net, et, gen = _load_page_state(conn, current_id)

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