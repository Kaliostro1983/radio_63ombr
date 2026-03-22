from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

from app.reports.enemy_moves_config import load_reports_config
from app.services.network_search import search_network_rows

EXCLUDED_STATUS_IDS: tuple[int, int] = (2, 4)  # "За межами", "Досліджується" (statuses.id)


@dataclass(frozen=True)
class EtalonReportNetwork:
    network_id: int
    frequency: str
    unit: str
    zone: str
    group_name: str
    status_name: str
    callsigns: list[str]
    has_etalon: bool
    start_date: str | None
    end_date: str | None
    purpose: str | None
    correspondents: str | None
    operation_mode: str | None
    traffic_type: str | None


def _set_base_font_12(doc: Document) -> None:
    style = doc.styles["Normal"]
    style.font.size = Pt(12)


def _add_header(doc: Document, *, title: str, subtitle: str) -> None:
    p1 = doc.add_paragraph()
    p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r1 = p1.add_run(title)
    r1.bold = True
    r1.font.size = Pt(14)

    p2 = doc.add_paragraph()
    p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r2 = p2.add_run(subtitle)
    r2.font.size = Pt(14)

    doc.add_paragraph("")


def _to_display_frequency(frequency: str, mask: str | None) -> str:
    freq = (frequency or "").strip()
    m = (mask or "").strip() if mask else ""
    return f"{freq} / {m}" if m else freq


def _in_placeholders(count: int) -> str:
    return ",".join(["?"] * count)


