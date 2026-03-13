# app/core/normalize.py
# заміни файл повністю

from __future__ import annotations

import re


def normalize_freq(value: str | None) -> str | None:
    if value is None:
        return None

    s = str(value).strip()
    if not s:
        return None

    s = s.replace(",", ".")
    s = re.sub(r"\s+", "", s)

    if "." in s:
        left, right = s.split(".", 1)
        left = re.sub(r"\D", "", left)
        right = re.sub(r"\D", "", right)

        if not left:
            left = "0"

        left = left[-3:].rjust(3, "0")
        right = (right + "0000")[:4]
        return f"{left}.{right}"

    digits = re.sub(r"\D", "", s)
    if not digits:
        return None

    left = digits[-3:].rjust(3, "0")
    return f"{left}.0000"


def normalize_freq_or_mask(value: str | None) -> tuple[str | None, str | None]:
    if value is None:
        return None, None

    s = str(value).strip()
    if not s:
        return None, None

    s = s.replace(",", ".")
    s = re.sub(r"\s+", "", s)

    if "." in s:
        left, right = s.split(".", 1)
        left = re.sub(r"\D", "", left)
        right = re.sub(r"\D", "", right)

        if not left and not right:
            return None, None

        left = (left or "0")[-3:].rjust(3, "0")

        if not right:
            return None, f"{left}.%"

        if len(right) >= 4:
            return f"{left}.{right[:4]}", None

        return None, f"{left}.{right}%"

    digits = re.sub(r"\D", "", s)
    if not digits:
        return None, None

    if len(digits) <= 3:
        return None, f"{digits.rjust(3, '0')}.%"

    left = digits[:3].rjust(3, "0")
    right = digits[3:]

    if len(right) >= 4:
        return f"{left}.{right[:4]}", None

    return None, f"{left}.{right}%"


def normalize_nonstandard_type_1(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    if len(lines) < 2:
        return text

    dt = lines[0]
    freq = lines[1]
    body = "\n".join(lines[2:])

    return f"{dt}\n{freq}\nукх р/м\n\n\n{body}"