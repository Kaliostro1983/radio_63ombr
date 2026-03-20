"""Low-level SQLite database utilities and schema management.

This module is responsible for:

- defining the initial SQLite schema for the project (`SCHEMA_SQL`);
- creating the database file and running schema initialization on startup;
- executing lightweight, additive migrations for existing databases;
- providing helpers to obtain SQLite connections (`get_db`, `get_conn`).

All higher-level code (services, repositories) should use these helpers
instead of opening raw SQLite connections directly. The actual DB path is
resolved via `app.core.config.settings.db_path`.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager

from app.db_utils import safe_execute
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

-- Network-only tags (UI labels for radio networks; unrelated to `tags` used in text tagging).
CREATE TABLE IF NOT EXISTS network_tags(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
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

CREATE TABLE IF NOT EXISTS network_tag_links(
    network_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY(network_id, tag_id),
    FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES network_tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS etalons(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL UNIQUE,
    start_date TEXT,
    end_date TEXT,
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

CREATE TABLE IF NOT EXISTS landmark_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS landmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_word TEXT NOT NULL,
    location_wkt TEXT NOT NULL,
    location_kind TEXT,
    comment TEXT,
    date_creation TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    id_group INTEGER,
    id_type INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    CHECK (key_word = lower(trim(key_word))),
    FOREIGN KEY (id_group) REFERENCES groups(id),
    FOREIGN KEY (id_type) REFERENCES landmark_types(id)
);

CREATE TABLE IF NOT EXISTS message_landmark_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_message INTEGER NOT NULL,
    id_landmark INTEGER NOT NULL,
    matched_text TEXT,
    start_pos INTEGER NOT NULL DEFAULT -1,
    end_pos INTEGER NOT NULL DEFAULT -1,
    created_at TEXT NOT NULL,
    matcher_version TEXT NOT NULL DEFAULT 'v1',
    FOREIGN KEY (id_message) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (id_landmark) REFERENCES landmarks(id) ON DELETE CASCADE,
    UNIQUE (id_message, id_landmark, start_pos, end_pos)
);

CREATE TABLE IF NOT EXISTS message_landmark_queue (
    message_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    queued_at TEXT NOT NULL,
    processed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
"""


def db_path() -> str:
    """Return absolute filesystem path to the SQLite database file.

    The directory is created if it does not yet exist, which allows the
    application to bootstrap a fresh environment without manual setup.

    Returns:
        str: absolute path to the SQLite database file as configured in
        `settings.db_path`.
    """
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
    return settings.db_path


def init_db() -> None:
    """Initialize the SQLite database and run lightweight migrations.

    This function is typically called once on application startup. It:

    - ensures foreign keys are enabled;
    - executes the static schema SQL (`SCHEMA_SQL`) to create missing tables;
    - applies idempotent "lightweight" migrations on top of the schema;
    - commits all changes before closing the connection.
    """
    with sqlite3.connect(db_path()) as conn:
        safe_execute(conn, "PRAGMA foreign_keys = ON;", module="app.core.db", function="init_db")
        conn.executescript(SCHEMA_SQL)
        _run_lightweight_migrations(conn)
        conn.commit()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    """Return True if a table with the given name exists in the database.

    Args:
        conn: open SQLite connection.
        table: name of the table to check.

    Returns:
        bool: True if the table exists, False otherwise.
    """
    row = safe_execute(
        conn,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
        module="app.core.db",
        function="_table_exists",
    ).fetchone()
    return row is not None


def _has_column(conn: sqlite3.Connection, table: str, col: str) -> bool:
    """Return True if a table has a column with the given name.

    Args:
        conn: open SQLite connection.
        table: name of the table to introspect.
        col: column name to look for.

    Returns:
        bool: True if the column exists, False otherwise.
    """
    if not _table_exists(conn, table):
        return False
    rows = safe_execute(conn, f"PRAGMA table_info({table})", module="app.core.db", function="_has_column").fetchall()
    return any(r[1] == col for r in rows)


def _ensure_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    ddl: str,
) -> None:
    """Ensure that a column exists on a table, adding it if necessary.

    This helper is used by `_run_lightweight_migrations` to evolve tables
    additively (via `ALTER TABLE ... ADD COLUMN`) without destructive
    operations.

    Args:
        conn: open SQLite connection.
        table: table name to alter.
        column: column name that should exist.
        ddl: full column definition used in the ALTER TABLE statement.
    """
    if not _has_column(conn, table, column):
        safe_execute(
            conn,
            f"ALTER TABLE {table} ADD COLUMN {ddl}",
            module="app.core.db",
            function="_ensure_column",
            stage=f"add_column:{table}.{column}",
        )


