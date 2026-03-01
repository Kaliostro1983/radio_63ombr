from __future__ import annotations
from datetime import date, datetime
from fastapi import APIRouter, Request, Form
from fastapi.responses import RedirectResponse, HTMLResponse

from app.core.db import get_conn
from app.core.auth_context import get_actor

DEFAULT_PURPOSE = "Для безперебійного управління підпорядкованими підрозділами."
DEFAULT_OPERATION_MODE = "Цілодобово, з використанням дуплексного режиму організації зв’язку."
DEFAULT_TRAFFIC_TYPE = "Службовий радіообмін"
DEFAULT_MODULATION = "NFM"

router = APIRouter()

def _fetchone(conn, sql: str, params=()):
    cur = conn.execute(sql, params)
    return cur.fetchone()

@router.get("/etalons", response_class=HTMLResponse)
def page(request: Request):
    msg = request.query_params.get("msg", "")
    last_id = request.session.get("last_network_id")
    if not last_id:
        return RedirectResponse(url="/networks?msg=Спочатку обери радіомережу.", status_code=303)

    with get_conn() as conn:
        net = _fetchone(conn, "SELECT * FROM networks WHERE id=?", (int(last_id),))
        if not net:
            return RedirectResponse(url="/networks?msg=Радіомережу не знайдено.", status_code=303)

        et = _fetchone(conn, "SELECT * FROM etalons WHERE network_id=?", (int(net["id"]),))
        now = datetime.utcnow().isoformat(timespec="seconds")
        if not et:
            conn.execute("INSERT INTO etalons(network_id, updated_at) VALUES (?,?)", (int(net["id"]), now))
            et = _fetchone(conn, "SELECT * FROM etalons WHERE network_id=?", (int(net["id"]),))

        # generated
        name = f"УКХ р/м {net['unit']}, {net['zone']}"
        area = net["zone"]
        period = "з невідомої дати по сьогоднішній день"
        sd = None
        if et and et["start_date"]:
            try:
                sd = date.fromisoformat(et["start_date"])
                period = f"з {sd.isoformat()} по сьогоднішній день"
            except Exception:
                pass

        context = {
            "request": request,
            "app_name": request.app.state.app_name,
            "msg": msg,
            "net": net,
            "et": et,
            "gen": {
                "name": name,
                "area": area,
                "frequency": net["frequency"],
                "modulation": DEFAULT_MODULATION,
                "period": period,
            },
            "defaults": {
                "purpose": DEFAULT_PURPOSE,
                "operation_mode": DEFAULT_OPERATION_MODE,
                "traffic_type": DEFAULT_TRAFFIC_TYPE,
            }
        }
        return request.app.state.templates.TemplateResponse("etalons.html", context)

@router.post("/etalons/save")
def save(request: Request,
         start_date_str: str = Form(default=""),
         purpose: str = Form(default=""),
         correspondents: str = Form(default=""),
         operation_mode: str = Form(default=""),
         traffic_type: str = Form(default="")):
    last_id = request.session.get("last_network_id")
    if not last_id:
        return RedirectResponse(url="/networks?msg=Спочатку обери радіомережу.", status_code=303)

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
            return RedirectResponse(url="/networks?msg=Радіомережу не знайдено.", status_code=303)

        row = _fetchone(conn, "SELECT id FROM etalons WHERE network_id=?", (int(net["id"]),))
        if row:
            conn.execute("""UPDATE etalons SET
                start_date=?, purpose=?, correspondents=?, operation_mode=?, traffic_type=?, updated_at=?
                WHERE network_id=?""",
                (sd_str,
                 (purpose.strip() or None),
                 (correspondents.strip() or None),
                 (operation_mode.strip() or None),
                 (traffic_type.strip() or None),
                 now,
                 int(net["id"]))
            )
        else:
            conn.execute("""INSERT INTO etalons
                (network_id, start_date, purpose, correspondents, operation_mode, traffic_type, updated_at)
                VALUES (?,?,?,?,?,?,?)""",
                (int(net["id"]), sd_str,
                 (purpose.strip() or None),
                 (correspondents.strip() or None),
                 (operation_mode.strip() or None),
                 (traffic_type.strip() or None),
                 now)
            )

    return RedirectResponse(url="/etalons?msg=Збережено.", status_code=303)
