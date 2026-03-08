from __future__ import annotations

from datetime import datetime
from typing import Optional


def now_sql() -> str:
    return datetime.now().isoformat(timespec="seconds")


def to_sql_dt(dt_text: str | None) -> str | None:
    if not dt_text:
        return None

    s = str(dt_text).strip()
    try:
        if "," in s:
            dt = datetime.strptime(s, "%d.%m.%Y, %H:%M:%S")
        else:
            dt = datetime.strptime(s, "%d.%m.%Y %H:%M:%S")
        return dt.isoformat(timespec="seconds")
    except Exception:
        return None


def calc_delay_sec(
    platform: str,
    published_at_platform: Optional[str],
    published_at_text: Optional[str],
) -> Optional[int]:
    if platform == "xlsx_import":
        return 0

    if not published_at_platform or not published_at_text:
        return None

    try:
        dt_platform = datetime.fromisoformat(str(published_at_platform).strip())

        published_text_raw = str(published_at_text).strip()
        if "," in published_text_raw:
            dt_text = datetime.strptime(published_text_raw, "%d.%m.%Y, %H:%M:%S")
        else:
            dt_text = datetime.strptime(published_text_raw, "%d.%m.%Y %H:%M:%S")

        return int((dt_platform - dt_text).total_seconds())
    except Exception:
        return None