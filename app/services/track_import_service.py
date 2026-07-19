"""Імпорт GPS-треків (AlpineQuest LDK/TRK, GPX, KML/KMZ).

Модель дзеркальна до палітр (`palette_import_service`): розбір файлу →
`ParsedTrack` → автоочищення викидів → збереження в `tracks` / `track_points`.

Розбір AlpineQuest покладається на штатний `app.core.apq_parser` — той самий,
що вже використовується для палітр.

Навіщо автоочищення: у трофейних LDK трапляються сторонні точки з зовсім іншого
району (демо-траси застосунку, залишки попередніх записів). Один такий викид
розтягує bbox на тисячі кілометрів і робить трек непридатним для карти. Фільтр
робастний — за відстанню від МЕДІАННОГО центру (медіана стійка до викидів).
"""

from __future__ import annotations

import math
import statistics
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from io import BytesIO
from typing import Any

from app.core.apq_parser import ApqFile, extract_geometries
from app.core.logging import get_logger

log = get_logger("track_import_service")

# Точку вважаємо викидом, якщо вона далі за цей поріг від медіанного центру.
OUTLIER_KM = 25.0
SUPPORTED_EXT = (".ldk", ".trk", ".gpx", ".kml", ".kmz")


@dataclass
class ParsedTrack:
    name: str
    points: list[dict] = field(default_factory=list)   # {lat, lon, alt, ts}
    source_format: str = ""
    source_filename: str = ""
    color: str = "#ff8000"
    recorded_at: str | None = None
    removed_count: int = 0


# ─── геометрія ────────────────────────────────────────────────────────────────

