from __future__ import annotations

from datetime import datetime, timedelta, time
from io import BytesIO
import csv
import json
import re
import urllib.request
import logging
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import RedirectResponse, StreamingResponse

from app.core.db import get_conn
from app.core.normalize import normalize_freq_or_mask
from app.reports.enemy_moves_config import load_reports_config
from app.reports.enemy_moves_report import EnemyMoveItem, build_enemy_moves_docx_bytes
from app.reports.rer_report import (
    RerItem,
    subunit_group,
    subunit_full,
    format_mgrs,
    build_rer_donesennya_docx_bytes,
)

from openpyxl import load_workbook

# Київ = UTC+3 (постійно, без переходів). Сервер і created_at — UTC.
_KYIV = timedelta(hours=3)
_RE_RAYON = re.compile(r"^(р[-/ ]?н|район)\b", re.IGNORECASE)


router = APIRouter(tags=["reports"])

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


@router.get("/reports")
def reports_page_redirect():
    """Звіти перенесено на Головну → вкладка «Звіти»."""
    return RedirectResponse(url="/home?tab=reports", status_code=302)

def _load_moves_from_xlsx_bytes(content: bytes) -> list[tuple[str, str]]:
    """Return list of (freq_or_mask, move_text) from the first worksheet."""
    wb = load_workbook(filename=BytesIO(content), read_only=True, data_only=True)
    ws = wb.worksheets[0]

    # Find headers in first row
    headers: dict[str, int] = {}
    for idx, cell in enumerate(next(ws.iter_rows(min_row=1, max_row=1, values_only=True)), start=1):
        if not cell:
            continue
        name = str(cell).strip()
        headers[name] = idx

    col_freq = headers.get("Частота/маска")
    col_move = headers.get("Переміщення")
    if not col_freq or not col_move:
        raise ValueError("У XLSX мають бути колонки 'Частота/маска' та 'Переміщення'.")

    result: list[tuple[str, str]] = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        raw_freq = row[col_freq - 1] if len(row) >= col_freq else None
        raw_move = row[col_move - 1] if len(row) >= col_move else None
        freq = str(raw_freq).strip() if raw_freq is not None else ""
        move = str(raw_move).strip() if raw_move is not None else ""
        if not freq or not move:
            continue
        result.append((freq, move))
    return result


