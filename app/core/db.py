from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager

from .config import settings

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS callsign_sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS callsign_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    icon TEXT
);

CREATE TABLE IF NOT EXISTS statuses(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    bg_color TEXT,
    border_color TEXT
);

CREATE TABLE IF NOT EXISTS chats(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS groups(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tags(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    template TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS networks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frequency TEXT NOT NULL UNIQUE,
    mask TEXT,
    unit TEXT NOT NULL,
    zone TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    status_id INTEGER NOT NULL,
    comment TEXT,
    updated_at TEXT NOT NULL,
    net_key TEXT,
    FOREIGN KEY(chat_id) REFERENCES chats(id),
    FOREIGN KEY(group_id) REFERENCES groups(id),
    FOREIGN KEY(status_id) REFERENCES statuses(id)
);

CREATE TABLE IF NOT EXISTS network_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    alias_text TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (network_id) REFERENCES networks(id),
    UNIQUE(network_id, alias_text)
);

CREATE TABLE IF NOT EXISTS network_tags(
    network_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY(network_id, tag_id),
    FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS etalons(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL UNIQUE,
    start_date TEXT,
    correspondents TEXT,
    callsigns TEXT,
    purpose TEXT,
    operation_mode TEXT,
    traffic_type TEXT,
    raw_import_text TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS network_changes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_freq_chat (
    frequency REAL,
    mask3 TEXT,
    mask_sh TEXT,
    chat_name TEXT,
    chat_id INTEGER
);

CREATE TABLE IF NOT EXISTS import_networks (
    frequency REAL,
    mask TEXT,
    comment TEXT,
    chat_name TEXT,
    unit TEXT,
    group_name TEXT,
    zone TEXT,
    status_name TEXT,
    status_id INTEGER,
    chat_id INTEGER,
    group_id INTEGER
);

CREATE TABLE IF NOT EXISTS ingest_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    source_chat_id TEXT,
    source_chat_name TEXT,
    source_message_id TEXT NOT NULL,
    source_file_name TEXT,
    source_row_number INTEGER,
    raw_text TEXT NOT NULL,
    normalized_text TEXT,
    published_at_text TEXT,
    received_at TEXT NOT NULL,
    message_format TEXT,
    parse_status TEXT NOT NULL,
    parse_error TEXT,
    UNIQUE(platform, source_message_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingest_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    net_description TEXT,
    body_text TEXT NOT NULL,
    comment TEXT,
    parse_confidence REAL DEFAULT 1.0,
    is_valid INTEGER DEFAULT 1,
    delay_sec INTEGER,
    need_approve INTEGER NOT NULL DEFAULT 0,
    tags_json TEXT DEFAULT '[]',
    FOREIGN KEY (ingest_id) REFERENCES ingest_messages(id),
    FOREIGN KEY (network_id) REFERENCES networks(id)
);

CREATE TABLE IF NOT EXISTS callsigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER,
    name TEXT NOT NULL,
    status_id INTEGER,
    comment TEXT,
    updated_at TEXT NOT NULL,
    last_seen_dt TEXT,
    callsign_status_id INTEGER,
    source_id INTEGER REFERENCES callsign_sources(id),
    UNIQUE(network_id, name),
    FOREIGN KEY(network_id) REFERENCES networks(id),
    FOREIGN KEY(status_id) REFERENCES callsign_statuses(id)
);

CREATE TABLE IF NOT EXISTS message_callsigns (
    message_id INTEGER NOT NULL,
    callsign_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY(message_id, callsign_id, role),
    FOREIGN KEY(message_id) REFERENCES messages(id),
    FOREIGN KEY(callsign_id) REFERENCES callsigns(id)
);

CREATE TABLE IF NOT EXISTS message_tags (
    message_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY(message_id, tag_id),
    FOREIGN KEY(message_id) REFERENCES messages(id),
    FOREIGN KEY(tag_id) REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS callsign_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    a_callsign_id INTEGER NOT NULL,
    b_callsign_id INTEGER NOT NULL,
    first_seen_dt TEXT NOT NULL,
    last_seen_dt TEXT NOT NULL,
    cnt INTEGER NOT NULL DEFAULT 1,
    CHECK (a_callsign_id < b_callsign_id),
    FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
    FOREIGN KEY (a_callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE,
    FOREIGN KEY (b_callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS callsign_status_map (
    callsign_id INTEGER NOT NULL,
    status_id INTEGER NOT NULL,
    PRIMARY KEY(callsign_id, status_id),
    FOREIGN KEY(callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE,
    FOREIGN KEY(status_id) REFERENCES callsign_statuses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS peleng_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_dt TEXT NOT NULL,
    frequency TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peleng_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    mgrs TEXT NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES peleng_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY,
    tag_id INTEGER NOT NULL,
    word TEXT NOT NULL,
    probability INTEGER NOT NULL DEFAULT 0,
    exceptions TEXT DEFAULT '[]',
    FOREIGN KEY (tag_id) REFERENCES tags(id)
);
"""


def db_path() -> str:
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
    return settings.db_path


def init_db():
    with sqlite3.connect(db_path()) as conn:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.executescript(SCHEMA_SQL)
        _run_lightweight_migrations(conn)
        conn.commit()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def _has_column(conn: sqlite3.Connection, table: str, col: str) -> bool:
    if not _table_exists(conn, table):
        return False
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == col for r in rows)


def _ensure_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    ddl: str,
) -> None:
    if not _has_column(conn, table, column):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _run_lightweight_migrations(conn: sqlite3.Connection) -> None:
    _ensure_column(conn, "statuses", "bg_color", "bg_color TEXT")
    _ensure_column(conn, "statuses", "border_color", "border_color TEXT")
    _ensure_column(conn, "tags", "template", "template TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "networks", "net_key", "net_key TEXT")
    _ensure_column(conn, "messages", "net_description", "net_description TEXT")
    _ensure_column(conn, "messages", "need_approve", "need_approve INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "messages", "tags_json", "tags_json TEXT DEFAULT '[]'")
    _ensure_column(conn, "callsign_statuses", "icon", "icon TEXT")
    _ensure_column(conn, "callsigns", "last_seen_dt", "last_seen_dt TEXT")
    _ensure_column(conn, "callsigns", "callsign_status_id", "callsign_status_id INTEGER")
    _ensure_column(conn, "callsigns", "source_id", "source_id INTEGER")

    # network_aliases lookup is by alias_text (no alias_norm)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_network_aliases_network_alias_text "
        "ON network_aliases(network_id, alias_text)"
    )
    # Enforce alias uniqueness across ACTIVE aliases only (archived aliases are allowed to duplicate).
    # This matches structured ingest lookup by alias_text.
    dup = conn.execute(
        """
        SELECT alias_text
        FROM network_aliases
        WHERE COALESCE(is_archived, 0) = 0
        GROUP BY alias_text
        HAVING COUNT(*) > 1
        LIMIT 1
        """
    ).fetchone()
    if dup is None:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_network_aliases_alias_text_active "
            "ON network_aliases(alias_text) WHERE COALESCE(is_archived, 0) = 0"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_network_created "
        "ON messages(network_id, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_callsigns_network_name "
        "ON callsigns(network_id, name)"
    )

    # Required for upsert in callsign_service.upsert_callsign_edge()
    # Keep name aligned with existing DBs (if present).
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_callsign_edges_net_pair "
        "ON callsign_edges(network_id, a_callsign_id, b_callsign_id)"
    )


def get_db():
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


@contextmanager
def get_conn():
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
