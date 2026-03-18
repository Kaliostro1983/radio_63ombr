"""Structured intercept processing service.

This service implements the structured-alias ingestion path:

- parse a structured intercept message into fields (core parser);
- resolve the radio network by `network_aliases.alias_text`;
- normalize caller/callee callsigns;
- build a payload suitable for the generic ingest pipeline to insert into
  `messages` and link callsigns.

The main entrypoint is `process_structured_intercept`, which is called from
`app.services.ingest_service` as part of the overall ingest pipeline.
"""

from app.core.callsign_normalizer import normalize_callsign, normalize_callsigns
from app.core.structured_intercept_parser import parse_structured_intercept
from app.repositories.network_aliases_repository import get_network_by_alias_text


def _build_diag(parsed: dict, header_line_1: str) -> dict:
    """Build a small diagnostic payload for logging and error responses.

    Args:
        parsed: raw parsed dict from the structured intercept parser.
        header_line_1: normalized first header line extracted from message.

    Returns:
        dict: diagnostic summary with safe-to-log values.
    """
    return {
        "header_line_1": header_line_1,
        "published_at_text": (parsed.get("published_at_text") or "").strip(),
        "sender_raw": (parsed.get("sender_raw") or "").strip(),
        "body_preview": ((parsed.get("body") or "").strip()[:120]),
    }


def process_structured_intercept(conn, raw_text: str) -> dict:
    """Process a raw structured intercept and build an ingest-ready payload.

    The function is intentionally non-throwing and returns a status object:

    - `{"status": "parsed", "payload": ..., "diag": ...}` on success
    - `{"status": "skipped", "reason": ..., "diag": ...}` on expected skip cases

    Args:
        conn: SQLite connection used for network lookup.
        raw_text: raw incoming message text.

    Returns:
        dict: status object describing whether the message was parsed and
        providing either a payload or a skip reason.
    """
    parsed = parse_structured_intercept(raw_text)

    header_line_1 = (parsed.get("header_line_1") or "").strip()
    diag = _build_diag(parsed, header_line_1)

    if not header_line_1:
        return {
            "status": "skipped",
            "reason": "header_missing",
            "diag": diag,
        }

    # Network resolution for structured intercepts is alias-based.
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

    # Callsign normalization is applied consistently across ingest paths.
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