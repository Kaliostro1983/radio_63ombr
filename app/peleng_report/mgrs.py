"""MGRS validation helper.

This module contains a minimal validator for MGRS coordinate lines used in
peleng workflows.

Usage in the system:
    Parsers and UI validation can use `is_valid_mgrs` to quickly validate
    a single line before attempting to process it further.
"""

# -*- coding: utf-8 -*-
import re

# Приклад рядка: "37U DQ 32966 26558"
MGRS_LINE = re.compile(r'^\s*[0-9]{1,2}[C-X]\s+[A-Z]{2}\s+\d{5}\s+\d{5}\s*$', re.IGNORECASE)

def is_valid_mgrs(line: str) -> bool:
    """Return True if the line matches the expected MGRS pattern.

    Args:
        line: input line.

    Returns:
        bool: True for valid MGRS line format, False otherwise.
    """
    return bool(MGRS_LINE.match(line or ""))
