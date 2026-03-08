from __future__ import annotations

from typing import Any, Dict, List, Optional


def get_table_columns(cur, table_name: str) -> List[str]:
    rows = cur.execute(f"PRAGMA table_info({table_name})").fetchall()
    out: List[str] = []
    for r in rows:
        out.append(r[1] if not isinstance(r, dict) else r["name"])
    return out


def insert_ingest_message(
    cur,
    *,
    platform: str,
    source_chat_id: str,
    source_chat_name: Optional[str],
    source_message_id: str,
    raw_text: str,
    received_at: str,
) -> int:
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
    return int(cur.lastrowid)


def set_message_format(cur, ingest_id: int, message_format: str) -> None:
    cur.execute(
        "UPDATE ingest_messages SET message_format=? WHERE id=?",
        (message_format, ingest_id),
    )


def mark_unknown_format(cur, ingest_id: int) -> None:
    cur.execute(
        "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
        ("skipped_unknown_format", "unknown format", ingest_id),
    )


def set_normalized_text(cur, ingest_id: int, normalized_text: str) -> None:
    cur.execute(
        "UPDATE ingest_messages SET normalized_text=?, parse_status=? WHERE id=?",
        (normalized_text, "normalized_nonstandard", ingest_id),
    )


def mark_parse_error(cur, ingest_id: int, err: str) -> None:
    cur.execute(
        "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
        ("parse_error", str(err), ingest_id),
    )


def set_published_at_text(cur, ingest_id: int, published_at_text: Optional[str]) -> None:
    cur.execute(
        "UPDATE ingest_messages SET published_at_text=?, parse_status=? WHERE id=?",
        (published_at_text, "parsed", ingest_id),
    )


def find_duplicate_message(
    cur,
    *,
    network_id: int,
    created_at: str,
    body_text: str,
) -> Optional[int]:
    row = cur.execute(
        """
        SELECT id
        FROM messages
        WHERE network_id = ?
          AND created_at = ?
          AND body_text = ?
        LIMIT 1
        """,
        (network_id, created_at, body_text.strip()),
    ).fetchone()

    if not row:
        return None

    return int(row[0] if not isinstance(row, dict) else row["id"])


def mark_duplicate_content(cur, ingest_id: int, existing_message_id: int) -> None:
    cur.execute(
        "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
        ("duplicate_content", f"duplicate of message_id={existing_message_id}", ingest_id),
    )


def insert_message(
    cur,
    *,
    ingest_id: int,
    network_id: int,
    created_at: str,
    received_at: str,
    body_text: str,
    parse_confidence: float,
    delay_sec: Optional[int],
    net_description: Optional[str] = None,
) -> int:
    message_cols = set(get_table_columns(cur, "messages"))

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
    return int(cur.lastrowid)