def _load_moves_from_gsheet_csv(spreadsheet_id: str, gid: str | None) -> list[tuple[str, str]]:
    """Load moves from Google Sheets CSV export.

    Requires the sheet to be accessible without auth in the current environment.
    """
    sid = (spreadsheet_id or "").strip()
    if not sid:
        raise ValueError("Не задано spreadsheet_id для gsheet_csv.")

    url = f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv"
    gid_val = (gid or "").strip()
    if gid_val:
        url += f"&gid={gid_val}"

    req = urllib.request.Request(url, headers={"User-Agent": "radio_63ombr/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()

    # Google may include UTF-8 BOM
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(text.splitlines())

    # Be tolerant to minor header whitespace
    fieldnames = [fn.strip() for fn in (reader.fieldnames or [])]
    # Map normalized header -> original
    header_map = {fn.strip(): fn for fn in (reader.fieldnames or [])}
    col_freq = header_map.get("Частота/маска")
    col_move = header_map.get("Переміщення")
    if not col_freq or not col_move:
        raise ValueError("У Google Sheet мають бути колонки 'Частота/маска' та 'Переміщення'.")

    result: list[tuple[str, str]] = []
    for row in reader:
        freq = str(row.get(col_freq) or "").strip()
        move = str(row.get(col_move) or "").strip()
        if not freq or not move:
            continue
        result.append((freq, move))
    return result


@router.post("/reports/enemy-moves")
def generate_enemy_moves_report(moves_xlsx: UploadFile | None = File(default=None)):
    """Generate enemies moves report from uploaded XLSX or configured Google Sheets CSV."""
    try:
        moves: list[tuple[str, str]]
        if moves_xlsx is not None and getattr(moves_xlsx, "filename", ""):
            content = moves_xlsx.file.read()
            moves = _load_moves_from_xlsx_bytes(content)
        else:
            cfg = load_reports_config()
            moves_cfg = cfg.get("moves") or {}
            if not isinstance(moves_cfg, dict):
                moves_cfg = {}
            source = str(moves_cfg.get("source") or "gsheet_csv").strip()
            if source == "xlsx":
                raise ValueError("Джерело moves=xlsx у веб-версії підтримується через завантаження файлу.")
            spreadsheet_id = str(moves_cfg.get("spreadsheet_id") or "").strip()
            gid = str(moves_cfg.get("gid") or "").strip()
            moves = _load_moves_from_gsheet_csv(spreadsheet_id, gid or None)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    items: list[EnemyMoveItem] = []
    missing_network: set[str] = set()
    missing_group: set[str] = set()

    with get_conn() as conn:
        for raw_freq_or_mask, move_text in moves:
            exact, mask = normalize_freq_or_mask(raw_freq_or_mask)

            row = None
            if mask:
                # Use LIKE against frequency and mask fields.
                row = conn.execute(
                    """
                    SELECT n.unit AS unit, g.name AS group_name, n.frequency AS frequency
                    FROM networks n
                    LEFT JOIN groups g ON g.id = n.group_id
                    WHERE (n.frequency LIKE ? OR n.mask LIKE ?)
                    ORDER BY n.frequency ASC
                    LIMIT 1
                    """,
                    (mask, mask),
                ).fetchone()
            elif exact:
                row = conn.execute(
                    """
                    SELECT n.unit AS unit, g.name AS group_name, n.frequency AS frequency
                    FROM networks n
                    LEFT JOIN groups g ON g.id = n.group_id
                    WHERE n.frequency = ? OR n.mask = ?
                    LIMIT 1
                    """,
                    (exact, exact),
                ).fetchone()

            if not row:
                missing_network.add(str(raw_freq_or_mask))
                continue

            group = (row["group_name"] or "").strip()
            if not group:
                missing_group.add(str(raw_freq_or_mask))
                continue

            unit = (row["unit"] or "").strip()
            freq_display = (exact or row["frequency"] or raw_freq_or_mask or "").strip()

            items.append(
                EnemyMoveItem(
                    freq=freq_display,
                    move=move_text,
                    unit=unit,
                    group=group,
                )
            )

    if missing_network:
        sample = sorted(missing_network)[:50]
        logging.warning(
            "Enemy moves report: не знайдено радіомережу в БД для %d рядків. Частоти/маски (перші %d): %s",
            len(missing_network),
            len(sample),
            ", ".join(sample),
        )

    if missing_group:
        sample = sorted(missing_group)[:50]
        logging.warning(
            "Enemy moves report: знайдено мережу, але відсутня group_id/назва групи для %d рядків. Частоти/маски (перші %d): %s",
            len(missing_group),
            len(sample),
            ", ".join(sample),
        )

    content, filename = build_enemy_moves_docx_bytes(items, report_date=datetime.now().date())
    bio = BytesIO(content)
    headers = {"Content-Disposition": _content_disposition_attachment(filename)}
    return StreamingResponse(
        bio,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers=headers,
    )


def _rayon_from_conclusion(conclusion_text: str | None) -> str:
    """Витягнути рядок району («р-н …») з тексту висновку (перший відповідний)."""
    for line in (conclusion_text or "").splitlines():
        s = line.strip()
        if _RE_RAYON.match(s):
            return s
    return ""


def _clean_conclusion(conclusion_text: str | None) -> str:
    """Ліва колонка: прибрати початковий рядок-район (він у «Локація»).

    Завершальну пунктуацію та перелік точок формує білдер (залежно від
    наявності координат у mgrs_json)."""
    lines = (conclusion_text or "").splitlines()
    while lines and _RE_RAYON.match(lines[0].strip()):
        lines.pop(0)
    body = "\n".join(lines).strip()
    # Прибрати вписані «в ручну» кінцеві індекси точок після двокрапки
    # (напр. «…квадрату:1», «…точок:1.2.3.4») — перелік додасть білдер із mgrs_json.
    body = re.sub(r":\s*(?:\d+\.?\s*)+$", ":", body).strip()
    return body


def _points_from_mgrs_json(mgrs_json: str | None) -> list[str]:
    """Список відформатованих MGRS-точок із mgrs_json висновку."""
    out: list[str] = []
    try:
        data = json.loads(mgrs_json or "[]")
    except Exception:
        return out
    if isinstance(data, list):
        for p in data:
            if isinstance(p, str) and p.strip():
                out.append(format_mgrs(p))
    return out


def _to_kyiv(utc_str: str | None) -> datetime | None:
    """created_at (UTC 'YYYY-MM-DD HH:MM:SS') → київський datetime."""
    if not utc_str:
        return None
    try:
        return datetime.strptime(str(utc_str)[:19], "%Y-%m-%d %H:%M:%S") + _KYIV
    except Exception:
        return None


def _rer_period_range(period: str) -> tuple[str, str, datetime, str, str]:
    """Межі періоду в UTC (для порівняння з created_at) + київський report_dt + підпис.

    period: 'night' (23:00 учора → 11:00 сьогодні) або 'day' (11:00 → 23:00 сьогодні),
    межі — у КИЇВСЬКОМУ часі, конвертуються в UTC (−3 год).
    """
    now_kyiv = datetime.utcnow() + _KYIV
    today = now_kyiv.date()
    if period == "day":
        start_kyiv = datetime.combine(today, time(11, 0))
        end_kyiv = datetime.combine(today, time(23, 0))
        label = "11:00 – 23:00"
        rng = "11:00-23:00"
    else:  # night (default)
        start_kyiv = datetime.combine(today - timedelta(days=1), time(23, 0))
        end_kyiv = datetime.combine(today, time(11, 0))
        label = "23:00 (учора) – 11:00"
        rng = "23:00-11:00"
    start_utc = (start_kyiv - _KYIV).strftime("%Y-%m-%d %H:%M:%S")
    end_utc = (end_kyiv - _KYIV).strftime("%Y-%m-%d %H:%M:%S")
    return start_utc, end_utc, now_kyiv, label, rng


@router.get("/reports/rer-donesennya")
def generate_rer_donesennya(period: str = "night"):
    """Донесення за результатами радіорозвідки (Форма 1.2.17).

    Двоколонкова таблиця висновків за період, згрупована за бригадно-полковими
    підрозділами. Напрямок один — Лиманський.
    """
    period = (period or "night").strip().lower()
    if period not in {"night", "day"}:
        period = "night"
    start_utc, end_utc, report_dt, period_label, filename_range = _rer_period_range(period)

    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT a.id AS cid, a.conclusion_text AS conclusion, a.message_id AS mid,
                   a.created_at AS a_created, a.mgrs_json AS mgrs_json,
                   n.frequency AS frequency, n.unit AS unit,
                   m.created_at AS m_created, m.body_text AS body_text
            FROM analytical_conclusions a
            JOIN networks n ON n.id = a.network_id
            LEFT JOIN messages m ON m.id = a.message_id
            WHERE a.created_at >= ? AND a.created_at < ?
              AND a.conclusion_text IS NOT NULL AND TRIM(a.conclusion_text) != ''
            ORDER BY a.created_at ASC
            """,
            (start_utc, end_utc),
        ).fetchall()

        # Позивні (Хто=caller, Кому=callee) для задіяних повідомлень.
        msg_ids = sorted({r["mid"] for r in rows if r["mid"] is not None})
        who: dict[int, list[str]] = {}
        whom: dict[int, list[str]] = {}
        if msg_ids:
            placeholders = ",".join("?" for _ in msg_ids)
            cs_rows = conn.execute(
                f"""
                SELECT mc.message_id AS mid, mc.role AS role, cs.name AS name
                FROM message_callsigns mc
                JOIN callsigns cs ON cs.id = mc.callsign_id
                WHERE mc.message_id IN ({placeholders})
                  AND mc.role IN ('caller', 'callee')
                """,
                msg_ids,
            ).fetchall()
            for cr in cs_rows:
                name = (cr["name"] or "").strip()
                if not name:
                    continue
                bucket = who if cr["role"] == "caller" else whom
                lst = bucket.setdefault(cr["mid"], [])
                if name not in lst:
                    lst.append(name)

    # Групування у пули за бригадно-полковим підрозділом (ключ) + повна назва
    # для заголовка (найчастіша серед підрозділів пулу).
    from collections import Counter
    from app.reports.rer_report import _group_sort_key  # службова сортувальна

    pools_map: dict[str, dict] = {}
    for r in rows:
        dt_disp = _to_kyiv(r["m_created"] or r["a_created"])
        mid = r["mid"]
        unit = (r["unit"] or "").strip()
        item = RerItem(
            conclusion=_clean_conclusion(r["conclusion"]),
            points=_points_from_mgrs_json(r["mgrs_json"]),
            date=dt_disp.strftime("%d.%m.%Y") if dt_disp else "",
            time=dt_disp.strftime("%H:%M") if dt_disp else "",
            freq=(r["frequency"] or "").strip(),
            unit=unit,
            location=_rayon_from_conclusion(r["conclusion"]),
            who=", ".join(who.get(mid, [])) if mid is not None else "",
            whom=", ".join(whom.get(mid, [])) if mid is not None else "",
            text=(r["body_text"] or "").strip(),
        )
        entry = pools_map.setdefault(subunit_group(unit), {"full": Counter(), "items": []})
        entry["full"][subunit_full(unit)] += 1
        entry["items"].append(item)

    pools = []
    for key in sorted(pools_map.keys(), key=_group_sort_key):
        entry = pools_map[key]
        header = entry["full"].most_common(1)[0][0] if entry["full"] else key
        pools.append((header, entry["items"]))

    content, filename = build_rer_donesennya_docx_bytes(
        direction="Лиманський напрямок",
        pools=pools,
        report_dt=report_dt,
        period_label=period_label,
        filename_range=filename_range,
    )
    bio = BytesIO(content)
    headers = {"Content-Disposition": _content_disposition_attachment(filename)}
    return StreamingResponse(
        bio,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers=headers,
    )

