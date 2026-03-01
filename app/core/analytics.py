from __future__ import annotations
import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from app.core.intercept_parser import is_template_intercept, parse_template_intercept

DT_RE = re.compile(r"^\s*(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2}:\d{2})\s*$")
FREQ_RE = re.compile(r"^\s*(\d{2,3}\.\d{3,4})\s*$")

def _to_iso_from_text(dt_line: str) -> Optional[str]:
    m = DT_RE.match(dt_line or "")
    if not m:
        return None
    d, t = m.group(1), m.group(2)
    # без TZ; нехай буде naive ISO, ти можеш потім додати TZ на рівні Node
    try:
        return datetime.strptime(f"{d} {t}", "%d.%m.%Y %H:%M:%S").isoformat()
    except ValueError:
        return None

def _split_lines(text: str) -> List[str]:
    return [ln.rstrip("\r") for ln in (text or "").split("\n")]

def parse_intercept_text(raw_text: str) -> Dict[str, Any]:
    
    if not is_template_intercept(raw_text):
        return {"ok": False, "error": "nonstandard format"}
    return parse_template_intercept(raw_text)

    """
    MVP парсер твого шаблону.
    Витягує:
      - published_at_text (ISO) якщо перший рядок має формат dd.mm.yyyy, HH:MM:SS
      - frequency
      - net_description (рядок 3)
      - caller + callees (рядки позивних до першого порожнього рядка/тіла)
      - body (все що після "шапки")
    """
    lines = _split_lines(raw_text)
    lines = [ln for ln in lines if ln is not None]

    published_at_text = None
    frequency = None
    net_description = None
    callsigns: List[str] = []
    body = ""

    # 1) published_at_text: шукаємо перший валідний рядок дати (зазвичай 1-й)
    if lines:
        published_at_text = _to_iso_from_text(lines[0])

    # 2) frequency: шукаємо перший рядок частоти після першого
    for i in range(1, min(len(lines), 10)):
        m = FREQ_RE.match(lines[i] or "")
        if m:
            frequency = m.group(1)
            freq_idx = i
            break
    else:
        freq_idx = None

    # 3) net_description: зазвичай наступний рядок після frequency
    if freq_idx is not None and freq_idx + 1 < len(lines):
        net_description = (lines[freq_idx + 1] or "").strip() or None
        start_callsigns = freq_idx + 2
    else:
        start_callsigns = 0

    # 4) callsigns: рядки після опису мережі до першого порожнього рядка або до лінії діалогу
    i = start_callsigns
    while i < len(lines):
        ln = (lines[i] or "").strip()
        if ln == "":
            i += 1
            break
        # якщо пішов діалог (— …) — зупиняємось
        if ln.startswith("—") or ln.startswith("-"):
            break
        # обмежимося простим правилом: позивний = короткий рядок без ком, до 40 символів
        if 0 < len(ln) <= 40:
            callsigns.append(ln)
            i += 1
            continue
        break

    # 5) body: решта тексту
    body = "\n".join(lines[i:]).strip()

    caller = callsigns[0] if callsigns else None
    callees = callsigns[1:] if len(callsigns) > 1 else []

    return {
        "published_at_text": published_at_text,
        "frequency": frequency,
        "net_description": net_description,
        "caller": caller,
        "callees": callees,
        "body": body,
        "parse_confidence": 0.8 if (published_at_text and frequency and caller) else 0.4,
    }

def callees_to_json(callees: List[str]) -> str:
    return json.dumps(callees, ensure_ascii=False)