import re


def normalize_callsign(value: str | None) -> str:
    if not value:
        return "НВ"

    s = value.strip()

    s = s.replace("—", "-")
    s = re.sub(r"\s+", " ", s)
    s = s.strip(" ,.;:()[]{}")

    if not s:
        return "НВ"

    return s.upper()


def normalize_callsigns(values: list[str] | None) -> list[str]:
    if not values:
        return ["НВ"]

    result: list[str] = []
    seen: set[str] = set()

    for value in values:
        norm = normalize_callsign(value)
        if norm and norm not in seen:
            seen.add(norm)
            result.append(norm)

    return result or ["НВ"]