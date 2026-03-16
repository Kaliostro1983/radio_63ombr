from __future__ import annotations

from typing import Any, Dict, List
import sqlite3

from app.core.db import get_conn
from app.core.intercept_parser import parse_template_intercept
from app.core.logging import get_logger
from app.core.normalize import normalize_nonstandard_type_1
from app.core.time_utils import calc_delay_sec, now_sql, to_sql_dt
from app.core.validators import detect_message_format
from app.services.callsign_service import link_message_callsigns
from app.services.ingest_store import (
    find_duplicate_message,
    insert_ingest_message,
    insert_message,
    mark_duplicate_content,
    mark_parse_error,
    mark_unknown_format,
    set_message_format,
    set_normalized_text,
    set_published_at_text,
)
from app.services.network_service import ensure_network, NetworkNotFoundError
from app.services.structured_intercept_service import process_structured_intercept

log = get_logger("ingest_service")


def _intercept_log_ctx(parsed: dict | None, raw_text: str | None = None) -> str:
    if parsed:
        header = (parsed.get("header_line_1") or "").strip()
        dt = (parsed.get("published_at_text") or "").strip()
        sender = (parsed.get("sender_raw") or "").strip()
        body_preview = (parsed.get("body_preview") or "").strip()

        if len(header) > 120:
            header = header[:117] + "..."
        if len(sender) > 80:
            sender = sender[:77] + "..."
        if len(body_preview) > 120:
            body_preview = body_preview[:117] + "..."

        return (
            f"header={header!r} "
            f"dt={dt!r} "
            f"sender={sender!r} "
            f"body_preview={body_preview!r}"
        )

    if raw_text:
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
        first_line = lines[0] if lines else ""
        second_line = lines[1] if len(lines) > 1 else ""

        if len(first_line) > 120:
            first_line = first_line[:117] + "..."
        if len(second_line) > 120:
            second_line = second_line[:117] + "..."

        return f"raw_first_line={first_line!r} raw_second_line={second_line!r}"

    return "header='' dt='' sender='' body_preview=''"