def haversine_km(a: dict, b: dict) -> float:
    """Відстань між двома точками {lat, lon} у кілометрах."""
    R = 6371.0
    dlat = math.radians(b["lat"] - a["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a["lat"])) * math.cos(math.radians(b["lat"]))
         * math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def track_length_km(points: list[dict]) -> float:
    return sum(haversine_km(points[i], points[i + 1]) for i in range(len(points) - 1))


def bbox_of(points: list[dict]) -> tuple[float, float, float, float]:
    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]
    return min(lats), min(lons), max(lats), max(lons)


def remove_outliers(points: list[dict], threshold_km: float = OUTLIER_KM) -> tuple[list[dict], int]:
    """Прибрати точки, що лежать далеко від решти треку.

    Центр рахуємо як МЕДІАНУ широт/довгот — вона не зсувається навіть коли
    викидів багато (у трофейному прикладі їх було 412 із 3873).

    Returns:
        (очищені точки, кількість видалених)
    """
    if len(points) < 3:
        return points, 0
    center = {
        "lat": statistics.median(p["lat"] for p in points),
        "lon": statistics.median(p["lon"] for p in points),
    }
    kept = [p for p in points if haversine_km(center, p) <= threshold_km]
    removed = len(points) - len(kept)
    if removed:
        log.info("Track import: removed %d outlier point(s) further than %.0f km from median center",
                 removed, threshold_km)
    return (kept, removed) if kept else (points, 0)


# ─── парсери ──────────────────────────────────────────────────────────────────

def _strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def normalize_color(value: Any, default: str = "#ff8000") -> str:
    """Звести колір до `#rrggbb`.

    AlpineQuest віддає 8-значний `#aarrggbb` (напр. `#ff008000`) — альфу
    відкидаємо, інакше CSS/Leaflet трактують такий рядок як невалідний.
    """
    s = str(value or "").strip()
    if not s:
        return default
    if not s.startswith("#"):
        s = "#" + s
    hexv = s[1:]
    if len(hexv) == 8:          # aarrggbb → rrggbb
        hexv = hexv[2:]
    elif len(hexv) == 3:        # rgb → rrggbb
        hexv = "".join(c * 2 for c in hexv)
    if len(hexv) != 6 or any(c not in "0123456789abcdefABCDEF" for c in hexv):
        return default
    return "#" + hexv.lower()


def parse_apq_bytes(data: bytes, *, source_filename: str) -> list[ParsedTrack]:
    """AlpineQuest .ldk / .trk → треки (кожна Line-геометрія = окремий трек)."""
    apq = ApqFile(data=data, rawname=source_filename)
    out: list[ParsedTrack] = []
    for g in extract_geometries(apq):
        if g.get("type") != "Line":
            continue
        pts = [{"lat": c[1], "lon": c[0], "alt": None, "ts": None}
               for c in (g.get("coordinates") or [])
               if isinstance(c, (list, tuple)) and len(c) >= 2]
        if len(pts) < 2:
            continue
        out.append(ParsedTrack(
            name=(g.get("name") or "").strip() or source_filename.rsplit(".", 1)[0],
            points=pts,
            source_format="apq",
            source_filename=source_filename,
            color=normalize_color(g.get("outlineColor")),
            recorded_at=g.get("observationDatetime"),
        ))
    return out


def parse_gpx_bytes(data: bytes, *, source_filename: str) -> list[ParsedTrack]:
    root = ET.fromstring(data)
    out: list[ParsedTrack] = []
    for trk in root.iter():
        if _strip_ns(trk.tag) != "trk":
            continue
        name = ""
        pts: list[dict] = []
        for el in trk.iter():
            t = _strip_ns(el.tag)
            if t == "name" and not name:
                name = (el.text or "").strip()
            elif t == "trkpt":
                try:
                    lat = float(el.get("lat")); lon = float(el.get("lon"))
                except (TypeError, ValueError):
                    continue
                alt = ts = None
                for ch in el:
                    ct = _strip_ns(ch.tag)
                    if ct == "ele":
                        try: alt = float(ch.text)
                        except (TypeError, ValueError): pass
                    elif ct == "time":
                        ts = (ch.text or "").strip() or None
                pts.append({"lat": lat, "lon": lon, "alt": alt, "ts": ts})
        if len(pts) >= 2:
            out.append(ParsedTrack(
                name=name or source_filename.rsplit(".", 1)[0],
                points=pts, source_format="gpx", source_filename=source_filename,
                recorded_at=pts[0].get("ts"),
            ))
    return out


def parse_kml_bytes(data: bytes, *, source_filename: str) -> list[ParsedTrack]:
    root = ET.fromstring(data)
    out: list[ParsedTrack] = []
    for pm in root.iter():
        if _strip_ns(pm.tag) != "Placemark":
            continue
        name = ""
        for ch in pm:
            if _strip_ns(ch.tag) == "name":
                name = (ch.text or "").strip()
                break
        for el in pm.iter():
            if _strip_ns(el.tag) != "LineString":
                continue
            for c in el:
                if _strip_ns(c.tag) != "coordinates":
                    continue
                pts: list[dict] = []
                for tok in (c.text or "").split():
                    parts = tok.split(",")
                    if len(parts) < 2:
                        continue
                    try:
                        lon = float(parts[0]); lat = float(parts[1])
                        alt = float(parts[2]) if len(parts) > 2 else None
                    except ValueError:
                        continue
                    pts.append({"lat": lat, "lon": lon, "alt": alt, "ts": None})
                if len(pts) >= 2:
                    out.append(ParsedTrack(
                        name=name or source_filename.rsplit(".", 1)[0],
                        points=pts, source_format="kml", source_filename=source_filename,
                    ))
    return out


def parse_track_file(data: bytes, filename: str) -> list[ParsedTrack]:
    """Розібрати файл треку за розширенням; повертає список треків (уже очищених)."""
    low = (filename or "").lower()
    if low.endswith(".kmz"):
        with zipfile.ZipFile(BytesIO(data)) as z:
            inner = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not inner:
                raise ValueError("У KMZ немає .kml")
            tracks = parse_kml_bytes(z.read(inner), source_filename=filename)
    elif low.endswith(".kml"):
        tracks = parse_kml_bytes(data, source_filename=filename)
    elif low.endswith(".gpx"):
        tracks = parse_gpx_bytes(data, source_filename=filename)
    elif low.endswith((".ldk", ".trk")):
        tracks = parse_apq_bytes(data, source_filename=filename)
    else:
        raise ValueError(f"Непідтримуваний формат. Дозволені: {', '.join(SUPPORTED_EXT)}")

    if not tracks:
        raise ValueError("У файлі не знайдено жодного треку (лінії з ≥2 точок)")

    for t in tracks:                       # автоочищення викидів
        t.points, t.removed_count = remove_outliers(t.points)
    return tracks


# ─── збереження ───────────────────────────────────────────────────────────────

def persist_track(conn, t: ParsedTrack, *, unit_ids: list[int] | None = None) -> int:
    """Записати трек у БД. Повертає id."""
    now = datetime.now().isoformat(timespec="seconds")
    seq = (conn.execute("SELECT COALESCE(MAX(seq_no), 0) + 1 FROM tracks").fetchone()[0]) or 1
    min_lat, min_lon, max_lat, max_lon = bbox_of(t.points)
    conn.execute(
        """INSERT INTO tracks(seq_no,name,color,source_format,source_filename,comment,
                              imported_at,point_count,removed_count,length_km,recorded_at,
                              min_lat,min_lon,max_lat,max_lon)
           VALUES(?,?,?,?,?,'',?,?,?,?,?,?,?,?,?)""",
        (seq, t.name, t.color, t.source_format, t.source_filename, now,
         len(t.points), t.removed_count, round(track_length_km(t.points), 3),
         t.recorded_at, min_lat, min_lon, max_lat, max_lon),
    )
    tid = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    conn.executemany(
        "INSERT INTO track_points(track_id,seq,lat,lon,alt,ts) VALUES(?,?,?,?,?,?)",
        [(tid, i, p["lat"], p["lon"], p.get("alt"), p.get("ts")) for i, p in enumerate(t.points)],
    )
    for uid in (unit_ids or []):
        conn.execute("INSERT OR IGNORE INTO track_unit_links(track_id,unit_id) VALUES(?,?)",
                     (tid, int(uid)))
    return tid


def track_to_kml(name: str, color: str, points: list[dict], *, description: str = "") -> str:
    """Сформувати KML-документ треку (для експорту в KMZ)."""
    def esc(s: str) -> str:
        return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))
    # KML колір = aabbggrr (зворотний порядок відносно #rrggbb)
    hexv = (color or "#ff8000").lstrip("#")
    kml_color = f"ff{hexv[4:6]}{hexv[2:4]}{hexv[0:2]}".lower() if len(hexv) >= 6 else "ff0080ff"
    coords = "\n".join(f"          {p['lon']:.7f},{p['lat']:.7f},{p.get('alt') or 0:.1f}"
                       for p in points)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>{esc(name)}</name>
  <description>{esc(description)}</description>
  <Style id="t"><LineStyle><color>{kml_color}</color><width>3</width></LineStyle></Style>
  <Placemark><name>{esc(name)}</name><styleUrl>#t</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>
{coords}
    </coordinates></LineString>
  </Placemark>
</Document></kml>"""


def track_to_kmz(name: str, color: str, points: list[dict], *, description: str = "") -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", track_to_kml(name, color, points, description=description))
    return buf.getvalue()
