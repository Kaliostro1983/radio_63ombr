from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional, List

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.db import get_conn
from app.core.logging import get_logger
from app.core.intercept_parser import parse_template_intercept
from app.core.validators import detect_message_format
from app.core.normalize import normalize_nonstandard_type_1

router = APIRouter(prefix="/api", tags=["ingest"])
log = get_logger("ingest")


def _now_sql() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _table_exists(cur, table_name: str) -> bool:
    row = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (table_name,),
    ).fetchone()
    return bool(row)


def _get_table_columns(cur, table_name: str) -> List[str]:
    rows = cur.execute(f"PRAGMA table_info({table_name})").fetchall()
    out: List[str] = []
    for r in rows:
        out.append(r[1] if not isinstance(r, dict) else r["name"])
    return out


def _get_default_network_chat_id(cur) -> int:
    """
    networks.chat_id is NOT NULL. We pick deterministic default:
      - if chats exists: try "Невідомо" by name/title, else first chats.id
      - else fallback to first networks.chat_id
    """
    if _table_exists(cur, "chats"):
        cols = set(_get_table_columns(cur, "chats"))
        if "name" in cols:
            row = cur.execute("SELECT id FROM chats WHERE name=? LIMIT 1", ("Невідомо",)).fetchone()
            if row:
                return int(row[0] if not isinstance(row, dict) else row["id"])
        if "title" in cols:
            row = cur.execute("SELECT id FROM chats WHERE title=? LIMIT 1", ("Невідомо",)).fetchone()
            if row:
                return int(row[0] if not isinstance(row, dict) else row["id"])

        row = cur.execute("SELECT id FROM chats ORDER BY id LIMIT 1").fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    row = cur.execute("SELECT chat_id FROM networks ORDER BY id LIMIT 1").fetchone()
    if row:
        return int(row[0] if not isinstance(row, dict) else row["chat_id"])

    raise RuntimeError("Cannot determine default networks.chat_id (tables chats/networks look empty).")


def ensure_network(
    cur,
    frequency: Optional[str],
    mask: Optional[str],
    now_dt: str,
    unit: Optional[str],
    zone: Optional[str],
) -> int:
    """
    If exists -> return id.
    Else -> create. Defaults only if unit/zone absent in intercept.
    group_id=7, status_id=14 always for auto-created.
    """
    def norm_s(v: Optional[str]) -> Optional[str]:
        v = (v or "").strip()
        return v or None

    frequency = norm_s(frequency)
    mask = norm_s(mask)
    unit = norm_s(unit) or "НВ підрозділу"
    zone = norm_s(zone) or "розвідується"

    if not frequency:
        frequency = f"UNKNOWN:{now_dt}"

    row = cur.execute("SELECT id FROM networks WHERE frequency=? LIMIT 1", (frequency,)).fetchone()
    if row:
        return int(row[0] if not isinstance(row, dict) else row["id"])

    if mask:
        row = cur.execute("SELECT id FROM networks WHERE mask=? LIMIT 1", (mask,)).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    chat_id = _get_default_network_chat_id(cur)

    cols = set(_get_table_columns(cur, "networks"))
    insert_cols: List[str] = []
    insert_vals: List[Any] = []

    def add(col: str, val: Any) -> None:
        if col in cols:
            insert_cols.append(col)
            insert_vals.append(val)

    add("frequency", frequency)
    add("mask", mask)
    add("unit", unit)
    add("zone", zone)
    add("chat_id", chat_id)
    add("group_id", 7)
    add("status_id", 14)
    add("comment", "auto-created")
    add("updated_at", now_dt)
    if "net_key" in cols:
        add("net_key", frequency)

    sql = f"INSERT INTO networks ({', '.join(insert_cols)}) VALUES ({', '.join(['?'] * len(insert_cols))})"
    cur.execute(sql, tuple(insert_vals))
    new_id = int(cur.lastrowid)

    log.notice(
        f"Created new network: frequency={frequency!r}, unit={unit!r}, zone={zone!r}, group_id=7, status_id=14"
    )
    return new_id


