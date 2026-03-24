"""Persistence helpers for the ingest pipeline.

This module contains low-level SQL helpers used by `ingest_service` to
persist ingestion state and parsed messages into SQLite.

Usage in the system:

- `insert_ingest_message` stores the raw payload into `ingest_messages` for
  traceability and potential re-processing.
- `set_message_format` / `set_normalized_text` / `set_published_at_text`
  update ingestion metadata after parsing/normalization decisions.
- `find_duplicate_message` implements the system invariant for message
  duplicates: (network_id, created_at, body_text).
- `insert_message` inserts parsed, normalized messages into `messages`.

These functions intentionally do not contain parsing or business logic; the
service layer coordinates the pipeline order.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.db_utils import safe_execute


def get_table_columns(cur, table_name: str) -> List[str]:
    """Return a list of column names for a SQLite table.

    Args:
        cur: SQLite cursor.
        table_name: name of the table.

    Returns:
        List[str]: column names in table order.
    """
    rows = safe_execute(cur, f"PRAGMA table_info({table_name})", module="app.services.ingest_store", function="get_table_columns").fetchall()
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
    """Insert a raw incoming message into `ingest_messages`.

    The raw ingest row is stored before any parsing to preserve traceability
    and to provide a stable deduplication point for source messages.

    Args:
        cur: SQLite cursor.
        platform: ingestion source identifier (e.g. `whatsapp`, `xlsx`).
        source_chat_id: external chat identifier.
        source_chat_name: human-readable chat name.
        source_message_id: external message identifier.
        raw_text: raw message body text.
        received_at: timestamp when the system received the payload.

    Returns:
        int: inserted `ingest_messages.id`.
    """
    safe_execute(
        cur,
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
    """Persist the detected message format for an ingest row.

    Args:
        cur: SQLite cursor.
        ingest_id: `ingest_messages.id` to update.
        message_format: string format label used by the system.
    """
    safe_execute(
        cur,
        "UPDATE ingest_messages SET message_format=? WHERE id=?",
        (message_format, ingest_id),
        module="app.services.ingest_store",
        function="set_message_format",
    )


def mark_unknown_format(cur, ingest_id: int) -> None:
    """Mark an ingest row as skipped due to unknown message format."""
    safe_execute(
        cur,
        "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
        ("skipped_unknown_format", "unknown format", ingest_id),
        module="app.services.ingest_store",
        function="mark_unknown_format",
    )


def set_normalized_text(cur, ingest_id: int, normalized_text: str) -> None:
    """Store normalized text for an ingest row (nonstandard normalization path)."""
    safe_execute(
        cur,
        "UPDATE ingest_messages SET normalized_text=?, parse_status=? WHERE id=?",
        (normalized_text, "normalized_nonstandard", ingest_id),
        module="app.services.ingest_store",
        function="set_normalized_text",
    )


def mark_parse_error(cur, ingest_id: int, err: str) -> None:
    """Mark an ingest row as failed/skipped due to a parse error."""
    safe_execute(
        cur,
        "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
        ("parse_error", str(err), ingest_id),
        module="app.services.ingest_store",
        function="mark_parse_error",
    )


def set_published_at_text(cur, ingest_id: int, published_at_text: Optional[str]) -> None:
    """Store the parsed/published datetime text for an ingest row."""
    safe_execute(
        cur,
        "UPDATE ingest_messages SET published_at_text=?, parse_status=? WHERE id=?",
        (published_at_text, "parsed", ingest_id),
        module="app.services.ingest_store",
        function="set_published_at_text",
    )


def find_duplicate_message(
    cur,
    *,
    network_id: int,
    created_at: str,
    body_text: str,
) -> Optional[int]:
    """Find an existing message that is a duplicate by invariant rule.

    Duplicate rule (system invariant):
        (network_id, created_at, body_text)

    Args:
        cur: SQLite cursor.
        network_id: resolved network id.
        created_at: message timestamp (ISO TEXT).
        body_text: message body text.

    Returns:
        Optional[int]: existing `messages.id` if a duplicate exists, else None.
    """
    row = safe_execute(
        cur,
        """
        SELECT id
        FROM messages
        WHERE network_id = ?
          AND created_at = ?
          AND body_text = ?
        LIMIT 1
        """,
        (network_id, created_at, body_text.strip()),
        module="app.services.ingest_store",
        function="find_duplicate_message",
    ).fetchone()

    if not row:
        return None

    return int(row[0] if not isinstance(row, dict) else row["id"])


def mark_duplicate_content(cur, ingest_id: int, existing_message_id: int) -> None:
    """Mark an ingest row as duplicate of an already stored message.

    Args:
        cur: SQLite cursor.
        ingest_id: `ingest_messages.id` to update.
        existing_message_id: `messages.id` of the duplicate target.
    """
    safe_execute(
        cur,
        "UPDATE ingest_messages SET parse_status=?, parse_error=? WHERE id=?",
        ("duplicate_content", f"duplicate of message_id={existing_message_id}", ingest_id),
        module="app.services.ingest_store",
        function="mark_duplicate_content",
    )


def insert_message(
    cur,
    *,
    ingest_id: int,
    network_id: int,
    created_at: str,
    received_at: str,
    body_text: str,
    content_type: str = "intercept",
    parse_confidence: float,
    delay_sec: Optional[int],
    net_description: Optional[str] = None,
) -> int:
    """Insert a parsed message into `messages`.

    The helper introspects the table columns to remain compatible with
    lightweight migrations (e.g. optional columns like `net_description`,
    `delay_sec`).

    Args:
        cur: SQLite cursor.
        ingest_id: FK to `ingest_messages.id`.
        network_id: FK to `networks.id`.
        created_at: message datetime (ISO TEXT).
        received_at: ingest receive datetime (ISO TEXT).
        body_text: message body.
        content_type: logical message type (`intercept`, `analytical`, `peleng`).
        parse_confidence: parse confidence score.
        delay_sec: delay between platform timestamp and message timestamp.
        net_description: optional network description line for UI display.

    Returns:
        int: inserted `messages.id`.
    """
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

    if "content_type" in message_cols:
        insert_cols.insert(6, "content_type")
        insert_vals.insert(6, (content_type or "intercept").strip().lower() or "intercept")

    placeholders = ", ".join(["?"] * len(insert_cols))
    sql = f"""
        INSERT INTO messages (
          {", ".join(insert_cols)}
        ) VALUES ({placeholders})
    """
    safe_execute(
        cur,
        sql,
        tuple(insert_vals),
        module="app.services.ingest_store",
        function="insert_message",
    )
    message_id = int(cur.lastrowid)

    # Schedule post-ingest landmark matching in background queue (optional; see LANDMARK_AUTO_MATCH).
    if settings.landmark_auto_match_enabled:
        safe_execute(
            cur,
            """
            INSERT OR IGNORE INTO message_landmark_queue (
                message_id, status, attempts, last_error, queued_at, processed_at, updated_at
            )
            VALUES (?, 'pending', 0, NULL, ?, NULL, ?)
            """,
            (message_id, received_at, received_at),
            module="app.services.ingest_store",
            function="insert_message",
            stage="enqueue:message_landmark_queue",
        )

    return message_id