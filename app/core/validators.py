"""Validation and lightweight classification helpers.

This module contains small, reusable checks that are used in both the UI
and ingestion/search flows:

- validate whether a user-provided string is an exact frequency;
- validate whether a user-provided string is a frequency mask/prefix;
- detect intercept message format (template vs nonstandard vs unknown).

The ingest pipeline uses `detect_message_format` to decide whether to run
the template parser, normalize a nonstandard format, or skip a message as
unknown.
"""

import re

from app.core.intercept_parser import is_template_intercept
from app.core.normalize import is_mask_candidate


def is_valid_freq(value: str | None) -> bool:
    """Return True if the value is a valid exact frequency (`DDD.DDDD`).

    Args:
        value: raw input value.

    Returns:
        bool: True for valid exact frequencies, False otherwise.
    """
    if not value:
        return False

    s = value.strip().replace(",", ".")
    s = re.sub(r"\s+", "", s)

    if is_mask_candidate(s):
        return False

    return bool(re.fullmatch(r"\d{3}\.\d{4}", s))


def is_valid_freq_mask(value: str | None) -> bool:
    """Return True if the value is a valid frequency mask candidate.

    Mask candidates are values that start with known prefixes (100/200/300)
    and can be represented either with or without a dot.

    Args:
        value: raw input value.

    Returns:
        bool: True if the value should be treated as a mask/prefix.
    """
    if not value:
        return False

    s = value.strip().replace(",", ".")
    s = re.sub(r"\s+", "", s)

    if not is_mask_candidate(s):
        return False

    return bool(re.fullmatch(r"(100|200|300)(\.\d{0,4})?", s) or re.fullmatch(r"(100|200|300)\d{0,4}", s))


def detect_message_format(text: str) -> str:
    """Detect intercept message format based on lightweight heuristics.

    The decision is intentionally conservative:
    - if the message matches the strict template header => `template`;
    - if it contains typical markers but is not template => `nonstandard_type_1`;
    - otherwise => `unknown`.

    Args:
        text: raw intercept text.

    Returns:
        str: one of `template`, `nonstandard_type_1`, `unknown`.
    """

    if is_template_intercept(text):
        return "template"

    if "укх" in text.lower() and "р/м" in text.lower():
        return "nonstandard_type_1"

    return "unknown"