"""Parser for analytical intercept messages with 4 logical blocks.

Analytical message contract:
1) analytical conclusion text (required);
2) coordinates block (optional, MGRS-like forms);
3) unit separator line with a brigade/unit marker;
4) template intercept that is parsed by `parse_template_intercept`.

The separator marker also identifies the *source side* of the conclusion:

- "------- 🦁 63 ОМБр 🦁 -------"        → side="analytics63" (group "Аналітика 63")
- "---------- ꑭ ОБТВР ꑭ ----------"     → side="battalions"  (group "Батальйони 63")
- "---------- ꑭ 60 ОМБр ꑭ ----------"   → side="battalions"  (group "Батальйони 63")

Both ОБТВР and 60 ОМБр are sub-sources of the single "Батальйони 63" side.
"""

from __future__ import annotations

import re
from typing import Any, Dict

from app.core.intercept_parser import parse_template_intercept


# Separator markers that divide the analytical preamble from the standard
# template header.  The matched marker identifies the conclusion source side.
RE_SEP_ANALYTICS = re.compile(r"63\s*омбр", flags=re.IGNORECASE)
RE_SEP_BATTALION = re.compile(r"(обтвр|60\s*омбр)", flags=re.IGNORECASE)
# Any known separator marker (used to locate the dividing line).
RE_SEPARATOR = re.compile(r"(63\s*омбр|60\s*омбр|обтвр)", flags=re.IGNORECASE)

RE_MGRS_ANY = re.compile(
    r"\b(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z]{2})\s*(\d{2,5})\s*(\d{2,5})\b",
    flags=re.IGNORECASE,
)

# Службовий маркер «[Палітра: N]» (порядковий id палітри, з якої взято точку).
# Додається у редакторі висновку після перехоплення; на парсингу його треба
# відділити від тіла перехоплення, щоб він не псував шаблонний парсер.
RE_PALETTE_TAG = re.compile(r"\[\s*Палітра\s*:\s*([^\]]*)\]", flags=re.IGNORECASE)


def _extract_palette_tag(text: str) -> tuple[str, list[int]]:
    """Витягти «[Палітра: N, …]» з тексту.

    Повертає (текст_без_тегу, [порядкові_id]). Тег видаляється разом із
    порожніми рядками навколо нього.
    """
    seqs: list[int] = []
    for m in RE_PALETTE_TAG.finditer(text or ""):
        for tok in re.split(r"[,\s]+", (m.group(1) or "").strip()):
            if tok.isdigit():
                n = int(tok)
                if n not in seqs:
                    seqs.append(n)
    cleaned = RE_PALETTE_TAG.sub("", text or "")
    # Прибрати осиротілі порожні рядки/пробіли, що лишилися від тегу.
    cleaned = re.sub(r"\n\s*\n\s*$", "", cleaned).rstrip()
    return cleaned, seqs


def _detect_source(line: str) -> tuple[str, str]:
    """Map a separator line to (source_side, source_marker).

    Returns ("", "") when the line carries no known marker.
    Battalion markers are checked first so "60 ОМБр" is not confused with
    the analytics "63 ОМБр" marker.
    """
    text = str(line or "")
    if RE_SEP_BATTALION.search(text):
        marker = "obtvr" if re.search(r"обтвр", text, flags=re.IGNORECASE) else "60ombr"
        return "battalions", marker
    if RE_SEP_ANALYTICS.search(text):
        return "analytics63", "63ombr"
    return "", ""


def _split_analytical_blocks(text: str) -> tuple[str, str, str, str]:
    """Split message by the first known separator line.

    Returns (preface, template_tail, source_side, source_marker).
    All strings are empty when no separator is found.
    """
    lines = (text or "").splitlines()
    for idx, line in enumerate(lines):
        if RE_SEPARATOR.search(str(line or "")):
            side, marker = _detect_source(line)
            preface = "\n".join(lines[:idx]).strip()
            tail = "\n".join(lines[idx + 1 :]).strip()
            return preface, tail, side, marker
    return "", "", "", ""


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
    preface, tail, _side, _marker = _split_analytical_blocks(text)
    if not preface or not tail:
        return False

    conclusion, _mgrs = _extract_analytical_conclusion_and_mgrs(preface)
    if not conclusion:
        return False

    tail, _seqs = _extract_palette_tag(tail)
    parsed = parse_template_intercept(tail)
    return bool(parsed.get("ok", False))


def parse_analytical_intercept(text: str) -> Dict[str, Any]:
    """Parse analytical intercept into template schema + analytical metadata.

    Adds the following analytical fields on success:
        analytical_conclusion   — conclusion text (coordinates stripped);
        analytical_mgrs         — list of normalized MGRS coordinate strings;
        analytical_source_side  — "analytics63" | "battalions";
        analytical_source_marker— "63ombr" | "obtvr" | "60ombr";
        analytical_tail_text    — raw template intercept text under the separator;
        source_message_format   — "analytical_type".
    """
    preface, tail, source_side, source_marker = _split_analytical_blocks(text)
    if not preface:
        return {"ok": False, "error": "analytical_preface_not_found"}
    if not tail:
        return {"ok": False, "error": "analytical_header_not_found"}

    conclusion, mgrs_codes = _extract_analytical_conclusion_and_mgrs(preface)
    if not conclusion:
        return {"ok": False, "error": "analytical_conclusion_not_found"}

    # Відокремити службовий маркер «[Палітра: N]» від тіла перехоплення.
    tail, palette_seqs = _extract_palette_tag(tail)

    parsed = parse_template_intercept(tail)
    if not parsed.get("ok", False):
        return parsed

    out: Dict[str, Any] = dict(parsed)
    out["analytical_conclusion"] = conclusion
    out["analytical_mgrs"] = mgrs_codes
    out["analytical_source_side"] = source_side or "analytics63"
    out["analytical_source_marker"] = source_marker or "63ombr"
    out["analytical_tail_text"] = tail
    out["analytical_palette_seqs"] = palette_seqs
    out["source_message_format"] = "analytical_type"
    return out
