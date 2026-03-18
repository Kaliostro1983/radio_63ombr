"""Repository helpers for `network_aliases`.

This module encapsulates the SQL query used to resolve a network from a
structured intercept message header.

Usage in the system:

- `app.services.structured_intercept_service` calls `get_network_by_alias_text`
  to map the first header line (`alias_text`) to `network_id` and to fetch
  basic network metadata (frequency/mask/unit/zone/net_key).

The lookup ignores archived aliases (`is_archived=1`).
"""

# app/repositories/network_aliases_repository.py

def get_network_by_alias_text(conn, alias_text: str):
    """Resolve a network by alias text (structured intercept path).

    Args:
        conn: SQLite connection.
        alias_text: alias text extracted from structured intercept header.

    Returns:
        dict | None: mapping with `network_id` and network fields, or None
        if no active alias matches.
    """
    sql = """
    SELECT
        na.network_id,
        n.frequency,
        n.mask,
        n.unit,
        n.zone,
        n.net_key
    FROM network_aliases na
    JOIN networks n
      ON n.id = na.network_id
    WHERE na.alias_text = ?
      AND COALESCE(na.is_archived, 0) = 0
    LIMIT 1
    """
    cur = conn.cursor()
    cur.execute(sql, (alias_text,))
    row = cur.fetchone()
    if not row:
        return None

    return {
        "network_id": row[0],
        "frequency": row[1],
        "mask": row[2],
        "unit": row[3],
        "zone": row[4],
        "net_key": row[5],
    }