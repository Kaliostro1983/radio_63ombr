"""Time helpers for the ingest pipeline and UI.

The project stores most timestamps in SQLite as `TEXT` using ISO-8601-like
strings (via `datetime.isoformat(timespec="seconds")`). This module
provides:

- current timestamp in storage format (`now_sql`);
- conversion from intercept template datetime strings to storage format (`to_sql_dt`);
- delay calculation between source platform timestamp and intercept timestamp (`calc_delay_sec`).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional


def now_sql() -> str:
    """Return current local time formatted for SQLite TEXT storage.

    Returns:
        str: ISO-formatted datetime string with second precision.
    """
    return datetime.now().isoformat(timespec="seconds")


def to_sql_dt(dt_text: str | None) -> str | None:
    """Convert intercept datetime text into ISO storage format.

    Supported input formats:
        - `DD.MM.YYYY, HH:MM:SS`
        - `DD.MM.YYYY HH:MM:SS`

    Args:
        dt_text: datetime string extracted from an intercept message.

    Returns:
        str | None: ISO-formatted datetime string or None if parsing fails.
    """
    if not dt_text:
        return None

    s = str(dt_text).strip()
    try:
        if "," in s:
            dt = datetime.strptime(s, "%d.%m.%Y, %H:%M:%S")
        else:
            dt = datetime.strptime(s, "%d.%m.%Y %H:%M:%S")
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def calc_delay_sec(
    platform: str,
    published_at_platform: Optional[str],
    published_at_text: Optional[str],
) -> Optional[int]:
    """Calculate delay in seconds between platform timestamp and intercept timestamp.

    Args:
        platform: ingestion source identifier (e.g. `whatsapp`, `xlsx`).
        published_at_platform: timestamp provided by the platform (typically ISO).
        published_at_text: timestamp extracted from intercept text (template format).

    Returns:
        Optional[int]: delay in seconds (`platform_dt - intercept_dt`), 0 for
        certain import sources, or None if inputs are missing/invalid.
    """
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