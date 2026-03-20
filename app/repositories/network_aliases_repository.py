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
    # Structured ingest compares alias text extracted from OCR'ed messages.
    # Exact equality is too brittle (extra spaces, casing, quotes).
    # We normalize both sides:
    # - lower, trim
    # - remove both double/single quotes
    # - collapse repeated spaces (approx. by repeated REPLACE)
    from app.core.alias_normalizer import normalize_network_alias

    norm_input = normalize_network_alias(alias_text)

    def _norm_sql(col: str) -> str:
        # Collapse multiple spaces by repeated replacement.
        collapsed = col
        for _ in range(5):
            collapsed = f"REPLACE({collapsed}, '  ', ' ')"
        # Lowercase + trim + remove quotes.
        # Remove double quotes and single quotes (CHAR(39)) safely.
        collapsed = (
            "LOWER(TRIM("
            f"REPLACE(REPLACE({collapsed}, '\"', ''), CHAR(39), '')"
            "))"
        )
        return collapsed

    sql = f"""
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
    WHERE {_norm_sql('na.alias_text')} = ?
      AND COALESCE(na.is_archived, 0) = 0
    LIMIT 1
    """

    cur = conn.cursor()
    cur.execute(sql, (norm_input,))
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