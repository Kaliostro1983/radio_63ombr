"""HTTP API for palettes (набори кодованих точок).

Endpoints (Phase 1):
    GET    /api/palettes/units                — довідник підрозділів
    GET    /api/palettes                       — список палітр (+ фільтри)
    POST   /api/palettes/import/analyze        — розбір файлу + аналіз дублів (без запису)
    POST   /api/palettes/import/commit         — запис палітри (з рішенням по дублях)
    POST   /api/palettes/{id}/archive          — архівувати
    POST   /api/palettes/{id}/unarchive        — розархівувати
    POST   /api/palettes/{id}/delete           — видалити
    GET    /api/palettes/search                — пошук точок (fold + маски)
    GET    /api/palettes/{id}/regions          — області (полігони) для карти
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import JSONResponse

from app.core.db import get_conn
from app.core.palette_fold import fold_code, mask_to_glob, is_mask
from app.services.palette_import_service import (
    parse_kml_bytes, parse_geojson_bytes, parse_ldk_bytes,
    build_regions, analyze_duplicates, persist_palette,
)

router = APIRouter()


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _detect_format(filename: str) -> str:
    fn = (filename or "").lower()
    if fn.endswith(".kmz"):
        return "kmz"
    if fn.endswith(".kml"):
        return "kml"
    if fn.endswith(".geojson") or fn.endswith(".json"):
        return "geojson"
    if fn.endswith(".ldk"):
        return "ldk"
    return ""


# --------------------------------------------------------------------------- #
#  Reference
# --------------------------------------------------------------------------- #


@router.get("/api/palettes/units")
def api_palette_units():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name FROM palette_units ORDER BY sort_order, name"
        ).fetchall()
    return {"ok": True, "units": [{"id": int(r["id"]), "name": str(r["name"])} for r in rows]}


# --------------------------------------------------------------------------- #
#  Listing
# --------------------------------------------------------------------------- #


@router.get("/api/palettes")
def api_palettes_list(
    include_archived: int = Query(default=0),
    unit_id: int | None = Query(default=None),
):
    where = []
    params: list[Any] = []
    if not include_archived:
        where.append("p.is_archived = 0")
    if unit_id:
        where.append("EXISTS (SELECT 1 FROM palette_unit_links l WHERE l.palette_id = p.id AND l.unit_id = ?)")
        params.append(int(unit_id))
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT p.id, p.name, p.source_format, p.source_filename, p.comment,
                   p.is_archived, p.imported_at, p.last_used_at, p.use_count,
                   p.point_count
            FROM palettes p
            {where_sql}
            ORDER BY p.is_archived, p.name
            """,
            params,
        ).fetchall()
        items = []
        for r in rows:
            units = conn.execute(
                """
                SELECT u.id, u.name FROM palette_unit_links l
                JOIN palette_units u ON u.id = l.unit_id
                WHERE l.palette_id = ? ORDER BY u.sort_order
                """,
                (r["id"],),
            ).fetchall()
            region_cnt = conn.execute(
                "SELECT COUNT(*) FROM palette_regions WHERE palette_id = ?", (r["id"],)
            ).fetchone()[0]
            items.append({
                "id": int(r["id"]),
                "name": str(r["name"]),
                "source_format": str(r["source_format"] or ""),
                "comment": str(r["comment"] or ""),
                "is_archived": int(r["is_archived"]),
                "imported_at": str(r["imported_at"] or ""),
                "last_used_at": str(r["last_used_at"] or "") if r["last_used_at"] else None,
                "use_count": int(r["use_count"] or 0),
                "point_count": int(r["point_count"] or 0),
                "region_count": int(region_cnt or 0),
                "units": [{"id": int(u["id"]), "name": str(u["name"])} for u in units],
            })
    return {"ok": True, "palettes": items}


# --------------------------------------------------------------------------- #
#  Import
# --------------------------------------------------------------------------- #


