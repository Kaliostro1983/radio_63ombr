from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Iterable, Tuple

from app.core.db import db_path


def _connect() -> sqlite3.Connection:
    path = Path(db_path())
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def _print_section(title: str) -> None:
    print()
    print("=" * len(title))
    print(title)
    print("=" * len(title))


def check_duplicate_messages(conn: sqlite3.Connection) -> None:
    """
    Invariant 1 --- Duplicate Message Rule
    (network_id, created_at, body_text) повинні визначати унікальне повідомлення.
    """
    _print_section("Duplicate messages by (network_id, created_at, body_text)")

    sql = """
    SELECT
        network_id,
        created_at,
        body_text,
        COUNT(*) AS cnt
    FROM messages
    GROUP BY network_id, created_at, body_text
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, created_at DESC
    LIMIT 100
    """
    rows: Iterable[sqlite3.Row] = conn.execute(sql).fetchall()

    if not rows:
        print("OK: no duplicates found.")
        return

    print(f"FOUND {len(rows)} duplicate groups (showing up to 100):")
    for r in rows:
        print(
            f"- network_id={r['network_id']}, created_at={r['created_at']}, "
            f"cnt={r['cnt']}, body_preview={ (r['body_text'] or '')[:80]!r}"
        )


def check_callsign_edges_order_and_uniqueness(conn: sqlite3.Connection) -> None:
    """
    Invariants 4, 5 --- Callsign Edge Ordering & Uniqueness
    a_callsign_id < b_callsign_id
    UNIQUE(network_id, a_callsign_id, b_callsign_id)
    """
    _print_section("Callsign edges ordering and duplicates")

    # Violations of a_callsign_id < b_callsign_id
    bad_order_sql = """
    SELECT COUNT(*) AS cnt
    FROM callsign_edges
    WHERE a_callsign_id >= b_callsign_id
    """
    bad_order_cnt = conn.execute(bad_order_sql).fetchone()["cnt"]
    if bad_order_cnt == 0:
        print("OK: all edges satisfy a_callsign_id < b_callsign_id.")
    else:
        print(f"ERROR: {bad_order_cnt} edges violate a_callsign_id < b_callsign_id.")

    # Potential duplicates at data level (even with UNIQUE index present)
    dup_sql = """
    SELECT
        network_id,
        a_callsign_id,
        b_callsign_id,
        COUNT(*) AS cnt
    FROM callsign_edges
    GROUP BY network_id, a_callsign_id, b_callsign_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 100
    """
    dups: Iterable[sqlite3.Row] = conn.execute(dup_sql).fetchall()
    if not dups:
        print("OK: no duplicate edge groups found.")
    else:
        print(f"ERROR: {len(dups)} duplicate edge groups (showing up to 100):")
        for r in dups:
            print(
                f"- net={r['network_id']}, a={r['a_callsign_id']}, "
                f"b={r['b_callsign_id']}, cnt={r['cnt']}"
            )


def check_callsign_edges_no_NV(conn: sqlite3.Connection) -> None:
    """
    Invariant 6 --- Technical Callsign "НВ" must not create edges.
    """
    _print_section('Callsign edges involving technical callsign "НВ"')

    sql = """
    SELECT
        ce.id,
        ce.network_id,
        ca.name AS a_name,
        cb.name AS b_name
    FROM callsign_edges ce
    JOIN callsigns ca ON ca.id = ce.a_callsign_id
    JOIN callsigns cb ON cb.id = ce.b_callsign_id
    WHERE ca.name = 'НВ' OR cb.name = 'НВ'
    LIMIT 100
    """
    rows: Iterable[sqlite3.Row] = conn.execute(sql).fetchall()
    if not rows:
        print('OK: no edges involve "НВ".')
        return

    print(f'ERROR: {len(rows)} edges involve "НВ" (showing up to 100):')
    for r in rows:
        print(
            f"- edge_id={r['id']}, net={r['network_id']}, "
            f"a_name={r['a_name']!r}, b_name={r['b_name']!r}"
        )


def check_messages_have_ingest(conn: sqlite3.Connection) -> None:
    """
    Invariant 12 / lifecycle sanity:
    кожне повідомлення має мати існуючий ingest_messages.ingest_id.
    """
    _print_section("Messages without corresponding ingest_messages row")

    sql = """
    SELECT
        m.id AS message_id,
        m.ingest_id,
        m.network_id,
        m.created_at
    FROM messages m
    LEFT JOIN ingest_messages im ON im.id = m.ingest_id
    WHERE m.ingest_id IS NOT NULL AND im.id IS NULL
    LIMIT 100
    """
    rows: Iterable[sqlite3.Row] = conn.execute(sql).fetchall()
    if not rows:
        print("OK: all messages have matching ingest_messages.")
        return

    print(f"ERROR: {len(rows)} messages reference missing ingest_messages (showing up to 100):")
    for r in rows:
        print(
            f"- message_id={r['message_id']}, ingest_id={r['ingest_id']}, "
            f"network_id={r['network_id']}, created_at={r['created_at']}"
        )


def main() -> None:
    """
    Optional CLI arguments:
      - duplicates  : only duplicate messages check
      - edges       : only callsign_edges ordering/uniqueness + no \"НВ\"
      - lifecycle   : only messages→ingest linkage
      - all / empty : run all checks
    """
    mode = (sys.argv[1] if len(sys.argv) > 1 else "all").strip().lower()

    conn = _connect()
    try:
        print("Healthcheck: DB invariants (radio_63ombr)")
        print(f"DB path: {db_path()}")

        if mode in ("all", ""):
            check_duplicate_messages(conn)
            check_callsign_edges_order_and_uniqueness(conn)
            check_callsign_edges_no_NV(conn)
            check_messages_have_ingest(conn)
        elif mode == "duplicates":
            check_duplicate_messages(conn)
        elif mode == "edges":
            check_callsign_edges_order_and_uniqueness(conn)
            check_callsign_edges_no_NV(conn)
        elif mode == "lifecycle":
            check_messages_have_ingest(conn)
        else:
            print(f"Unknown mode: {mode!r}. Supported: all, duplicates, edges, lifecycle.")

        print()
        print("Healthcheck finished.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

