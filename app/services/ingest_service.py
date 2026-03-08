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
from app.services.network_service import ensure_network

log = get_logger("ingest_service")


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
            log.notice("Unknown intercept format; skipping DB write (messages/networks/callsigns).")
            mark_unknown_format(cur, ingest_id)
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": "unknown format",
                "actions": actions,
            }

        if message_format == "nonstandard_type_1":
            normalized = normalize_nonstandard_type_1(raw_text)
            set_normalized_text(cur, ingest_id, normalized)
            raw_text = normalized

        parsed = parse_template_intercept(raw_text)
        if not parsed.get("ok"):
            err = parsed.get("error") or "template_parse_failed"
            log.notice(f"Template intercept failed validation; skipping. error={err}")
            mark_parse_error(cur, ingest_id, str(err))
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": err,
                "actions": actions,
            }

        published_at_text = parsed.get("published_at_text")
        frequency = parsed.get("frequency")
        mask = parsed.get("mask")
        unit = parsed.get("unit")
        zone = parsed.get("zone")
        net_description = parsed.get("net_line")
        caller = parsed.get("caller")
        callees = parsed.get("callees") or []
        body_text = parsed.get("body") or ""
        parse_confidence = float(parsed.get("parse_confidence") or 0.9)

        created_at = to_sql_dt(published_at_text) or received_at
        if platform == "xlsx":
            received_at = created_at
    
        set_published_at_text(cur, ingest_id, published_at_text)

        network_id = ensure_network(
            cur,
            frequency=frequency,
            mask=mask,
            now_dt=received_at,
            unit=unit,
            zone=zone,
        )
        
        log.info(
            "Network resolved",
            extra={
                "ingest_id": ingest_id,
                "network_id": network_id,
                "frequency": frequency,
            },
        )

        existing_message_id = find_duplicate_message(
            cur,
            network_id=network_id,
            created_at=created_at,
            body_text=body_text,
        )
        if existing_message_id is not None:
            log.notice(
                f"Duplicate parsed intercept detected; skipping message insert. "
                f"existing_message_id={existing_message_id}, network_id={network_id}, created_at={created_at}"
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
            "Message inserted",
            extra={
                "ingest_id": ingest_id,
                "message_id": message_id,
            },
        )

        link_message_callsigns(
            cur,
            network_id=int(network_id),
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
            "network_id": int(network_id),
        },
        "actions": actions,
    }