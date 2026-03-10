import re


def normalize_network_alias(text: str) -> str:
    if not text:
        return ""

    text = text.lower().strip()

    text = text.replace('"', '')
    text = text.replace("'", "")

    text = re.sub(r"\s+", " ", text)

    return text