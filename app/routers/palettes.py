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

import html
import io
import json
import re
import zipfile
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import JSONResponse, Response

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


def _rows_to_mgrs_groups(rows) -> list:
    """[{mgrs_json}] → [[mgrs, ...], ...] — one list per conclusion (drops empties)."""
    out = []
    for r in rows:
        try:
            pts = [str(m).strip() for m in json.loads(r["mgrs_json"] or "[]") if str(m).strip()]
        except Exception:
            pts = []
        if pts:
            out.append(pts)
    return out


def _network_conclusion_groups(conn, network_id: int, days: int) -> list:
    """Per-conclusion MGRS point groups for a network over the last `days` days.

    Returns [[mgrs, ...], ...] — one list per analytical conclusion. The client
    converts these to lat/lon and tests them against each palette's region hulls
    to compute the per-palette conclusion count (server has no MGRS converter).
    """
    if not network_id:
        return []
    start = (datetime.now() - timedelta(days=int(days or 10))).strftime("%Y-%m-%d %H:%M:%S")
    rows = conn.execute(
        "SELECT mgrs_json FROM analytical_conclusions "
        "WHERE network_id = ? AND REPLACE(created_at,'T',' ') >= ?",
        (int(network_id), start),
    ).fetchall()
    return _rows_to_mgrs_groups(rows)


def _other_conclusion_groups(conn, network_id: int, days: int) -> list:
    """MGRS point groups for conclusions on OTHER networks (last `days` days).

    Used by the client to flag palettes that already hold conclusions on a
    different frequency/unit (tier 2) versus palettes with no conclusions at
    all (tier 3). When `network_id` is 0 we have no "current" frequency, so we
    return every conclusion's group (the client then has only this one bucket).
    """
    start = (datetime.now() - timedelta(days=int(days or 10))).strftime("%Y-%m-%d %H:%M:%S")
    if network_id:
        rows = conn.execute(
            "SELECT mgrs_json FROM analytical_conclusions "
            "WHERE network_id IS NOT NULL AND network_id <> ? "
            "AND REPLACE(created_at,'T',' ') >= ?",
            (int(network_id), start),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT mgrs_json FROM analytical_conclusions "
            "WHERE network_id IS NOT NULL AND REPLACE(created_at,'T',' ') >= ?",
            (start,),
        ).fetchall()
    return _rows_to_mgrs_groups(rows)


def _unit_tokens(s: str) -> list:
    """Lowercased whitespace-split tokens of a unit string (Cyrillic-safe)."""
    return [t for t in re.split(r"\s+", (s or "").strip().lower()) if t]


def _is_contiguous_subseq(haystack: list, needle: list) -> bool:
    """True if `needle` tokens appear as a contiguous run inside `haystack`."""
    n, m = len(haystack), len(needle)
    if not m or m > n:
        return False
    for i in range(n - m + 1):
        if haystack[i:i + m] == needle:
            return True
    return False


