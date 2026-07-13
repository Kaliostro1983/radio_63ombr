"""Application configuration management.

This module provides a small configuration layer for the service. It loads
environment variables from a dotenv file (by default `config.env`) and
exposes a frozen `Settings` object used by the rest of the codebase.

Usage in the system:

- `app.main` uses `settings.app_name` for the FastAPI title.
- `app.core.db` uses `settings.db_path` to locate the SQLite database.
- `app.core.backup` uses backup-related settings for automatic backups.
- Optional `LANDMARK_AUTO_MATCH` controls automatic landmark keyword matching
  (background worker + queueing); see `docs/PIPELINE.md`.
"""

from __future__ import annotations
import os
import secrets
from dataclasses import dataclass
from dotenv import load_dotenv


def _env_bool(name: str, default: bool = False) -> bool:
    """Parse truthy env values: 1, true, yes, on (case-insensitive)."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _resolve_session_secret(db_path: str) -> str:
    """Resolve the cookie-session secret key.

    Priority:
      1. `SESSION_SECRET` env var (explicit, recommended for prod).
      2. A random key persisted next to the DB (`session_secret.key`) so it
         stays stable across restarts without manual config — otherwise every
         restart would silently invalidate sessions.
      3. Ephemeral random (last resort) if the file can't be read/written.

    Replaces the former hardcoded ``"change_me_please"``.
    """
    env = (os.getenv("SESSION_SECRET") or "").strip()
    if env:
        return env

    d = os.path.dirname(db_path) or "."
    path = os.path.join(d, "session_secret.key")
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                val = f.read().strip()
            if val:
                return val
        os.makedirs(d, exist_ok=True)
        val = secrets.token_urlsafe(48)
        with open(path, "w", encoding="utf-8") as f:
            f.write(val)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return val
    except OSError:
        return secrets.token_urlsafe(48)


@dataclass(frozen=True)
class Settings:
    """Typed container for runtime configuration values."""
    app_name: str = "63ombr"
    db_path: str = "database/radio.db"
    backup_dir: str = "backups"
    backup_keep: int = 30
    freq_xlsx: str = "Frequencies_63.xlsx"
    etalon_xlsx: str = ""
    # When False: no background thread; no enqueue from ingest / landmark APIs.
    landmark_auto_match_enabled: bool = False
    # Google Sheets sync via Apps Script webhook (empty = disabled).
    sheets_script_url: str = ""
    # Chat-bot service base URL (empty = disabled).
    # Set to e.g. http://localhost:3001 in config.env.
    bot_service_url: str = ""
    # Cookie-session secret (resolved from env or persisted file; never the old default).
    session_secret: str = ""


def load_settings() -> Settings:
    """Load configuration from environment variables (optionally via dotenv).

    The function tries to load a dotenv file if it exists. The path is
    controlled by the `APP_CONFIG` environment variable; if not set,
    `config.env` is used.

    Returns:
        Settings: immutable settings object used by the application.
    """
    env_path = os.getenv("APP_CONFIG", "config.env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
    db_path = os.getenv("DB_PATH", "database/radio.db")
    return Settings(
        app_name=os.getenv("APP_NAME", "63ombr"),
        db_path=db_path,
        backup_dir=os.getenv("BACKUP_DIR", "backups"),
        backup_keep=int(os.getenv("BACKUP_KEEP", "30")),
        freq_xlsx=os.getenv("FREQ_XLSX", "Frequencies_63.xlsx"),
        etalon_xlsx=os.getenv("ETALON_XLSX", ""),
        landmark_auto_match_enabled=_env_bool("LANDMARK_AUTO_MATCH", default=False),
        sheets_script_url=os.getenv("SHEETS_SCRIPT_URL", ""),
        bot_service_url=os.getenv("BOT_SERVICE_URL", ""),
        session_secret=_resolve_session_secret(db_path),
    )

settings = load_settings()
