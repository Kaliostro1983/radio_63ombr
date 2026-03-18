"""Database backup helper.

This module implements a simple time-based backup strategy for the SQLite
database file:

- on application startup, `maybe_backup_db` may create a copy of the DB
  file into `settings.backup_dir`;
- a new backup is created at most once per 24 hours;
- old backups are rotated, keeping the most recent `settings.backup_keep`
  files.

The backup operation is intentionally best-effort: failures are silently
ignored during rotation to avoid preventing the service from starting.
"""

from __future__ import annotations
import os
import shutil
from datetime import datetime, timedelta
from .config import settings

def _latest_backup_ts() -> datetime | None:
    """Return timestamp of the latest backup file, if any.

    Backup filenames are expected to follow the pattern:
        radio_YYYYMMDD_HHMMSS.db

    Returns:
        datetime | None: parsed timestamp of the newest backup file or None
        if no backups exist / directory missing.
    """
    if not os.path.isdir(settings.backup_dir):
        return None
    files = [f for f in os.listdir(settings.backup_dir) if f.endswith(".db")]
    if not files:
        return None
    files.sort(reverse=True)
    # filenames: radio_YYYYMMDD_HHMMSS.db
    for fn in files:
        try:
            stamp = fn.split("_", 1)[1].rsplit(".", 1)[0]
            dt = datetime.strptime(stamp, "%Y%m%d_%H%M%S")
            return dt
        except Exception:
            continue
    return None

def maybe_backup_db():
    """Create a database backup if backup policy allows.

    The function:
    - ensures the backup directory exists;
    - checks whether a backup was created in the last 24 hours;
    - copies the DB file into the backup directory with a timestamp suffix;
    - removes older backups beyond `settings.backup_keep`.

    Returns:
        None
    """
    os.makedirs(settings.backup_dir, exist_ok=True)
    last = _latest_backup_ts()
    if last and datetime.now() - last < timedelta(hours=24):
        return
    src = settings.db_path
    if not os.path.exists(src):
        return
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(settings.backup_dir, f"radio_{stamp}.db")
    shutil.copy2(src, dst)

    # Rotation: keep only the newest N backups.
    keep = max(1, int(settings.backup_keep))
    files = sorted([f for f in os.listdir(settings.backup_dir) if f.endswith(".db")], reverse=True)
    for fn in files[keep:]:
        try:
            os.remove(os.path.join(settings.backup_dir, fn))
        except Exception:
            pass
