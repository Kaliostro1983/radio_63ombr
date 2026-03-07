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

    # If it's all digits and long (e.g., 50625 -> 50.625?), we can't guess safely.
    # We support common inputs:
    # - '50.625' -> '050.0625' ? no: user wants 3 left, 4 right. For freq, typical is '050.6250' like?
    # We'll interpret:
    #   if there is a dot, left/right parts are padded/truncated to 3/4.
    #   if no dot: treat as integer MHz and set .0000.
    if "." in s:
        left, right = s.split(".", 1)
        left = re.sub(r"\D", "", left)
        right = re.sub(r"\D", "", right)
        if not left:
            left = "0"
        left = left[-3:].rjust(3, "0")
        right = (right + "0000")[:4]
        return f"{left}.{right}"
    # no dot
    digits = re.sub(r"\D", "", s)
    if not digits:
        return None
    left = digits[-3:].rjust(3, "0")
    return f"{left}.0000"


def normalize_nonstandard_type_1(text: str) -> str:
    """
    Convert nonstandard intercept to template structure.
    Minimal version for now.
    """

    lines = [l.strip() for l in text.splitlines() if l.strip()]

    if len(lines) < 2:
        return text

    # приклад грубої нормалізації
    dt = lines[0]
    freq = lines[1]

    body = "\n".join(lines[2:])

    return f"{dt}\n{freq}\nукх р/м\n\n\n{body}"
