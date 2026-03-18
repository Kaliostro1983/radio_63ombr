"""Network alias normalization helper.

Historically the project used a normalized alias field in the database for
lookup. The current system resolves structured intercepts by `alias_text`,
but normalization may still be useful for:

- cleaning user input in UI forms;
- improving consistency when comparing aliases across systems.

This module provides a pure string normalizer and does not touch the DB.
"""

import re


def normalize_network_alias(text: str) -> str:
    """Normalize network alias text for consistent comparisons.

    Args:
        text: raw alias text.

    Returns:
        str: lowercased, trimmed alias with normalized whitespace and
        stripped quotes. Returns an empty string for empty input.
    """
    if not text:
        return ""

    text = text.lower().strip()

    text = text.replace('"', '')
    text = text.replace("'", "")

    text = re.sub(r"\s+", " ", text)

    return text