def upsert_callsign_edge(cur, network_id: int, a_id: int, b_id: int, dt: str) -> None:
    if not network_id or not a_id or not b_id or a_id == b_id:
        return
    if a_id > b_id:
        a_id, b_id = b_id, a_id

    cur.execute(
        """
        INSERT INTO callsign_edges
            (network_id, a_callsign_id, b_callsign_id, first_seen_dt, last_seen_dt, cnt)
        VALUES
            (?, ?, ?, ?, ?, 1)
        ON CONFLICT(network_id, a_callsign_id, b_callsign_id)
        DO UPDATE SET
            last_seen_dt = CASE
                WHEN callsign_edges.last_seen_dt < excluded.last_seen_dt THEN excluded.last_seen_dt
                ELSE callsign_edges.last_seen_dt
            END,
            cnt = callsign_edges.cnt + 1
        """,
        (network_id, a_id, b_id, dt, dt),
    )


def _to_sql_dt(dt_text: str | None) -> str | None:
    if not dt_text:
        return None
    s = str(dt_text).strip()
    try:
        if "," in s:
            dt = datetime.strptime(s, "%d.%m.%Y, %H:%M:%S")
        else:
            dt = datetime.strptime(s, "%d.%m.%Y %H:%M:%S")
        return dt.isoformat(timespec="seconds")
    except Exception:
        return None


def _calc_delay_sec(
    platform: str,
    published_at_platform: Optional[str],
    published_at_text: Optional[str],
) -> Optional[int]:
    if platform == "xlsx_import":
        return 0

    if not published_at_platform or not published_at_text:
        return None

    try:
        dt_platform = datetime.fromisoformat(str(published_at_platform).strip())

        published_text_raw = str(published_at_text).strip()
        if "," in published_text_raw:
            dt_text = datetime.strptime(published_text_raw, "%d.%m.%Y, %H:%M:%S")
        else:
            dt_text = datetime.strptime(published_text_raw, "%d.%m.%Y %H:%M:%S")

        return int((dt_platform - dt_text).total_seconds())
    except Exception as e:
        log.notice(f"Failed to calculate delay_sec: {e}")
        return None


