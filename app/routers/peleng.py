# app/routers/peleng.py
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
import re
from datetime import datetime

from app.core.db import get_db  # у вас init_db() викликається в main.py :contentReference[oaicite:1]{index=1}


class SaveIn(BaseModel):
    date: str          # YYYY-MM-DD
    time: str          # HH:MM
    freq_or_mask: str  # що в полі (ми нормалізуємо до 4)
    mgrs_text: str     # textarea з MGRS

class SaveOut(BaseModel):
    ok: bool
    batch_id: int
    
    
router = APIRouter()

@router.post("/peleng/save", response_model=SaveOut)
def peleng_save(payload: SaveIn):
    # 1) базова перевірка
    missing = []
    if not (payload.date or "").strip(): missing.append("Дата")
    if not (payload.time or "").strip(): missing.append("Час")
    if not (payload.freq_or_mask or "").strip(): missing.append("Частота/Маска")
    if not (payload.mgrs_text or "").strip(): missing.append("MGRS")
    if missing:
        return JSONResponse(status_code=400, content={"detail": f"Заповни: {', '.join(missing)}"})

    # 2) нормалізуємо частоту/маску до 4 знаків
    try:
        value4 = norm4(payload.freq_or_mask)
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Невірний формат частоти/маски"})

    # 3) MGRS: санітизація
    raw_lines = [ln for ln in payload.mgrs_text.splitlines() if ln.strip()]
    lines = []
    bad_idx = []
    for i, ln in enumerate(raw_lines, 1):
        try:
            lines.append(sanitize_mgrs_line(ln))
        except Exception:
            bad_idx.append(i)
    if bad_idx:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Невірний формат цифр у рядках: {bad_idx}. Очікується два блоки по 5 цифр наприкінці."}
        )

    # 4) event_dt у форматі ISO (або як у вас прийнято)
    # якщо в БД event_dt TEXT — це ок
    event_dt = f"{payload.date} {payload.time}:00"

    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO peleng_batches (event_dt, frequency) VALUES (?, ?)",
            (event_dt, value4)
        )
        batch_id = cur.lastrowid

        db.executemany(
            "INSERT INTO peleng_points (batch_id, mgrs) VALUES (?, ?)",
            [(batch_id, mgrs) for mgrs in lines]
        )
        db.commit()
    finally:
        db.close()

    return {"ok": True, "batch_id": batch_id}



# ---------- helpers ----------
MASK_PREFIXES = ("100", "200", "300")
_mgrs_space_re = re.compile(r"\s+")

def _to_float(value: str) -> float:
    return float(str(value).strip().replace(",", "."))

def norm4(value: str) -> str:
    v = _to_float(value)
    return f"{v:.4f}"

def is_mask_like(value: str) -> bool:
    s = str(value or "").strip()
    return s.startswith(MASK_PREFIXES)

def sanitize_mgrs_line(line: str) -> str:
    s = (line or "").strip()
    if not s:
        raise ValueError("Порожній рядок")
    s = _mgrs_space_re.sub(" ", s)
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
    # date_iso: YYYY-MM-DD, time: HH:MM  ->  DD.MM.YYYY HH.MM
    y, m, d = date_iso.split("-")
    hh, mi = time_hhmm.split(":")
    return f"{d}.{m}.{y} {hh}.{mi}"

def fetch_unit_zone_by_value(db, value4: str):
    # шукаємо по ВВЕДЕНОМУ значенню: або frequency, або mask
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

# ---------- page ----------
@router.get("/peleng", response_class=HTMLResponse)
def peleng_page(request: Request):
    # ваш шаблон є в templates/peleng.html :contentReference[oaicite:2]{index=2}
    return request.app.state.templates.TemplateResponse("peleng.html", {"request": request})

# ---------- API models ----------
class AcceptIn(BaseModel):
    value: str  # частота/маска як ввів користувач

class AcceptOut(BaseModel):
    display_value: str
    unit: str | None = None
    location: str | None = None  # це zone

class GenerateIn(BaseModel):
    date: str          # YYYY-MM-DD
    time: str          # HH:MM
    freq_or_mask: str  # вже нормалізоване (або ні — ми підстрахуємось)
    unit: str
    location: str
    mgrs_text: str
    comment: str | None = None

class GenerateOut(BaseModel):
    text: str

@router.post("/peleng/accept", response_model=AcceptOut)
def peleng_accept(payload: AcceptIn):
    raw = (payload.value or "").strip()
    if not raw:
        return JSONResponse(status_code=400, content={"detail": "Порожнє значення"})

    # маску теж нормалізуємо до 4 знаків (як ти сказав)
    try:
        value4 = norm4(raw)
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Невірний формат числа"})

    db = get_db()
    try:
        unit, zone = fetch_unit_zone_by_value(db, value4)
    finally:
        db.close()

    # display_value: якщо це маска — лишаємо маску, якщо частота — лишаємо частоту
    # але оскільки обидва формати однакові, тут просто повертаємо value4
    return {"display_value": value4, "unit": unit, "location": zone}

@router.post("/peleng/generate", response_model=GenerateOut)
def peleng_generate(payload: GenerateIn):
    # 1) перевірка обов'язкових даних
    missing = []
    if not (payload.date or "").strip(): missing.append("Дата")
    if not (payload.time or "").strip(): missing.append("Час")
    if not (payload.freq_or_mask or "").strip(): missing.append("Частота/Маска")
    if not (payload.unit or "").strip(): missing.append("Підрозділ")
    if not (payload.location or "").strip(): missing.append("Location")
    if not (payload.mgrs_text or "").strip(): missing.append("MGRS")
    if missing:
        return JSONResponse(status_code=400, content={"detail": f"Заповни: {', '.join(missing)}"})

    # 2) нормалізуємо freq/mask до 4 знаків (підстраховка)
    try:
        freq_or_mask4 = norm4(payload.freq_or_mask)
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Невірний формат частоти/маски"})

    # 3) MGRS: санітизація та валідація рядків (як у десктопі)
    raw_lines = [ln for ln in payload.mgrs_text.splitlines() if ln.strip()]
    if not raw_lines:
        return JSONResponse(status_code=400, content={"detail": "Немає MGRS рядків"})

    lines = []
    bad_idx = []
    for i, ln in enumerate(raw_lines, 1):
        try:
            lines.append(sanitize_mgrs_line(ln))
        except Exception:
            bad_idx.append(i)
    if bad_idx:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Невірний формат цифр у рядках: {bad_idx}. Очікується два блоки по 5 цифр наприкінці."}
        )

    # 4) формуємо фінальний текст
    dt_str = fmt_dt(payload.date, payload.time)
    desc = f"УКХ р/м {payload.unit.strip()} ({payload.location.strip()})"
    out_lines = [f"{freq_or_mask4} / {dt_str}", desc, *lines]

    comment = (payload.comment or "").strip()
    if comment:
        out_lines.append(comment)

    text = "\n".join(out_lines)
    return {"text": text}