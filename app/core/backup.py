from __future__ import annotations
import os
import shutil
from datetime import datetime, timedelta
from .config import settings

def _latest_backup_ts() -> datetime | None:
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

    # rotation
    keep = max(1, int(settings.backup_keep))
    files = sorted([f for f in os.listdir(settings.backup_dir) if f.endswith(".db")], reverse=True)
    for fn in files[keep:]:
        try:
            os.remove(os.path.join(settings.backup_dir, fn))
        except Exception:
            pass
