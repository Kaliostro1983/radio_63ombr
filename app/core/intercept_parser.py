from __future__ import annotations

import re
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
    # кома тут не допускається: CSV-рядок розбираємо окремо
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


def split_callsigns_line(line: Optional[str]) -> List[str]:
    s = (line or "").strip()
    if not s:
        return []

    parts = [p.strip() for p in s.split(",")]
    out: List[str] = []

    for part in parts:
        if not part:
            continue
        if looks_like_callsign(part):
            out.append(part)

    return out


def is_body_line(line: Optional[str]) -> bool:
    s = (line or "").strip()
    if not s:
        return False

    # типові маркери початку тексту перехоплення
    if s.startswith("—") or s.startswith("-"):
        return True

    return False


def parse_template_intercept(text: str) -> Dict[str, Any]:
    """
    Supported template cases:

    A) Standard:
       1) datetime
       2) frequency
       3) net_line
       4) callee
       5) caller
       6+) body

    B) Broken:
       1) datetime
       2) frequency
       3) net_line
       4) caller
       5) callee1, callee2, ...
       6+) body

    C) No callsigns:
       1) datetime
       2) frequency
       3) net_line
       4+) body

       => caller = "НВ", callees = ["НВ"]
    """

    lines = [ln.strip() for ln in (text or "").splitlines()]
    nonempty = [ln for ln in lines if ln]

    if len(nonempty) < 3:
        return {"ok": False, "error": "too_few_lines"}

    published_at_text = nonempty[0]
    frequency = nonempty[1]
    net_line = nonempty[2]

    if not RE_DT.match(published_at_text):
        return {"ok": False, "error": "dt_invalid"}

    if not RE_FREQ.match(frequency):
        return {"ok": False, "error": "freq_invalid"}

    if not RE_NETLINE.search(net_line):
        return {"ok": False, "error": "net_line_invalid"}

    unit, zone = extract_unit_zone(net_line)

    tail = nonempty[3:]

    caller: Optional[str] = None
    callees: List[str] = []
    body_start_idx = 0

    # Case C: після net_line нічого немає
    if not tail:
        caller = "НВ"
        callees = ["НВ"]
        body_start_idx = 0

    # Case C: після net_line одразу починається тіло
    elif is_body_line(tail[0]):
        caller = "НВ"
        callees = ["НВ"]
        body_start_idx = 0

    # Case B: caller + csv-callees
    elif len(tail) >= 2 and "," in tail[1]:
        maybe_caller = _norm_s(tail[0])
        maybe_callees = split_callsigns_line(tail[1])

        caller = maybe_caller if maybe_caller and looks_like_callsign(maybe_caller) else "НВ"
        callees = maybe_callees or ["НВ"]
        body_start_idx = 2

    # Case A: callee + caller
    else:
        maybe_callee = _norm_s(tail[0]) if len(tail) >= 1 else None
        maybe_caller = _norm_s(tail[1]) if len(tail) >= 2 else None

        parsed_callees: List[str] = []
        if maybe_callee and looks_like_callsign(maybe_callee):
            parsed_callees = [maybe_callee]

        parsed_caller: Optional[str] = None
        if maybe_caller and looks_like_callsign(maybe_caller):
            parsed_caller = maybe_caller

        caller = parsed_caller or "НВ"
        callees = parsed_callees or ["НВ"]
        body_start_idx = 2 if len(tail) >= 2 else 1

    body = "\n".join(tail[body_start_idx:]).strip()

    return {
        "ok": True,
        "published_at_text": published_at_text,
        "frequency": frequency.strip(),
        "mask": None,  # якщо потім додаси маску в парсер — тут заповниш
        "unit": unit,
        "zone": zone,
        "net_line": net_line,
        "caller": _norm_s(caller) or "НВ",
        "callees": callees if callees else ["НВ"],
        "body": body,
        "parse_confidence": 0.95,
    }