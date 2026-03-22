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

    text = str(text)
    text = text.replace("\u00a0", " ")
    text = text.replace("\u200b", "")

    text = text.lower().strip()

    text = text.replace('"', '')
    text = text.replace("'", "")

    # OCR / export: en-dash, em-dash → hyphen (must match DB-stored alias_text)
    text = text.replace("\u2013", "-").replace("\u2014", "-").replace("\u2011", "-")

    # WhatsApp/XLSX export line prefix like "$ 83" before the real header (not in DB alias).
    text = re.sub(r"^\s*\$\s*\d*\s*", "", text)

    text = re.sub(r"\s+", " ", text)

    return text.strip()