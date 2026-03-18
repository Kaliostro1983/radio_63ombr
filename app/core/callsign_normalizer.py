"""Callsign normalization helpers.

This module defines project-wide rules for converting raw callsign tokens
into canonical values.

Usage in the system:

- `app.services.structured_intercept_service` normalizes sender/recipient
  callsigns from structured intercepts.
- `app.services.callsign_service` relies on canonical callsign strings to
  enforce uniqueness within a network.

The special callsign "НВ" is treated as a technical placeholder meaning
"unknown"; it is allowed to be stored, but does not create graph edges.
"""

import re


def normalize_callsign(value: str | None) -> str:
    """Normalize a single callsign token.

    Args:
        value: raw callsign string (may contain extra punctuation/spacing).

    Returns:
        str: normalized callsign in uppercase, or "НВ" for empty/invalid input.
    """
    if not value:
        return "НВ"

    s = value.strip()

    s = s.replace("—", "-")
    s = re.sub(r"\s+", " ", s)
    s = s.strip(" ,.;:()[]{}")

    if not s:
        return "НВ"

    return s.upper()


def normalize_callsigns(values: list[str] | None) -> list[str]:
    """Normalize a list of callsign tokens and remove duplicates.

    Args:
        values: list of raw callsign tokens.

    Returns:
        list[str]: normalized callsigns with stable order and no duplicates.
        Returns ["НВ"] if input is empty or all values normalize to empty.
    """
    if not values:
        return ["НВ"]

    result: list[str] = []
    seen: set[str] = set()

    for value in values:
        norm = normalize_callsign(value)
        if norm and norm not in seen:
            seen.add(norm)
            result.append(norm)

    return result or ["НВ"]