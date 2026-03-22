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
from fastapi.responses import RedirectResponse, HTMLResponse, StreamingResponse
from io import BytesIO
from urllib.parse import quote

from app.core.db import get_conn
from app.core.auth_context import get_actor
from app.services.network_search import search_network_rows
from app.reports.etalons_report import build_etalons_docx_bytes

DEFAULT_PURPOSE = "Для безперебійного управління підпорядкованими підрозділами."
DEFAULT_OPERATION_MODE = "Цілодобово, з використанням дуплексного режиму організації зв’язку."
DEFAULT_TRAFFIC_TYPE = "Службовий радіообмін"
DEFAULT_MODULATION = "NFM"

def _ascii_filename_fallback(filename: str) -> str:
    """Return a latin-1 safe fallback filename (best-effort)."""
    safe = (filename or "").strip()
    if not safe:
        return "report.docx"
    out: list[str] = []
    for ch in safe:
        o = ord(ch)
        if 32 <= o < 127 and ch not in {'"', "\\"}:
            out.append(ch)
        elif ch in {" ", "-", "_", ".", "(", ")", "[", "]"}:
            out.append(ch)
        else:
            out.append("_")
    fallback = "".join(out).strip() or "report.docx"
    if not fallback.lower().endswith(".docx"):
        fallback += ".docx"
    return fallback


def _content_disposition_attachment(filename: str) -> str:
    """RFC 6266 / RFC 5987 compatible Content-Disposition for UTF-8 filenames."""
    fallback = _ascii_filename_fallback(filename)
    utf8 = quote(filename, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{utf8}"

router = APIRouter()

# Окремий URL для iframe на /networks (без query embed=1 — редіректи після POST його гублять).
ETALONS_PANEL_BASE = "/etalons/panel"


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
    today_disp = datetime.now().date().strftime("%d.%m.%Y")

    sd = None
    ed = None
    if et:
        # `et` is a sqlite3.Row (not a dict), so use bracket access.
        try:
            sd = et["start_date"]
        except Exception:
            sd = None
        try:
            ed = et["end_date"]
        except Exception:
            ed = None

    start_part = "невідомої дати"
    if sd:
        try:
            start_part = date.fromisoformat(sd).strftime("%d.%m.%Y")
        except Exception:
            start_part = "невідомої дати"

    end_part = today_disp
    if ed:
        try:
            end_part = date.fromisoformat(ed).strftime("%d.%m.%Y")
        except Exception:
            end_part = today_disp

    period = f"з {start_part} по {end_part}"

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
    is_embed: bool = False,
    etalons_base: str = "/etalons",
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
        "is_embed": is_embed,
        "etalons_base": (etalons_base or "/etalons").rstrip("/") or "/etalons",
    }


def _etalons_template(is_embed: bool) -> str:
    return "etalons_embed.html" if is_embed else "etalons.html"


def _etalons_response_template(*, is_embed: bool, etalons_base: str) -> str:
    if etalons_base == ETALONS_PANEL_BASE:
        return "etalons_embed.html"
    return _etalons_template(is_embed)


def _is_embed_request(request: Request, etalon_embed_form: str = "") -> bool:
    """Detect iframe/embed UI: form body, POST ?embed=1, or Referer (fallback)."""
    if (etalon_embed_form or "").strip() == "1":
        return True
    if request.query_params.get("embed") == "1":
        return True
    ref = request.headers.get("referer") or ""
    return "embed=1" in ref


def _etalons_page_get(
    request: Request,
    pick: Optional[int],
    actor,
    *,
    etalons_base: str,
    is_embed: bool,
):
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
        is_embed=is_embed,
        etalons_base=etalons_base,
    )
    tpl = _etalons_response_template(is_embed=is_embed, etalons_base=etalons_base)
    return request.app.state.templates.TemplateResponse(tpl, context)


@router.get("/etalons/panel", response_class=HTMLResponse)
def page_panel(
    request: Request,
    pick: Optional[int] = None,
    actor=Depends(get_actor),
):
    """Компактна еталонка лише для iframe на сторінці /networks (окремі POST-шляхи)."""
    return _etalons_page_get(
        request,
        pick,
        actor,
        etalons_base=ETALONS_PANEL_BASE,
        is_embed=True,
    )


@router.get("/etalons", response_class=HTMLResponse)
def page(
    request: Request,
    pick: Optional[int] = None,
    actor=Depends(get_actor),
):
    """Render the etalons page for the last-selected (or picked) network."""
    is_embed = request.query_params.get("embed") == "1"
    return _etalons_page_get(
        request,
        pick,
        actor,
        etalons_base="/etalons",
        is_embed=is_embed,
    )


