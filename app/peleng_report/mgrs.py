# -*- coding: utf-8 -*-
import re

# Приклад рядка: "37U DQ 32966 26558"
MGRS_LINE = re.compile(r'^\s*[0-9]{1,2}[C-X]\s+[A-Z]{2}\s+\d{5}\s+\d{5}\s*$', re.IGNORECASE)

def is_valid_mgrs(line: str) -> bool:
    return bool(MGRS_LINE.match(line or ""))
