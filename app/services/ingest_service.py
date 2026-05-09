"""Ingest pipeline orchestrator.

This module implements the main deterministic ingest pipeline for incoming
intercept messages from external sources (e.g., WhatsApp bot payloads or
XLSX imports).

High-level flow (system invariant / docs):
    incoming payload -> ingest_messages -> detect format -> parse ->
    resolve network -> duplicate check -> insert into messages ->
    link message_callsigns -> update callsign_edges

Key properties:
    - raw payload is stored first for traceability;
    - message duplicates are detected strictly by (network_id, created_at, body_text);
    - networks are never auto-created (missing network => message is skipped);
    - callsign graph is updated only after message insertion.

The primary entrypoint is `process_whatsapp_payload`, which is called by
the `/api/ingest/whatsapp` router.
"""

from __future__ import annotations

from typing import Any, Dict, List
import sqlite3

from app.core.db import get_conn
from app.core.analytical_intercept_parser import parse_analytical_intercept
from app.core.intercept_parser import parse_template_intercept
from app.core.logging import get_logger
from app.core.normalize import normalize_nonstandard_type_1
from app.core.peleng_intercept_parser import parse_peleng_intercept
from app.core.time_utils import calc_delay_sec, now_sql, to_sql_dt
from app.core.validators import detect_message_format
from app.services.callsign_service import link_message_callsigns
from app.services.ingest_store import (
    find_duplicate_message,
    insert_analytical_conclusion,
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


def _content_type_from_format(message_format: str) -> str:
    fmt = str(message_format or "").strip().lower()
    if fmt == "analytical_type":
        return "analytical"
    if fmt == "peleng_type":
        return "peleng"
    return "intercept"


def _intercept_log_ctx(parsed: dict | None, raw_text: str | None = None) -> str:
    """Build a short, safe-to-log summary of an intercept for diagnostics.

    Args:
        parsed: parsed diagnostic dict (structured path) or None.
        raw_text: raw message text used as fallback summary.

    Returns:
        str: compact string with header/date/sender/body preview.
    """
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


def _run_ingest_pipeline(
    conn,
    cur,
    *,
    ingest_id: int,
    platform: str,
    raw_text: str,
    received_at: str,
    published_at_platform: Any,
    actions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Run the parsing/resolution pipeline on an already-stored ingest row.

    This helper contains all logic that runs *after* the ingest row has been
    inserted (or reset for retry): format detection, parsing, network
    resolution, duplicate check, message insert, callsign graph update.

    It is called both by `process_whatsapp_payload` (new messages) and by
    `reprocess_ingest_message` (retry of rejected messages).

    Args:
        conn: open SQLite connection (transactional context manager).
        cur: cursor from conn.
        ingest_id: existing `ingest_messages.id` to process.
        platform: source platform identifier.
        raw_text: raw message text (may be mutated for nonstandard_type_1).
        received_at: ISO timestamp when the message was received.
        published_at_platform: platform-side timestamp (may be None).
        actions: mutable list of side-effect actions to append to.

    Returns:
        Dict[str, Any]: pipeline result suitable for a JSON response.
    """
    # Format detection determines the parsing branch.
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

    if message_format == "peleng_type":
        peleng = parse_peleng_intercept(raw_text)
        if not peleng.get("ok"):
            reason = str(peleng.get("error") or "peleng_parse_failed")
            mark_parse_error(cur, ingest_id, reason)
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": reason,
                "actions": actions,
            }

        published_at_text = str(peleng["published_at_text"])
        created_at = to_sql_dt(published_at_text) or received_at
        set_published_at_text(cur, ingest_id, published_at_text)

        frequency = str(peleng.get("frequency") or "")
        mask = str(peleng.get("mask") or "")
        try:
            network_id = ensure_network(
                cur,
                frequency=frequency or None,
                mask=mask or None,
                now_dt=received_at,
                unit=None,
                zone=None,
            )
        except NetworkNotFoundError:
            mark_parse_error(cur, ingest_id, "network_not_found")
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": "network_not_found",
                "details": {"frequency": frequency, "mask": mask},
                "actions": actions,
            }

        cur.execute(
            "INSERT INTO peleng_batches (event_dt, network_id) VALUES (?, ?)",
            (created_at, network_id),
        )
        batch_id = int(cur.lastrowid)
        points = list(peleng.get("points") or [])
        cur.executemany(
            "INSERT INTO peleng_points (batch_id, mgrs) VALUES (?, ?)",
            [(batch_id, p) for p in points],
        )
        return {
            "ok": True,
            "ingest_id": ingest_id,
            "peleng_batch_id": batch_id,
            "parsed": {
                "message_format": "peleng_type",
                "network_id": network_id,
                "frequency": frequency,
                "mask": mask,
                "points_count": len(points),
            },
            "actions": actions,
        }

    if message_format == "structured_alias":
        # Structured intercepts resolve network via alias_text, not by
        # frequency/mask.
        structured_result = process_structured_intercept(conn, raw_text)
        structured_diag = structured_result.get("diag") or {}

        if structured_result.get("status") == "parsed":
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

            # Duplicate invariant: (network_id, created_at, body_text)
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
                content_type=_content_type_from_format(message_format),
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

            # Callsign graph is updated only after the message exists in `messages`.
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

        log.notice(
            "Structured intercept rejected %s",
            _intercept_log_ctx(structured_diag, raw_text),
            extra={
                "ingest_id": ingest_id,
                "reason": "structured_parse_failed",
                "format": "structured_alias",
            },
        )
        mark_parse_error(cur, ingest_id, "structured_parse_failed")
        return {
            "ok": True,
            "ingest_id": ingest_id,
            "skipped": True,
            "reason": "structured_parse_failed",
            "actions": actions,
        }

    if message_format == "nonstandard_type_1":
        # Normalize the nonstandard layout into a template-like shape
        # before running the template parser.
        normalized = normalize_nonstandard_type_1(raw_text)
        set_normalized_text(cur, ingest_id, normalized)
        raw_text = normalized

    try:
        if message_format == "analytical_type":
            parsed = parse_analytical_intercept(raw_text)
        else:
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

    if not parsed.get("ok", False):
        reason = parsed.get("error", "template_parse_failed")
        mark_parse_error(cur, ingest_id, reason)
        return {
            "ok": True,
            "ingest_id": ingest_id,
            "skipped": True,
            "reason": reason,
            "actions": actions,
        }

    published_at_text = parsed.get("published_at_text")
    frequency = parsed.get("frequency")
    mask = parsed.get("mask")
    unit = parsed.get("unit")
    zone = parsed.get("zone")
    net_description = parsed.get("net_line")
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

    # Duplicate invariant: (network_id, created_at, body_text)
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
        content_type=_content_type_from_format(message_format),
        parse_confidence=parse_confidence,
        delay_sec=delay_sec,
        net_description=net_description,
    )

    # Callsign graph is updated only after the message exists in `messages`.
    link_message_callsigns(
        cur,
        network_id=network_id,
        message_id=message_id,
        caller=caller,
        callees=list(callees),
        created_at=created_at,
        received_at=received_at,
    )

    # Persist analytical conclusion if this is an analytical-type message.
    if message_format == "analytical_type":
        conclusion_text = parsed.get("analytical_conclusion") or ""
        mgrs_list = list(parsed.get("analytical_mgrs") or [])
        if conclusion_text:
            insert_analytical_conclusion(
                cur,
                message_id=message_id,
                network_id=network_id,
                created_at=created_at,
                conclusion_text=conclusion_text,
                mgrs_list=mgrs_list,
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


def process_whatsapp_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Process an incoming ingest payload and store it in the database.

    Validates the payload, stores the raw row in `ingest_messages`, then
    delegates to `_run_ingest_pipeline` for format detection, parsing,
    network resolution, duplicate check and message insert.

    Args:
        payload: dict received from ingest transport layer (e.g., WhatsApp bot).

    Returns:
        Dict[str, Any]: response object with `ok` boolean and additional
        fields such as `ingest_id`, `message_row_id`, `duplicate`, `skipped`,
        `reason`, and optional `actions`.
    """
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
        actions.append({"type": "send_message", "text": raw_text})

    if allow_send:
        log.notice("Forward command received (#go)")

    if not source_chat_id or not source_message_id or not raw_text:
        return {"ok": False, "error": "chat_id, message_id, text are required"}

    received_at = now_sql()

    # Use a single transactional connection for the entire ingest flow so
    # that ingest metadata and message inserts remain consistent.
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

        return _run_ingest_pipeline(
            conn,
            cur,
            ingest_id=ingest_id,
            platform=platform,
            raw_text=raw_text,
            received_at=received_at,
            published_at_platform=published_at_platform,
            actions=actions,
        )


def reprocess_ingest_message(ingest_id: int) -> Dict[str, Any]:
    """Re-run the ingest pipeline on an existing rejected ingest_messages row.

    Reads the raw_text and metadata from the stored row, resets its
    parse_status to 'received' and parse_error to NULL, then re-runs the
    full parsing pipeline in place (without creating a new ingest row).

    Only rows with `parse_status IN ('parse_error', 'skipped_unknown_format')`
    are eligible for retry.

    Args:
        ingest_id: `ingest_messages.id` of the row to reprocess.

    Returns:
        Dict[str, Any]: same structure as `process_whatsapp_payload`.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM ingest_messages WHERE id = ?", (ingest_id,)
        ).fetchone()

        if not row:
            return {"ok": False, "error": f"ingest row {ingest_id} not found"}

        status = row["parse_status"] or ""
        if status not in ("parse_error", "skipped_unknown_format"):
            return {
                "ok": False,
                "error": f"row {ingest_id} has status '{status}'; only parse_error/skipped_unknown_format rows can be retried",
            }

        platform = row["platform"] or "whatsapp"
        raw_text = row["raw_text"] or ""
        received_at = row["received_at"] or now_sql()

        # Reset to re-processable state before running the pipeline.
        conn.execute(
            "UPDATE ingest_messages SET parse_status='received', parse_error=NULL, reviewed_at=NULL, message_format=NULL WHERE id=?",
            (ingest_id,),
        )

        cur = conn.cursor()
        return _run_ingest_pipeline(
            conn,
            cur,
            ingest_id=ingest_id,
            platform=platform,
            raw_text=raw_text,
            received_at=received_at,
            published_at_platform=None,
            actions=[],
        )