def _parse_upload(data: bytes, filename: str):
    fmt = _detect_format(filename)
    # KMZ — zip-архів (магічні байти "PK"); KML — XML.
    if fmt == "kmz" or data[:2] == b"PK":
        return parse_kml_bytes(data, source_format="kmz", source_filename=filename)
    if fmt == "kml":
        return parse_kml_bytes(data, source_format="kml", source_filename=filename)
    if fmt == "geojson":
        return parse_geojson_bytes(data, source_filename=filename)
    # LDK (AlpineQuest) — бінарний формат, magic "LDK:" (4C 44 4B 3A)
    if fmt == "ldk" or data[:4] == b"LDK:":
        return parse_ldk_bytes(data, source_filename=filename)
    # Фолбек: спробувати визначити за вмістом, якщо розширення невідоме.
    head = data.lstrip()[:1]
    if head == b"<":
        return parse_kml_bytes(data, source_format="kml", source_filename=filename)
    if head in (b"{", b"["):
        return parse_geojson_bytes(data, source_filename=filename)
    raise HTTPException(status_code=400, detail="Підтримуються .kml / .kmz / .geojson / .ldk файли")


@router.post("/api/palettes/import/analyze")
async def api_palette_import_analyze(file: UploadFile = File(...)):
    """Parse the uploaded file and report a summary + duplicate candidates.
    Does NOT persist anything."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Порожній файл")
    parsed = _parse_upload(data, file.filename or "")
    if not parsed.points:
        raise HTTPException(status_code=400, detail="У файлі не знайдено точок (Placemark з координатами)")

    regions = build_regions(parsed.points)
    with get_conn() as conn:
        duplicates = analyze_duplicates(conn, parsed)

    return {
        "ok": True,
        "summary": {
            "name": parsed.name,
            "source_format": parsed.source_format,
            "point_count": len(parsed.points),
            "region_count": len(regions),
            "regions": [
                {"color": r.color, "label": r.label, "point_count": len(r.points)}
                for r in regions
            ],
        },
        "duplicates": duplicates,
    }


@router.post("/api/palettes/import/commit")
async def api_palette_import_commit(
    file: UploadFile = File(...),
    name: str = Form(default=""),
    comment: str = Form(default=""),
    unit_ids: str = Form(default=""),
    replace_ids: str = Form(default=""),
):
    """Persist the uploaded palette. `unit_ids`/`replace_ids` are CSV lists.
    `replace_ids` palettes are deleted before insert (заміна старої палітри)."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Порожній файл")
    parsed = _parse_upload(data, file.filename or "")
    if not parsed.points:
        raise HTTPException(status_code=400, detail="У файлі не знайдено точок")

    if name.strip():
        parsed.name = name.strip()

    def _csv_ints(s: str) -> list[int]:
        out = []
        for tok in (s or "").split(","):
            tok = tok.strip()
            if tok.isdigit():
                out.append(int(tok))
        return out

    unit_id_list = _csv_ints(unit_ids)
    replace_id_list = _csv_ints(replace_ids)

    with get_conn() as conn:
        palette_id = persist_palette(
            conn, parsed,
            unit_ids=unit_id_list,
            comment=comment.strip(),
            replace_palette_ids=replace_id_list,
        )
        conn.commit()

    return {"ok": True, "palette_id": palette_id}


# --------------------------------------------------------------------------- #
#  Archive / delete
# --------------------------------------------------------------------------- #


@router.post("/api/palettes/{palette_id}/archive")
def api_palette_archive(palette_id: int):
    with get_conn() as conn:
        cur = conn.execute("UPDATE palettes SET is_archived = 1 WHERE id = ?", (palette_id,))
        if getattr(cur, "rowcount", 0) == 0:
            raise HTTPException(status_code=404, detail="Палітру не знайдено")
        conn.commit()
    return {"ok": True}


@router.post("/api/palettes/{palette_id}/unarchive")
def api_palette_unarchive(palette_id: int):
    with get_conn() as conn:
        cur = conn.execute("UPDATE palettes SET is_archived = 0 WHERE id = ?", (palette_id,))
        if getattr(cur, "rowcount", 0) == 0:
            raise HTTPException(status_code=404, detail="Палітру не знайдено")
        conn.commit()
    return {"ok": True}


