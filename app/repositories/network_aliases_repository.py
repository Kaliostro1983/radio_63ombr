# app/repositories/network_aliases_repository.py

def get_network_by_alias_text(conn, alias_text: str):
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