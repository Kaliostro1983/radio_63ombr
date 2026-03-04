from __future__ import annotations

from datetime import datetime, date
from typing import List, Optional

from fastapi import APIRouter, Depends, Request, Form
from fastapi.responses import RedirectResponse, HTMLResponse

from app.core.db import get_conn
from app.core.normalize import normalize_freq
from app.core.auth_context import get_actor

router = APIRouter()


@router.get("/api/networks/lookup")
def api_networks_lookup(q: str):
    query = (q or "").strip()
    if not query:
        return {"ok": True, "rows": []}

    qn = normalize_freq(query) or query
    like = f"%{query}%"
    like_n = f"%{qn}%"

    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, frequency, mask, unit
            FROM networks
            WHERE (frequency IS NOT NULL AND (frequency LIKE ? OR frequency LIKE ? OR CAST(frequency AS REAL)=CAST(? AS REAL)))
               OR (mask IS NOT NULL AND (mask LIKE ? OR mask LIKE ? OR CAST(mask AS REAL)=CAST(? AS REAL)))
               OR (unit IS NOT NULL AND unit LIKE ? COLLATE NOCASE)
            ORDER BY
              CASE WHEN frequency IS NULL THEN 1 ELSE 0 END,
              frequency ASC
            LIMIT 60
            """,
            (like, like_n, qn, like, like_n, qn, like),
        ).fetchall()

        out = []
        for r in rows:
            out.append(
                {
                    "id": int(r["id"]),
                    "frequency": r["frequency"] or "",
                    "mask": r["mask"] or "",
                    "unit": r["unit"] or "",
                }
            )

    return {"ok": True, "rows": out}


@router.get("/api/networks/by-id")
def api_network_by_id(id: int):
    """Return a minimal network row for preselecting a network in UI."""
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



def _fetchall(conn, sql: str, params=()):
    cur = conn.execute(sql, params)
    return cur.fetchall()


def _fetchone(conn, sql: str, params=()):
    cur = conn.execute(sql, params)
    return cur.fetchone()


def _lookup(conn):
    statuses = _fetchall(conn, "SELECT id, name FROM statuses ORDER BY name")
    chats = _fetchall(conn, "SELECT id, name FROM chats ORDER BY name")
    groups = _fetchall(conn, "SELECT id, name FROM groups ORDER BY name")
    tags = _fetchall(conn, "SELECT id, name FROM tags ORDER BY name")

    status_map = {r["id"]: r["name"] for r in statuses}
    chat_map = {r["id"]: r["name"] for r in chats}
    group_map = {r["id"]: r["name"] for r in groups}
    tag_map = {r["id"]: r["name"] for r in tags}

    return statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map


def _get_tag_ids(conn, network_id: int) -> List[int]:
    rows = _fetchall(conn, "SELECT tag_id FROM network_tags WHERE network_id=?", (network_id,))
    return [int(r["tag_id"]) for r in rows]


def _set_tags(conn, network_id: int, tag_ids: List[int]):
    conn.execute("DELETE FROM network_tags WHERE network_id=?", (network_id,))
    for tid in sorted(set(int(x) for x in tag_ids or [])):
        conn.execute(
            "INSERT OR IGNORE INTO network_tags(network_id, tag_id) VALUES (?,?)",
            (network_id, tid),
        )


def _ensure_etalon(conn, network_id: int):
    row = _fetchone(conn, "SELECT id FROM etalons WHERE network_id=?", (network_id,))
    if row:
        return
    now = datetime.utcnow().isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO etalons(network_id, start_date, updated_at) VALUES (?,?,?)",
        (network_id, None, now),
    )


def _get_etalon_start_date(conn, network_id: int) -> Optional[date]:
    row = _fetchone(conn, "SELECT start_date FROM etalons WHERE network_id=?", (network_id,))
    if not row or not row["start_date"]:
        return None
    try:
        return date.fromisoformat(row["start_date"])
    except Exception:
        return None


def _set_etalon_start_date(conn, network_id: int, start_date_str: str):
    now = datetime.utcnow().isoformat(timespec="seconds")
    conn.execute(
        "UPDATE etalons SET start_date=?, updated_at=? WHERE network_id=?",
        (start_date_str, now, network_id),
    )


def _looks_like_partial_frequency(raw: str) -> bool:
    """
    Якщо користувач ввів "144" або "144.4" — вважаємо це частковим пошуком
    і показуємо список matches. Якщо ввів щось схоже на повну частоту — будемо
    намагатися знайти exact через normalize_freq.
    """
    s = (raw or "").strip()
    if not s:
        return False
    # дуже груба евристика: немає роздільника — це зазвичай частковий пошук
    return ("." not in s and "," not in s) or len(s) < 6


@router.get("/networks", response_class=HTMLResponse)
def networks_page(
    request: Request,
    id: Optional[int] = None,
    pick: Optional[int] = None,
    actor=Depends(get_actor),
):
    network_id = pick or id

    with get_conn() as conn:
        statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map = _lookup(conn)

        current = None
        matches = []
        selected_tags: List[int] = []
        start_date_val: Optional[date] = None

        q_freq = ""
        q_mask = ""
        message = ""

        if network_id:
            current = _fetchone(conn, "SELECT * FROM networks WHERE id=?", (int(network_id),))
            if current:
                q_freq = current["frequency"] or ""
                q_mask = current["mask"] or ""
                selected_tags = _get_tag_ids(conn, int(current["id"]))
                _ensure_etalon(conn, int(current["id"]))
                start_date_val = _get_etalon_start_date(conn, int(current["id"]))

    context = dict(
        request=request,
        actor=actor,
        q_freq=q_freq,
        q_mask=q_mask,
        matches=matches,
        current=current,
        statuses=statuses,
        chats=chats,
        groups=groups,
        tags=tags,
        status_map=status_map,
        chat_map=chat_map,
        group_map=group_map,
        tag_map=tag_map,
        selected_tags=selected_tags,
        start_date=start_date_val,
        message=message,
    )
    return request.app.state.templates.TemplateResponse("networks.html", context)


@router.post("/networks/search", response_class=HTMLResponse)
def networks_search(
    request: Request,
    frequency: str = Form(""),
    mask: str = Form(""),
    actor=Depends(get_actor),
):
    q_freq = (frequency or "").strip()
    q_mask = (mask or "").strip()

    with get_conn() as conn:
        statuses, chats, groups, tags, status_map, chat_map, group_map, tag_map = _lookup(conn)

        current = None
        matches = []
        selected_tags: List[int] = []
        start_date_val: Optional[date] = None
        message = ""

        # 1) Якщо частковий пошук — показуємо список matches (LIKE)
        if q_freq and _looks_like_partial_frequency(q_freq):
            sql = "SELECT id, frequency, mask, unit, zone, chat_id, status_id FROM networks WHERE frequency LIKE ?"
            params = [f"%{q_freq}%"]
            if q_mask:
                sql += " AND (mask LIKE ?)"
                params.append(f"%{q_mask}%")
            sql += " ORDER BY frequency"
            matches = _fetchall(conn, sql, tuple(params))

            # Якщо раптом 1 збіг — одразу відкриваємо картку
            if len(matches) == 1:
                nid = int(matches[0]["id"])
                current = _fetchone(conn, "SELECT * FROM networks WHERE id=?", (nid,))
                if current:
                    selected_tags = _get_tag_ids(conn, nid)
                    _ensure_etalon(conn, nid)
                    start_date_val = _get_etalon_start_date(conn, nid)

        # 2) Інакше — точний lookup по нормалізованій частоті
        elif q_freq:
            try:
                freq_norm = normalize_freq(q_freq)
            except Exception:
                freq_norm = ""

            if not freq_norm:
                message = "Некоректна частота."
            else:
                # networks.frequency у тебе UNIQUE, тож exact дасть 0 або 1
                row = _fetchone(conn, "SELECT * FROM networks WHERE frequency=?", (freq_norm,))
                if row:
                    # якщо маску ввели — і вона не збігається, можна показати повідомлення
                    if q_mask and (row["mask"] or "") != q_mask:
                        # не блокуємо відкриття, просто попереджаємо
                        message = "Знайшов по частоті, але маска відрізняється."
                    current = row
                    nid = int(current["id"])
                    selected_tags = _get_tag_ids(conn, nid)
                    _ensure_etalon(conn, nid)
                    start_date_val = _get_etalon_start_date(conn, nid)
                else:
                    message = "Не знайдено. Заповни поля і тисни “Зберегти”."

        context = dict(
            request=request,
            actor=actor,
            q_freq=q_freq,
            q_mask=q_mask,
            matches=matches,
            current=current,
            statuses=statuses,
            chats=chats,
            groups=groups,
            tags=tags,
            status_map=status_map,
            chat_map=chat_map,
            group_map=group_map,
            tag_map=tag_map,
            selected_tags=selected_tags,
            start_date=start_date_val,
            message=message,
        )
        return request.app.state.templates.TemplateResponse("networks.html", context)


@router.post("/networks/save")
def networks_save(
    request: Request,
    action: str = Form("save"),  # "save" | "save_new"
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
    actor=Depends(get_actor),
):
    freq_norm = normalize_freq(frequency)
    now = datetime.utcnow().isoformat(timespec="seconds")

    with get_conn() as conn:
        # Вкладка “Радіомережі” працює через upsert по frequency (бо вона UNIQUE).
        existing = _fetchone(conn, "SELECT id FROM networks WHERE frequency=?", (freq_norm,))

        if action == "save_new" or not existing:
            # INSERT (новий запис)
            cur = conn.execute(
                """
                INSERT INTO networks (frequency, mask, unit, zone, chat_id, group_id, status_id, comment, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (freq_norm, mask or None, unit, zone, int(chat_id), int(group_id), int(status_id), comment, now),
            )
            network_id = int(cur.lastrowid)
        else:
            # UPDATE (існуючий по frequency)
            network_id = int(existing["id"])
            conn.execute(
                """
                UPDATE networks
                SET mask=?, unit=?, zone=?, chat_id=?, group_id=?, status_id=?, comment=?, updated_at=?
                WHERE id=?
                """,
                (mask or None, unit, zone, int(chat_id), int(group_id), int(status_id), comment, now, network_id),
            )

        _set_tags(conn, network_id, tag_ids)

        _ensure_etalon(conn, network_id)
        if start_date_str:
            _set_etalon_start_date(conn, network_id, start_date_str)

        conn.commit()

    return RedirectResponse(url=f"/networks?pick={network_id}", status_code=303)