@router.post("/api/palettes/{palette_id}/delete")
def api_palette_delete(palette_id: int):
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM palette_points_rtree WHERE id IN "
            "(SELECT id FROM palette_points WHERE palette_id = ?)",
            (palette_id,),
        )
        cur = conn.execute("DELETE FROM palettes WHERE id = ?", (palette_id,))
        if getattr(cur, "rowcount", 0) == 0:
            raise HTTPException(status_code=404, detail="Палітру не знайдено")
        conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Search
# --------------------------------------------------------------------------- #


def _mask_to_regex(mask_folded: str) -> re.Pattern:
    """Build a full-match regex from a folded mask (* → .*, % → .)."""
    out = []
    for ch in mask_folded:
        if ch == "*":
            out.append(".*")
        elif ch == "%":
            out.append(".")
        else:
            out.append(re.escape(ch))
    return re.compile("^" + "".join(out) + "$")


@router.get("/api/palettes/search")
def api_palette_search(
    q: str = Query(default="", max_length=100),
    case_sensitive: int = Query(default=0),
    include_archived: int = Query(default=0),
    unit_id: int | None = Query(default=None),
    limit: int = Query(default=300, ge=1, le=2000),
):
    """Search palette points by code (fold + masks).

    Масовий пошук іде по code_fold (розкладко-/регістронезалежний). Якщо
    case_sensitive=1 — додатковий пост-фільтр по сирому коду з урахуванням
    регістру. Архівні палітри включаються лише при include_archived=1
    (розширений пошук).
    """
    query = (q or "").strip()
    if not query:
        return {"ok": True, "results": []}

    where = []
    params: list[Any] = []
    if not include_archived:
        where.append("pal.is_archived = 0")
    if unit_id:
        where.append("EXISTS (SELECT 1 FROM palette_unit_links l WHERE l.palette_id = pal.id AND l.unit_id = ?)")
        params.append(int(unit_id))

    if is_mask(query):
        glob = mask_to_glob(query)
        where.append("pp.code_fold GLOB ?")
        params.append(glob)
        case_re = _mask_to_regex(glob) if case_sensitive else None
    else:
        # Без маски — точний збіг (а не «містить»). Підстановки лише через */%.
        fold = fold_code(query)
        where.append("pp.code_fold = ?")
        params.append(fold)
        case_re = None

    where_sql = " AND ".join(where) if where else "1=1"

    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT pp.id, pp.code, pp.code_fold, pp.color, pp.lat, pp.lon,
                   pp.palette_id, pal.name AS palette_name,
                   reg.label AS region_label
            FROM palette_points pp
            JOIN palettes pal ON pal.id = pp.palette_id
            LEFT JOIN palette_regions reg ON reg.id = pp.region_id
            WHERE {where_sql}
            ORDER BY pal.name, pp.code_fold
            LIMIT ?
            """,
            [*params, int(limit)],
        ).fetchall()

    # Case-sensitive post-filter against the raw code.
    def _keep(r) -> bool:
        if not case_sensitive:
            return True
        raw = str(r["code"] or "")
        if case_re is not None:
            return bool(case_re.match(fold_code(raw))) and (query in raw)
        # Substring case-sensitive match on raw code.
        return query in raw

    grouped: dict[int, dict] = {}
    for r in rows:
        if not _keep(r):
            continue
        pid = int(r["palette_id"])
        g = grouped.setdefault(pid, {
            "palette_id": pid,
            "palette_name": str(r["palette_name"]),
            "points": [],
        })
        g["points"].append({
            "id": int(r["id"]),
            "code": str(r["code"] or ""),
            "color": str(r["color"] or ""),
            "lat": r["lat"], "lon": r["lon"],
            "region_label": str(r["region_label"] or "") if r["region_label"] else None,
        })

    return {"ok": True, "results": list(grouped.values())}


# --------------------------------------------------------------------------- #
#  Regions (for map rendering)
# --------------------------------------------------------------------------- #


@router.get("/api/palettes/{palette_id}/regions")
def api_palette_regions(palette_id: int):
    with get_conn() as conn:
        pal = conn.execute(
            "SELECT id, name, min_lat, min_lon, max_lat, max_lon FROM palettes WHERE id = ?",
            (palette_id,),
        ).fetchone()
        if not pal:
            raise HTTPException(status_code=404, detail="Палітру не знайдено")
        rows = conn.execute(
            """
            SELECT id, color, hull_wkt, code_prefix, num_min, num_max, label,
                   center_lat, center_lon, point_count
            FROM palette_regions WHERE palette_id = ?
            ORDER BY color
            """,
            (palette_id,),
        ).fetchall()

    return {
        "ok": True,
        "palette": {
            "id": int(pal["id"]), "name": str(pal["name"]),
            "bbox": [pal["min_lat"], pal["min_lon"], pal["max_lat"], pal["max_lon"]],
        },
        "regions": [
            {
                "id": int(r["id"]),
                "color": str(r["color"] or ""),
                "hull_wkt": str(r["hull_wkt"] or ""),
                "label": str(r["label"] or ""),
                "center": [r["center_lat"], r["center_lon"]],
                "point_count": int(r["point_count"] or 0),
            }
            for r in rows
        ],
    }


@router.post("/api/palettes/{palette_id}/colors")
async def api_palette_set_colors(palette_id: int, payload: dict = Body(...)):
    """Batch-зміна кольорів регіонів палітри.

    Body: {"colors": [{"region_id": N, "color": "#rrggbb"}, ...]}

    Оновлюємо `palette_regions.color` АБО `palette_points.color` для всіх точок
    цього регіону. Невалідні / непомінувані кольори ігноруються (тиха відмова
    краща за частковий апдейт із помилкою).
    """
    from app.services.palette_import_service import _normalize_color

    items = (payload or {}).get("colors") or []
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="Порожній перелік кольорів")

    # Парсимо вхід: лише валідні пари {region_id, color}.
    updates: list[tuple[int, str]] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        try:
            rid = int(raw.get("region_id"))
        except (TypeError, ValueError):
            continue
        color = _normalize_color(raw.get("color"))
        if not color:
            continue
        updates.append((rid, color))

    if not updates:
        raise HTTPException(status_code=400, detail="Жоден елемент не валідний")

    with get_conn() as conn:
        # Перевіряємо, що палітра існує (і не помилково отримуємо чужі регіони).
        pal = conn.execute("SELECT id FROM palettes WHERE id = ?", (palette_id,)).fetchone()
        if not pal:
            raise HTTPException(status_code=404, detail="Палітру не знайдено")

        # Беремо тільки ті регіони, що належать цій палітрі — захист від tampering.
        rids = [u[0] for u in updates]
        placeholders = ",".join("?" * len(rids))
        valid = {
            int(r[0]) for r in conn.execute(
                f"SELECT id FROM palette_regions WHERE palette_id = ? AND id IN ({placeholders})",
                (palette_id, *rids),
            ).fetchall()
        }
        updates = [(rid, color) for rid, color in updates if rid in valid]
        if not updates:
            raise HTTPException(status_code=404, detail="Жодного регіону не знайдено в цій палітрі")

        # Транзакція: оновити обидві таблиці послідовно. SQLite-конект з get_conn
        # підтримує одне з'єднання, тож все в одному WAL-кадрі.
        for rid, color in updates:
            conn.execute(
                "UPDATE palette_regions SET color = ? WHERE id = ? AND palette_id = ?",
                (color, rid, palette_id),
            )
            conn.execute(
                "UPDATE palette_points SET color = ? WHERE region_id = ? AND palette_id = ?",
                (color, rid, palette_id),
            )
        conn.commit()

    return {"ok": True, "updated": len(updates)}
