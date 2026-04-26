"""UI and API router for peleng (direction finding) workflows.

This router provides the peleng UI page and a set of API endpoints for:

- normalizing and validating frequency/mask values;
- validating/sanitizing MGRS coordinate input;
- saving peleng batches/points into SQLite (`peleng_batches`, `peleng_points`);
- managing runtime `posts.json` configuration used by DOCX report templates;
- generating DOCX reports either from pasted text or from DB data by period;
- serving version and changelog endpoints used by the UI.

The router includes a number of helper functions for input cleaning and
record building. Complex DOCX generation is delegated to
`app.peleng_report.report.build_docx`, and WhatsApp text parsing to
`app.peleng_report.parser.parse_whatsapp_text`.
"""

# app/routers/peleng.py
from __future__ import annotations

import re
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from fastapi.responses import PlainTextResponse

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from app.core.db import get_db
from app.peleng_report.parser import parse_whatsapp_text
from app.peleng_report.report import build_docx
from app.peleng_report.runner import load_posts

import json
from pathlib import Path
from typing import Any


router = APIRouter()


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


MASK_PREFIXES = ("-", "—", "–")
MGRS_SPACE_RE = re.compile(r"\s+")

FALLBACK_UNIT = "НВ підрозділу"
FALLBACK_LOC = "ТОРСЬКЕ"
FALLBACK_UNIT_DESC = "УКХ р/м НВ підрозділу, н.п. УТОЧНЮЄТЬСЯ"


class ReportPreviewOut(BaseModel):
    batch_count: int
    point_count: int

class PostsSaveIn(BaseModel):
    posts: list[dict[str, Any]]


# =========================================================
# helpers
# =========================================================
def project_root() -> Path:
    """Return repository root directory for version/changelog/posts files."""
    return Path(__file__).resolve().parents[2]

def version_file_path() -> Path:
    """Return path to VERSION file (docs/VERSION)."""
    return project_root() / "docs" / "VERSION"

def changelog_file_path() -> Path:
    """Return path to docs/CHANGELOG.md."""
    return project_root() / "docs" / "CHANGELOG.md"

def read_version() -> str:
    """Read version string from VERSION file (fallback to 0.0.0)."""
    p = version_file_path()
    if not p.exists():
        return "0.0.0"
    return p.read_text(encoding="utf-8").strip() or "0.0.0"

def read_changelog() -> str:
    """Read changelog file content (fallback to a placeholder text)."""
    p = changelog_file_path()
    if not p.exists():
        return "# Changelog\n\nФайл changelog ще не створено."
    return p.read_text(encoding="utf-8")

def posts_json_path() -> Path:
    """Return path to runtime posts.json."""
    return Path(__file__).resolve().parents[2] / "posts.json"

def ensure_posts_json() -> Path:
    """Ensure posts.json exists (seed it with default posts if missing)."""
    p = posts_json_path()
    if p.exists():
        return p

    seed = [
        {
            "id": "post_1",
            "active": True,
            "name": "МІКОЛАЇВКА",
            "bp_number": "0000",
            "unit": "А3719\n(63 омбр)",
            "equipment": "Пластун",
        },
        {
            "id": "post_2",
            "active": True,
            "name": "МАЯКИ",
            "bp_number": "0001",
            "unit": "А3719\n(63 омбр)",
            "equipment": "Пластун",
        },
    ]
    p.write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")
    return p

def load_all_posts() -> list[dict]:
    """Load posts.json as a list of dicts (no filtering)."""
    p = ensure_posts_json()
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("posts.json має містити список")
    return data

def save_all_posts(posts: list[dict]) -> None:
    """Persist posts list to posts.json."""
    p = ensure_posts_json()
    p.write_text(json.dumps(posts, ensure_ascii=False, indent=2), encoding="utf-8")

def _to_float(value: str) -> float:
    """Parse string into float supporting comma decimal separator."""
    s = str(value or "").strip().replace(",", ".")
    if not s:
        raise ValueError("Порожнє значення")
    return float(s)


def norm4(value: str) -> str:
    """Normalize numeric input into a 4-decimal string representation."""
    v = _to_float(value)
    return f"{v:.4f}"


def is_mask_like(value: str) -> bool:
    """Return True if the value looks like a mask line (dash-prefixed)."""
    s = str(value or "").strip()
    return s.startswith(MASK_PREFIXES)


