"""Router for the radio-network dictionary (slang/codewords)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from app.core.db import get_conn
from app.repositories import dictionary_repository as repo

router = APIRouter(prefix="/api/dictionary", tags=["dictionary"])


def _network_label(row: dict[str, Any]) -> str:
    """Compose a human-readable network label for autocomplete display."""
    bits: list[str] = []
    if row.get("frequency"):
        bits.append(str(row["frequency"]))
    if row.get("mask"):
        bits.append(f"({row['mask']})")
    if row.get("unit"):
        bits.append(str(row["unit"]))
    return " ".join(bits).strip()


def _enrich(item: dict[str, Any]) -> dict[str, Any]:
    item = dict(item)
    item["network_label"] = _network_label(item)
    return item


@router.get("")
def list_terms(
    q: str | None = Query(None),
    network_id: int | None = Query(None),
    group_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    """List/search dictionary terms.

    No query and no scope → most-recent-N (used as the default panel view).
    """
    with get_conn() as conn:
        q_clean = (q or "").strip()
        if not q_clean and network_id is None and group_id is None:
            items = repo.list_recent(conn, limit=min(limit, 10))
        else:
            items = repo.search(
                conn,
                q=q_clean or None,
                network_id=network_id,
                group_id=group_id,
                limit=limit,
            )
    return JSONResponse({"ok": True, "items": [_enrich(x) for x in items]})


@router.get("/networks")
def list_networks_for_autocomplete(
    q: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    """Autocomplete: search networks by freq/mask/unit for the scope picker.

    Used by the panel autocomplete + add-term form. Returns lightweight
    rows with a precomputed display label.
    """
    q_clean = (q or "").strip().lower()
    sql = """
        SELECT n.id, n.frequency, n.mask, n.unit, n.group_id, g.name AS group_name
        FROM networks n
        LEFT JOIN groups g ON g.id = n.group_id
    """
    params: list[Any] = []
    if q_clean:
        sql += """
            WHERE LOWER(n.frequency) LIKE ?
               OR LOWER(COALESCE(n.mask, '')) LIKE ?
               OR LOWER(n.unit) LIKE ?
        """
        like = f"%{q_clean}%"
        params = [like, like, like]
    sql += " ORDER BY n.frequency LIMIT ?"
    params.append(int(limit))

    with get_conn() as conn:
        cur = conn.execute(sql, params)
        rows = [
            {
                "id":         r["id"],
                "frequency":  r["frequency"],
                "mask":       r["mask"],
                "unit":       r["unit"],
                "group_id":   r["group_id"],
                "group_name": r["group_name"],
                "label":      _network_label(
                    {
                        "frequency": r["frequency"],
                        "mask":      r["mask"],
                        "unit":      r["unit"],
                    }
                ),
            }
            for r in cur.fetchall()
        ]
    return JSONResponse({"ok": True, "items": rows})


@router.post("")
def create_term(payload: dict = Body(...)):
    term       = (payload.get("term") or "").strip()
    definition = (payload.get("definition") or "").strip()
    network_id = payload.get("network_id")

    if not term:
        raise HTTPException(400, detail="term is required")
    if not network_id:
        raise HTTPException(400, detail="network_id is required")
    try:
        network_id = int(network_id)
    except (TypeError, ValueError):
        raise HTTPException(400, detail="network_id must be integer")

    with get_conn() as conn:
        row = conn.execute("SELECT id FROM networks WHERE id = ?", (network_id,)).fetchone()
        if not row:
            raise HTTPException(404, detail="network not found")
        item = repo.create(
            conn,
            term=term,
            definition=definition,
            network_id=network_id,
        )
    return JSONResponse({"ok": True, "item": _enrich(item)})


@router.patch("/{term_id}")
def update_term(term_id: int, payload: dict = Body(...)):
    fields: dict[str, Any] = {}
    if "term" in payload:
        v = (payload.get("term") or "").strip()
        if not v:
            raise HTTPException(400, detail="term cannot be empty")
        fields["term"] = v
    if "definition" in payload:
        fields["definition"] = (payload.get("definition") or "").strip()
    if "network_id" in payload:
        try:
            fields["network_id"] = int(payload["network_id"])
        except (TypeError, ValueError):
            raise HTTPException(400, detail="network_id must be integer")

    if not fields:
        raise HTTPException(400, detail="nothing to update")

    with get_conn() as conn:
        if "network_id" in fields:
            row = conn.execute(
                "SELECT id FROM networks WHERE id = ?", (fields["network_id"],)
            ).fetchone()
            if not row:
                raise HTTPException(404, detail="target network not found")
        item = repo.update(conn, term_id, **fields)
    if not item:
        raise HTTPException(404, detail="term not found")
    return JSONResponse({"ok": True, "item": _enrich(item)})


@router.delete("/{term_id}")
def delete_term(term_id: int):
    with get_conn() as conn:
        ok = repo.delete(conn, term_id)
    if not ok:
        raise HTTPException(404, detail="term not found")
    return JSONResponse({"ok": True})