@router.get("/etalons/download")
def download_etalons_report(
    query: str = "",
    actor=Depends(get_actor),
):
    """Download DOCX report with etalon descriptions for eligible networks."""
    del actor, query  # auth side-effect only; report is based on DB statuses filter
    with get_conn() as conn:
        content, filename = build_etalons_docx_bytes(
            conn=conn,
            query="",
            report_date=datetime.now().date(),
        )

    bio = BytesIO(content)
    return StreamingResponse(
        bio,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": _content_disposition_attachment(filename)},
    )


def _etalons_run_search(
    request: Request,
    query: str,
    etalon_embed: str,
    actor,
    *,
    etalons_base: str,
):
    """Shared search handler for /etalons/search and /etalons/panel/search."""
    q_query = (query or "").strip()
    is_panel = etalons_base == ETALONS_PANEL_BASE
    is_embed = is_panel or _is_embed_request(request, etalon_embed)
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
                is_embed=is_embed,
                etalons_base=etalons_base,
            )
            tpl = _etalons_response_template(is_embed=is_embed, etalons_base=etalons_base)
            return request.app.state.templates.TemplateResponse(tpl, context)

        matches = search_network_rows(conn, q_query, limit=50)

        if len(matches) == 1:
            request.session["last_network_id"] = int(matches[0]["id"])
            nid = int(matches[0]["id"])
            return RedirectResponse(url=f"{etalons_base}?pick={nid}", status_code=303)

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
            is_embed=is_embed,
            etalons_base=etalons_base,
        )
        tpl = _etalons_response_template(is_embed=is_embed, etalons_base=etalons_base)
        return request.app.state.templates.TemplateResponse(tpl, context)


@router.post("/etalons/panel/search", response_class=HTMLResponse)
def search_panel(
    request: Request,
    query: str = Form(""),
    etalon_embed: str = Form(default=""),
    actor=Depends(get_actor),
):
    """Пошук еталонки всередині iframe (/networks)."""
    return _etalons_run_search(request, query, etalon_embed, actor, etalons_base=ETALONS_PANEL_BASE)


@router.post("/etalons/search", response_class=HTMLResponse)
def search(
    request: Request,
    query: str = Form(""),
    etalon_embed: str = Form(default=""),
    actor=Depends(get_actor),
):
    """Search networks and either select a single match or show match list."""
    return _etalons_run_search(request, query, etalon_embed, actor, etalons_base="/etalons")


def _etalons_run_save(
    request: Request,
    start_date_str: str,
    purpose: str,
    correspondents: str,
    operation_mode: str,
    traffic_type: str,
    etalon_embed: str,
    *,
    etalons_base: str,
) -> RedirectResponse:
    is_panel = etalons_base == ETALONS_PANEL_BASE
    is_embed = is_panel or _is_embed_request(request, etalon_embed)
    last_id = request.session.get("last_network_id")

    if not last_id:
        qm = quote("Спочатку обери радіомережу.")
        if is_panel:
            url = f"{etalons_base}?msg={qm}"
        elif is_embed:
            url = f"{etalons_base}?embed=1&msg={qm}"
        else:
            url = f"{etalons_base}?msg={qm}"
        return RedirectResponse(url=url, status_code=303)

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
            qm = quote("Радіомережу не знайдено.")
            if is_panel:
                url = f"{etalons_base}?msg={qm}"
            elif is_embed:
                url = f"{etalons_base}?embed=1&msg={qm}"
            else:
                url = f"{etalons_base}?msg={qm}"
            return RedirectResponse(url=url, status_code=303)

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

    ok_msg = quote("Збережено.")
    if is_panel:
        url = f"{etalons_base}?pick={int(last_id)}&msg={ok_msg}"
    elif is_embed:
        url = f"{etalons_base}?pick={int(last_id)}&embed=1&msg={ok_msg}"
    else:
        url = f"{etalons_base}?pick={int(last_id)}&msg={ok_msg}"
    return RedirectResponse(url=url, status_code=303)


@router.post("/etalons/panel/save")
def save_panel(
    request: Request,
    start_date_str: str = Form(default=""),
    purpose: str = Form(default=""),
    correspondents: str = Form(default=""),
    operation_mode: str = Form(default=""),
    traffic_type: str = Form(default=""),
    etalon_embed: str = Form(default=""),
):
    """Збереження еталонки з iframe (/networks)."""
    return _etalons_run_save(
        request,
        start_date_str,
        purpose,
        correspondents,
        operation_mode,
        traffic_type,
        etalon_embed,
        etalons_base=ETALONS_PANEL_BASE,
    )


@router.post("/etalons/save")
def save(
    request: Request,
    start_date_str: str = Form(default=""),
    purpose: str = Form(default=""),
    correspondents: str = Form(default=""),
    operation_mode: str = Form(default=""),
    traffic_type: str = Form(default=""),
    etalon_embed: str = Form(default=""),
):
    """Persist etalon fields for the last-selected network."""
    return _etalons_run_save(
        request,
        start_date_str,
        purpose,
        correspondents,
        operation_mode,
        traffic_type,
        etalon_embed,
        etalons_base="/etalons",
    )