def sanitize_mgrs_line(line: str) -> str:
    """Validate and normalize a single MGRS line into canonical token spacing.

    Args:
        line: raw input line.

    Returns:
        str: normalized MGRS line formatted as `T0 T1 12345 67890`.
    """
    s = (line or "").strip()
    if not s:
        raise ValueError("Порожній рядок")

    s = MGRS_SPACE_RE.sub(" ", s)
    parts = s.split(" ")

    if len(parts) < 4:
        raise ValueError("Неповний рядок (очікується 4+ токени)")

    d1, d2 = parts[-2], parts[-1]
    if not (d1.isdigit() and d2.isdigit() and len(d1) == 5 and len(d2) == 5):
        raise ValueError("Цифрові блоки мають бути по 5 цифр")

    t0 = parts[0].upper()
    t1 = parts[1].upper()
    return f"{t0} {t1} {d1} {d2}"


def fmt_dt(date_iso: str, time_hhmm: str) -> str:
    """Format date/time into the message header format used in peleng texts."""
    # YYYY-MM-DD + HH:MM -> DD.MM.YYYY HH.MM
    y, m, d = date_iso.split("-")
    hh, mi = time_hhmm.split(":")
    return f"{d}.{m}.{y} {hh}.{mi}"


def fetch_unit_zone_by_value(db, value4: str):
    """Fetch unit/zone from networks table for a frequency/mask value."""
    # Для першого режиму лишаємо поточну поведінку:
    # шукаємо або по frequency, або по mask.
    cur = db.execute(
        """
        SELECT unit, zone
        FROM networks
        WHERE frequency = ? OR mask = ?
        LIMIT 1
        """,
        (value4, value4),
    )
    row = cur.fetchone()
    if not row:
        return None, None
    return row["unit"], row["zone"]


def fetch_network_id_by_frequency(db, value4: str) -> int | None:
    """Resolve latest network id for an exact frequency value."""
    row = db.execute(
        """
        SELECT id
        FROM networks
        WHERE frequency = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
        """,
        (value4,),
    ).fetchone()
    if not row:
        return None
    return int(row["id"])


def build_unit_desc(unit: str | None, zone: str | None) -> str:
    """Build a human-readable unit description for reports."""
    unit = (unit or "").strip()
    zone = (zone or "").strip()
    if unit and zone:
        return f"УКХ р/м {unit}, {zone}"
    return FALLBACK_UNIT_DESC


def fetch_latest_networks_by_frequencies(db, freqs: list[str]) -> dict[str, dict]:
    """
    Зв'язок ТІЛЬКИ по frequency.
    Якщо є дублікати frequency у вибірці — беремо latest by updated_at,
    tie-break: id DESC.
    """
    if not freqs:
        return {}

    placeholders = ",".join(["?"] * len(freqs))
    cur = db.execute(
        f"""
        SELECT frequency, unit, zone
        FROM (
            SELECT
                id,
                frequency,
                unit,
                zone,
                updated_at,
                ROW_NUMBER() OVER (
                    PARTITION BY frequency
                    ORDER BY updated_at DESC, id DESC
                ) AS rn
            FROM networks
            WHERE frequency IN ({placeholders})
        )
        WHERE rn = 1
        """,
        tuple(freqs),
    )

    result: dict[str, dict] = {}
    for row in cur.fetchall():
        result[str(row["frequency"])] = {
            "unit": row["unit"],
            "zone": row["zone"],
        }
    return result


def build_records_from_db_rows(batches, points, net_by_freq: dict[str, dict]) -> list[dict]:
    """Convert DB rows into record dicts expected by DOCX generator."""
    batch_by_id = {int(b["id"]): b for b in batches}
    records: list[dict] = []

    for p in points:
        batch = batch_by_id.get(int(p["batch_id"]))
        if not batch:
            continue

        freq = str(batch["frequency"])
        net = net_by_freq.get(freq) or {}

        records.append({
            "freq_or_mask": freq,
            "unit_desc": build_unit_desc(net.get("unit"), net.get("zone")),
            "dt": str(batch["event_dt"]),
            "mgrs": str(p["mgrs"]),
        })

    return records


def render_docx_bytes(records: list[dict]) -> tuple[bytes, str]:
    """Render DOCX content bytes for records using active posts config."""
    posts = load_posts(active_only=True)
    if not posts:
        raise RuntimeError("Немає активних постів у posts.json")

    filename = f"Форма_1.2.13_{datetime.now().strftime('%d.%m.%Y')}.docx"

    with tempfile.TemporaryDirectory() as td:
        out_path = Path(td) / filename
        build_docx(records, out_path, posts=posts)
        content = out_path.read_bytes()

    return content, filename