@router.get("/api/palettes/for-unit")
def api_palettes_for_unit(unit: str = "", network_id: int = 0, days: int = 90):
    """Palettes relevant to a unit, ordered narrowest → broadest, each with the
    number of conclusions made USING it (explicit point selection, recorded in
    conclusion_palette_points) over the last `days` days — split into:
      `cnt_freq`  — conclusions on THIS network (frequency);
      `cnt_other` — conclusions on OTHER networks.
    These drive the 3 tiers in the editor panel (this freq / other freq / none).

    A palette unit-tag is relevant when its tokens appear as a contiguous run
    ANYWHERE inside the intercept's unit (token-boundary containment, not just a
    suffix). E.g. unit "1 мсб 164 омсбр 25 ЗА" matches a palette tagged
    "164 омсбр"; longer tags are narrower and ranked first within a tier.
    """
    unit = (unit or "").strip()
    try:
        days = max(1, min(int(days or 90), 3650))
    except (TypeError, ValueError):
        days = 90
    start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    nid = int(network_id or 0)
    with get_conn() as conn:
        if not unit:
            return {"ok": True, "palettes": []}

        unit_tokens = _unit_tokens(unit)
        spec = {}  # unit_id -> (name, specificity_len)
        for u in conn.execute("SELECT id, name FROM palette_units").fetchall():
            nm = (u["name"] or "").strip()
            if nm and _is_contiguous_subseq(unit_tokens, _unit_tokens(nm)):
                spec[int(u["id"])] = (nm, len(nm))
        if not spec:
            return {"ok": True, "palettes": []}

        unit_ids = list(spec.keys())
        ph = ",".join("?" * len(unit_ids))
        prows = conn.execute(
            f"""SELECT p.id, p.name, l.unit_id
                FROM palettes p JOIN palette_unit_links l ON l.palette_id = p.id
                WHERE p.is_archived = 0 AND l.unit_id IN ({ph})""",
            unit_ids,
        ).fetchall()

        best = {}  # palette_id -> info (narrowest matched unit wins)
        for r in prows:
            pid = int(r["id"]); uid = int(r["unit_id"]); s = spec[uid][1]
            if pid not in best or s > best[pid]["spec"]:
                best[pid] = {"id": pid, "name": r["name"] or "", "unit": spec[uid][0], "spec": s}

        palettes = []
        for pid, info in best.items():
            cnt = conn.execute(
                "SELECT "
                "  COUNT(DISTINCT CASE WHEN ac.network_id = ?  THEN cpp.conclusion_id END) AS cnt_freq, "
                "  COUNT(DISTINCT CASE WHEN ac.network_id <> ? THEN cpp.conclusion_id END) AS cnt_other "
                "FROM conclusion_palette_points cpp "
                "JOIN analytical_conclusions ac ON ac.id = cpp.conclusion_id "
                "WHERE cpp.palette_id = ? AND REPLACE(ac.created_at,'T',' ') >= ?",
                (nid, nid, pid, start),
            ).fetchone()
            info["cnt_freq"]  = int(cnt["cnt_freq"]) if cnt and cnt["cnt_freq"] is not None else 0
            info["cnt_other"] = int(cnt["cnt_other"]) if cnt and cnt["cnt_other"] is not None else 0
            palettes.append(info)
        palettes.sort(key=lambda x: (-x["spec"], x["name"]))

    return {"ok": True, "palettes": palettes}


def _hex_to_kml_color(hexc: str) -> str:
    """#rrggbb → KML aabbggrr (opaque). Inverse of import's _kml_color_to_hex."""
    h = (hexc or "").strip().lstrip("#").lower()
    if len(h) != 6 or any(ch not in "0123456789abcdef" for ch in h):
        return "ffffffff"
    rr, gg, bb = h[0:2], h[2:4], h[4:6]
    return "ff" + bb + gg + rr


def _build_palette_kml(name: str, points) -> str:
    """KML matching the import format: one Placemark per point with the code as
    <name>, the stored colour as inline IconStyle, and lon,lat coordinates."""
    esc = html.escape
    out = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        '    <Document>',
        f'        <name>{esc(str(name or ""))}</name>',
        '        <visibility>1</visibility>',
    ]
    for p in points:
        code = esc(str(p["code"] or ""))
        kcol = _hex_to_kml_color(p["color"])
        lat = p["lat"]; lon = p["lon"]
        out.append('        <Placemark>')
        out.append(f'            <name>{code}</name>')
        out.append('            <description>Точка</description>')
        out.append('            <Style><IconStyle>'
                   f'<color>{kcol}</color><scale>1.0</scale></IconStyle></Style>')
        out.append(f'            <Point><coordinates>{lon},{lat}</coordinates></Point>')
        out.append('        </Placemark>')
    out.append('    </Document>')
    out.append('</kml>')
    return "\n".join(out)


