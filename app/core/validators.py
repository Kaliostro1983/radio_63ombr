import re
from app.core.intercept_parser import is_template_intercept

def is_valid_freq(value: str | None) -> bool:
    if not value:
        return False
    return bool(re.fullmatch(r"\d{3}\.\d{4}", value))


def is_valid_freq_mask(value: str | None) -> bool:
    if not value:
        return False

    s = value.strip().replace(",", ".")
    s = re.sub(r"\s+", "", s)

    return bool(re.fullmatch(r"\d{1,3}(\.\d{0,4})?", s) or re.fullmatch(r"\d{1,7}", s))


def detect_message_format(text: str) -> str:
    """
    Returns:
        template
        nonstandard_type_1
        unknown
    """

    if is_template_intercept(text):
        return "template"

    # поки що лише один нетиповий формат
    if "укх" in text.lower() and "р/м" in text.lower():
        return "nonstandard_type_1"

    return "unknown"