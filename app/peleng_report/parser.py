"""Peleng WhatsApp/export text parser.

This parser converts a block of human text (often copied from WhatsApp
export or similar sources) into a stream of peleng records suitable for
reporting.

Supported header formats include:
    - WhatsApp export prefix: `[07:29, 28.02.2026] Name: 146.6350 / 28.02.2026 07.26`
    - bare header: `146.6350 / 28.02.2026 07.26`
    - legacy prefix: `Пеленг РЕР_63: 146.6350 / 28.02.2026 07.26`

Each header is followed by 1..N MGRS coordinate lines. Each coordinate
line becomes a separate record in the output.
"""

# src/pelengreport/parser.py
from __future__ import annotations

import re
import logging
from dataclasses import dataclass, field
from typing import Iterable, Iterator, Dict, Any, List, Optional


# 1) Заголовки можуть бути:
#   A) WhatsApp export:
#      [07:29, 28.02.2026] Сірко: 146.6350 / 28.02.2026 07.26
#   B) "голий" заголовок:
#      146.6350 / 28.02.2026 07.26
#   C) старий "службовий" формат (залишаємо для сумісності):
#      Пеленг РЕР_63: 146.6350 / 28.02.2026 07.26
#
# Підтримуємо / або \, пробіли будь-які, час з : або .


_HDR = re.compile(
    r"""
    ^
    (?:\[\d{2}:\d{2},\s*\d{2}\.\d{2}\.\d{4}\]\s*[^:]+:\s*)?        # WhatsApp prefix (optional)
    (?:Пеленг\s+РЕР_63:\s*)?                                        # legacy prefix (optional)
    (?P<freq>\d{2,3}(?:\.\d{1,4})?)\s*                              # frequency
    [/\\]\s*                                                        # slash or backslash
    (?P<date>\d{2}\.\d{2}\.(?:\d{2}|\d{4}))\s+                      # date
    (?P<time>\d{1,2}[:.]\d{2})                                      # time (hh:mm or hh.mm)
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

_SPACE_RE = re.compile(r"\s+")
_MGRS_LAST_TWO_5 = re.compile(r"^\d{5}$")


@dataclass
class ParseDiag:
    suspicious_headers: List[str] = field(default_factory=list)
    coord_break_lines: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


def _norm_spaces(s: str) -> str:
    """Normalize whitespace to single spaces and strip ends."""
    return _SPACE_RE.sub(" ", (s or "").strip())


def norm_time(t: str) -> str:
    """Normalize time token into `HH:MM`."""
    t = (t or "").strip().replace(".", ":")
    # "7:26" -> "07:26"
    if len(t) == 4 and t[1] == ":":
        t = "0" + t
    return t


def norm_date(d: str) -> str:
    """Normalize date token into `DD.MM.YYYY` (expand 2-digit year)."""
    d = (d or "").strip()
    parts = d.split(".")
    if len(parts) == 3 and len(parts[2]) == 2:
        parts[2] = "20" + parts[2]
        d = ".".join(parts)
    return d


def sanitize_mgrs(line: str) -> str:
    """
    Приймаємо MGRS у вигляді:
      37U DQ 19732 20311
    Допускаємо будь-які пробіли між токенами.
    """
    s = _norm_spaces(line)
    parts = s.split(" ")
    if len(parts) < 4:
        raise ValueError("Недостатньо токенів для MGRS")
    t0, t1, d1, d2 = parts[0].upper(), parts[1].upper(), parts[-2], parts[-1]
    if not (_MGRS_LAST_TWO_5.match(d1) and _MGRS_LAST_TWO_5.match(d2)):
        raise ValueError("Останні два блоки MGRS мають бути по 5 цифр")
    return f"{t0} {t1} {d1} {d2}"


def parse_whatsapp_text(lines: Iterable[str], diag: Optional[ParseDiag] = None) -> Iterator[Dict[str, Any]]:
    """
    Один заголовок -> 1..N MGRS. Кожна координата - окремий запис.

    Повертає dict:
      {freq_or_mask, unit_desc, dt, mgrs}
    """
    # The parser is resilient to noisy exports: it scans line-by-line,
    # detects headers with regex, then collects subsequent MGRS lines until
    # the next header.
    if diag is None:
        diag = ParseDiag()

    lines_list = list(lines)
    logging.warning(f"Парсинг WhatsApp тексту: {len(lines_list)} рядків")

    def looks_like_header(s: str) -> bool:
        return bool(_HDR.match(_norm_spaces(s)))

    def looks_like_mgrs(s: str) -> bool:
        try:
            sanitize_mgrs(s)
            return True
        except Exception:
            return False

    i, n = 0, len(lines_list)
    while i < n:
        raw = lines_list[i].rstrip("\n")
        s = _norm_spaces(raw)
        m = _HDR.match(s)
        if not m:
            # якщо рядок "схожий на заголовок" (є "/" і дата), але regex не взяв — у suspicious
            if ("/" in s or "\\" in s) and re.search(r"\d{2}\.\d{2}\.\d{2,4}", s):
                diag.suspicious_headers.append(raw)
            i += 1
            continue

        try:
            freq_s = m.group("freq")
            date_s = norm_date(m.group("date"))
            time_s = norm_time(m.group("time"))
            dt_s = f"{date_s} {time_s}"
        except Exception as e:
            diag.errors.append(f"{type(e).__name__}: {e}")
            i += 1
            continue

        # Опис зазвичай на наступному рядку; інколи може тягнутись ще одним рядком
        i += 1
        if i >= n:
            break

        desc = _norm_spaces(lines_list[i])
        j = i + 1
        if j < n and (not looks_like_header(lines_list[j])) and (not looks_like_mgrs(lines_list[j])):
            # склеюємо ще один рядок опису, якщо це не заголовок і не координата
            desc = _norm_spaces(desc + " " + lines_list[j])
            i = j

        # Збираємо 1..N координат до наступного заголовка
        coords: List[str] = []
        k = i + 1
        while k < n and (not looks_like_header(lines_list[k])):
            line_k = lines_list[k].strip()
            if not line_k:
                k += 1
                continue
            try:
                coords.append(sanitize_mgrs(line_k))
            except Exception:
                # перша "не координата" зупиняє збір координат для цього заголовка
                diag.coord_break_lines.append(lines_list[k].rstrip("\n"))
                break
            k += 1

        for mgrs in coords:
            yield {
                "freq_or_mask": freq_s,
                "unit_desc": desc,
                "dt": dt_s,
                "mgrs": mgrs,
            }

        i = k


__all__ = ["parse_whatsapp_text", "sanitize_mgrs", "norm_time", "norm_date", "ParseDiag"]