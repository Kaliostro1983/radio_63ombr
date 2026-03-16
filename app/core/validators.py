import re

from app.core.intercept_parser import is_template_intercept
from app.core.normalize import is_mask_candidate


def is_valid_freq(value: str | None) -> bool:
    if not value:
        return False

    s = value.strip().replace(",", ".")
    s = re.sub(r"\s+", "", s)

    if is_mask_candidate(s):
        return False

    return bool(re.fullmatch(r"\d{3}\.\d{4}", s))


def is_valid_freq_mask(value: str | None) -> bool:
    if not value:
        return False

    s = value.strip().replace(",", ".")
    s = re.sub(r"\s+", "", s)

    if not is_mask_candidate(s):
        return False

    return bool(re.fullmatch(r"(100|200|300)(\.\d{0,4})?", s) or re.fullmatch(r"(100|200|300)\d{0,4}", s))


def detect_message_format(text: str) -> str:
    """
    Returns:
        template
        nonstandard_type_1
        unknown
    """

    if is_template_intercept(text):
        return "template"

    if "укх" in text.lower() and "р/м" in text.lower():
        return "nonstandard_type_1"

    return "unknown"