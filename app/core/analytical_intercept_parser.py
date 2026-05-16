"""Parser for analytical intercept messages with 4 logical blocks.

Analytical message contract:
1) analytical conclusion text (required);
2) coordinates block (optional, MGRS-like forms);
3) standard separator with brigade marker (`63 ОМБр`);
4) template intercept that is parsed by `parse_template_intercept`.
"""

from __future__ import annotations

import re
from typing import Any, Dict

from app.core.intercept_parser import parse_template_intercept


# Matches the brigade/unit separator line that divides analytical preamble
# from the standard template header.  Covers known variants:
# "------- 🐻 63 ОМБр 🐻 -------"  and  "---------- ꑭ ОБТВР ꑭ ----------"
RE_63_OMBR = re.compile(r"(63\s*омбр|обтвр)", flags=re.IGNORECASE)
RE_MGRS_ANY = re.compile(
    r"\b(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z]{2})\s*(\d{2,5})\s*(\d{2,5})\b",
    flags=re.IGNORECASE,
)


def _split_analytical_blocks(text: str) -> tuple[str, str]:
    """Split message into (preface, template_tail) by first 63 ОМБр separator."""
    lines = (text or "").splitlines()
    for idx, line in enumerate(lines):
        if RE_63_OMBR.search(str(line or "")):
            return "\n".join(lines[:idx]).strip(), "\n".join(lines[idx + 1 :]).strip()
    return "", ""


def _normalize_mgrs(zone: str, band: str, sq: str, easting: str, northing: str) -> str:
    """Normalize MGRS parts into compact canonical uppercase form."""
    return f"{zone}{band.upper()}{sq.upper()}{easting}{northing}"


def _extract_analytical_conclusion_and_mgrs(preface: str) -> tuple[str, list[str]]:
    """Extract conclusion text and normalize optional MGRS coordinates."""
    mgrs: list[str] = []
    cleaned_lines: list[str] = []

    for raw_line in (preface or "").splitlines():
        line = (raw_line or "").strip()
        if not line:
            continue

        matches = list(RE_MGRS_ANY.finditer(line))
        if matches:
            for m in matches:
                mgrs.append(
                    _normalize_mgrs(
                        m.group(1),
                        m.group(2),
                        m.group(3),
                        m.group(4),
                        m.group(5),
                    )
                )
            # Coordinate-only lines are excluded from analytical conclusion.
            remainder = RE_MGRS_ANY.sub("", line).strip(" ,;:-")
            if remainder:
                cleaned_lines.append(remainder)
            continue

        cleaned_lines.append(line)

    # Keep first-seen order and drop duplicates.
    seen: set[str] = set()
    mgrs_unique: list[str] = []
    for code in mgrs:
        if code in seen:
            continue
        seen.add(code)
        mgrs_unique.append(code)

    conclusion = "\n".join(cleaned_lines).strip()
    return conclusion, mgrs_unique


def is_analytical_intercept(text: str) -> bool:
    """Detect analytical intercept with required 4-block structure."""
    preface, tail = _split_analytical_blocks(text)
    if not preface or not tail:
        return False

    conclusion, _mgrs = _extract_analytical_conclusion_and_mgrs(preface)
    if not conclusion:
        return False

    parsed = parse_template_intercept(tail)
    return bool(parsed.get("ok", False))


def parse_analytical_intercept(text: str) -> Dict[str, Any]:
    """Parse analytical intercept into template schema + analytical metadata."""
    preface, tail = _split_analytical_blocks(text)
    if not preface:
        return {"ok": False, "error": "analytical_preface_not_found"}
    if not tail:
        return {"ok": False, "error": "analytical_header_not_found"}

    conclusion, mgrs_codes = _extract_analytical_conclusion_and_mgrs(preface)
    if not conclusion:
        return {"ok": False, "error": "analytical_conclusion_not_found"}

    parsed = parse_template_intercept(tail)
    if not parsed.get("ok", False):
        return parsed

    out: Dict[str, Any] = dict(parsed)
    out["analytical_conclusion"] = conclusion
    out["analytical_mgrs"] = mgrs_codes
    out["source_message_format"] = "analytical_type"
    return out
