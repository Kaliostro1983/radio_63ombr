from __future__ import annotations

import re


MASK_PREFIXES = ("100", "200", "300")


def _clean_numeric(value: str | None) -> str:
    if value is None:
        return ""

    s = str(value).strip()
    if not s:
        return ""

    s = s.replace(",", ".")
    s = re.sub(r"\s+", "", s)
    return s


def _digits_only(value: str) -> str:
    return re.sub(r"\D", "", value)


def is_mask_candidate(value: str | None) -> bool:
    s = _clean_numeric(value)
    if not s:
        return False

    digits = _digits_only(s)
    if len(digits) < 3:
        return False

    return digits[:3] in MASK_PREFIXES


def normalize_freq(value: str | None) -> str | None:
    if value is None:
        return None

    if is_mask_candidate(value):
        return None

    s = _clean_numeric(value)
    if not s:
        return None

    if "." in s:
        left, right = s.split(".", 1)
        left = re.sub(r"\D", "", left)
        right = re.sub(r"\D", "", right)

        if not left:
            left = "0"

        left = left[-3:].rjust(3, "0")
        right = (right + "0000")[:4]
        return f"{left}.{right}"

    digits = _digits_only(s)
    if not digits:
        return None

    left = digits[-3:].rjust(3, "0")
    return f"{left}.0000"


def normalize_mask(value: str | None) -> str | None:
    s = _clean_numeric(value)
    if not s:
        return None

    digits = _digits_only(s)
    if len(digits) < 3:
        return None

    if digits[:3] not in MASK_PREFIXES:
        return None

    if "." in s:
        left, right = s.split(".", 1)
        left = re.sub(r"\D", "", left)
        right = re.sub(r"\D", "", right)

        if not left:
            return None

        left = left[:3].rjust(3, "0")

        if not right:
            return f"{left}.%"

        return f"{left}.{right[:4]}%"

    left = digits[:3]
    right = digits[3:]

    if not right:
        return f"{left}.%"

    return f"{left}.{right[:4]}%"


def normalize_freq_or_mask(value: str | None) -> tuple[str | None, str | None]:
    if value is None:
        return None, None

    if is_mask_candidate(value):
        return None, normalize_mask(value)

    return normalize_freq(value), None


def normalize_nonstandard_type_1(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    if len(lines) < 2:
        return text

    dt = lines[0]
    freq = lines[1]
    body = "\n".join(lines[2:])

    return f"{dt}\n{freq}\nукх р/м\n\n\n{body}"