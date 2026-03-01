from __future__ import annotations
import os
import sqlite3
from contextlib import contextmanager
from .config import settings
from pathlib import Path

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS statuses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
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
  FOREIGN KEY(chat_id) REFERENCES chats(id),
  FOREIGN KEY(group_id) REFERENCES groups(id),
  FOREIGN KEY(status_id) REFERENCES statuses(id)
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

-- =========================
-- Intercepts (ingest/messages/callsigns)
-- =========================

CREATE TABLE IF NOT EXISTS ingest_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_chat_name TEXT,
  source_message_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  published_at_text TEXT,
  published_at_platform TEXT,
  received_at TEXT NOT NULL,
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
  body_text TEXT NOT NULL,
  comment TEXT,
  parse_confidence REAL,
  is_valid INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(ingest_id) REFERENCES ingest_messages(id) ON DELETE CASCADE,
  FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS callsigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status_id INTEGER,
  comment TEXT,
  updated_at TEXT NOT NULL,
  last_seen_dt TEXT,
  FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY(status_id) REFERENCES statuses(id),
  UNIQUE(network_id, name)
);

CREATE TABLE IF NOT EXISTS message_callsigns (
  message_id INTEGER NOT NULL,
  callsign_id INTEGER NOT NULL,
  role TEXT,
  PRIMARY KEY(message_id, callsign_id, role),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS callsign_edges (
  network_id INTEGER NOT NULL,
  a_callsign_id INTEGER NOT NULL,
  b_callsign_id INTEGER NOT NULL,
  first_seen_dt TEXT NOT NULL,
  last_seen_dt TEXT NOT NULL,
  cnt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(network_id, a_callsign_id, b_callsign_id),
  FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY(a_callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE,
  FOREIGN KEY(b_callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE
);

-- =========================
-- Callsign statuses
-- =========================
-- Lookup table (what user sees in UI)
CREATE TABLE IF NOT EXISTS callsign_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- Many-to-many mapping (callsign -> status)
CREATE TABLE IF NOT EXISTS callsign_status_map (
  callsign_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  PRIMARY KEY(callsign_id, status_id),
  FOREIGN KEY(callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE,
  FOREIGN KEY(status_id) REFERENCES callsign_statuses(id) ON DELETE CASCADE
);
"""

def db_path() -> str:
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
    return settings.db_path

def init_db():
    with sqlite3.connect(db_path()) as conn:
        conn.executescript(SCHEMA_SQL)
        # Lightweight migrations for existing DBs
        _ensure_callsign_status_id_column(conn)
        conn.commit()


def _has_column(conn: sqlite3.Connection, table: str, col: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == col for r in rows)  # r[1] = name


def _ensure_callsign_status_id_column(conn: sqlite3.Connection) -> None:
    """Ensure callsigns has callsign_status_id (FK -> callsign_statuses).

    We keep legacy callsigns.status_id (FK -> statuses) untouched.
    """
    try:
        if not _has_column(conn, "callsigns", "callsign_status_id"):
            conn.execute("ALTER TABLE callsigns ADD COLUMN callsign_status_id INTEGER")
    except Exception:
        # Best-effort; if it fails we will catch at runtime in routers.
        pass
        
def get_db():
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
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