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

import json as _json
import re as _re
import threading as _threading
import time as _time
import urllib.error as _uerr
import urllib.request as _ureq
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
    insert_battalion_conclusion,
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


_RE_EMPTY_NUMBERED = _re.compile(r"^(\s*\d+\.)\s*$")


def _fill_route_points(text: str, mgrs_list: List[str] | None) -> str:
    """Inject MGRS points into empty numbered list rows ('1.', '2.', …).

    Returns text unchanged if either side is empty.  Compacts MGRS (no spaces).
    Fills in document order; extra numbers/points are left as-is.
    """
    if not text or not mgrs_list:
        return text
    points = [m.replace(" ", "") for m in mgrs_list if m]
    if not points:
        return text
    lines = text.split("\n")
    idx = 0
    for i, line in enumerate(lines):
        if idx >= len(points):
            break
        m = _RE_EMPTY_NUMBERED.match(line)
        if m:
            lines[i] = f"{m.group(1)} {points[idx]}"
            idx += 1
    return "\n".join(lines)


def _normalize_delta_identification(value: object) -> str:
    """Map any legacy/intermediate value to one of the two canonical states.

    Rule (single source of truth = "Ворожий" checkbox in conclusion-type card):
      - 'Ворожий'  → 'Ворожий'
      - порожнє/NULL → 'Ворожий' (system default for not-yet-edited types)
      - все інше ('Невизначений', 'Невідомий', 'Дружній', …) → 'Дружній'
    """
    v = str(value or "").strip()
    if v == "Ворожий" or v == "":
        return "Ворожий"
    return "Дружній"