# =========================================================
# version and changelog
# =========================================================
@router.get("/version")
def app_version():
    """Return current app version as JSON."""
    return {"version": read_version()}

@router.get("/changelog", response_class=PlainTextResponse)
def app_changelog():
    """Return changelog content as plain text."""
    return read_changelog()

# =========================================================
# page
# =========================================================
@router.get("/peleng", response_class=HTMLResponse)
def peleng_page(request: Request):
    """Render peleng UI page."""
    return request.app.state.templates.TemplateResponse(
        "peleng.html",
        {"request": request},
    )


# =========================================================
# API models
# =========================================================
class AcceptIn(BaseModel):
    value: str


class AcceptOut(BaseModel):
    display_value: str
    unit: str | None = None
    location: str | None = None


class GenerateIn(BaseModel):
    date: str
    time: str
    freq_or_mask: str
    unit: str
    location: str
    mgrs_text: str
    comment: str | None = None


class GenerateOut(BaseModel):
    text: str


class SaveIn(BaseModel):
    date: str
    time: str
    freq_or_mask: str
    mgrs_text: str


class SaveOut(BaseModel):
    ok: bool
    batch_id: int


class ReportFromTextIn(BaseModel):
    text: str


# =========================================================
# API: accept
# =========================================================
@router.post("/peleng/accept", response_model=AcceptOut)
def peleng_accept(payload: AcceptIn):
    """Validate/normalize frequency input and fetch unit/zone if available."""
    raw = (payload.value or "").strip()
    if not raw:
        return JSONResponse(status_code=400, content={"detail": "Порожнє значення"})

    try:
        value4 = norm4(raw)
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Невірний формат числа"})

    db = get_db()
    try:
        unit, zone = fetch_unit_zone_by_value(db, value4)
    finally:
        db.close()

    return {
        "display_value": value4,
        "unit": unit,
        "location": zone,
    }


# =========================================================
# API: generate message
# =========================================================
@router.post("/peleng/generate", response_model=GenerateOut)
def peleng_generate(payload: GenerateIn):
    """Generate a peleng message text from form inputs (no DB writes)."""
    missing = []
    if not (payload.date or "").strip():
        missing.append("Дата")
    if not (payload.time or "").strip():
        missing.append("Час")
    if not (payload.freq_or_mask or "").strip():
        missing.append("Частота/Маска")
    if not (payload.unit or "").strip():
        missing.append("Підрозділ")
    if not (payload.location or "").strip():
        missing.append("Location")
    if not (payload.mgrs_text or "").strip():
        missing.append("MGRS")

    if missing:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Заповни: {', '.join(missing)}"},
        )

    try:
        value4 = norm4(payload.freq_or_mask)
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Невірний формат частоти/маски"})

    raw_lines = [ln for ln in payload.mgrs_text.splitlines() if ln.strip()]
    lines: list[str] = []
    bad_idx: list[int] = []

    for i, ln in enumerate(raw_lines, 1):
        try:
            lines.append(sanitize_mgrs_line(ln))
        except Exception:
            bad_idx.append(i)

    if bad_idx:
        return JSONResponse(
            status_code=400,
            content={
                "detail": (
                    f"Невірний формат цифр у рядках: {bad_idx}. "
                    "Очікується два блоки по 5 цифр наприкінці."
                )
            },
        )

    dt = fmt_dt(payload.date, payload.time)
    unit = payload.unit.strip()
    location = payload.location.strip()
    comment = (payload.comment or "").rstrip()

    out_lines = [
        f"Пеленгація {dt}",
        f"{value4} УКХ р/м {unit}, н.п. {location}",
        *lines,
    ]
    if comment:
        out_lines += ["", comment]

    return {"text": "\n".join(out_lines)}


