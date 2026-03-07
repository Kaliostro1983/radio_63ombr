import re
from app.core.intercept_parser import is_template_intercept

def is_valid_freq(value: str | None) -> bool:
    if not value:
        return False
    return bool(re.fullmatch(r"\d{3}\.\d{4}", value))


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