"""Application configuration management.

This module provides a small configuration layer for the service. It loads
environment variables from a dotenv file (by default `config.env`) and
exposes a frozen `Settings` object used by the rest of the codebase.

Usage in the system:

- `app.main` uses `settings.app_name` for the FastAPI title.
- `app.core.db` uses `settings.db_path` to locate the SQLite database.
- `app.core.backup` uses backup-related settings for automatic backups.
"""

from __future__ import annotations
import os
from dataclasses import dataclass
from dotenv import load_dotenv

@dataclass(frozen=True)
class Settings:
    """Typed container for runtime configuration values."""
    app_name: str = "63ombr"
    db_path: str = "database/radio.db"
    backup_dir: str = "backups"
    backup_keep: int = 30
    freq_xlsx: str = "Frequencies_63.xlsx"
    etalon_xlsx: str = ""

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
    return Settings(
        app_name=os.getenv("APP_NAME", "63ombr"),
        db_path=os.getenv("DB_PATH", "database/radio.db"),
        backup_dir=os.getenv("BACKUP_DIR", "backups"),
        backup_keep=int(os.getenv("BACKUP_KEEP", "30")),
        freq_xlsx=os.getenv("FREQ_XLSX", "Frequencies_63.xlsx"),
        etalon_xlsx=os.getenv("ETALON_XLSX", ""),
    )

settings = load_settings()