# =========================================================
# API: save batch
# =========================================================
@router.post("/peleng/save", response_model=SaveOut)
def peleng_save(payload: SaveIn):
    """Persist a peleng batch and its MGRS points into SQLite."""
    missing = []
    if not (payload.date or "").strip():
        missing.append("Дата")
    if not (payload.time or "").strip():
        missing.append("Час")
    if not (payload.freq_or_mask or "").strip():
        missing.append("Частота/Маска")
    if not (payload.mgrs_text or "").strip():
        missing.append("MGRS")

    if missing:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Заповни: {', '.join(missing)}"},
        )

    try:
        value4 = norm4(payload.freq_or_mask)
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Невірний формат частоти/маски"})

    raw_lines = [ln for ln in payload.mgrs_text.splitlines() if ln.strip()]
    lines: list[str] = []
    bad_idx: list[int] = []

    for i, ln in enumerate(raw_lines, 1):
        try:
            lines.append(sanitize_mgrs_line(ln))
        except Exception:
            bad_idx.append(i)

    if bad_idx:
        return JSONResponse(
            status_code=400,
            content={
                "detail": (
                    f"Невірний формат цифр у рядках: {bad_idx}. "
                    "Очікується два блоки по 5 цифр наприкінці."
                )
            },
        )

    event_dt = f"{payload.date} {payload.time}:00"

    db = get_db()
    try:
        network_id = fetch_network_id_by_frequency(db, value4)
        cur = db.execute(
            "INSERT INTO peleng_batches (event_dt, network_id) VALUES (?, ?)",
            (event_dt, network_id),
        )
        batch_id = cur.lastrowid

        db.executemany(
            "INSERT INTO peleng_points (batch_id, mgrs) VALUES (?, ?)",
            [(batch_id, mgrs) for mgrs in lines],
        )
        db.commit()

        return {"ok": True, "batch_id": batch_id}
    except Exception as e:
        db.rollback()
        return JSONResponse(status_code=500, content={"detail": str(e)})
    finally:
        db.close()

# =========================================================
# API: peleng posts management
# =========================================================

@router.get("/peleng/posts")
def peleng_get_posts():
    """Return current posts configuration."""
    try:
        return {"posts": load_all_posts()}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@router.post("/peleng/posts/save")
def peleng_save_posts(payload: PostsSaveIn):
    """Validate and save posts configuration to posts.json."""
    try:
        posts = payload.posts or []

        normalized: list[dict] = []
        for idx, p in enumerate(posts, 1):
            normalized.append({
                "id": str(p.get("id") or f"post_{idx}").strip(),
                "active": bool(p.get("active", False)),
                "name": str(p.get("name") or "").strip(),
                "bp_number": str(p.get("bp_number") or "").strip(),
                "unit": str(p.get("unit") or "").rstrip(),
                "equipment": str(p.get("equipment") or "").strip(),
            })

        save_all_posts(normalized)
        return {"ok": True, "detail": "Пости збережено"}
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

# =========================================================
# API: peleng status summary (Актуальне tab)
# =========================================================

@router.get("/api/peleng/status-summary")
def peleng_status_summary():
    """Return peleng status for all networks that have peleng data."""
    from datetime import datetime, timedelta

    now = datetime.now()
    d3_start  = (now.date() - timedelta(days=3)).isoformat()  + " 00:00:00"
    d10_start = (now.date() - timedelta(days=10)).isoformat() + " 00:00:00"

    db = get_db()
    try:
        rows = db.execute(
            """
            SELECT
                n.id,
                n.frequency,
                COALESCE(n.mask, '')  AS mask,
                COALESCE(n.unit, '')  AS unit,
                MAX(pb.event_dt)      AS last_peleng_dt,
                COUNT(CASE WHEN pb.event_dt >= :d10 THEN pb.id END) AS peleng_count_10d,
                COALESCE((
                    SELECT COUNT(*)
                    FROM messages m
                    WHERE m.network_id = n.id
                      AND m.content_type = 'intercept'
                      AND COALESCE(m.is_valid, 1) = 1
                      AND m.created_at >= :d3
                ), 0) AS intercept_count_3d,
                GROUP_CONCAT(DISTINCT nt.name) AS tags
            FROM networks n
            INNER JOIN peleng_batches pb ON pb.network_id = n.id
            LEFT JOIN network_tag_links ntl ON ntl.network_id = n.id
            LEFT JOIN network_tags nt ON nt.id = ntl.tag_id
            GROUP BY n.id
            ORDER BY intercept_count_3d DESC, last_peleng_dt DESC
            """,
            {"d10": d10_start, "d3": d3_start},
        ).fetchall()

        result = []
        for row in rows:
            raw = row["last_peleng_dt"] or ""
            if raw:
                try:
                    ld = datetime.fromisoformat(raw[:19])
                    age_h = (now - ld).total_seconds() / 3600
                    status = "green" if age_h <= 72 else ("yellow" if age_h <= 192 else "red")
                    last_display = ld.strftime("%d.%m.%Y %H:%M")
                except ValueError:
                    status, last_display = "red", raw[:16]
            else:
                status, last_display = "red", ""

            result.append({
                "id": int(row["id"]),
                "frequency": row["frequency"],
                "mask": row["mask"],
                "unit": row["unit"],
                "tags": row["tags"] or "",
                "status": status,
                "last_peleng_dt": last_display,
                "peleng_count_10d": int(row["peleng_count_10d"] or 0),
                "intercept_count_3d": int(row["intercept_count_3d"] or 0),
            })

        return result
    finally:
        db.close()


