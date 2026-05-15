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
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from app.db_utils import safe_execute
from .config import settings


def _register_sql_functions(conn: sqlite3.Connection) -> None:
    """Register Python callables for use in SQL (e.g. alias lookup)."""

    from app.core.alias_normalizer import normalize_network_alias

    def _norm_alias_sql(val: object) -> str:
        if val is None:
            return ""
        return normalize_network_alias(str(val))

    conn.create_function("norm_alias", 1, _norm_alias_sql)

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
    name TEXT NOT NULL UNIQUE,
    conclusions TEXT
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
    content_type TEXT NOT NULL DEFAULT 'intercept',
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
    network_id INTEGER,
    UNIQUE(event_dt, network_id),
    FOREIGN KEY (network_id) REFERENCES networks(id)
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

CREATE TABLE IF NOT EXISTS landmark_geoms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO landmark_geoms (id, name) VALUES
  (1, 'точка'),
  (2, 'зона'),
  (3, 'крива');

CREATE TABLE IF NOT EXISTS landmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_word TEXT NOT NULL,
    location_wkt TEXT NOT NULL,
    location_kind TEXT,
    location_mgrs TEXT,
    id_geom INTEGER,
    comment TEXT,
    date_creation TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    id_group INTEGER,
    id_type INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    CHECK (key_word = lower(trim(key_word))),
    FOREIGN KEY (id_group) REFERENCES groups(id),
    FOREIGN KEY (id_type) REFERENCES landmark_types(id),
    FOREIGN KEY (id_geom) REFERENCES landmark_geoms(id)
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

-- Maps wrong callsign names to their correct counterparts within a network.
-- Populated automatically when a callsign merge is performed.
-- Used during ingest to redirect wrong callsign tokens before creating records.
CREATE TABLE IF NOT EXISTS callsign_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    wrong_name TEXT NOT NULL COLLATE NOCASE,
    correct_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(network_id, wrong_name),
    FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE
);

-- Typology for analytical conclusions (filled manually via UI or migration).
-- id=0 is reserved as the "невідомо" default.
-- keywords_json holds a JSON array of keyword stems used for auto-classification.
CREATE TABLE IF NOT EXISTS conclusion_types (
    id            INTEGER PRIMARY KEY,
    type          TEXT NOT NULL UNIQUE,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    color         TEXT
);

INSERT OR IGNORE INTO conclusion_types (id, type) VALUES (0, 'невідомо');