@router.get("/api/palettes/{palette_id}/export")
def api_palette_export(palette_id: int):
    """Export a palette as a .kmz (zip with doc.kml) — re-importable here and
    viewable in Google Earth. Colours/codes/coordinates round-trip via import."""
    with get_conn() as conn:
        prow = conn.execute(
            "SELECT id, name FROM palettes WHERE id = ?", (palette_id,)
        ).fetchone()
        if not prow:
            raise HTTPException(status_code=404, detail="palette not found")
        name = (prow["name"] or f"palette_{palette_id}").strip()
        pts = conn.execute(
            "SELECT code, color, lat, lon FROM palette_points "
            "WHERE palette_id = ? AND lat IS NOT NULL AND lon IS NOT NULL "
            "ORDER BY id",
            (palette_id,),
        ).fetchall()

    kml = _build_palette_kml(name, pts)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", kml.encode("utf-8"))
    data = buf.getvalue()

    # ASCII-safe fallback filename + RFC 5987 UTF-8 name for Cyrillic.
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or f"palette_{palette_id}"
    fname = name + ".kmz"
    disposition = (
        f'attachment; filename="{ascii_name}.kmz"; '
        f"filename*=UTF-8''{quote(fname)}"
    )
    return Response(
        content=data,
        media_type="application/vnd.google-earth.kmz",
        headers={"Content-Disposition": disposition},
    )


@router.get("/api/palettes/efficiency")
def api_palettes_efficiency(days: int = 90):
    """Palette efficiency: for each non-archived palette, how many conclusions
    over the last `days` were made USING that palette — i.e. the operator
    searched a code, picked one of the palette's points, and saved the
    conclusion. Counted from conclusion_palette_points (recorded at save time).

    Returns per palette: `conclusions` (distinct conclusions that used a point
    of this palette) and `points` (total effective point selections).
    """
    try:
        days = max(1, min(int(days or 90), 3650))
    except (TypeError, ValueError):
        days = 90
    start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        prows = conn.execute(
            "SELECT id, name FROM palettes WHERE is_archived = 0 ORDER BY name"
        ).fetchall()
        palettes = []
        for p in prows:
            pid = int(p["id"])
            cnt = conn.execute(
                "SELECT COUNT(DISTINCT cpp.conclusion_id) AS c, COUNT(*) AS pts "
                "FROM conclusion_palette_points cpp "
                "JOIN analytical_conclusions ac ON ac.id = cpp.conclusion_id "
                "WHERE cpp.palette_id = ? AND REPLACE(ac.created_at,'T',' ') >= ?",
                (pid, start),
            ).fetchone()
            units = conn.execute(
                "SELECT u.name FROM palette_unit_links l "
                "JOIN palette_units u ON u.id = l.unit_id "
                "WHERE l.palette_id = ? ORDER BY u.name",
                (pid,),
            ).fetchall()
            palettes.append({
                "id": pid,
                "name": p["name"] or "",
                "units": [str(u["name"]) for u in units],
                "conclusions": int(cnt["c"]) if cnt and cnt["c"] is not None else 0,
                "points": int(cnt["pts"]) if cnt and cnt["pts"] is not None else 0,
            })
    return {"ok": True, "days": days, "palettes": palettes}


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


@router.post("/api/palettes/{palette_id}/units")
async def api_palette_set_units(palette_id: int, payload: dict = Body(...)):
    """Replace the unit tags (підрозділи) linked to a palette.

    Body: {"unit_ids": [int, ...]}. Existing links are replaced wholesale.
    Invalid / unknown unit ids are ignored. An empty list clears all tags.
    """
    raw = (payload or {}).get("unit_ids") or []
    unit_ids: list[int] = []
    for x in raw:
        try:
            unit_ids.append(int(x))
        except (TypeError, ValueError):
            continue

    with get_conn() as conn:
        if not conn.execute("SELECT id FROM palettes WHERE id = ?", (palette_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Палітру не знайдено")

        if unit_ids:
            ph = ",".join("?" * len(unit_ids))
            valid = {
                int(r[0]) for r in conn.execute(
                    f"SELECT id FROM palette_units WHERE id IN ({ph})", unit_ids
                ).fetchall()
            }
            # preserve order, drop unknowns
            unit_ids = [u for u in dict.fromkeys(unit_ids) if u in valid]

        conn.execute("DELETE FROM palette_unit_links WHERE palette_id = ?", (palette_id,))
        for uid in unit_ids:
            conn.execute(
                "INSERT OR IGNORE INTO palette_unit_links (palette_id, unit_id) VALUES (?, ?)",
                (palette_id, uid),
            )
        conn.commit()

    return {"ok": True, "unit_ids": unit_ids}