# =========================================================
# API: preview report by period
# =========================================================

@router.get("/peleng/report/preview", response_model=ReportPreviewOut)
def peleng_report_preview(
    from_dt: str = Query(..., description="YYYY-MM-DD HH:MM:SS"),
    to_dt: str = Query(..., description="YYYY-MM-DD HH:MM:SS"),
):
    """Return counts of batches and points for a period (preview before report)."""
    db = get_db()
    try:
        batches = db.execute(
            """
            SELECT id
            FROM peleng_batches
            WHERE event_dt >= ? AND event_dt <= ?
            """,
            (from_dt, to_dt),
        ).fetchall()

        batch_count = len(batches)
        if batch_count == 0:
            return {"batch_count": 0, "point_count": 0}

        batch_ids = [int(b["id"]) for b in batches]
        placeholders = ",".join(["?"] * len(batch_ids))

        row = db.execute(
            f"""
            SELECT COUNT(*) AS cnt
            FROM peleng_points
            WHERE batch_id IN ({placeholders})
            """,
            tuple(batch_ids),
        ).fetchone()

        point_count = int(row["cnt"] or 0)
        return {"batch_count": batch_count, "point_count": point_count}
    finally:
        db.close()
        
# =========================================================
# API: report from pasted text
# =========================================================

@router.post("/peleng/report/from-text")
def peleng_report_from_text(payload: ReportFromTextIn):
    """Build a DOCX report from pasted WhatsApp/export text."""
    raw_text = (payload.text or "").strip()
    if not raw_text:
        return JSONResponse(status_code=400, content={"detail": "Текст для звіту порожній"})

    try:
        lines = raw_text.splitlines()
        records = list(parse_whatsapp_text(lines))

        if len(records) == 0:
            return JSONResponse(
                status_code=400,
                content={"detail": "Не вдалося витягти записи зі вставленого тексту"},
            )

        content, filename = render_docx_bytes(records)
        return Response(
            content=content,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": _content_disposition_attachment(filename)},
        )
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

# =========================================================
# API: report from DB period
# =========================================================
@router.get("/peleng/report/by-period")
def peleng_report_by_period(
    from_dt: str = Query(..., description="YYYY-MM-DD HH:MM:SS"),
    to_dt: str = Query(..., description="YYYY-MM-DD HH:MM:SS"),
):
    """Build a DOCX report from DB peleng data for a selected period."""
    db = get_db()
    try:
        batches = db.execute(
            """
            SELECT
                pb.id,
                pb.event_dt,
                COALESCE(n.frequency, '') AS frequency
            FROM peleng_batches pb
            LEFT JOIN networks n ON n.id = pb.network_id
            WHERE pb.event_dt >= ? AND pb.event_dt <= ?
            ORDER BY pb.event_dt ASC, pb.id ASC
            """,
            (from_dt, to_dt),
        ).fetchall()

        if not batches:
            return JSONResponse(
                status_code=400,
                content={"detail": "За вказаний період даних не знайдено"},
            )

        batch_ids = [int(b["id"]) for b in batches]
        placeholders = ",".join(["?"] * len(batch_ids))

        points = db.execute(
            f"""
            SELECT id, batch_id, mgrs
            FROM peleng_points
            WHERE batch_id IN ({placeholders})
            ORDER BY batch_id ASC, id ASC
            """,
            tuple(batch_ids),
        ).fetchall()

        freqs = sorted({str(b["frequency"]) for b in batches})
        net_by_freq = fetch_latest_networks_by_frequencies(db, freqs)

        records = build_records_from_db_rows(batches, points, net_by_freq)
        if not records:
            return JSONResponse(
                status_code=400,
                content={"detail": "Для вибраного періоду немає точок пеленгації"},
            )

        content, filename = render_docx_bytes(records)
        return Response(
            content=content,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": _content_disposition_attachment(filename)},
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})
    finally:
        db.close()