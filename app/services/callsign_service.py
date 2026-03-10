from __future__ import annotations

from typing import List, Optional


def upsert_callsign(
    cur,
    network_id: int,
    message_id: int,
    name: Optional[str],
    role: str,
    created_at: str,
    received_at: str,
) -> Optional[int]:
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


def link_message_callsigns(
    cur,
    network_id: int,
    message_id: int,
    caller: Optional[str],
    callees: List[str],
    created_at: str,
    received_at: str,
) -> None:
    TECH_UNKNOWN = "НВ"

    def norm_name(value: Optional[str]) -> Optional[str]:
        s = (value or "").strip()
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