-- Analytical conclusions extracted from analytical-type intercept messages.
-- One row per message (1:1 via UNIQUE on message_id).
-- network_id and created_at are denormalized from messages for fast queries.
-- mgrs_json stores a JSON array of normalized MGRS coordinate strings.
-- type_id defaults to 0 ("невідомо") until typology algorithm assigns a real type.
CREATE TABLE IF NOT EXISTS analytical_conclusions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL UNIQUE,
    network_id  INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    conclusion_text TEXT NOT NULL,
    mgrs_json   TEXT NOT NULL DEFAULT '[]',
    type_id     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
    FOREIGN KEY(type_id)    REFERENCES conclusion_types(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_analytical_conclusions_network_dt
    ON analytical_conclusions(network_id, created_at DESC);

-- Custom map labels placed on the quick-conclusions Leaflet map.
-- name  – display text (shown on the satellite map)
-- mgrs  – MGRS coordinate string (e.g. "37U DQ 29050 28377")
CREATE TABLE IF NOT EXISTS map_labels (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mgrs TEXT NOT NULL DEFAULT ''
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


def _try_ddl(
    conn: sqlite3.Connection,
    sql: str,
    *,
    stage: str = "",
) -> bool:
    """Execute a non-critical DDL statement (index/table drop or create).

    Unlike `safe_execute`, this helper catches `sqlite3.DatabaseError`
    (e.g. "database disk image is malformed" on a corrupted index page) and
    prints a warning instead of crashing.  Use it for migration steps that
    are purely for performance optimisation and whose failure does not affect
    data correctness.

    Returns:
        bool: True on success, False if a DatabaseError was suppressed.
    """
    try:
        conn.execute(sql)
        return True
    except sqlite3.DatabaseError as exc:
        print(
            f"[DB WARN] Skipping DDL step (possible corruption) — {stage}: {exc}\n"
            "          Run: sqlite3 your.db \".recover\" | sqlite3 recovered.db"
        )
        return False


def _auto_vacuum_recover(path: str) -> bool:
    """Attempt to recover a corrupted SQLite database via VACUUM INTO.

    Creates a clean copy of the database next to the original, then
    replaces the original with the clean copy.  The corrupted file is
    renamed to ``<name>.corrupted.<timestamp>.db`` for inspection.

    Returns:
        bool: True if recovery succeeded and the new file is in place,
              False if VACUUM INTO failed (e.g. too badly corrupted).
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dir_  = os.path.dirname(path)
    base  = os.path.basename(path)
    tmp   = os.path.join(dir_, base + ".vacuum_tmp.db")
    bak   = os.path.join(dir_, base + f".corrupted.{ts}.db")

    print(f"[DB INFO] Attempting automatic VACUUM INTO recovery for: {path}")
    try:
        # Remove leftover tmp from a previous failed attempt.
        if os.path.exists(tmp):
            os.remove(tmp)

        with sqlite3.connect(path) as src:
            src.execute(f"VACUUM INTO '{tmp}'")

        # Swap files atomically (as close as SQLite allows on Windows).
        shutil.move(path, bak)
        shutil.move(tmp, path)

        # Remove WAL / SHM of the corrupted file if they exist.
        for ext in ("-wal", "-shm"):
            stale = path + ext
            if os.path.exists(stale):
                try:
                    os.remove(stale)
                except OSError:
                    pass

        print(f"[DB INFO] Recovery succeeded. Corrupted file backed up to: {bak}")
        return True

    except Exception as exc:
        print(f"[DB ERROR] VACUUM INTO recovery failed: {exc}")
        # Clean up tmp if it was partially created.
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False


def _probe_integrity(path: str) -> bool:
    """Run a quick integrity probe on the SQLite file.

    Uses ``PRAGMA quick_check(1)`` which stops at the first error found and
    is much faster than a full ``integrity_check``.

    Returns:
        bool: True if the file looks healthy, False if corruption is detected
              or the probe itself crashes.
    """
    try:
        with sqlite3.connect(path, timeout=10) as probe:
            row = probe.execute("PRAGMA quick_check(1)").fetchone()
            return bool(row and row[0] == "ok")
    except sqlite3.DatabaseError:
        return False


def init_db() -> None:
    """Initialize the SQLite database and run lightweight migrations.

    Start-up sequence:
    1. If the DB file exists, run a fast ``PRAGMA quick_check``.  Any sign
       of corruption triggers ``VACUUM INTO`` *before* the first migration
       attempt (proactive recovery).
    2. Run migrations.
    3. If migrations still raise ``DatabaseError`` (e.g. VACUUM wasn't
       enough), attempt one more ``VACUUM INTO`` and retry once.
    4. If that second attempt also fails, re-raise so the operator is
       notified with a clear traceback.
    """
    def _run(p: str) -> None:
        with sqlite3.connect(p) as conn:
            conn.row_factory = sqlite3.Row
            safe_execute(conn, "PRAGMA foreign_keys = ON;",
                         module="app.core.db", function="init_db")
            conn.executescript(SCHEMA_SQL)
            _run_lightweight_migrations(conn)
            conn.commit()

    path = db_path()

    # ── Step 1: proactive integrity check ──────────────────────────────
    if os.path.exists(path) and not _probe_integrity(path):
        print("[DB WARN] quick_check detected corruption. Running proactive VACUUM recovery.")
        _auto_vacuum_recover(path)

    # ── Step 2: first migration attempt ────────────────────────────────
    try:
        _run(path)
        return
    except sqlite3.DatabaseError as exc:
        print(f"[DB WARN] Migration run failed: {exc}. Attempting reactive VACUUM recovery.")

    # ── Step 3: reactive recovery + retry ──────────────────────────────
    if _auto_vacuum_recover(path):
        print("[DB INFO] Retrying migrations on recovered database…")
        try:
            _run(path)
            return
        except sqlite3.DatabaseError as exc2:
            print(f"[DB ERROR] Migrations failed even after VACUUM recovery: {exc2}")
            raise
    else:
        raise sqlite3.DatabaseError(
            "Database is corrupted and VACUUM INTO recovery failed. "
            "Please restore from a backup or use: "
            "sqlite3 your.db \".recover\" | sqlite3 recovered.db"
        )


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

    # --- Status consolidation migrations ---
    # 1. Merge "Спостерігається нами" / "Спостерігається сусідами" → "Спостерігається".
    #    Idempotent: safe to run when old statuses no longer exist.
    for _old_name in ("Спостерігається нами", "Спостерігається сусідами"):
        safe_execute(
            conn,
            """
            UPDATE networks
            SET status_id = (SELECT id FROM statuses WHERE name = 'Спостерігається' LIMIT 1)
            WHERE status_id IN (SELECT id FROM statuses WHERE name = ?)
              AND EXISTS (SELECT 1 FROM statuses WHERE name = 'Спостерігається')
            """,
            (_old_name,),
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage=f"merge_status:{_old_name}",
        )
        safe_execute(
            conn,
            "DELETE FROM statuses WHERE name = ?",
            (_old_name,),
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage=f"delete_status:{_old_name}",
        )

    # 2. Ensure "Не інформативна" exists, then migrate "Малоінформативна" references.
    safe_execute(
        conn,
        "INSERT OR IGNORE INTO statuses(name) VALUES ('Не інформативна')",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="seed_status:Не інформативна",
    )
    safe_execute(
        conn,
        """
        UPDATE networks
        SET status_id = (SELECT id FROM statuses WHERE name = 'Не інформативна' LIMIT 1)
        WHERE status_id IN (SELECT id FROM statuses WHERE name = 'Малоінформативна')
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="merge_status:Малоінформативна",
    )
    safe_execute(
        conn,
        "DELETE FROM statuses WHERE name = 'Малоінформативна'",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="delete_status:Малоінформативна",
    )

    _ensure_column(conn, "tags", "template", "template TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "networks", "net_key", "net_key TEXT")
    _ensure_column(conn, "messages", "net_description", "net_description TEXT")
    _ensure_column(conn, "messages", "content_type", "content_type TEXT NOT NULL DEFAULT 'intercept'")
    _ensure_column(conn, "messages", "need_approve", "need_approve INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "messages", "tags_json", "tags_json TEXT DEFAULT '[]'")
    _ensure_column(conn, "callsign_statuses", "icon", "icon TEXT")
    _ensure_column(conn, "callsigns", "last_seen_dt", "last_seen_dt TEXT")
    _ensure_column(conn, "callsigns", "callsign_status_id", "callsign_status_id INTEGER")
    _ensure_column(conn, "callsigns", "source_id", "source_id INTEGER")
    _ensure_column(conn, "etalons", "end_date", "end_date TEXT")
    _ensure_column(conn, "network_tags", "conclusions", "conclusions TEXT")

    # --- Populate status colours (idempotent: only updates NULLs so manual overrides survive). ---
    _STATUS_COLORS = [
        ("Спостерігається",  "#1e8e3e20", "#1e8e3e80"),
        ("За межами",        "#ea433520", "#ea433580"),
        ("Мертва",           "#9aa0a620", "#9aa0a680"),
        ("Досліджується",    "#fbbc0420", "#fbbc0480"),
        ("Не інформативна",  "#a142f420", "#a142f480"),
    ]
    for _sname, _bg, _bd in _STATUS_COLORS:
        safe_execute(
            conn,
            "UPDATE statuses SET bg_color=?, border_color=? WHERE name=? AND bg_color IS NULL",
            (_bg, _bd, _sname),
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage=f"status_color:{_sname}",
        )

    # --- callsign_corrections table (created via SCHEMA_SQL for fresh installs;
    #     this CREATE ensures existing DBs get the table without a full rebuild). ---
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS callsign_corrections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            network_id INTEGER NOT NULL,
            wrong_name TEXT NOT NULL COLLATE NOCASE,
            correct_name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(network_id, wrong_name),
            FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:callsign_corrections",
    )

    # --- conclusion_types + analytical_conclusions tables (idempotent). ---
    safe_execute(
        conn,
        "CREATE TABLE IF NOT EXISTS conclusion_types (id INTEGER PRIMARY KEY, type TEXT NOT NULL UNIQUE)",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:conclusion_types",
    )
    # Add keywords_json BEFORE the seed INSERT so it exists on old databases.
    _ensure_column(conn, "conclusion_types", "keywords_json", "keywords_json TEXT NOT NULL DEFAULT '[]'")
    _ensure_column(conn, "conclusion_types", "color", "color TEXT")
    safe_execute(
        conn,
        "INSERT OR IGNORE INTO conclusion_types (id, type) VALUES (0, 'невідомо')",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="seed:conclusion_types:невідомо",
    )
    # Seed default marker colours (idempotent: only fills NULL rows).
    for _ct_name, _ct_color in [
        ("невідомо", "#6b7280"),
        ("БпЛА",     "#3b82f6"),
        ("піхота",   "#22c55e"),
        ("арта",     "#ef4444"),
    ]:
        safe_execute(
            conn,
            "UPDATE conclusion_types SET color = ? WHERE lower(type) = lower(?) AND color IS NULL",
            (_ct_color, _ct_name),
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage=f"seed_color:conclusion_types:{_ct_name}",
        )
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS analytical_conclusions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id  INTEGER NOT NULL UNIQUE,
            network_id  INTEGER NOT NULL,
            created_at  TEXT NOT NULL,
            conclusion_text TEXT NOT NULL,
            mgrs_json   TEXT NOT NULL DEFAULT '[]',
            type_id     INTEGER,
            FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
            FOREIGN KEY(type_id)    REFERENCES conclusion_types(id) ON DELETE SET NULL
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:analytical_conclusions",
    )
    # Add type_id to existing analytical_conclusions tables created before this migration.
    _ensure_column(conn, "analytical_conclusions", "type_id", "type_id INTEGER NOT NULL DEFAULT 0 REFERENCES conclusion_types(id) ON DELETE SET NULL")
    # Backfill any rows that were inserted before type_id existed.
    _try_ddl(
        conn,
        "UPDATE analytical_conclusions SET type_id = 0 WHERE type_id IS NULL",
        stage="backfill:analytical_conclusions.type_id",
    )
    _try_ddl(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_analytical_conclusions_network_dt"
        " ON analytical_conclusions(network_id, created_at DESC)",
        stage="create_index:analytical_conclusions_network_dt",
    )

    # Drop deprecated etalons columns (idempotent: skipped if column does not exist).
    for _col in ("callsigns", "operation_mode", "traffic_type", "purpose", "raw_import_text"):
        if _has_column(conn, "etalons", _col):
            safe_execute(
                conn,
                f"ALTER TABLE etalons DROP COLUMN {_col}",
                module="app.core.db",
                function="_run_lightweight_migrations",
                stage=f"drop_column:etalons.{_col}",
            )
    _ensure_column(conn, "peleng_batches", "network_id", "network_id INTEGER")
    # Rebuild legacy peleng_batches(event_dt, frequency) into
    # peleng_batches(event_dt, network_id), preserving ids and points links.
    if _table_exists(conn, "peleng_batches") and _has_column(conn, "peleng_batches", "frequency"):
        safe_execute(conn, "PRAGMA foreign_keys = OFF", module="app.core.db", function="_run_lightweight_migrations", stage="fk_off:peleng_batches_rebuild")
        safe_execute(
            conn,
            """
            CREATE TABLE IF NOT EXISTS peleng_batches_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_dt TEXT NOT NULL,
                network_id INTEGER,
                FOREIGN KEY (network_id) REFERENCES networks(id)
            )
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="create_table:peleng_batches_new",
        )
        safe_execute(
            conn,
            """
            INSERT INTO peleng_batches_new (id, event_dt, network_id)
            SELECT
                pb.id,
                pb.event_dt,
                COALESCE(
                    pb.network_id,
                    (
                        SELECT n.id
                        FROM networks n
                        WHERE n.frequency = pb.frequency
                        ORDER BY n.updated_at DESC, n.id DESC
                        LIMIT 1
                    )
                ) AS network_id
            FROM peleng_batches pb
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="copy:peleng_batches_to_new",
        )
        safe_execute(conn, "DROP TABLE peleng_batches", module="app.core.db", function="_run_lightweight_migrations", stage="drop_table:peleng_batches_old")
        safe_execute(conn, "ALTER TABLE peleng_batches_new RENAME TO peleng_batches", module="app.core.db", function="_run_lightweight_migrations", stage="rename:peleng_batches_new")
        safe_execute(conn, "PRAGMA foreign_keys = ON", module="app.core.db", function="_run_lightweight_migrations", stage="fk_on:peleng_batches_rebuild")

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
    safe_execute(
        conn,
        """
        CREATE TABLE IF NOT EXISTS landmark_geoms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
        """,
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="create_table:landmark_geoms",
    )
    row_cnt = safe_execute(
        conn,
        "SELECT COUNT(*) AS c FROM landmark_geoms",
        module="app.core.db",
        function="_run_lightweight_migrations",
        stage="count:landmark_geoms",
    ).fetchone()
    # init_db() uses a plain connection (no Row factory); use index [0].
    if row_cnt is not None and int(row_cnt[0] or 0) == 0:
        safe_execute(
            conn,
            """
            INSERT INTO landmark_geoms (id, name) VALUES
              (1, 'точка'),
              (2, 'зона'),
              (3, 'крива')
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="seed:landmark_geoms",
        )
    _ensure_column(conn, "landmarks", "location_mgrs", "location_mgrs TEXT")
    _ensure_column(conn, "landmarks", "id_geom", "id_geom INTEGER REFERENCES landmark_geoms(id)")
    _try_ddl(
        conn,
        """
        UPDATE landmarks
        SET id_geom = CASE
            WHEN lower(trim(coalesce(location_kind, ''))) IN ('point', 'multipoint') THEN 1
            WHEN lower(trim(coalesce(location_kind, ''))) IN ('polygon', 'multipolygon') THEN 2
            WHEN lower(trim(coalesce(location_kind, ''))) IN ('linestring', 'multilinestring') THEN 3
            ELSE NULL
        END
        WHERE id_geom IS NULL
          AND location_kind IS NOT NULL
          AND trim(location_kind) <> ''
        """,
        stage="migrate:id_geom_from_location_kind",
    )
    _try_ddl(
        conn,
        "UPDATE landmarks SET id_geom = 1 WHERE id_geom IS NULL",
        stage="default:id_geom",
    )
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
        _try_ddl(
            conn,
            """
            INSERT OR IGNORE INTO network_tag_links(network_id, tag_id)
            SELECT l.network_id, nt.id
            FROM network_tag_links_old l
            JOIN tags t ON t.id = l.tag_id
            JOIN network_tags nt ON nt.name = t.name
            """,
            stage="migrate:network_tag_links_old",
        )
        # Drop the legacy table after data has been migrated.
        safe_execute(
            conn,
            "DROP TABLE IF EXISTS network_tag_links_old",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="drop_table:network_tag_links_old",
        )

    # network_aliases lookup is by alias_text (no alias_norm)
    _try_ddl(conn, "CREATE UNIQUE INDEX IF NOT EXISTS idx_network_aliases_network_alias_text "
             "ON network_aliases(network_id, alias_text)",
             stage="create_index:idx_network_aliases_network_alias_text")
    # Enforce alias uniqueness across ACTIVE aliases only (archived aliases are allowed to duplicate).
    # This matches structured ingest lookup by alias_text.
    try:
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
    except sqlite3.DatabaseError:
        dup = object()   # treat as "duplicates exist" → skip index creation
    if dup is None:
        _try_ddl(conn, "CREATE UNIQUE INDEX IF NOT EXISTS ux_network_aliases_alias_text_active "
                 "ON network_aliases(alias_text) WHERE COALESCE(is_archived, 0) = 0",
                 stage="create_index:ux_network_aliases_alias_text_active")
    # Older DBs may have been created with UNIQUE(network_id, created_at), which
    # contradicts ingest dedup (network_id, created_at, body_text) and causes
    # insert failures when two messages share the same second. Recreate as a
    # non-unique index for search performance only.
    _try_ddl(conn, "DROP INDEX IF EXISTS idx_messages_network_created",
             stage="drop_index:idx_messages_network_created_if_wrong_unique")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_messages_network_created "
             "ON messages(network_id, created_at)",
             stage="create_index:idx_messages_network_created")
    _try_ddl(
        conn,
        """
        UPDATE messages
        SET content_type = CASE
            WHEN EXISTS (
                SELECT 1
                FROM ingest_messages im
                WHERE im.id = messages.ingest_id
                  AND lower(trim(coalesce(im.message_format, ''))) = 'analytical_type'
            ) THEN 'analytical'
            ELSE 'intercept'
        END
        WHERE coalesce(trim(content_type), '') = ''
           OR lower(trim(content_type)) NOT IN ('intercept', 'analytical', 'peleng')
        """,
        stage="backfill:messages.content_type",
    )
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_messages_content_type_created "
             "ON messages(content_type, created_at)",
             stage="create_index:idx_messages_content_type_created")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_messages_network_content_type_created "
             "ON messages(network_id, content_type, created_at)",
             stage="create_index:idx_messages_network_content_type_created")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_callsigns_network_name "
             "ON callsigns(network_id, name)",
             stage="create_index:idx_callsigns_network_name")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_peleng_batches_network_id "
             "ON peleng_batches(network_id)",
             stage="create_index:idx_peleng_batches_network_id")
    # Enforce logical uniqueness for peleng batches:
    # one batch per (event_dt, network_id).
    # Existing duplicates are compacted by re-linking points to the oldest
    # batch id and deleting duplicate batch headers.
    # The entire block is wrapped in a try/except so a corrupted page cannot
    # prevent application startup (deduplication is non-critical).
    try:
        safe_execute(
            conn,
            "CREATE TEMP TABLE IF NOT EXISTS _peleng_batch_dedup_map (dup_id INTEGER PRIMARY KEY, keep_id INTEGER NOT NULL)",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="create_temp_table:_peleng_batch_dedup_map",
        )
        safe_execute(
            conn,
            "DELETE FROM _peleng_batch_dedup_map",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="clear_temp_table:_peleng_batch_dedup_map",
        )
        safe_execute(
            conn,
            """
            INSERT INTO _peleng_batch_dedup_map (dup_id, keep_id)
            SELECT id, keep_id
            FROM (
                SELECT
                    id,
                    MIN(id) OVER (PARTITION BY event_dt, network_id) AS keep_id,
                    ROW_NUMBER() OVER (PARTITION BY event_dt, network_id ORDER BY id ASC) AS rn
                FROM peleng_batches
                WHERE network_id IS NOT NULL
            )
            WHERE rn > 1
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="fill_temp_table:_peleng_batch_dedup_map",
        )
        _try_ddl(
            conn,
            """
            UPDATE peleng_points
            SET batch_id = (
                SELECT m.keep_id
                FROM _peleng_batch_dedup_map m
                WHERE m.dup_id = peleng_points.batch_id
            )
            WHERE batch_id IN (SELECT dup_id FROM _peleng_batch_dedup_map)
            """,
            stage="relink:peleng_points_to_kept_batches",
        )
        _try_ddl(
            conn,
            "DELETE FROM peleng_batches WHERE id IN (SELECT dup_id FROM _peleng_batch_dedup_map)",
            stage="delete:duplicate_peleng_batches",
        )
        safe_execute(
            conn,
            "DROP TABLE IF EXISTS _peleng_batch_dedup_map",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="drop_temp_table:_peleng_batch_dedup_map",
        )
    except sqlite3.DatabaseError as _dedup_exc:
        print(
            f"[DB WARN] Skipping peleng batch dedup block (possible corruption): {_dedup_exc}\n"
            "          Run: sqlite3 your.db \".recover\" | sqlite3 recovered.db"
        )
        try:
            conn.execute("DROP TABLE IF EXISTS _peleng_batch_dedup_map")
        except Exception:
            pass
    _try_ddl(conn, "CREATE UNIQUE INDEX IF NOT EXISTS ux_peleng_batches_event_network "
             "ON peleng_batches(event_dt, network_id)",
             stage="create_index:ux_peleng_batches_event_network")
    # Normalize any T-format event_dt values (e.g. "2026-05-14T08:24:00" → "2026-05-14 08:24:00")
    # so that string range queries work correctly in SQLite (space < 'T' in ASCII).
    _try_ddl(
        conn,
        "UPDATE peleng_batches SET event_dt = REPLACE(event_dt, 'T', ' ') WHERE event_dt LIKE '%T%'",
        stage="normalize:peleng_batches.event_dt",
    )

    # Required for upsert in callsign_service.upsert_callsign_edge()
    _try_ddl(conn, "CREATE UNIQUE INDEX IF NOT EXISTS ux_callsign_edges_net_pair "
             "ON callsign_edges(network_id, a_callsign_id, b_callsign_id)",
             stage="create_index:ux_callsign_edges_net_pair")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_landmarks_keyword ON landmarks(key_word)",
             stage="create_index:idx_landmarks_keyword")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_landmarks_type ON landmarks(id_type)",
             stage="create_index:idx_landmarks_type")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_landmarks_group ON landmarks(id_group)",
             stage="create_index:idx_landmarks_group")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_landmarks_active ON landmarks(is_active)",
             stage="create_index:idx_landmarks_active")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_matches_message "
             "ON message_landmark_matches(id_message)",
             stage="create_index:idx_matches_message")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_matches_landmark "
             "ON message_landmark_matches(id_landmark)",
             stage="create_index:idx_matches_landmark")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_matches_created "
             "ON message_landmark_matches(created_at)",
             stage="create_index:idx_matches_created")
    _try_ddl(conn, "CREATE UNIQUE INDEX IF NOT EXISTS ux_matches_message_landmark_pos "
             "ON message_landmark_matches(id_message, id_landmark, start_pos, end_pos)",
             stage="create_index:ux_matches_message_landmark_pos")
    _try_ddl(conn, "CREATE INDEX IF NOT EXISTS idx_message_landmark_queue_status "
             "ON message_landmark_queue(status, queued_at)",
             stage="create_index:idx_message_landmark_queue_status")

    # --- Quick conclusions and quick points tables ---
    _try_ddl(
        conn,
        """
        CREATE TABLE IF NOT EXISTS quick_conclusions (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            text TEXT NOT NULL DEFAULT ''
        )
        """,
        stage="create_table:quick_conclusions",
    )
    _try_ddl(
        conn,
        """
        CREATE TABLE IF NOT EXISTS quick_points (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name  TEXT NOT NULL UNIQUE,
            point TEXT NOT NULL DEFAULT ''
        )
        """,
        stage="create_table:quick_points",
    )
    for _qc_name, _qc_text in [
        ("Квадро", "Ворог повідомляє про рух квадроцикла в районі точки:"),
        ("Мото",   "Ворог повідомляє про рух мотоцикла в районі точки:"),
        ("Вело",   "Ворог повідомляє про рух велосипеда в районі точки:"),
        ("Т\\з",   "Ворог повідомляє про рух Т/З в районі точки:"),
        ("БпЛА",   "Ворог повідомляє про власний БПЛА перехоплювач в районі точки:"),
    ]:
        _try_ddl(
            conn,
            f"INSERT OR IGNORE INTO quick_conclusions (name, text) VALUES ('{_qc_name}', '{_qc_text}')",
            stage=f"seed:quick_conclusions:{_qc_name}",
        )
    for _qp_name, _qp_point in [
        ("04",  "37U DQ 29050 28377"),
        ("114", "37U DQ 31342 29470"),
    ]:
        _try_ddl(
            conn,
            f"INSERT OR IGNORE INTO quick_points (name, point) VALUES ('{_qp_name}', '{_qp_point}')",
            stage=f"seed:quick_points:{_qp_name}",
        )

    # --- ingest_messages: reviewed_at for chatbot error queue ---
    _ensure_column(conn, "ingest_messages", "reviewed_at", "reviewed_at TEXT")

    # --- Map labels table (custom place-name labels on the quick-conclusions map) ---
    _try_ddl(
        conn,
        """
        CREATE TABLE IF NOT EXISTS map_labels (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            mgrs TEXT NOT NULL DEFAULT ''
        )
        """,
        stage="create_table:map_labels",
    )

    # --- Casualties: units + working entries (no date) + daily snapshots ---
    _try_ddl(
        conn,
        """
        CREATE TABLE IF NOT EXISTS cas_units (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )
        """,
        stage="create_table:cas_units",
    )
    # cas_entries holds the *current* (undated) working values for the two input
    # columns.  When the old date-keyed schema is detected, migrate to the new
    # one by keeping the most-recent values per (unit_id, category).
    if _has_column(conn, "cas_entries", "entry_date"):
        safe_execute(
            conn,
            """
            CREATE TABLE IF NOT EXISTS cas_entries_new (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                unit_id  INTEGER NOT NULL REFERENCES cas_units(id) ON DELETE CASCADE,
                category TEXT NOT NULL,
                morning  INTEGER NOT NULL DEFAULT 0,
                night    INTEGER NOT NULL DEFAULT 0,
                UNIQUE(unit_id, category)
            )
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="create_table:cas_entries_new",
        )
        safe_execute(
            conn,
            """
            INSERT OR IGNORE INTO cas_entries_new (unit_id, category, morning, night)
            SELECT unit_id, category, morning, night
            FROM cas_entries e1
            WHERE entry_date = (
                SELECT MAX(entry_date) FROM cas_entries e2
                WHERE e2.unit_id = e1.unit_id AND e2.category = e1.category
            )
            """,
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="migrate:cas_entries_to_undated",
        )
        safe_execute(
            conn, "DROP TABLE cas_entries",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="drop_table:cas_entries_dated",
        )
        safe_execute(
            conn, "ALTER TABLE cas_entries_new RENAME TO cas_entries",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="rename:cas_entries_new",
        )
    _try_ddl(
        conn,
        """
        CREATE TABLE IF NOT EXISTS cas_entries (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            unit_id  INTEGER NOT NULL REFERENCES cas_units(id) ON DELETE CASCADE,
            category TEXT NOT NULL,
            morning  INTEGER NOT NULL DEFAULT 0,
            night    INTEGER NOT NULL DEFAULT 0,
            UNIQUE(unit_id, category)
        )
        """,
        stage="create_table:cas_entries",
    )
    # Snapshot saved when the 16-08 summary button is pressed.
    # Stores only the daily total (08-08) per unit/category for period queries.
    # If old schema with morning/night columns exists, drop and recreate.
    if _has_column(conn, "cas_report_snapshots", "morning"):
        safe_execute(
            conn,
            "DROP TABLE IF EXISTS cas_report_snapshots",
            module="app.core.db",
            function="_run_lightweight_migrations",
            stage="drop_table:cas_report_snapshots_old_schema",
        )
    _try_ddl(
        conn,
        """
        CREATE TABLE IF NOT EXISTS cas_report_snapshots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            report_date TEXT NOT NULL,
            unit_id     INTEGER NOT NULL REFERENCES cas_units(id) ON DELETE CASCADE,
            unit_name   TEXT NOT NULL,
            category    TEXT NOT NULL,
            total       INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            UNIQUE(report_date, unit_id, category)
        )
        """,
        stage="create_table:cas_report_snapshots",
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
    _register_sql_functions(conn)
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
    _register_sql_functions(conn)
    safe_execute(conn, "PRAGMA busy_timeout = 30000;", module="app.core.db", function="get_conn")
    safe_execute(conn, "PRAGMA foreign_keys = ON;", module="app.core.db", function="get_conn")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
