from __future__ import annotations

from typing import Any, List, Optional

from app.core.logging import get_logger

log = get_logger("network_service")


def _table_exists(cur, table_name: str) -> bool:
    row = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (table_name,),
    ).fetchone()
    return bool(row)


def _get_table_columns(cur, table_name: str) -> List[str]:
    rows = cur.execute(f"PRAGMA table_info({table_name})").fetchall()
    out: List[str] = []
    for r in rows:
        out.append(r[1] if not isinstance(r, dict) else r["name"])
    return out


def get_default_network_chat_id(cur) -> int:
    """
    networks.chat_id is NOT NULL. We pick deterministic default:
      - if chats exists: try "Невідомо" by name/title, else first chats.id
      - else fallback to first networks.chat_id
    """
    if _table_exists(cur, "chats"):
        cols = set(_get_table_columns(cur, "chats"))

        if "name" in cols:
            row = cur.execute(
                "SELECT id FROM chats WHERE name=? LIMIT 1",
                ("Невідомо",),
            ).fetchone()
            if row:
                return int(row[0] if not isinstance(row, dict) else row["id"])

        if "title" in cols:
            row = cur.execute(
                "SELECT id FROM chats WHERE title=? LIMIT 1",
                ("Невідомо",),
            ).fetchone()
            if row:
                return int(row[0] if not isinstance(row, dict) else row["id"])

        row = cur.execute("SELECT id FROM chats ORDER BY id LIMIT 1").fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    row = cur.execute("SELECT chat_id FROM networks ORDER BY id LIMIT 1").fetchone()
    if row:
        return int(row[0] if not isinstance(row, dict) else row["chat_id"])

    raise RuntimeError("Cannot determine default networks.chat_id (tables chats/networks look empty).")


def ensure_network(
    cur,
    frequency: Optional[str],
    mask: Optional[str],
    now_dt: str,
    unit: Optional[str],
    zone: Optional[str],
) -> int:
    """
    If exists -> return id.
    Else -> create. Defaults only if unit/zone absent in intercept.
    group_id=7, status_id=14 always for auto-created.
    """

    def norm_s(v: Optional[str]) -> Optional[str]:
        v = (v or "").strip()
        return v or None

    frequency = norm_s(frequency)
    mask = norm_s(mask)
    unit = norm_s(unit) or "НВ підрозділу"
    zone = norm_s(zone) or "розвідується"

    if not frequency:
        frequency = f"UNKNOWN:{now_dt}"

    row = cur.execute("SELECT id FROM networks WHERE frequency=? LIMIT 1", (frequency,)).fetchone()
    if row:
        return int(row[0] if not isinstance(row, dict) else row["id"])

    if mask:
        row = cur.execute("SELECT id FROM networks WHERE mask=? LIMIT 1", (mask,)).fetchone()
        if row:
            return int(row[0] if not isinstance(row, dict) else row["id"])

    chat_id = get_default_network_chat_id(cur)

    cols = set(_get_table_columns(cur, "networks"))
    insert_cols: List[str] = []
    insert_vals: List[Any] = []

    def add(col: str, val: Any) -> None:
        if col in cols:
            insert_cols.append(col)
            insert_vals.append(val)

    add("frequency", frequency)
    add("mask", mask)
    add("unit", unit)
    add("zone", zone)
    add("chat_id", chat_id)
    add("group_id", 7)
    add("status_id", 14)
    add("comment", "auto-created")
    add("updated_at", now_dt)

    if "net_key" in cols:
        add("net_key", frequency)

    sql = f"""
        INSERT INTO networks ({", ".join(insert_cols)})
        VALUES ({", ".join(["?"] * len(insert_cols))})
    """
    cur.execute(sql, tuple(insert_vals))
    new_id = int(cur.lastrowid)

    log.notice(
        f"Created new network: frequency={frequency!r}, unit={unit!r}, zone={zone!r}, group_id=7, status_id=14"
    )
    return new_id