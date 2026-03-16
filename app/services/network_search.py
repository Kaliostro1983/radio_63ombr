from __future__ import annotations

from app.core.normalize import normalize_freq_or_mask


def search_network_rows(conn, query: str, limit: int = 100):
    raw = (query or "").strip()
    if not raw:
        return []

    try:
        exact_value, like_value = normalize_freq_or_mask(raw)
    except Exception:
        exact_value, like_value = None, None

    raw_like = f"%{raw}%"

    where_parts = []
    params = []

    if exact_value is not None:
        where_parts.append("(frequency = ? OR mask = ?)")
        params.extend([exact_value, exact_value])

    if like_value is not None:
        where_parts.append("(frequency LIKE ? OR mask LIKE ?)")
        params.extend([like_value, like_value])

    where_parts.append("frequency LIKE ?")
    params.append(raw_like)

    where_parts.append("mask LIKE ?")
    params.append(raw_like)

    where_parts.append("unit LIKE ? COLLATE NOCASE")
    params.append(raw_like)

    where_parts.append("zone LIKE ? COLLATE NOCASE")
    params.append(raw_like)

    sql = f"""
        SELECT id, frequency, mask, unit, zone, chat_id, status_id
        FROM networks
        WHERE {" OR ".join(where_parts)}
        ORDER BY
          CASE
            WHEN ? IS NOT NULL AND frequency = ? THEN 0
            WHEN ? IS NOT NULL AND mask = ? THEN 1
            WHEN ? IS NOT NULL AND frequency LIKE ? THEN 2
            WHEN ? IS NOT NULL AND mask LIKE ? THEN 3
            WHEN frequency LIKE ? THEN 4
            WHEN mask LIKE ? THEN 5
            WHEN unit LIKE ? COLLATE NOCASE THEN 6
            WHEN zone LIKE ? COLLATE NOCASE THEN 7
            ELSE 8
          END,
          frequency ASC,
          id ASC
        LIMIT ?
    """

    order_params = [
        exact_value, exact_value,
        exact_value, exact_value,
        like_value, like_value,
        like_value, like_value,
        raw_like,
        raw_like,
        raw_like,
        raw_like,
        int(limit),
    ]

    cur = conn.execute(sql, [*params, *order_params])
    return cur.fetchall()
