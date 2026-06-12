"""Dictionary of slang/codewords used on radio networks.

A term is bound to ONE network at a time. Search supports two scopes:
- by `network_id`           — default; matches what an operator typically wants
- by `group_id` of network  — "розширений пошук" (broader: всі мережі в групі)

This module performs raw SQLite I/O and returns plain dicts so that the
router/service layers can serialize directly.
"""

from __future__ import annotations

from typing import Any, Iterable


def _row_to_dict(row) -> dict[str, Any]:
    return {
        "id":          row["id"],
        "term":        row["term"],
        "definition":  row["definition"],
        "network_id":  row["network_id"],
        "frequency":   row["frequency"],
        "mask":        row["mask"],
        "unit":        row["unit"],
        "group_id":    row["group_id"],
        "group_name":  row["group_name"],
        "created_at":  row["created_at"],
        "updated_at":  row["updated_at"],
    }


_BASE_SELECT = """
    SELECT
        d.id, d.term, d.definition, d.network_id,
        d.created_at, d.updated_at,
        n.frequency, n.mask, n.unit, n.group_id,
        g.name AS group_name
    FROM dictionary_terms d
    JOIN networks n ON n.id = d.network_id
    LEFT JOIN groups g ON g.id = n.group_id
"""


def list_recent(conn, *, limit: int = 10) -> list[dict[str, Any]]:
    """Return most-recently-updated terms (used when no search is active)."""
    cur = conn.execute(
        _BASE_SELECT + " ORDER BY d.updated_at DESC, d.id DESC LIMIT ?",
        (int(limit),),
    )
    return [_row_to_dict(r) for r in cur.fetchall()]


def search(
    conn,
    *,
    q: str | None = None,
    network_id: int | None = None,
    group_id: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search terms with optional scope filter.

    Scope rules:
    - `network_id` provided → only that network
    - `group_id`   provided → all networks in that group
    - both None            → no scope filter (free search)

    `q` matches against `term` (prefix or substring, case-insensitive).
    If `q` is empty/None and no scope is provided, falls back to
    most-recently-updated entries (mirrors `list_recent`).
    """
    where: list[str] = []
    params: list[Any] = []

    q_clean = (q or "").strip()
    if q_clean:
        where.append("LOWER(d.term) LIKE ?")
        params.append(f"%{q_clean.lower()}%")

    if network_id is not None:
        where.append("d.network_id = ?")
        params.append(int(network_id))
    elif group_id is not None:
        where.append("n.group_id = ?")
        params.append(int(group_id))

    sql = _BASE_SELECT
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY d.updated_at DESC, d.id DESC LIMIT ?"
    params.append(int(limit))

    cur = conn.execute(sql, params)
    return [_row_to_dict(r) for r in cur.fetchall()]


def get_by_id(conn, term_id: int) -> dict[str, Any] | None:
    cur = conn.execute(_BASE_SELECT + " WHERE d.id = ?", (int(term_id),))
    row = cur.fetchone()
    return _row_to_dict(row) if row else None


def create(
    conn,
    *,
    term: str,
    definition: str,
    network_id: int,
) -> dict[str, Any]:
    cur = conn.execute(
        "INSERT INTO dictionary_terms(term, definition, network_id) VALUES (?, ?, ?)",
        ((term or "").strip(), (definition or "").strip(), int(network_id)),
    )
    new_id = cur.lastrowid
    conn.commit()
    out = get_by_id(conn, new_id)
    assert out is not None
    return out


def update(
    conn,
    term_id: int,
    *,
    term: str | None = None,
    definition: str | None = None,
    network_id: int | None = None,
) -> dict[str, Any] | None:
    """Partial update. Pass only the fields to change.

    Move-between-networks is just `update(..., network_id=NEW_ID)`.
    """
    sets: list[str] = []
    params: list[Any] = []
    if term is not None:
        sets.append("term = ?")
        params.append(term.strip())
    if definition is not None:
        sets.append("definition = ?")
        params.append(definition.strip())
    if network_id is not None:
        sets.append("network_id = ?")
        params.append(int(network_id))
    if not sets:
        return get_by_id(conn, term_id)

    sets.append("updated_at = CURRENT_TIMESTAMP")
    sql = f"UPDATE dictionary_terms SET {', '.join(sets)} WHERE id = ?"
    params.append(int(term_id))
    conn.execute(sql, params)
    conn.commit()
    return get_by_id(conn, term_id)


def delete(conn, term_id: int) -> bool:
    cur = conn.execute("DELETE FROM dictionary_terms WHERE id = ?", (int(term_id),))
    conn.commit()
    return cur.rowcount > 0