def process_whatsapp_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    platform = payload.get("platform") or "whatsapp"
    source_chat_id = payload.get("chat_id")
    source_chat_name = payload.get("chat_name")
    source_message_id = payload.get("message_id")
    raw_text = payload.get("text") or ""
    published_at_platform = payload.get("published_at_platform")

    log.info(
        "Ingest received",
        extra={
            "platform": platform,
            "chat_id": source_chat_id,
            "message_id": source_message_id,
        },
    )

    allow_send = bool(payload.get("allow_send", False))
    actions: List[Dict[str, Any]] = []

    if allow_send and raw_text:
        actions.append(
            {
                "type": "send_message",
                "text": raw_text,
            }
        )

    if allow_send:
        log.notice("Forward command received (#go)")

    if not source_chat_id or not source_message_id or not raw_text:
        return {"ok": False, "error": "chat_id, message_id, text are required"}

    received_at = now_sql()

    with get_conn() as conn:
        cur = conn.cursor()

        try:
            ingest_id = insert_ingest_message(
                cur,
                platform=platform,
                source_chat_id=source_chat_id,
                source_chat_name=source_chat_name,
                source_message_id=source_message_id,
                raw_text=raw_text,
                received_at=received_at,
            )
        except sqlite3.IntegrityError as e:
            log.warning(
                "insert_ingest_message integrity error",
                extra={
                    "platform": platform,
                    "chat_id": source_chat_id,
                    "message_id": source_message_id,
                    "error": str(e),
                },
            )
            return {
                "ok": True,
                "duplicate": True,
                "reason": str(e),
                "actions": actions,
            }
        except Exception as e:
            log.exception(
                "insert_ingest_message failed",
                extra={
                    "platform": platform,
                    "chat_id": source_chat_id,
                    "message_id": source_message_id,
                },
            )
            return {
                "ok": False,
                "error": f"insert_ingest_message failed: {e}",
                "actions": actions,
            }

        structured_result = process_structured_intercept(conn, raw_text)
        structured_diag = structured_result.get("diag") or {}

        if structured_result.get("status") == "parsed":
            set_message_format(cur, ingest_id, "structured_alias")

            payload2 = structured_result["payload"]

            published_at_text = payload2["published_at"]
            frequency = payload2["frequency"]
            unit = payload2["unit"]
            zone = payload2["zone"]
            caller = payload2["caller"]
            callees = payload2["callees"]
            body_text = payload2["body"]
            parse_confidence = float(payload2.get("parse_confidence") or 0.9)
            net_description = payload2.get("net_description") or payload2.get("raw_header_line_1")

            created_at = to_sql_dt(published_at_text) or received_at
            if platform == "xlsx":
                received_at = created_at

            set_published_at_text(cur, ingest_id, published_at_text)

            network_id = int(payload2["network_id"])

            existing_message_id = find_duplicate_message(
                cur,
                network_id=network_id,
                created_at=created_at,
                body_text=body_text,
            )
            if existing_message_id is not None:
                log.notice(
                    "Structured intercept rejected %s",
                    _intercept_log_ctx(structured_diag),
                    extra={
                        "ingest_id": ingest_id,
                        "reason": "duplicate_message",
                        "network_id": network_id,
                        "existing_message_id": existing_message_id,
                        "created_at": created_at,
                    },
                )
                mark_duplicate_content(cur, ingest_id, existing_message_id)
                return {
                    "ok": True,
                    "ingest_id": ingest_id,
                    "duplicate": True,
                    "duplicate_stage": "message_content",
                    "existing_message_id": existing_message_id,
                    "actions": actions,
                }

            if platform == "xlsx":
                delay_sec = 0
            else:
                delay_sec = calc_delay_sec(
                    platform=platform,
                    published_at_platform=published_at_platform,
                    published_at_text=published_at_text,
                )

            message_id = insert_message(
                cur,
                ingest_id=ingest_id,
                network_id=network_id,
                created_at=created_at,
                received_at=received_at,
                body_text=body_text,
                parse_confidence=parse_confidence,
                delay_sec=delay_sec,
                net_description=net_description,
            )

            log.info(
                "Structured message inserted %s",
                _intercept_log_ctx(structured_diag),
                extra={
                    "ingest_id": ingest_id,
                    "message_id": message_id,
                    "network_id": network_id,
                    "frequency": frequency,
                    "format": "structured_alias",
                },
            )

            link_message_callsigns(
                cur,
                network_id=network_id,
                message_id=message_id,
                caller=caller,
                callees=list(callees),
                created_at=created_at,
                received_at=received_at,
            )

            return {
                "ok": True,
                "ingest_id": ingest_id,
                "message_row_id": message_id,
                "parsed": {
                    "frequency": frequency,
                    "unit": unit,
                    "zone": zone,
                    "caller": caller,
                    "callees": list(callees),
                    "network_id": network_id,
                },
                "actions": actions,
            }

        structured_reason = structured_result.get("reason")
        structured_reasons = {
            "header_missing",
            "alias_not_found",
            "published_at_missing",
            "body_missing",
            "sender_missing",
        }

        if structured_reason in structured_reasons:
            set_message_format(cur, ingest_id, "structured_alias")

            log.notice(
                "Structured intercept rejected %s",
                _intercept_log_ctx(structured_diag, raw_text),
                extra={
                    "ingest_id": ingest_id,
                    "reason": structured_reason,
                    "alias_text": structured_result.get("alias_text"),
                    "format": "structured_alias",
                },
            )
            mark_parse_error(cur, ingest_id, structured_reason)
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": structured_reason,
                "actions": actions,
            }

        message_format = detect_message_format(raw_text)
        set_message_format(cur, ingest_id, message_format)

        log.info(
            "Message format detected",
            extra={
                "ingest_id": ingest_id,
                "format": message_format,
            },
        )

        if message_format == "unknown":
            log.notice(
                "Unknown intercept format; skipping DB write %s",
                _intercept_log_ctx(None, raw_text),
                extra={
                    "ingest_id": ingest_id,
                    "reason": "unknown_format",
                    "format": "unknown",
                },
            )
            mark_unknown_format(cur, ingest_id)
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": "unknown_format",
                "actions": actions,
            }

        if message_format == "nonstandard_type_1":
            normalized = normalize_nonstandard_type_1(raw_text)
            set_normalized_text(cur, ingest_id, normalized)
            raw_text = normalized

        try:
            parsed = parse_template_intercept(raw_text)
        except Exception as e:
            log.warning(
                "Template parse failed",
                extra={
                    "ingest_id": ingest_id,
                    "error": str(e),
                },
            )
            mark_parse_error(cur, ingest_id, str(e))
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": f"parse error: {e}",
                "actions": actions,
            }

        published_at_text = parsed.get("published_at")
        frequency = parsed.get("frequency")
        mask = parsed.get("mask")
        unit = parsed.get("unit")
        zone = parsed.get("zone")
        net_description = parsed.get("net_description")
        caller = parsed.get("caller") or "НВ"
        callees = parsed.get("callees") or ["НВ"]
        body_text = parsed.get("body") or ""
        parse_confidence = float(parsed.get("parse_confidence") or 0.9)

        set_published_at_text(cur, ingest_id, published_at_text)

        created_at = to_sql_dt(published_at_text) or received_at
        if platform == "xlsx":
            received_at = created_at

        try:
            network_id = ensure_network(
                cur,
                frequency=frequency,
                mask=mask,
                now_dt=received_at,
                unit=unit,
                zone=zone,
            )
        except NetworkNotFoundError as e:
            log.notice(
                "Intercept skipped: network not found in DB %s",
                _intercept_log_ctx(parsed, raw_text),
                extra={
                    "ingest_id": ingest_id,
                    "frequency": e.frequency,
                    "mask": e.mask,
                    "unit": e.unit,
                    "zone": e.zone,
                    "reason": "network_not_found",
                },
            )
            mark_parse_error(cur, ingest_id, str(e))
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": "network_not_found",
                "details": {
                    "frequency": e.frequency,
                    "mask": e.mask,
                    "unit": e.unit,
                    "zone": e.zone,
                },
                "actions": actions,
            }

        existing_message_id = find_duplicate_message(
            cur,
            network_id=network_id,
            created_at=created_at,
            body_text=body_text,
        )
        if existing_message_id is not None:
            log.notice(
                "Duplicate parsed intercept detected; skipping message insert.",
                extra={
                    "existing_message_id": existing_message_id,
                    "network_id": network_id,
                    "created_at": created_at,
                },
            )
            mark_duplicate_content(cur, ingest_id, existing_message_id)
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "duplicate": True,
                "duplicate_stage": "message_content",
                "existing_message_id": existing_message_id,
                "actions": actions,
            }

        if platform == "xlsx":
            delay_sec = 0
        else:
            delay_sec = calc_delay_sec(
                platform=platform,
                published_at_platform=published_at_platform,
                published_at_text=published_at_text,
            )

        message_id = insert_message(
            cur,
            ingest_id=ingest_id,
            network_id=network_id,
            created_at=created_at,
            received_at=received_at,
            body_text=body_text,
            parse_confidence=parse_confidence,
            delay_sec=delay_sec,
            net_description=net_description,
        )

        link_message_callsigns(
            cur,
            network_id=network_id,
            message_id=message_id,
            caller=caller,
            callees=list(callees),
            created_at=created_at,
            received_at=received_at,
        )

        return {
            "ok": True,
            "ingest_id": ingest_id,
            "message_row_id": message_id,
            "parsed": {
                "frequency": frequency,
                "unit": unit,
                "zone": zone,
                "caller": caller,
                "callees": list(callees),
                "network_id": network_id,
            },
            "actions": actions,
        }