from app.core.callsign_normalizer import normalize_callsign, normalize_callsigns
from app.core.structured_intercept_parser import parse_structured_intercept
from app.repositories.network_aliases_repository import get_network_by_alias_text


def _build_diag(parsed: dict, header_line_1: str) -> dict:
    return {
        "header_line_1": header_line_1,
        "published_at_text": (parsed.get("published_at_text") or "").strip(),
        "sender_raw": (parsed.get("sender_raw") or "").strip(),
        "body_preview": ((parsed.get("body") or "").strip()[:120]),
    }


def process_structured_intercept(conn, raw_text: str) -> dict:
    parsed = parse_structured_intercept(raw_text)

    header_line_1 = (parsed.get("header_line_1") or "").strip()
    diag = _build_diag(parsed, header_line_1)

    if not header_line_1:
        return {
            "status": "skipped",
            "reason": "header_missing",
            "diag": diag,
        }

    network = get_network_by_alias_text(conn, header_line_1)
    if not network:
        return {
            "status": "skipped",
            "reason": "alias_not_found",
            "diag": diag,
            "alias_text": header_line_1,
        }

    published_at_text = (parsed.get("published_at_text") or "").strip()
    if not published_at_text:
        return {
            "status": "skipped",
            "reason": "published_at_missing",
            "diag": diag,
            "alias_text": header_line_1,
        }

    body = (parsed.get("body") or "").strip()
    if not body:
        return {
            "status": "skipped",
            "reason": "body_missing",
            "diag": diag,
            "alias_text": header_line_1,
        }

    sender_raw = (parsed.get("sender_raw") or "").strip()
    if not sender_raw:
        return {
            "status": "skipped",
            "reason": "sender_missing",
            "diag": diag,
            "alias_text": header_line_1,
        }

    caller = normalize_callsign(sender_raw)
    callees = normalize_callsigns(parsed.get("recipients_raw"))

    payload = {
        "published_at": published_at_text,
        "network_id": network["network_id"],
        "frequency": network.get("frequency"),
        "mask": network.get("mask"),
        "unit": network.get("unit"),
        "zone": network.get("zone"),
        "net_key": network.get("net_key"),
        "net_description": header_line_1,
        "caller": caller,
        "callees": callees,
        "body": body,
        "raw_text": raw_text,
        "message_format": "structured_alias",
        "raw_header_line_1": parsed.get("header_line_1"),
        "raw_header_line_2": parsed.get("header_line_2"),
        "parse_confidence": 0.9,
    }

    return {
        "status": "parsed",
        "payload": payload,
        "diag": diag,
    }