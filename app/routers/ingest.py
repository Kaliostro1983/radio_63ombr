from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional, List

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.db import get_conn
from app.core.logging import get_logger
from app.core.intercept_parser import is_template_intercept, parse_template_intercept

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
    # rows: (cid, name, type, notnull, dflt_value, pk)
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
    group_id=7, status_id=14 always for auto-created (as per your rule).
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

    # optional lookup by mask
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

    log.notice(f"Created new network: frequency={frequency!r}, unit={unit!r}, zone={zone!r}, group_id=7, status_id=14")
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


@router.post("/ingest/whatsapp")
async def ingest_whatsapp(request: Request):
    payload: Dict[str, Any] = await request.json()

    platform = payload.get("platform") or "whatsapp"
    source_chat_id = payload.get("chat_id")
    source_chat_name = payload.get("chat_name")
    source_message_id = payload.get("message_id")
    raw_text = payload.get("text") or ""
    published_at_platform = payload.get("published_at_platform")  # ISO from Node (optional)

    if not source_chat_id or not source_message_id or not raw_text:
        return JSONResponse({"ok": False, "error": "chat_id, message_id, text are required"}, status_code=400)

    received_at = _now_sql()

    with get_conn() as conn:
        cur = conn.cursor()

        # 1) journal ingest_messages
        try:
            cur.execute(
                """
                INSERT INTO ingest_messages (
                  platform, source_chat_id, source_chat_name, source_message_id,
                  raw_text, published_at_text, published_at_platform, received_at,
                  parse_status, parse_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL)
                """,
                (
                    platform,
                    source_chat_id,
                    source_chat_name,
                    source_message_id,
                    raw_text,
                    None,
                    published_at_platform,
                    received_at,
                ),
            )
            ingest_id = int(cur.lastrowid)
        except Exception as e:
            # likely duplicate UNIQUE(platform, source_message_id)
            return {"ok": True, "duplicate": True, "reason": str(e), "actions": []}

        # 2) template routing
        if not is_template_intercept(raw_text):
            log.notice("Nonstandard intercept received; skipping DB write (messages/networks/callsigns).")
            cur.execute(
                "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
                ("skipped_nonstandard", "nonstandard format", ingest_id),
            )
            return {"ok": True, "ingest_id": ingest_id, "skipped": True, "reason": "nonstandard", "actions": []}

        # 3) parse template
        parsed = parse_template_intercept(raw_text)
        if not parsed.get("ok"):
            err = parsed.get("error") or "template_parse_failed"
            log.notice(f"Template intercept failed validation; skipping. error={err}")
            cur.execute(
                "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
                ("skipped_nonstandard", str(err), ingest_id),
            )
            return {"ok": True, "ingest_id": ingest_id, "skipped": True, "reason": err, "actions": []}

        published_at_text = parsed.get("published_at_text")
        frequency = parsed.get("frequency")
        mask = parsed.get("mask")
        unit = parsed.get("unit")
        zone = parsed.get("zone")
        caller = parsed.get("caller")
        callees = parsed.get("callees") or []
        body_text = parsed.get("body") or ""
        parse_confidence = float(parsed.get("parse_confidence") or 0.9)

        created_at = published_at_platform or published_at_text or received_at

        # store published_at_text into journal (useful for audits)
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

        # 5) insert message (NEW STRUCTURE)
        cur.execute(
            """
            INSERT INTO messages (
              ingest_id, network_id,
              created_at, received_at,
              body_text,
              comment, parse_confidence, is_valid
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1)
            """,
            (ingest_id, network_id, created_at, received_at, body_text, parse_confidence),
        )
        message_id = int(cur.lastrowid)

        # 6) callsigns directory + links (normalized)
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

        # 7) edges
        if caller_id is not None:
            for callee_id in callee_ids:
                upsert_callsign_edge(cur, int(network_id), int(caller_id), int(callee_id), created_at)

    # Відповідь Node-боту (actions за бажанням)
    actions = [
        {
            "type": "send_message",
            "chat_id": source_chat_id,
            "text": f"✅ Прийнято. message_id={message_id}",
        }
    ]

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