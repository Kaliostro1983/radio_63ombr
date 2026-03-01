import re

def is_valid_freq(value: str | None) -> bool:
    if not value:
        return False
    return bool(re.fullmatch(r"\d{3}\.\d{4}", value))