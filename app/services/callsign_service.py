"""Callsign persistence and callsign-graph updates.

This module is responsible for linking parsed callsigns to messages and
maintaining the aggregated callsign interaction graph:

- Upsert callsigns into `callsigns` (unique per network).
- Link callsigns to a message in `message_callsigns` with roles
  (`caller` / `callee`).
- Update aggregated edges in `callsign_edges` to track interactions over
  time.

Key system invariants enforced here:

- Callsign uniqueness is scoped to a network: (network_id, name).
- Graph edges are stored in normalized order: a_callsign_id < b_callsign_id.
- Technical callsign "НВ" must not create edges.
- Edges are updated only after the message is inserted into `messages`.
"""

from __future__ import annotations

from typing import List, Optional

from app.core.callsign_normalizer import normalize_callsign


def upsert_callsign(
    cur,
    network_id: int,
    message_id: int,
    name: Optional[str],
    role: str,
    created_at: str,
    received_at: str,
) -> Optional[int]:
    """Upsert a callsign and link it to a message with a specific role.

    Args:
        cur: SQLite cursor.
        network_id: network scope for callsign uniqueness.
        message_id: message to link the callsign to.
        name: callsign name token.
        role: callsign role in message (`caller` or `callee`).
        created_at: message time (for last_seen updates).
        received_at: ingest receive time (for updated_at field on insert).

    Returns:
        Optional[int]: callsign id, or None if the provided name is empty.
    """
    name = (name or "").strip()
    if not name:
        return None

    # Check if there is a registered correction for this callsign name within
    # this network (e.g. created by a previous MERGE operation).  If so,
    # redirect silently to the correct name so that re-ingested messages
    # automatically use the canonical callsign.
    corr_row = cur.execute(
        "SELECT correct_name FROM callsign_corrections WHERE network_id = ? AND wrong_name = ? COLLATE NOCASE LIMIT 1",
        (network_id, name),
    ).fetchone()
    if corr_row:
        corrected = (corr_row[0] if not isinstance(corr_row, dict) else corr_row["correct_name"]) or name
        if corrected and corrected != name:
            name = corrected

    row = cur.execute(
        "SELECT id FROM callsigns WHERE network_id=? AND name=?",
        (network_id, name),
    ).fetchone()

    if row:
        cs_id = int(row[0] if not isinstance(row, dict) else row["id"])
        # Only move last_seen_dt forward; never decrease it.
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


def upsert_callsign_edge(cur, network_id: int, a_id: int, b_id: int, dt: str) -> None:
    """Upsert an interaction edge between two callsigns.

    The function normalizes the pair ordering (a_id < b_id) to satisfy the
    schema invariant and uses an `ON CONFLICT` upsert to increment counters
    and update last_seen timestamps.

    Args:
        cur: SQLite cursor.
        network_id: network id for scoping the edge.
        a_id: first callsign id.
        b_id: second callsign id.
        dt: interaction datetime (ISO TEXT) used for first/last seen updates.
    """
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


def link_message_callsigns(
    cur,
    network_id: int,
    message_id: int,
    caller: Optional[str],
    callees: List[str],
    created_at: str,
    received_at: str,
) -> None:
    """Link message callsigns and update callsign_edges graph.

    The function:
    - upserts caller and callee callsigns under a network scope;
    - creates `message_callsigns` rows with roles;
    - updates `callsign_edges` for caller↔callee interactions.

    Special rule:
        Callsign "НВ" is technical and does not create edges.

    Args:
        cur: SQLite cursor.
        network_id: network id.
        message_id: message id in `messages`.
        caller: caller callsign token (may be None/empty).
        callees: list of callee tokens.
        created_at: message timestamp.
        received_at: ingest receive timestamp.
    """
    TECH_UNKNOWN = "НВ"

    def norm_name(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if not str(value).strip():
            return None
        s = normalize_callsign(value)
        return s or None

    caller_name = norm_name(caller)
    callee_names: List[str] = []

    for callee in callees:
        name = norm_name(callee)
        if name:
            callee_names.append(name)

    caller_id = upsert_callsign(
        cur=cur,
        network_id=network_id,
        message_id=message_id,
        name=caller_name,
        role="caller",
        created_at=created_at,
        received_at=received_at,
    )

    callee_pairs: List[tuple[str, int]] = []
    for callee_name in callee_names:
        callee_id = upsert_callsign(
            cur=cur,
            network_id=network_id,
            message_id=message_id,
            name=callee_name,
            role="callee",
            created_at=created_at,
            received_at=received_at,
        )
        if callee_id is not None:
            callee_pairs.append((callee_name, callee_id))

    if caller_id is None or not caller_name:
        return

    if caller_name == TECH_UNKNOWN:
        return

    for callee_name, callee_id in callee_pairs:
        if callee_name == TECH_UNKNOWN:
            continue

        if caller_id == callee_id:
            continue

        upsert_callsign_edge(
            cur,
            int(network_id),
            int(caller_id),
            int(callee_id),
            created_at,
        )