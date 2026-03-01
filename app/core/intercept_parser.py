from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, List, Dict, Any

# 27.02.2026, 16:43:47  або  27.02.2026 16:00:21
RE_DT = re.compile(r"^\s*\d{2}\.\d{2}\.\d{4}[,\s]+\d{2}:\d{2}:\d{2}\s*$")

# 166.8000 / 300.3010 / 200.2720
RE_FREQ = re.compile(r"^\s*\d{2,3}\.\d{4}\s*$")

# net line must contain "укх" and "р/м" (case-insensitive)
RE_NETLINE = re.compile(r"(?i)\bукх\b.*\bр/м\b")

# everything inside first (...) is zone candidate
RE_ZONE_IN_PARENS = re.compile(r"\(([^)]*?)\)")

# everything after "р/м"
RE_AFTER_RM = re.compile(r"(?i)р/м\s+(.*)$")


def first_nonempty_lines(text: str, n: int = 2) -> List[str]:
    out: List[str] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if s:
            out.append(s)
        if len(out) >= n:
            break
    return out


def is_template_intercept(text: str) -> bool:
    head = first_nonempty_lines(text, 2)
    if len(head) < 2:
        return False
    return bool(RE_DT.match(head[0])) and bool(RE_FREQ.match(head[1]))


def _norm_s(v: Optional[str]) -> Optional[str]:
    v = (v or "").strip()
    return v or None


def looks_like_callsign(s: str) -> bool:
    s = (s or "").strip()
    if not s:
        return False
    if len(s) > 40:
        return False
    # якщо це схоже на нумерований пункт або фразу з пунктуацією — це не позивний
    if re.search(r"[.,:;]", s):
        return False
    if re.fullmatch(r"\d+", s):
        return False
    return True


def extract_unit_zone(net_line: str) -> tuple[Optional[str], Optional[str]]:
    net_line = net_line.strip()

    # zone from parentheses
    zone = None
    m = RE_ZONE_IN_PARENS.search(net_line)
    if m:
        zone = m.group(1).strip()
        # прибираємо "р-н" як шум на початку
        zone = re.sub(r"(?i)^\s*р-?н\s*", "", zone).strip()
        zone = zone or None

    # unit from text after "р/м", without parentheses
    unit = None
    m2 = RE_AFTER_RM.search(net_line)
    if m2:
        unit_raw = m2.group(1).strip()
        unit_raw = re.sub(r"\([^)]*\)", "", unit_raw).strip()
        unit = unit_raw or None

    return unit, zone


def parse_template_intercept(text: str) -> Dict[str, Any]:
    """
    Expected template:
      1) datetime
      2) frequency
      3) net_line (укх р/м ...)
      4) callee (optional)
      5) caller (optional)
      6+) body

    Validation rules:
      - net_line must contain "укх" and "р/м"
      - if callee/caller don't look like callsigns -> set to None (but do NOT shift fields)
    """
    nz = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]

    if len(nz) < 3:
        return {"ok": False, "error": "too_few_lines"}

    published_at_text = nz[0]
    frequency = nz[1]
    net_line = nz[2]

    if not RE_DT.match(published_at_text):
        return {"ok": False, "error": "dt_invalid"}

    if not RE_FREQ.match(frequency):
        return {"ok": False, "error": "freq_invalid"}

    if not RE_NETLINE.search(net_line):
        return {"ok": False, "error": "net_line_invalid"}

    unit, zone = extract_unit_zone(net_line)

    callee = nz[3] if len(nz) > 3 else None
    caller = nz[4] if len(nz) > 4 else None

    if callee and not looks_like_callsign(callee):
        callee = None
    if caller and not looks_like_callsign(caller):
        caller = None

    body = "\n".join(nz[5:]) if len(nz) > 5 else ""

    return {
        "ok": True,
        "published_at_text": published_at_text,
        "frequency": frequency.strip(),
        "mask": None,  # якщо потім додаси маску в парсер — тут заповниш
        "unit": unit,
        "zone": zone,
        "caller": _norm_s(caller),
        "callees": [_norm_s(callee)] if _norm_s(callee) else [],
        "body": body,
        "parse_confidence": 0.95,
    }