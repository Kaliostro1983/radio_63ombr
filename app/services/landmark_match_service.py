"""Background landmark keyword matching service.

This module provides post-ingest matching of message text to landmark
keywords and stores results in `message_landmark_matches`.

Architecture:
- ingest inserts into `messages`;
- when `LANDMARK_AUTO_MATCH=1`, ingest enqueues `message_id` into `message_landmark_queue`;
- a lightweight background worker processes pending queue rows (same flag);
- API/UI reads match rows and renders highlight + map geometry.

When automatic matching is off (default), nothing is queued and the worker is not started.
"""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime
from typing import Any

from app.core.config import settings
from app.core.db import get_conn

MATCHER_VERSION = "v1"
MAX_ATTEMPTS = 5

_worker_lock = threading.Lock()
_worker_started = False


def _now_iso() -> str:
    """Return current UTC timestamp in ISO format."""
    return datetime.utcnow().isoformat()


def _keyword_pattern(keyword: str) -> re.Pattern[str]:
    """Build a whole-word regex for a landmark keyword."""
    return re.compile(rf"(?<!\w){re.escape(keyword)}(?!\w)", flags=re.IGNORECASE)


def _load_active_landmarks(conn) -> list[dict[str, Any]]:
    """Load active landmarks used by matcher."""
    rows = conn.execute(
        """
        SELECT id, key_word
        FROM landmarks
        WHERE is_active = 1
          AND key_word IS NOT NULL
          AND trim(key_word) <> ''
        """
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        out.append({"id": int(row["id"]), "key_word": str(row["key_word"]).strip().lower()})
    return out


def enqueue_message_landmark_match(conn, message_id: int, queued_at: str | None = None) -> None:
    """Queue one message for background landmark matching."""
    if not settings.landmark_auto_match_enabled:
        return
    ts = queued_at or _now_iso()
    conn.execute(
        """
        INSERT INTO message_landmark_queue (
            message_id, status, attempts, last_error, queued_at, processed_at, updated_at
        )
        VALUES (?, 'pending', 0, NULL, ?, NULL, ?)
        ON CONFLICT(message_id) DO UPDATE SET
            status = 'pending',
            last_error = NULL,
            queued_at = excluded.queued_at,
            updated_at = excluded.updated_at
        """,
        (message_id, ts, ts),
    )


def _match_message(conn, message_id: int) -> int:
    """Match one message text against active landmark keywords."""
    msg = conn.execute(
        """
        SELECT id, body_text
        FROM messages
        WHERE id = ? AND COALESCE(is_valid, 1) = 1
        LIMIT 1
        """,
        (message_id,),
    ).fetchone()
    if not msg:
        return 0

    body_text = str(msg["body_text"] or "")
    if not body_text.strip():
        conn.execute("DELETE FROM message_landmark_matches WHERE id_message = ?", (message_id,))
        return 0

    landmarks = _load_active_landmarks(conn)

    # Compute matches first to keep the write lock short.
    # Only after the whole CPU matching is done we delete/reinsert.
    created_at = _now_iso()
    inserts: list[tuple[Any, ...]] = []
    for landmark in landmarks:
        keyword = landmark["key_word"]
        pattern = _keyword_pattern(keyword)
        for match in pattern.finditer(body_text):
            inserts.append(
                (
                    message_id,
                    landmark["id"],
                    body_text[match.start() : match.end()],
                    int(match.start()),
                    int(match.end()),
                    created_at,
                    MATCHER_VERSION,
                )
            )

    # Rebuild matches for deterministic reprocessing.
    conn.execute("DELETE FROM message_landmark_matches WHERE id_message = ?", (message_id,))

    if inserts:
        conn.executemany(
            """
            INSERT OR IGNORE INTO message_landmark_matches (
                id_message, id_landmark, matched_text, start_pos, end_pos, created_at, matcher_version
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            inserts,
        )

    return len(inserts)


def process_pending_landmark_queue_batch(batch_size: int = 50) -> int:
    """Process one queue batch and return number of processed messages."""
    now = _now_iso()
    processed = 0

    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT message_id
            FROM message_landmark_queue
            WHERE status IN ('pending', 'error')
              AND attempts < ?
            ORDER BY queued_at ASC
            LIMIT ?
            """,
            (MAX_ATTEMPTS, int(batch_size)),
        ).fetchall()
        message_ids = [int(row["message_id"]) for row in rows]

        for message_id in message_ids:
            conn.execute(
                """
                UPDATE message_landmark_queue
                SET status = 'processing',
                    attempts = attempts + 1,
                    updated_at = ?
                WHERE message_id = ?
                """,
                (now, message_id),
            )
            # Commit quickly after status update so other writers/reads are not
            # blocked by a long-running batch transaction.
            conn.commit()

            try:
                _match_message(conn, message_id)
                done_at = _now_iso()
                conn.execute(
                    """
                    UPDATE message_landmark_queue
                    SET status = 'done',
                        last_error = NULL,
                        processed_at = ?,
                        updated_at = ?
                    WHERE message_id = ?
                    """,
                    (done_at, done_at, message_id),
                )
                conn.commit()
                processed += 1
            except Exception as exc:
                err_at = _now_iso()
                conn.execute(
                    """
                    UPDATE message_landmark_queue
                    SET status = 'error',
                        last_error = ?,
                        updated_at = ?
                    WHERE message_id = ?
                    """,
                    (str(exc), err_at, message_id),
                )
                conn.commit()

    return processed


def start_landmark_match_worker(poll_interval_sec: float = 2.0, batch_size: int = 10) -> None:
    """Start daemon worker thread once per process."""
    if not settings.landmark_auto_match_enabled:
        return
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    def _loop():
        while True:
            try:
                processed = process_pending_landmark_queue_batch(batch_size=batch_size)
                if processed == 0:
                    time.sleep(poll_interval_sec)
            except Exception:
                time.sleep(max(2.0, poll_interval_sec))

    th = threading.Thread(target=_loop, name="landmark-match-worker", daemon=True)
    th.start()


def get_message_landmark_matches(message_id: int) -> list[dict[str, Any]]:
    """Return landmark matches for one message with geometry data."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                mlm.id,
                mlm.id_message,
                mlm.id_landmark,
                mlm.matched_text,
                mlm.start_pos,
                mlm.end_pos,
                mlm.created_at,
                mlm.matcher_version,
                l.name AS landmark_name,
                l.key_word,
                l.location_wkt,
                l.location_kind,
                l.id_geom,
                l.id_group,
                l.comment AS landmark_comment,
                l.id_type,
                lt.name AS landmark_type_name
            FROM message_landmark_matches mlm
            JOIN landmarks l ON l.id = mlm.id_landmark
            LEFT JOIN landmark_types lt ON lt.id = l.id_type
            WHERE mlm.id_message = ?
            ORDER BY mlm.start_pos ASC, mlm.id ASC
            """,
            (message_id,),
        ).fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        out.append(
            {
                "id": int(row["id"]),
                "id_message": int(row["id_message"]),
                "id_landmark": int(row["id_landmark"]),
                "matched_text": row["matched_text"] or "",
                "start_pos": int(row["start_pos"] or -1),
                "end_pos": int(row["end_pos"] or -1),
                "created_at": row["created_at"] or "",
                "matcher_version": row["matcher_version"] or "",
                "landmark": {
                    "id": int(row["id_landmark"]),
                    "name": row["landmark_name"] or "",
                    "key_word": row["key_word"] or "",
                    "location_wkt": row["location_wkt"] or "",
                    "location_kind": row["location_kind"] or "",
                    "id_geom": int(row["id_geom"]) if row["id_geom"] is not None else None,
                    "id_group": int(row["id_group"]) if row["id_group"] is not None else None,
                    "comment": row["landmark_comment"] or "",
                    "id_type": row["id_type"],
                    "type_name": row["landmark_type_name"] or "",
                },
            }
        )
    return out
