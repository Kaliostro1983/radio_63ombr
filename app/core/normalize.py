"""Normalization utilities for frequencies and frequency masks.

This module provides normalization helpers used across the system:

- ingest pipeline and search features accept user-entered frequency/mask
  values and normalize them into canonical forms;
- network resolution logic can interpret values as either an exact
  frequency (e.g. `300.3010`) or a mask/prefix suitable for SQL LIKE
  queries (e.g. `300.%`, `300.30%`).

The functions here are pure string transformations and do not access the
database.
"""

from __future__ import annotations

import re


MASK_PREFIXES = ("100", "200", "300")


def _clean_numeric(value: str | None) -> str:
    """Normalize numeric-ish input to a compact string representation.

    Args:
        value: raw user input or value extracted from messages.

    Returns:
        str: trimmed string with commas converted to dots and all
        whitespace removed. Returns an empty string for None/empty input.
    """
    if value is None:
        return ""

    s = str(value).strip()
    if not s:
        return ""

    s = s.replace(",", ".")
    s = re.sub(r"\s+", "", s)
    return s


def _digits_only(value: str) -> str:
    """Return only digits from the provided string."""
    return re.sub(r"\D", "", value)


def is_mask_candidate(value: str | None) -> bool:
    """Return True if the value looks like a frequency mask/prefix.

    Mask candidates are values whose leading 3 digits belong to one of the
    known mask prefixes (100/200/300).

    Args:
        value: raw input value.

    Returns:
        bool: True if the value should be treated as a mask candidate.
    """
    s = _clean_numeric(value)
    if not s:
        return False

    digits = _digits_only(s)
    if len(digits) < 3:
        return False

    return digits[:3] in MASK_PREFIXES


def normalize_freq(value: str | None) -> str | None:
    """Normalize an input into canonical frequency string format.

    Canonical format used in the project is `DDD.DDDD` (e.g. `166.8000`).
    If the input appears to be a mask candidate, the function returns None.

    Args:
        value: raw input value.

    Returns:
        str | None: canonical frequency string (`DDD.DDDD`) or None if the
        value cannot be normalized as an exact frequency.
    """
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
    """Normalize an input into a SQL LIKE mask string.

    The returned value is intended to be used with `LIKE` in SQL queries,
    and therefore may contain `%` wildcards.

    Examples:
        - `300` -> `300.%`
        - `300.3` -> `300.3%`
        - `3003010` -> `300.3010%` (mask-style interpretation)

    Args:
        value: raw input value.

    Returns:
        str | None: mask string usable in SQL LIKE, or None if the value is
        not a valid mask candidate.
    """
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
    """Interpret input as either an exact frequency or a mask.

    Args:
        value: raw input value.

    Returns:
        tuple[str | None, str | None]: `(frequency, mask)` where exactly one
        element is typically non-None.
    """
    if value is None:
        return None, None

    if is_mask_candidate(value):
        return None, normalize_mask(value)

    return normalize_freq(value), None


def normalize_nonstandard_type_1(text: str) -> str:
    """Normalize nonstandard intercept format into the template-like layout.

    This helper is used by the ingest pipeline when it detects a message
    that contains "укх" and "р/м" markers but does not fully match the
    expected template. The normalization injects a placeholder net line
    (`укх р/м`) and keeps the original body intact.

    Args:
        text: raw intercept text.

    Returns:
        str: rewritten text in a format closer to `parse_template_intercept`.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    if len(lines) < 2:
        return text

    dt = lines[0]
    freq = lines[1]
    body = "\n".join(lines[2:])

    return f"{dt}\n{freq}\nукх р/м\n\n\n{body}"