def _run_lightweight_migrations(conn: sqlite3.Connection) -> None:
    """Apply idempotent, additive migrations to an existing database.

    Migrations performed here are intentionally conservative:

    - only `ADD COLUMN` operations (via `_ensure_column`);
    - creation of missing indexes and UNIQUE constraints;
    - no destructive changes to existing tables.

    This function can be safely called multiple times; it is used both
    during initial schema creation and on subsequent application starts.
    """
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
    _ensure_column(conn, "etalons", "end_date", "end_date TEXT")

    # --- Landmark keyword matching schema ---
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS landmark_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:landmark_types",
    )
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS landmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            key_word TEXT NOT NULL,
            location_wkt TEXT NOT NULL,
            location_kind TEXT,
            comment TEXT,
            date_creation TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            id_group INTEGER,
            id_type INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            CHECK (key_word = lower(trim(key_word))),
            FOREIGN KEY (id_group) REFERENCES groups(id),
            FOREIGN KEY (id_type) REFERENCES landmark_types(id)
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:landmarks",
    )
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS message_landmark_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_message INTEGER NOT NULL,
            id_landmark INTEGER NOT NULL,
            matched_text TEXT,
            start_pos INTEGER NOT NULL DEFAULT -1,
            end_pos INTEGER NOT NULL DEFAULT -1,
            created_at TEXT NOT NULL,
            matcher_version TEXT NOT NULL DEFAULT 'v1',
            FOREIGN KEY (id_message) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (id_landmark) REFERENCES landmarks(id) ON DELETE CASCADE
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:message_landmark_matches",
    )
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS message_landmark_queue (
            message_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            queued_at TEXT NOT NULL,
            processed_at TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:message_landmark_queue",
    )
    _ensure_column(conn, "landmarks", "location_kind", "location_kind TEXT")
    _ensure_column(conn, "landmarks", "updated_at", "updated_at TEXT")
    _ensure_column(conn, "landmarks", "is_active", "is_active INTEGER NOT NULL DEFAULT 1")
    _ensure_column(conn, "message_landmark_matches", "matched_text", "matched_text TEXT")
    _ensure_column(conn, "message_landmark_matches", "start_pos", "start_pos INTEGER NOT NULL DEFAULT -1")
    _ensure_column(conn, "message_landmark_matches", "end_pos", "end_pos INTEGER NOT NULL DEFAULT -1")
    _ensure_column(
        conn,
        "message_landmark_matches",
        "matcher_version",
        "matcher_version TEXT NOT NULL DEFAULT 'v1'",
    )
    _ensure_column(conn, "message_landmark_queue", "status", "status TEXT NOT NULL DEFAULT 'pending'")
    _ensure_column(conn, "message_landmark_queue", "attempts", "attempts INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "message_landmark_queue", "last_error", "last_error TEXT")
    _ensure_column(conn, "message_landmark_queue", "queued_at", "queued_at TEXT")
    _ensure_column(conn, "message_landmark_queue", "processed_at", "processed_at TEXT")
    _ensure_column(conn, "message_landmark_queue", "updated_at", "updated_at TEXT")

    # --- Network tags migration ---
    # Older DBs used:
    # - `tags` as the source of network tags
    # - `network_tags(network_id, tag_id)` as the link table to `tags`.
    #
    # New model:
    # - `network_tags(id, name)` is a dedicated dictionary for network tags
    # - `network_tag_links(network_id, tag_id)` links to that dictionary.
    if _table_exists(conn, "network_tags") and _has_column(conn, "network_tags", "network_id") and _has_column(conn, "network_tags", "tag_id"):
        # Rename old link table away to free the `network_tags` name for the new dictionary.
        safe_execute(
            conn,
            "ALTER TABLE network_tags RENAME TO network_tag_links_old",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="rename:network_tags_to_network_tag_links_old",
        )

    # Ensure new tables exist (safe even if already created by SCHEMA_SQL).
    safe_execute(
        conn,
        "CREATE TABLE IF NOT EXISTS network_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:network_tags",
    )

    # If a partially-migrated DB created `network_tag_links` with a wrong foreign key target,
    # rebuild it to reference `network_tags(id)` correctly.
    if _table_exists(conn, "network_tag_links"):
        fk_rows = safe_execute(
            conn,
            "PRAGMA foreign_key_list(network_tag_links)",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="inspect_fk:network_tag_links",
        ).fetchall()
        # fk_rows columns: (id, seq, table, from, to, on_update, on_delete, match)
        bad_fk = any(r[2] != "network_tags" and r[3] == "tag_id" for r in fk_rows)
        if bad_fk:
            safe_execute(
                conn,
                "DROP TABLE IF EXISTS network_tag_links",
                module="app.core.db",
                function="_run_lightweight_migrations",
                stage="drop_table:network_tag_links_bad_fk",
            )

    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS network_tag_links(
            network_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY(network_id, tag_id),
            FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES network_tags(id) ON DELETE CASCADE
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:network_tag_links",
    )

    # Seed required network tags (idempotent).
    for name in ("БпЛА", "ППО", "ШД", "Загальна", "Арта", "Евак"):
        safe_execute(
            conn,
            "INSERT OR IGNORE INTO network_tags(name) VALUES (?)",
            (name,),
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="seed:network_tags",
        )

    # Migrate old selections by matching tag names, if we have the old table.
    if _table_exists(conn, "network_tag_links_old"):
        safe_execute(
            conn,
            """
            INSERT OR IGNORE INTO network_tag_links(network_id, tag_id)
            SELECT l.network_id, nt.id
            FROM network_tag_links_old l
            JOIN tags t ON t.id = l.tag_id
            JOIN network_tags nt ON nt.name = t.name
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="migrate:network_tag_links_old",
        )

    # network_aliases lookup is by alias_text (no alias_norm)
    safe_execute(
        conn,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_network_aliases_network_alias_text "
        "ON network_aliases(network_id, alias_text)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_network_aliases_network_alias_text",
    )
    # Enforce alias uniqueness across ACTIVE aliases only (archived aliases are allowed to duplicate).
    # This matches structured ingest lookup by alias_text.
    dup = safe_execute(
        conn,
        """
        SELECT alias_text
        FROM network_aliases
        WHERE COALESCE(is_archived, 0) = 0
        GROUP BY alias_text
        HAVING COUNT(*) > 1
        LIMIT 1
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="check_active_alias_duplicates",
    ).fetchone()
    if dup is None:
        safe_execute(
            conn,
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_network_aliases_alias_text_active "
            "ON network_aliases(alias_text) WHERE COALESCE(is_archived, 0) = 0",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="create_index:ux_network_aliases_alias_text_active",
        )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_messages_network_created "
        "ON messages(network_id, created_at)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_messages_network_created",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_callsigns_network_name "
        "ON callsigns(network_id, name)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_callsigns_network_name",
    )

    # Required for upsert in callsign_service.upsert_callsign_edge()
    # Keep name aligned with existing DBs (if present).
    safe_execute(
        conn,
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_callsign_edges_net_pair "
        "ON callsign_edges(network_id, a_callsign_id, b_callsign_id)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:ux_callsign_edges_net_pair",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_landmarks_keyword ON landmarks(key_word)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_landmarks_keyword",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_landmarks_type ON landmarks(id_type)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_landmarks_type",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_landmarks_group ON landmarks(id_group)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_landmarks_group",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_landmarks_active ON landmarks(is_active)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_landmarks_active",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_matches_message ON message_landmark_matches(id_message)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_matches_message",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_matches_landmark ON message_landmark_matches(id_landmark)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_matches_landmark",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_matches_created ON message_landmark_matches(created_at)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_matches_created",
    )
    safe_execute(
        conn,
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_matches_message_landmark_pos "
        "ON message_landmark_matches(id_message, id_landmark, start_pos, end_pos)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:ux_matches_message_landmark_pos",
    )
    safe_execute(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_message_landmark_queue_status "
        "ON message_landmark_queue(status, queued_at)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_index:idx_message_landmark_queue_status",
    )


def get_db() -> sqlite3.Connection:
    """Create and return a new low-level SQLite connection.

    The caller is responsible for closing the returned connection when it
    is no longer needed.

    Returns:
        sqlite3.Connection: connection with `Row` row_factory and foreign
        keys enabled.
    """
    conn = sqlite3.connect(db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    safe_execute(conn, "PRAGMA busy_timeout = 30000;", module="app.core.db", function="get_db")
    safe_execute(conn, "PRAGMA foreign_keys = ON;", module="app.core.db", function="get_db")
    return conn


@contextmanager
def get_conn() -> sqlite3.Connection:
    """Context manager that yields a transactional SQLite connection.

    Usage:

        with get_conn() as conn:
            conn.execute(...)

    The context manager:

    - opens a new connection with foreign keys enabled;
    - yields it to the caller;
    - commits on normal exit;
    - closes the connection in all cases.

    Yields:
        sqlite3.Connection: open transactional SQLite connection.
    """
    conn = sqlite3.connect(db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    safe_execute(conn, "PRAGMA busy_timeout = 30000;", module="app.core.db", function="get_conn")
    safe_execute(conn, "PRAGMA foreign_keys = ON;", module="app.core.db", function="get_conn")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