@router.post("/ingest/whatsapp")
async def ingest_whatsapp(request: Request):
    payload: Dict[str, Any] = await request.json()

    platform = payload.get("platform") or "whatsapp"
    source_chat_id = payload.get("chat_id")
    source_chat_name = payload.get("chat_name")
    source_message_id = payload.get("message_id")
    raw_text = payload.get("text") or ""
    published_at_platform = payload.get("published_at_platform")

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
        return JSONResponse(
            {"ok": False, "error": "chat_id, message_id, text are required"},
            status_code=400,
        )

    received_at = _now_sql()

    with get_conn() as conn:
        cur = conn.cursor()

        # 1) journal ingest_messages
        try:
            cur.execute(
                """
                INSERT INTO ingest_messages (
                  platform, source_chat_id, source_chat_name, source_message_id,
                  raw_text, published_at_text, received_at,
                  message_format, parse_status, parse_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    platform,
                    source_chat_id,
                    source_chat_name,
                    source_message_id,
                    raw_text,
                    None,
                    received_at,
                    None,
                    "received",
                ),
            )
            ingest_id = int(cur.lastrowid)
        except Exception as e:
            return {"ok": True, "duplicate": True, "reason": str(e), "actions": actions}

        # 2) detect message format
        message_format = detect_message_format(raw_text)

        cur.execute(
            "UPDATE ingest_messages SET message_format=? WHERE id=?",
            (message_format, ingest_id),
        )

        if message_format == "unknown":
            log.notice("Unknown intercept format; skipping DB write (messages/networks/callsigns).")
            cur.execute(
                "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
                ("skipped_unknown_format", "unknown format", ingest_id),
            )
            return {
                "ok": True,
                "ingest_id": ingest_id,
                "skipped": True,
                "reason": "unknown format",
                "actions": actions,
            }

        if message_format == "nonstandard_type_1":
            normalized = normalize_nonstandard_type_1(raw_text)

            cur.execute(
                "UPDATE ingest_messages SET normalized_text=?, parse_status=? WHERE id=?",
                (normalized, "normalized_nonstandard", ingest_id),
            )

            raw_text = normalized

        # 3) parse template
        parsed = parse_template_intercept(raw_text)
        if not parsed.get("ok"):
            err = parsed.get("error") or "template_parse_failed"
            log.notice(f"Template intercept failed validation; skipping. error={err}")
            cur.execute(
                "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
                ("parse_error", str(err), ingest_id),
            )
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

        created_at = _to_sql_dt(published_at_text) or received_at

        cur.execute(
            "UPDATE ingest_messages SET published_at_text=?, parse_status=? WHERE id=?",
            (published_at_text, "parsed", ingest_id),
        )

        # 4) ensure network exists
        network_id = ensure_network(
            cur,
            frequency=frequency,
            mask=mask,
            now_dt=received_at,
            unit=unit,
            zone=zone,
        )

        # 5) duplicate guard on parsed intercept content
        body_norm = (body_text or "").strip()

        existing_message = cur.execute(
            """
            SELECT id
            FROM messages
            WHERE network_id = ?
              AND created_at = ?
              AND body_text = ?
            LIMIT 1
            """,
            (
                network_id,
                created_at,
                body_norm,
            ),
        ).fetchone()

        if existing_message:
            existing_message_id = int(
                existing_message[0] if not isinstance(existing_message, dict) else existing_message["id"]
            )

            log.notice(
                f"Duplicate parsed intercept detected; skipping message insert. "
                f"existing_message_id={existing_message_id}, network_id={network_id}, created_at={created_at}"
            )

            cur.execute(
                "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
                ("duplicate_content", f"duplicate of message_id={existing_message_id}", ingest_id),
            )

            return {
                "ok": True,
                "ingest_id": ingest_id,
                "duplicate": True,
                "duplicate_stage": "message_content",
                "existing_message_id": existing_message_id,
                "actions": actions,
            }

        # 6) insert message
        delay_sec = _calc_delay_sec(
            platform=platform,
            published_at_platform=published_at_platform,
            published_at_text=published_at_text,
        )

        message_cols = set(_get_table_columns(cur, "messages"))

        insert_cols = [
            "ingest_id",
            "network_id",
            "created_at",
            "received_at",
            "body_text",
            "comment",
            "parse_confidence",
            "is_valid",
        ]
        insert_vals: List[Any] = [
            ingest_id,
            network_id,
            created_at,
            received_at,
            body_text,
            None,
            parse_confidence,
            1,
        ]

        if "net_description" in message_cols:
            insert_cols.insert(4, "net_description")
            insert_vals.insert(4, net_description)

        if "delay_sec" in message_cols:
            insert_cols.append("delay_sec")
            insert_vals.append(delay_sec)

        placeholders = ", ".join(["?"] * len(insert_cols))
        sql = f"""
            INSERT INTO messages (
              {", ".join(insert_cols)}
            ) VALUES ({placeholders})
        """
        cur.execute(sql, tuple(insert_vals))
        message_id = int(cur.lastrowid)

        # 7) callsigns directory + links
        def upsert_callsign(name: Optional[str], role: str) -> Optional[int]:
            name = (name or "").strip()
            if not name:
                return None

            row = cur.execute(
                "SELECT id FROM callsigns WHERE network_id=? AND name=?",
                (network_id, name),
            ).fetchone()

            if row:
                cs_id = int(row[0] if not isinstance(row, dict) else row["id"])
                cur.execute(
                    """
                    UPDATE callsigns
                    SET last_seen_dt = CASE
                        WHEN last_seen_dt IS NULL OR last_seen_dt < ? THEN ?
                        ELSE last_seen_dt
                    END
                    WHERE id = ?
                    """,
                    (created_at, created_at, cs_id),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO callsigns (network_id, name, status_id, comment, updated_at, last_seen_dt)
                    VALUES (?, ?, NULL, NULL, ?, ?)
                    """,
                    (network_id, name, received_at, created_at),
                )
                cs_id = int(cur.lastrowid)

            cur.execute(
                "INSERT OR IGNORE INTO message_callsigns (message_id, callsign_id, role) VALUES (?, ?, ?)",
                (message_id, cs_id, role),
            )
            return cs_id

        caller_id = upsert_callsign(caller, "caller")
        callee_ids: List[int] = []
        for c in callees:
            cid = upsert_callsign(c, "callee")
            if cid is not None:
                callee_ids.append(cid)

        # 8) edges
        if caller_id is not None:
            for callee_id in callee_ids:
                upsert_callsign_edge(cur, int(network_id), int(caller_id), int(callee_id), created_at)

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