def _try_delta_auto_send(
    conn,
    ac_id: int,
    type_id: int,
    conclusion_text: str,
    body_text: str,
    created_at: str,
    network_id: int,
    mgrs_list: list,
) -> None:
    """Attempt to auto-send a Delta report via the bot service.

    All exceptions are silently swallowed — auto-send is best-effort
    and must never interrupt the ingest pipeline.
    """
    from app.core.config import settings as _cfg  # local import to avoid circulars

    try:
        if not _cfg.bot_service_url:
            log.warning("_try_delta_auto_send: bot_service_url not configured (BOT_SERVICE_URL empty)")
            return

        # Global switch
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key='delta_send_enabled'"
        ).fetchone()
        if not row or str(row[0]) != "1":
            log.info("_try_delta_auto_send: skipped — delta_send_enabled is off (ac_id=%s)", ac_id)
            return

        chat_id_row  = conn.execute(
            "SELECT value FROM app_settings WHERE key='delta_chat_id'"
        ).fetchone()
        platform_row = conn.execute(
            "SELECT value FROM app_settings WHERE key='delta_platform'"
        ).fetchone()
        chat_id  = (chat_id_row[0]  if chat_id_row  else "") or ""
        platform = (platform_row[0] if platform_row else "whatsapp") or "whatsapp"
        if not chat_id:
            log.warning(
                "_try_delta_auto_send: skipped — delta_chat_id is empty in app_settings "
                "(ac_id=%s). Open Налаштування tab to sync chat from browser.", ac_id
            )
            return

        # Per-type auto-send flag
        type_row = conn.execute(
            "SELECT delta_auto_send, delta_type, delta_identification, "
            "       delta_source, delta_presence "
            "FROM conclusion_types WHERE id=?",
            (type_id,),
        ).fetchone()
        if not type_row or not int(type_row[0] or 0):
            log.info(
                "_try_delta_auto_send: skipped — delta_auto_send=0 for type_id=%s (ac_id=%s)",
                type_id, ac_id,
            )
            return  # delta_auto_send is off for this type

        # Mark that an auto-send was attempted (all gating passed). The background
        # re-send worker uses this to retry ONLY failed ingest sends — never
        # manually-created conclusions (operator-controlled) nor the pre-deploy
        # backlog (which has delta_attempted=0).
        conn.execute(
            "UPDATE analytical_conclusions SET delta_attempted=1 WHERE id=?",
            (ac_id,),
        )

        # Network for frequency / unit
        net_row = conn.execute(
            "SELECT frequency, unit FROM networks WHERE id=?", (network_id,)
        ).fetchone()
        frequency = (net_row[0] if net_row else "") or ""
        unit      = (net_row[1] if net_row else "") or ""

        # Format datetime "2026-05-25 09:58:42" → "25.05.2026 09:58:42"
        dt_fmt = created_at or ""
        try:
            raw_dt = dt_fmt.replace("T", " ")
            dp, tp = raw_dt.split(" ", 1)
            y, mo, d = dp.split("-")
            dt_fmt = f"{d}.{mo}.{y} {tp}"
        except Exception:
            pass

        mgrs_compact = ", ".join(m.replace(" ", "") for m in (mgrs_list or []) if m)

        delta_type     = str(type_row[1] or "")
        identification = _normalize_delta_identification(type_row[2])
        source         = str(type_row[3] or "")
        presence       = str(type_row[4] or "")

        header_lines: list[str] = []
        if delta_type:     header_lines.append(f"Тип: {delta_type}")
        if frequency:      header_lines.append(f"Назва: {frequency}")
        if identification: header_lines.append(f"Ідентифікація: {identification}")
        if unit:           header_lines.append(f"Підрозділ: {unit}")
        if presence:       header_lines.append(f"Присутність: {presence}")
        if source:         header_lines.append(f"Джерело: {source}")
        if dt_fmt:         header_lines.append(f"Час виявлення: {dt_fmt}")
        if mgrs_compact:   header_lines.append(f"MGRS: {mgrs_compact}")

        text = "\n\n".join(
            p for p in [
                "\n".join(header_lines),
                _fill_route_points((conclusion_text or "").strip(), mgrs_list),
                (body_text or "").strip(),
            ]
            if p
        )

        payload = _json.dumps(
            {"platform": platform, "chat_id": chat_id, "text": text}
        ).encode("utf-8")
        req = _ureq.Request(
            f"{_cfg.bot_service_url.rstrip('/')}/api/push/send",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with _ureq.urlopen(req, timeout=8) as resp:
            resp_data = _json.loads(resp.read())
            if resp_data.get("ok"):
                conn.execute(
                    "UPDATE analytical_conclusions SET sended=1 WHERE id=?",
                    (ac_id,),
                )
                log.info(
                    "_try_delta_auto_send: sent OK (ac_id=%s type_id=%s chat=%s)",
                    ac_id, type_id, chat_id,
                )
            else:
                log.warning(
                    "_try_delta_auto_send: bot returned not-ok (ac_id=%s): %s",
                    ac_id, resp_data,
                )
    except Exception as exc:
        log.warning("_try_delta_auto_send: exception (ac_id=%s): %s", ac_id, exc)
        pass  # best-effort; never break ingest


def _try_import_error_send(ingest_id: int) -> None:
    """Notify a messenger chat that an ingested message failed to parse and
    landed in the Import/Export error queue.

    Gated by app_settings: `import_err_send_enabled` (default "1") and a
    configured `import_err_chat_id`/`import_err_platform`. Runs AFTER the
    ingest transaction has committed, in its own short read — fully best-effort
    so it can never affect ingest. Only fires for rows whose final
    parse_status is an error-queue status.
    """
    from app.core.config import settings as _cfg  # local import to avoid circulars

    try:
        if not _cfg.bot_service_url:
            return
        with get_conn() as conn:
            srv = {
                r["key"]: r["value"]
                for r in conn.execute(
                    "SELECT key, value FROM app_settings WHERE key IN "
                    "('import_err_send_enabled','import_err_chat_id','import_err_platform')"
                ).fetchall()
            }
            if str(srv.get("import_err_send_enabled", "1")) != "1":
                return
            chat_id = (srv.get("import_err_chat_id") or "").strip()
            if not chat_id:
                return
            platform = (srv.get("import_err_platform") or "whatsapp").strip() or "whatsapp"
            row = conn.execute(
                "SELECT parse_status, parse_error, source_chat_name, message_format, raw_text "
                "FROM ingest_messages WHERE id=?",
                (ingest_id,),
            ).fetchone()
        if not row:
            return
        status = str(row["parse_status"] or "")
        if status not in ("parse_error", "skipped_unknown_format"):
            return  # not an error-queue row → nothing to notify

        reason = str(row["parse_error"] or (
            "невідомий формат" if status == "skipped_unknown_format" else "помилка розбору"
        ))
        src = str(row["source_chat_name"] or "")
        fmt = str(row["message_format"] or "")
        body = str(row["raw_text"] or "").strip()

        lines = ["⚠️ Помилка імпорту перехоплення"]
        if src:
            lines.append("Чат: " + src)
        if fmt:
            lines.append("Формат: " + fmt)
        lines.append("Причина: " + reason)
        text = "\n".join(lines) + ("\n\n" + body if body else "")

        payload = _json.dumps(
            {"platform": platform, "chat_id": chat_id, "text": text}
        ).encode("utf-8")
        req = _ureq.Request(
            f"{_cfg.bot_service_url.rstrip('/')}/api/push/send",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with _ureq.urlopen(req, timeout=8) as resp:
            rd = _json.loads(resp.read())
            if rd.get("ok"):
                log.info("_try_import_error_send: sent OK (ingest_id=%s chat=%s)", ingest_id, chat_id)
            else:
                log.warning("_try_import_error_send: bot returned not-ok (ingest_id=%s): %s", ingest_id, rd)
    except Exception as exc:
        log.warning("_try_import_error_send: exception (ingest_id=%s): %s", ingest_id, exc)


# ---------------------------------------------------------------------------
# Delta re-send worker
# ---------------------------------------------------------------------------
# The ingest-time Delta send is ONE-SHOT with no retry, so a transient blip
# (bot/WhatsApp/connectivity) leaves a classified conclusion stuck at sended=0.
# This background sweep re-attempts those failures. It is scoped tightly so it
# self-heals recent failures WITHOUT flooding the chat:
#   * sended = 0                  — not yet delivered
#   * delta_attempted = 1         — ingest tried & failed (excludes manual + backlog)
#   * created within window_hours — bounds retries for a permanently-stuck row
# Throttled (small batch + per-send delay) to avoid bursting the group.

_RESEND_WINDOW_HOURS = 24
_RESEND_BATCH = 10
_RESEND_POLL_SEC = 180

_resend_worker_started = False
_resend_worker_lock = _threading.Lock()


def resend_unsent_recent_conclusions(
    window_hours: int = _RESEND_WINDOW_HOURS,
    batch_size: int = _RESEND_BATCH,
) -> int:
    """Re-attempt the Delta auto-send for recently-failed conclusions.

    Returns the number successfully (re-)sent this sweep. Best-effort: any
    error is logged and swallowed so the worker keeps running.
    """
    from datetime import datetime, timedelta

    cutoff = (datetime.now() - timedelta(hours=window_hours)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    # 1) Fetch a small batch in one short read, then release the connection so
    #    the per-send POSTs below never hold a DB lock across the network call.
    try:
        with get_conn() as conn:
            rows = conn.execute(
                """
                SELECT ac.id, ac.type_id, ac.conclusion_text, ac.created_at,
                       ac.network_id, ac.mgrs_json, m.body_text
                FROM analytical_conclusions ac
                JOIN conclusion_types ct ON ct.id = ac.type_id
                LEFT JOIN messages m ON m.id = ac.message_id
                WHERE COALESCE(ac.sended, 0) = 0
                  AND COALESCE(ac.delta_attempted, 0) = 1
                  AND ac.type_id > 0
                  AND ct.delta_auto_send = 1
                  AND REPLACE(ac.created_at, 'T', ' ') >= ?
                ORDER BY ac.created_at ASC
                LIMIT ?
                """,
                (cutoff, batch_size),
            ).fetchall()
            batch = [dict(r) for r in rows]
    except Exception as exc:
        log.warning("resend_unsent_recent_conclusions: fetch failed: %s", exc)
        return 0

    sent = 0
    for r in batch:
        try:
            mgrs_list = _json.loads(r.get("mgrs_json") or "[]")
            if not isinstance(mgrs_list, list):
                mgrs_list = []
        except Exception:
            mgrs_list = []
        try:
            with get_conn() as conn:
                _try_delta_auto_send(
                    conn,
                    ac_id=int(r["id"]),
                    type_id=int(r["type_id"]),
                    conclusion_text=r.get("conclusion_text") or "",
                    body_text=r.get("body_text") or "",
                    created_at=r.get("created_at") or "",
                    network_id=int(r["network_id"]),
                    mgrs_list=mgrs_list,
                )
                after = conn.execute(
                    "SELECT sended FROM analytical_conclusions WHERE id=?",
                    (int(r["id"]),),
                ).fetchone()
                if after and int(after[0] or 0) == 1:
                    sent += 1
        except Exception as exc:
            log.warning("resend sweep: send failed (ac=%s): %s", r.get("id"), exc)
        _time.sleep(0.4)  # throttle — не спамити чат
    return sent


def start_delta_resend_worker(
    poll_interval_sec: int = _RESEND_POLL_SEC,
    window_hours: int = _RESEND_WINDOW_HOURS,
    batch_size: int = _RESEND_BATCH,
) -> None:
    """Start the background Delta re-send worker (idempotent, daemon thread)."""
    global _resend_worker_started
    with _resend_worker_lock:
        if _resend_worker_started:
            return
        _resend_worker_started = True

    def _loop():
        while True:
            try:
                n = resend_unsent_recent_conclusions(
                    window_hours=window_hours, batch_size=batch_size
                )
                if n:
                    log.info("delta-resend-worker: re-sent %d conclusion(s)", n)
            except Exception as exc:
                log.warning("delta-resend-worker: loop error: %s", exc)
            _time.sleep(poll_interval_sec)

    th = _threading.Thread(target=_loop, name="delta-resend-worker", daemon=True)
    th.start()
    log.info(
        "delta-resend-worker: started (poll=%ss window=%sh batch=%s)",
        poll_interval_sec, window_hours, batch_size,
    )


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

        existing_batch = cur.execute(
            "SELECT id FROM peleng_batches WHERE event_dt = ? AND network_id = ?",
            (created_at, network_id),
        ).fetchone()
        if existing_batch:
            batch_id = int(existing_batch[0] if not isinstance(existing_batch, dict) else existing_batch["id"])
            cur.execute(
                "UPDATE ingest_messages SET reviewed_at = ? WHERE id = ?",
                (now_sql(), ingest_id),
            )
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "duplicate": True,
                "peleng_batch_id": batch_id,
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

    # "Батальйони 63" conclusions are fully isolated: resolve the network
    # (read-only lookup) and store ONLY in battalion_conclusions for the
    # comparison report. No messages row, no callsign graph, no type
    # classification, not shown on the map, never auto-sent to Delta.
    if (
        message_format == "analytical_type"
        and parsed.get("analytical_source_side") == "battalions"
    ):
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
                "Battalion conclusion skipped: network not found %s",
                _intercept_log_ctx(parsed, raw_text),
                extra={
                    "ingest_id": ingest_id,
                    "frequency": e.frequency,
                    "mask": e.mask,
                    "reason": "network_not_found",
                },
            )
            mark_parse_error(cur, ingest_id, str(e))
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": "network_not_found",
                "details": {"frequency": e.frequency, "mask": e.mask},
                "actions": actions,
            }

        conclusion_text = parsed.get("analytical_conclusion") or ""
        mgrs_list = list(parsed.get("analytical_mgrs") or [])
        intercept_text = parsed.get("analytical_tail_text") or body_text or ""
        source_marker = parsed.get("analytical_source_marker") or ""

        bc_id = insert_battalion_conclusion(
            cur,
            network_id=network_id,
            created_at=created_at,
            conclusion_text=conclusion_text,
            mgrs_list=mgrs_list,
            source_marker=source_marker,
            intercept_text=intercept_text,
            received_at=received_at,
        )
        cur.execute(
            "UPDATE ingest_messages SET reviewed_at = ? WHERE id = ?",
            (now_sql(), ingest_id),
        )
        log.info(
            "Battalion conclusion stored (isolated)",
            extra={
                "ingest_id": ingest_id,
                "battalion_conclusion_id": bc_id,
                "network_id": network_id,
                "source_marker": source_marker,
            },
        )
        return {
            "ok": True,
            "ingest_id": ingest_id,
            "battalion_conclusion_id": bc_id,
            "parsed": {
                "message_format": "analytical_type",
                "source_side": "battalions",
                "source_marker": source_marker,
                "network_id": network_id,
            },
            "actions": actions,
        }

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
        # For analytical messages the intercept body may already be stored as a
        # plain 'intercept' record.  We still need to persist the analytical
        # conclusion — just link it to the existing message row.
        if message_format == "analytical_type":
            conclusion_text = parsed.get("analytical_conclusion") or ""
            mgrs_list = list(parsed.get("analytical_mgrs") or [])
            if conclusion_text:
                ac_info = insert_analytical_conclusion(
                    cur,
                    message_id=existing_message_id,
                    network_id=network_id,
                    created_at=created_at,
                    conclusion_text=conclusion_text,
                    mgrs_list=mgrs_list,
                )
                if ac_info["id"]:
                    _try_delta_auto_send(
                        conn,
                        ac_id=ac_info["id"],
                        type_id=ac_info["type_id"],
                        conclusion_text=conclusion_text,
                        body_text=body_text,
                        created_at=created_at,
                        network_id=network_id,
                        mgrs_list=mgrs_list,
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
            ac_info = insert_analytical_conclusion(
                cur,
                message_id=message_id,
                network_id=network_id,
                created_at=created_at,
                conclusion_text=conclusion_text,
                mgrs_list=mgrs_list,
            )
            if ac_info["id"]:
                _try_delta_auto_send(
                    conn,
                    ac_id=ac_info["id"],
                    type_id=ac_info["type_id"],
                    conclusion_text=conclusion_text,
                    body_text=body_text,
                    created_at=created_at,
                    network_id=network_id,
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

        result = _run_ingest_pipeline(
            conn,
            cur,
            ingest_id=ingest_id,
            platform=platform,
            raw_text=raw_text,
            received_at=received_at,
            published_at_platform=published_at_platform,
            actions=actions,
        )

    # Transaction committed above. If this message ended up in the Import/Export
    # error queue, optionally notify a messenger chat (best-effort, gated by
    # app settings). Runs outside the tx so it never holds a DB lock or rolls
    # back ingest.
    try:
        _try_import_error_send(ingest_id)
    except Exception:
        pass
    return result


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