def _parse_date_any(value: str | None) -> date | None:
    """Parse DB TEXT date stored as ISO (YYYY-MM-DD) or as dd.mm.yyyy."""
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Most common: ISO date from HTML <input type="date">.
    try:
        return date.fromisoformat(s)
    except Exception:
        pass
    # Fallback: dd.mm.yyyy.
    for fmt in ("%d.%m.%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except Exception:
            continue
    return None


def _format_ddmmyyyy(d: date | None) -> str:
    if not d:
        return ""
    return d.strftime("%d.%m.%Y")


def _load_networks_for_report(conn, *, query: str) -> list[dict[str, Any]]:
    """Load networks for etalons report.

    If query is provided - try to match networks by it (like the UI search).
    Otherwise - load all networks except excluded statuses.
    """
    q = (query or "").strip()
    if q:
        candidates = search_network_rows(conn, q, limit=500)
        ids = [int(r["id"]) for r in candidates if r and r["id"] is not None]
        if not ids:
            return []
        placeholders = _in_placeholders(len(ids))
        sql = f"""
            SELECT
              n.id,
              n.frequency,
              n.mask,
              n.unit,
              n.zone,
              COALESCE(g.name, '') AS group_name,
              n.status_id,
              COALESCE(s.name, '') AS status_name
            FROM networks n
            LEFT JOIN statuses s ON s.id = n.status_id
            LEFT JOIN groups g ON g.id = n.group_id
            WHERE n.id IN ({placeholders})
              AND n.status_id NOT IN (?,?)
            ORDER BY n.frequency ASC, n.id ASC
        """
        return conn.execute(sql, [*ids, *EXCLUDED_STATUS_IDS]).fetchall()

    sql = """
        SELECT
          n.id,
          n.frequency,
          n.mask,
          n.unit,
          n.zone,
          COALESCE(g.name, '') AS group_name,
          n.status_id,
          COALESCE(s.name, '') AS status_name
        FROM networks n
        LEFT JOIN statuses s ON s.id = n.status_id
        LEFT JOIN groups g ON g.id = n.group_id
        WHERE n.status_id NOT IN (?,?)
        ORDER BY n.frequency ASC, n.id ASC
    """
    return conn.execute(sql, list(EXCLUDED_STATUS_IDS)).fetchall()


def _load_etalons_map(conn, *, network_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not network_ids:
        return {}
    placeholders = _in_placeholders(len(network_ids))
    sql = f"""
        SELECT
          network_id,
          start_date,
          end_date,
          purpose,
          correspondents,
          operation_mode,
          traffic_type
        FROM etalons
        WHERE network_id IN ({placeholders})
    """
    rows = conn.execute(sql, network_ids).fetchall()
    out: dict[int, dict[str, Any]] = {}
    for r in rows:
        out[int(r["network_id"])] = r
    return out


def _load_callsigns_map(conn, *, network_ids: list[int]) -> dict[int, list[str]]:
    if not network_ids:
        return {}
    placeholders = _in_placeholders(len(network_ids))
    sql = f"""
        SELECT network_id, name
        FROM callsigns
        WHERE network_id IN ({placeholders})
        ORDER BY network_id ASC, name ASC
    """
    rows = conn.execute(sql, network_ids).fetchall()
    out: dict[int, list[str]] = {}
    for r in rows:
        nid = int(r["network_id"])
        out.setdefault(nid, []).append((r["name"] or "").strip())
    return out


def build_etalons_docx_bytes(*, conn, query: str = "", report_date: date | None = None) -> tuple[bytes, str]:
    cfg_root = load_reports_config()
    cfg = cfg_root.get("etalons") if isinstance(cfg_root, dict) else None
    cfg = cfg if isinstance(cfg, dict) else {}

    today = report_date or datetime.now().date()
    date_str = today.strftime("%d.%m.%Y")

    title = str(cfg.get("title") or "Звіт по еталонних описах")
    subtitle_template = str(cfg.get("subtitle_template") or "за результатами стану мереж ({date})")
    subtitle = subtitle_template.format(date=date_str)
    empty_text = str(cfg.get("empty_text") or "За наявними даними мереж для звіту не знайдено.")
    filename_template = str(cfg.get("filename_template") or "Еталонні описи ({date}).docx")
    filename = filename_template.format(date=date_str)

    networks = _load_networks_for_report(conn, query=query)
    network_ids = [int(n["id"]) for n in networks if n and n["id"] is not None]
    et_map = _load_etalons_map(conn, network_ids=network_ids)
    callsigns_map = _load_callsigns_map(conn, network_ids=network_ids)

    items: list[EtalonReportNetwork] = []
    for n in networks:
        nid = int(n["id"])
        et = et_map.get(nid)

        items.append(
            EtalonReportNetwork(
                network_id=nid,
                frequency=(n["frequency"] or "").strip(),
                unit=(n["unit"] or "").strip(),
                zone=(n["zone"] or "").strip(),
                group_name=(n["group_name"] or "").strip(),
                status_name=(n["status_name"] or "").strip(),
                callsigns=[c for c in callsigns_map.get(nid, []) if (c or "").strip()],
                has_etalon=bool(et),
                start_date=(et["start_date"] if et else None),
                end_date=(et["end_date"] if et else None),
                purpose=(et["purpose"] if et else None),
                correspondents=(et["correspondents"] if et else None),
                operation_mode=(et["operation_mode"] if et else None),
                traffic_type=(et["traffic_type"] if et else None),
            )
        )

    doc = Document()
    _set_base_font_12(doc)
    _add_header(doc, title=title, subtitle=subtitle)

    if not items:
        doc.add_paragraph(empty_text)
    else:
        section_subtitle = str(
            cfg.get(
                "section_subtitle"
            )
            or "Для КХ та УКХ діапазонів радіохвиль (з урахуванням виявлених джерел маневреними групами РЕР частин РЕР у районах виконання завдань)"
        ).strip()
        modulation = str(cfg.get("modulation") or "NFM").strip()

        for idx, it in enumerate(items):
            doc.add_paragraph(section_subtitle)

            if not it.has_etalon:
                missing_text = f"Немає еталонного опису для частоти {it.frequency}"
                if it.status_name:
                    missing_text += f" (статус: {it.status_name})."
                doc.add_paragraph(missing_text)
            else:
                # The desktop DOCX uses a fixed form layout with lines 1..10.
                # We keep labels close to the sample "Форма 1.5.3".
                # Match desktop report format:
                # "УКХ р/м {unit}, н.п. {zone}"
                net_name = f"УКХ р/м {it.unit}, н.п. {it.zone}".replace("  ", " ").strip()
                sd = _parse_date_any(it.start_date)
                start_part = _format_ddmmyyyy(sd) if sd else "невідомої дати"

                ed = _parse_date_any(it.end_date) or today
                end_part = _format_ddmmyyyy(ed) or date.today().strftime("%d.%m.%Y")

                doc.add_paragraph(f"1. Назва радіомережі: {net_name}")
                doc.add_paragraph(f"2. Район функціонування/розгортання: {it.zone}")
                doc.add_paragraph(f"3. Призначення: {(it.purpose or '—').strip()}")
                doc.add_paragraph(f"4. Склад кореспондентів: {(it.correspondents or '—').strip()}")
                doc.add_paragraph(
                    f"5. Позивні: {', '.join(it.callsigns) if it.callsigns else '—'}"
                )
                doc.add_paragraph(f"6. Частоти: {it.frequency}")
                doc.add_paragraph(f"7. Вид передачі: {modulation}")
                doc.add_paragraph(f"8. Режим роботи: {(it.operation_mode or '—').strip()}")
                doc.add_paragraph(f"9. Характер роботи: {(it.traffic_type or '—').strip()}")
                doc.add_paragraph(f"10. Період функціонування: з {start_part} по {end_part}")

            if idx < len(items) - 1:
                doc.add_page_break()

    bio = BytesIO()
    doc.save(bio)
    return bio.getvalue(), filename


__all__ = ["build_etalons_docx_bytes"]

