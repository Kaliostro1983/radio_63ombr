"""HTTP-роутер треків (GPS-маршрути).

Дзеркалить API палітр: перелік, імпорт файлу, теги підрозділів, перейменування
й колір, видалення, точки для карти, експорт KMZ, інфо.

Теги беруться зі СПІЛЬНОГО з палітрами довідника `palette_units`
(полково-бригадний рівень) — див. `GET /api/palettes/units`.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from app.core.access import require_capability
from app.core.db import get_conn
from app.core.logging import get_logger
from app.services.track_import_service import (
    SUPPORTED_EXT,
    normalize_color,
    parse_track_file,
    persist_track,
    track_to_kmz,
)

log = get_logger("tracks_router")
router = APIRouter(tags=["tracks"])


def _row_to_track(r) -> dict:
    return {
        "id": int(r["id"]),
        "seq_no": r["seq_no"],
        "name": r["name"],
        "color": r["color"],
        "point_count": r["point_count"],
        "removed_count": r["removed_count"],
        "length_km": r["length_km"],
        "imported_at": r["imported_at"],
        "recorded_at": r["recorded_at"],
        "source_format": r["source_format"],
        "source_filename": r["source_filename"],
        "comment": r["comment"],
        "is_archived": bool(r["is_archived"]),
        "bbox": [r["min_lat"], r["min_lon"], r["max_lat"], r["max_lon"]],
    }


@router.get("/api/tracks")
def api_tracks_list(unit_id: int = 0, include_archived: int = 0):
    """Перелік треків (з тегами). `unit_id` — фільтр за підрозділом."""
    where = [] if int(include_archived or 0) else ["t.is_archived = 0"]
    params: list[Any] = []
    if int(unit_id or 0):
        where.append("EXISTS(SELECT 1 FROM track_unit_links l "
                     "WHERE l.track_id = t.id AND l.unit_id = ?)")
        params.append(int(unit_id))
    sql = "SELECT t.* FROM tracks t"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY t.seq_no"

    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        out = []
        for r in rows:
            item = _row_to_track(r)
            item["units"] = [
                {"id": int(u["id"]), "name": u["name"]}
                for u in conn.execute(
                    "SELECT u.id, u.name FROM track_unit_links l "
                    "JOIN palette_units u ON u.id = l.unit_id "
                    "WHERE l.track_id = ? ORDER BY u.sort_order, u.name",
                    (item["id"],),
                ).fetchall()
            ]
            out.append(item)
    return {"ok": True, "rows": out}


@router.get("/api/tracks/{track_id}/points")
def api_track_points(track_id: int):
    """Точки треку для відмальовування на карті."""
    with get_conn() as conn:
        t = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not t:
            return JSONResponse({"ok": False, "error": "Трек не знайдено"}, status_code=404)
        pts = conn.execute(
            "SELECT lat, lon, alt FROM track_points WHERE track_id = ? ORDER BY seq",
            (track_id,),
        ).fetchall()
    return {
        "ok": True,
        "id": track_id,
        "name": t["name"],
        "color": t["color"],
        "bbox": [t["min_lat"], t["min_lon"], t["max_lat"], t["max_lon"]],
        "points": [[p["lat"], p["lon"]] for p in pts],
    }


@router.post("/api/tracks/import")
async def api_track_import(request: Request, file: UploadFile = File(...)):
    """Імпорт файлу треку (LDK/TRK/GPX/KML/KMZ). Викиди чистяться автоматично."""
    require_capability(request, "conclusion.write")
    filename = file.filename or "track"
    if not filename.lower().endswith(SUPPORTED_EXT):
        return JSONResponse(
            {"ok": False, "error": f"Підтримувані формати: {', '.join(SUPPORTED_EXT)}"},
            status_code=400,
        )
    try:
        data = await file.read()
        tracks = parse_track_file(data, filename)
    except Exception as e:  # noqa: BLE001
        log.warning("track import failed (%s): %s", filename, e)
        return JSONResponse({"ok": False, "error": f"Не вдалося розібрати файл: {e}"},
                            status_code=400)

    created = []
    with get_conn() as conn:
        for t in tracks:
            tid = persist_track(conn, t)
            created.append({"id": tid, "name": t.name, "points": len(t.points),
                            "removed": t.removed_count})
        conn.commit()
    return {"ok": True, "created": created}


@router.patch("/api/tracks/{track_id}")
async def api_track_update(track_id: int, request: Request):
    """Часткове оновлення: `name`, `color`, `comment`, `is_archived`."""
    require_capability(request, "conclusion.write")
    payload: Dict[str, Any] = await request.json()
    sets, params = [], []
    if "name" in payload:
        name = (payload.get("name") or "").strip()
        if not name:
            return JSONResponse({"ok": False, "error": "Назва не може бути порожньою"},
                                status_code=400)
        sets.append("name = ?"); params.append(name)
    if "color" in payload:
        sets.append("color = ?"); params.append(normalize_color(payload.get("color")))
    if "comment" in payload:
        sets.append("comment = ?"); params.append(str(payload.get("comment") or ""))
    if "is_archived" in payload:
        sets.append("is_archived = ?"); params.append(1 if payload.get("is_archived") else 0)
    if not sets:
        return JSONResponse({"ok": False, "error": "Немає що оновлювати"}, status_code=400)

    with get_conn() as conn:
        if not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
            return JSONResponse({"ok": False, "error": "Трек не знайдено"}, status_code=404)
        conn.execute(f"UPDATE tracks SET {', '.join(sets)} WHERE id = ?", params + [track_id])
        conn.commit()
        r = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    return {"ok": True, **_row_to_track(r)}


@router.post("/api/tracks/{track_id}/units")
async def api_track_units(track_id: int, request: Request):
    """Замінити теги підрозділів треку. Body: `{unit_ids: [int, …]}`."""
    require_capability(request, "conclusion.write")
    payload: Dict[str, Any] = await request.json()
    unit_ids = [int(x) for x in (payload.get("unit_ids") or [])]
    with get_conn() as conn:
        if not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
            return JSONResponse({"ok": False, "error": "Трек не знайдено"}, status_code=404)
        conn.execute("DELETE FROM track_unit_links WHERE track_id = ?", (track_id,))
        for uid in unit_ids:
            conn.execute("INSERT OR IGNORE INTO track_unit_links(track_id, unit_id) VALUES(?,?)",
                         (track_id, uid))
        conn.commit()
    return {"ok": True, "unit_ids": unit_ids}


@router.delete("/api/tracks/{track_id}")
def api_track_delete(track_id: int, request: Request):
    """Видалити трек разом із точками (ON DELETE CASCADE)."""
    require_capability(request, "conclusion.write")
    with get_conn() as conn:
        if not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
            return JSONResponse({"ok": False, "error": "Трек не знайдено"}, status_code=404)
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
    return {"ok": True, "id": track_id}


@router.get("/api/tracks/{track_id}/export")
def api_track_export(track_id: int):
    """Експорт треку у KMZ."""
    with get_conn() as conn:
        t = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not t:
            return JSONResponse({"ok": False, "error": "Трек не знайдено"}, status_code=404)
        pts = conn.execute(
            "SELECT lat, lon, alt FROM track_points WHERE track_id = ? ORDER BY seq",
            (track_id,),
        ).fetchall()
    points = [{"lat": p["lat"], "lon": p["lon"], "alt": p["alt"]} for p in pts]
    desc = (f"Імпортовано: {t['imported_at']}. Точок: {t['point_count']}, "
            f"довжина: {t['length_km']} км. Джерело: {t['source_filename']}")
    blob = track_to_kmz(t["name"], t["color"], points, description=desc)
    safe = "".join(ch for ch in (t["name"] or "track") if ch.isalnum() or ch in " _-").strip() or "track"
    return Response(
        content=blob,
        media_type="application/vnd.google-earth.kmz",
        headers={"Content-Disposition": f'attachment; filename="{safe}.kmz"'},
    )
