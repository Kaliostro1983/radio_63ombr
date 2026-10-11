"""Import service for palettes (наборів кодованих точок).

Pipeline:
    bytes (KML/KMZ/GeoJSON) → parse placemarks → ParsedPoint[]
                            → group by colour   → alpha-shape regions
                            → dedup analysis vs existing palettes
                            → persist (palettes / palette_regions / palette_points
                               / palette_points_rtree)

The parser is dependency-free (xml.etree + zipfile + json).
"""

from __future__ import annotations

import csv
import io
import json
import math
import random
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from xml.etree import ElementTree as ET

from app.core.apq_parser import DEFAULT_COLOR as APQ_DEFAULT_COLOR
from app.core.palette_fold import fold_code, display_code

# --------------------------------------------------------------------------- #
#  Parsing
# --------------------------------------------------------------------------- #


@dataclass
class ParsedPoint:
    code: str
    color: str           # "#rrggbb" (lowercase) or "" if unknown
    lat: float
    lon: float


@dataclass
class ParsedPalette:
    name: str
    source_format: str
    source_filename: str
    points: list[ParsedPoint] = field(default_factory=list)


def _strip_ns(tag: str) -> str:
    """Return local tag name without the XML namespace prefix."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _kml_color_to_hex(kml_color: str) -> str:
    """Convert a KML ``aabbggrr`` colour to a web ``#rrggbb`` string.

    Returns "" if the value is not a valid 8-hex-digit colour.
    """
    c = (kml_color or "").strip().lower()
    if len(c) != 8 or any(ch not in "0123456789abcdef" for ch in c):
        return ""
    bb, gg, rr = c[2:4], c[4:6], c[6:8]
    return f"#{rr}{gg}{bb}"


def _extract_kml_from_kmz(data: bytes) -> bytes:
    """Return the main KML document bytes from a KMZ (zip) archive."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        # Prefer doc.kml, else the first *.kml.
        target = next((n for n in names if n.lower().endswith("doc.kml")), None)
        if target is None:
            target = next((n for n in names if n.lower().endswith(".kml")), None)
        if target is None:
            raise ValueError("KMZ не містить .kml файлу")
        return zf.read(target)


def _build_style_color_map(root: ET.Element) -> dict[str, str]:
    """Map ``#styleId`` → "#rrggbb" using <Style> and <StyleMap> definitions."""
    colors: dict[str, str] = {}
    raw_style: dict[str, str] = {}      # styleId → hex
    style_maps: dict[str, str] = {}     # styleMapId → referenced styleId (normal)

    for el in root.iter():
        tag = _strip_ns(el.tag)
        if tag == "Style":
            sid = el.get("id")
            if not sid:
                continue
            # Colour usually lives in IconStyle/color; fall back to LineStyle.
            hexc = ""
            for sub in el.iter():
                if _strip_ns(sub.tag) == "color" and sub.text:
                    hexc = _kml_color_to_hex(sub.text)
                    if hexc:
                        break
            if hexc:
                raw_style[sid] = hexc
        elif tag == "StyleMap":
            sid = el.get("id")
            if not sid:
                continue
            key, url = None, None
            for pair in el.iter():
                pt = _strip_ns(pair.tag)
                if pt == "key" and pair.text:
                    key = pair.text.strip()
                elif pt == "styleUrl" and pair.text:
                    url = pair.text.strip().lstrip("#")
                if pt == "Pair":
                    key, url = None, None
            # Simplified: capture the last normal styleUrl.
            for pair in el.iter():
                if _strip_ns(pair.tag) == "Pair":
                    k = v = None
                    for c in pair.iter():
                        ct = _strip_ns(c.tag)
                        if ct == "key" and c.text:
                            k = c.text.strip()
                        elif ct == "styleUrl" and c.text:
                            v = c.text.strip().lstrip("#")
                    if k == "normal" and v:
                        style_maps[sid] = v

    for sid, hexc in raw_style.items():
        colors[sid] = hexc
    for sid, ref in style_maps.items():
        if ref in raw_style:
            colors[sid] = raw_style[ref]
    return colors


def parse_kml_bytes(data: bytes, *, source_format: str, source_filename: str) -> ParsedPalette:
    """Parse KML/KMZ bytes into a ParsedPalette of point placemarks."""
    if source_format == "kmz" or (data[:2] == b"PK"):
        data = _extract_kml_from_kmz(data)
        source_format = "kmz"

    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f"Не вдалося розібрати KML: {exc}") from exc

    style_colors = _build_style_color_map(root)

    # Document name → palette name fallback.
    doc_name = ""
    for el in root.iter():
        if _strip_ns(el.tag) == "Document":
            for c in el:
                if _strip_ns(c.tag) == "name" and c.text:
                    doc_name = c.text.strip()
                    break
            break

    points: list[ParsedPoint] = []
    for pm in root.iter():
        if _strip_ns(pm.tag) != "Placemark":
            continue
        name = ""
        coords_text = ""
        style_url = ""
        inline_color = ""
        for el in pm.iter():
            t = _strip_ns(el.tag)
            if t == "name" and el.text and not name:
                name = el.text.strip()
            elif t == "styleUrl" and el.text and not style_url:
                style_url = el.text.strip().lstrip("#")
            elif t == "coordinates" and el.text and not coords_text:
                coords_text = el.text.strip()
            elif t == "color" and el.text and not inline_color:
                inline_color = _kml_color_to_hex(el.text)
        if not coords_text:
            continue
        # Only the first coordinate triple (point placemarks).
        first = coords_text.split()[0]
        parts = first.split(",")
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
        except ValueError:
            continue
        # Точки без кольору (у AlpineQuest-експортах їх багато) отримують той
        # самий дефолт, що й LDK-шлях через apq_parser — інакше та сама палітра
        # з .ldk була б фіолетовою, а з .kml — безколірною (запасний оранжевий).
        color = inline_color or style_colors.get(style_url, "") or APQ_DEFAULT_COLOR
        points.append(ParsedPoint(code=name, color=color.lower(), lat=lat, lon=lon))

    # Дефолтна назва — зі імені файлу (без розширення), бо внутрішнє
    # <Document><name> у KML часто містить стару/чужу назву. Doc-name — резерв.
    file_stem = re.sub(r"\.[A-Za-z0-9]+$", "", (source_filename or "").strip())
    pal_name = file_stem or doc_name or "Палітра"
    return ParsedPalette(
        name=pal_name,
        source_format=source_format,
        source_filename=source_filename,
        points=points,
    )


def _normalize_color(value) -> str:
    """Accept "#rrggbb", "rrggbb", "#rgb", "rgb(...)" or [r,g,b] → "#rrggbb".

    Returns "" if the value cannot be interpreted as a colour.
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        try:
            r, g, b = (max(0, min(255, int(c))) for c in value[:3])
            return f"#{r:02x}{g:02x}{b:02x}"
        except (TypeError, ValueError):
            return ""
    s = str(value).strip().lower()
    if not s:
        return ""
    if s.startswith("rgb"):
        nums = re.findall(r"\d+", s)
        if len(nums) >= 3:
            try:
                r, g, b = (max(0, min(255, int(c))) for c in nums[:3])
                return f"#{r:02x}{g:02x}{b:02x}"
            except ValueError:
                return ""
        return ""
    # Голий «r,g,b» / «r,g,b,a» (CSV-експорт GOI: напр. "0,0,255,1.00").
    if "," in s:
        nums = re.findall(r"\d+", s)
        if len(nums) >= 3:
            try:
                r, g, b = (max(0, min(255, int(c))) for c in nums[:3])
                return f"#{r:02x}{g:02x}{b:02x}"
            except ValueError:
                return ""
        return ""
    if s.startswith("#"):
        s = s[1:]
    if len(s) == 3 and all(c in "0123456789abcdef" for c in s):
        return "#" + "".join(c * 2 for c in s)
    if len(s) == 6 and all(c in "0123456789abcdef" for c in s):
        return "#" + s
    if len(s) == 8 and all(c in "0123456789abcdef" for c in s):
        # AlpineQuest/GOI пишуть колір як #AARRGGBB — альфа ПОПЕРЕДУ.
        # Раніше тут бралися перші 6 символів (як для rrggbbaa), через що
        # #ff8b4513 (коричневий) ставав #ff8b45 (рожевий), #ffffa500
        # (помаранчевий) → #ffffa5 (блідо-жовтий) тощо: усі кольори з LDK
        # зсувались на байт і не збігалися з тим, що показує ГОІ.
        return "#" + s[2:]
    return ""


def parse_geojson_bytes(data: bytes, *, source_filename: str) -> ParsedPalette:
    """Parse a GeoJSON FeatureCollection (or single Feature/Geometry) into a
    ParsedPalette. Only Point / MultiPoint placemarks are kept (palette = points).

    Code is taken from properties (``code`` / ``name`` / ``title`` / ``id``).
    Colour is taken from properties (``color`` / ``stroke`` / ``fill`` /
    ``marker-color`` — the simplestyle-spec used by Mapbox/Github).
    """
    try:
        obj = json.loads(data.decode("utf-8-sig", errors="replace"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"Не вдалося розібрати GeoJSON: {exc}") from exc

    features: list[dict] = []
    if isinstance(obj, dict):
        t = obj.get("type")
        if t == "FeatureCollection":
            features = [f for f in obj.get("features", []) if isinstance(f, dict)]
        elif t == "Feature":
            features = [obj]
        elif t in ("Point", "MultiPoint"):
            features = [{"type": "Feature", "geometry": obj, "properties": {}}]

    points: list[ParsedPoint] = []
    for f in features:
        geom = f.get("geometry") or {}
        if not isinstance(geom, dict):
            continue
        props = f.get("properties") or {}
        if not isinstance(props, dict):
            props = {}
        code = ""
        for key in ("code", "name", "title", "Name", "id"):
            v = props.get(key)
            if v:
                code = str(v).strip()
                break
        # Різні джерела використовують різні ключі для кольору. Перелічуємо
        # від найточніших до найзагальніших; первинний знайдений виграє.
        color = ""
        for key in (
            # GOI пише саме "outline-color" (apq_parser у JSON — "outlineColor").
            # Без цих двох ключів усі точки GOI-експорту вважались безколірними.
            "outline-color", "outlineColor",
            "icon-color", "iconColor",          # GOI / mil-symbol exports
            "marker-color",                       # simplestyle-spec (Mapbox/GitHub)
            "color", "stroke", "fill",
            "Color", "Stroke", "Fill",
        ):
            color = _normalize_color(props.get(key))
            if color:
                break
        if not color:
            color = APQ_DEFAULT_COLOR     # єдиний дефолт з apq_parser (див. KML вище)

        gtype = geom.get("type")
        coords = geom.get("coordinates")
        coord_list: list[list[float]] = []
        if gtype == "Point" and isinstance(coords, list) and len(coords) >= 2:
            coord_list = [coords]
        elif gtype == "MultiPoint" and isinstance(coords, list):
            coord_list = [c for c in coords if isinstance(c, list) and len(c) >= 2]
        # Інші типи (LineString, Polygon тощо) — для палітри не релевантні.

        for c in coord_list:
            try:
                lon = float(c[0]); lat = float(c[1])
            except (TypeError, ValueError):
                continue
            points.append(ParsedPoint(code=code, color=color, lat=lat, lon=lon))

    file_stem = re.sub(r"\.[A-Za-z0-9]+$", "", (source_filename or "").strip())
    pal_name = file_stem or "Палітра"
    return ParsedPalette(
        name=pal_name,
        source_format="geojson",
        source_filename=source_filename,
        points=points,
    )


def parse_csv_bytes(data: bytes, *, source_filename: str) -> ParsedPalette:
    """Parse a CSV export (GOI/Kropyva) into a ParsedPalette.

    Очікувані колонки: ``name`` (код точки), ``coordinates`` (WKT
    ``POINT (lon lat)``), ``color`` (напр. "0,0,255,1.00" — r,g,b,a, або будь-який
    формат, який розуміє ``_normalize_color``). Рядки без коректного POINT
    пропускаються (палітра = точки).
    """
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    pt_re = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)", re.IGNORECASE)

    points: list[ParsedPoint] = []
    for row in reader:
        code = str(row.get("name") or "").strip()
        m = pt_re.search(str(row.get("coordinates") or ""))
        if not m:
            continue
        try:
            lon = float(m.group(1)); lat = float(m.group(2))
        except (TypeError, ValueError):
            continue
        color = _normalize_color(row.get("color"))
        points.append(ParsedPoint(code=code, color=color, lat=lat, lon=lon))

    file_stem = re.sub(r"\.[A-Za-z0-9]+$", "", (source_filename or "").strip())
    pal_name = file_stem or "Палітра"
    return ParsedPalette(
        name=pal_name,
        source_format="csv",
        source_filename=source_filename,
        points=points,
    )


def parse_ldk_bytes(data: bytes, *, source_filename: str) -> ParsedPalette:
    """Parse an AlpineQuest LDK (or .wpt/.set/.rte/.trk/.are) into a ParsedPalette.

    Тільки Point-геометрії (waypoints) потрапляють у палітру — Line/Polygon
    для палітр радіомереж не релевантні. Колір беремо з `outlineColor`,
    назву — з `name`. `MultiPoint` не виникає (парсер дає Point per waypoint).
    """
    from app.core.apq_parser import apq_to_features, ApqParserError

    try:
        features = apq_to_features(data, name=source_filename or "file.ldk")
    except ApqParserError as e:
        raise ValueError(f"Не вдалося розпарсити LDK: {e}") from e

    points: list[ParsedPoint] = []
    for feat in features:
        geom = (feat or {}).get("geometry") or {}
        if geom.get("type") != "Point":
            continue  # Line/Polygon пропускаємо
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon = float(coords[0]); lat = float(coords[1])
        except (TypeError, ValueError):
            continue
        props = (feat or {}).get("properties") or {}
        code = (props.get("name") or "").strip()
        if not code:
            continue  # пропускаємо беззразкові — без назви точки немає сенсу
        color = _normalize_color(props.get("outlineColor"))
        points.append(ParsedPoint(code=code, color=color, lat=lat, lon=lon))

    name = source_filename
    if name:
        name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        for ext in (".ldk", ".wpt", ".set", ".rte", ".trk", ".are"):
            if name.lower().endswith(ext):
                name = name[: -len(ext)]
                break
    return ParsedPalette(
        name=name or "LDK",
        source_format="ldk",
        source_filename=source_filename,
        points=points,
    )


# --------------------------------------------------------------------------- #
#  Regions (convex hull) + code parsing
# --------------------------------------------------------------------------- #

_LETTERS_RE = re.compile(r"^([^\W\d_]+)", re.UNICODE)
_TRAILNUM_RE = re.compile(r"(\d+)\s*$")


def parse_code_parts(code: str) -> tuple[str, int | None]:
    """Split a code into (leading-letters, trailing-number).

    "Т-3" → ("Т", 3) ; "ДД12" → ("ДД", 12) ; "уч" → ("уч", None) ; "15" → ("", 15).
    Letters are taken from the start, the number from the end (separators ignored).
    """
    s = (code or "").strip()
    if not s:
        return "", None
    ml = _LETTERS_RE.match(s)
    letters = ml.group(1) if ml else ""
    mn = _TRAILNUM_RE.search(s)
    num = int(mn.group(1)) if mn else None
    return letters, num


def convex_hull(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Andrew's monotone chain convex hull.

    Input/return as (lon, lat) pairs. For <3 unique points returns the unique
    points themselves (degenerate hull).
    """
    uniq = sorted(set(pts))
    if len(uniq) <= 2:
        return uniq

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in uniq:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(uniq):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


@dataclass
class RegionAgg:
    color: str
    points: list[ParsedPoint]
    hull_wkt: str
    code_prefix: str
    num_min: int | None
    num_max: int | None
    label: str
    center_lat: float
    center_lon: float


def concave_outline(pts: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Увігнуті межі набору точок (lon, lat) — альфа-форма, як у ГОІ.

    Опукла оболонка «роздувається» назовні: вона накриває порожні ділянки й
    неминуче перетинає сусідні області, коли їхні точки чергуються.

    Алгоритм повторює ГОІ (`turf.concave({maxEdge: 2.5})` з відкатом на
    `turf.convex`):
      1. тріангуляція Делоне по точках групи;
      2. викидаємо трикутники, у яких хоч одна сторона довша за MAX_EDGE_KM;
      3. зливаємо решту — межа союзу і є контуром зони.

    Вершинами контуру стають САМІ точки, тож лінії виходять рівні без
    згладжування, а віддалені викиди відпадають разом зі своїми трикутниками.

    Повертає СПИСОК кілець (кожне — без дублювання першої точки): група може
    складатися з кількох роз'єднаних скупчень. Якщо тріангуляція неможлива
    (менше 3 точок, усі на одній прямій) — повертає опуклу оболонку.
    """
    uniq = sorted(set(pts))
    if len(uniq) < 3:
        return [convex_hull(uniq)]

    rings = _alpha_shape_rings(uniq, MAX_EDGE_KM)
    return rings or [convex_hull(uniq)]


# Трикутник із стороною довшою за це (км) не належить зоні. Значення взяте з
# ГОІ: `concave(featureCollection, {maxEdge: 2.5})`.
MAX_EDGE_KM = 2.5


def _alpha_shape_rings(
    uniq: list[tuple[float, float]], max_edge_km: float
) -> list[list[tuple[float, float]]]:
    """Альфа-форма набору точок → кільця межі (проти годинникової)."""
    try:
        import numpy as np
        from scipy.spatial import Delaunay, QhullError
    except ImportError:
        return []

    # Градуси → кілометри, щоб MAX_EDGE_KM був у реальних одиницях: довгота
    # стискається косинусом широти, інакше поріг «поїде» з широтою.
    lat0 = sum(p[1] for p in uniq) / len(uniq)
    kx = 111.320 * math.cos(math.radians(lat0))
    ky = 110.574
    xy = np.array([(x * kx, y * ky) for x, y in uniq])
    try:
        tri = Delaunay(xy)
    except (QhullError, ValueError):
        return []

    # Внутрішні ребра трапляються двічі у протилежних напрямках і скорочуються;
    # те, що лишиться, — орієнтована межа союзу трикутників.
    edges: dict[tuple[int, int], int] = {}
    limit = max_edge_km * max_edge_km
    for a, b, c in tri.simplices:
        pa, pb, pc = xy[a], xy[b], xy[c]
        if (max(_d2(pa, pb), _d2(pb, pc), _d2(pc, pa))) > limit:
            continue
        # Орієнтуємо трикутник проти годинникової.
        if (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]) < 0:
            a, b, c = a, c, b
        for e in ((a, b), (b, c), (c, a)):
            rev = (e[1], e[0])
            if edges.get(rev):
                edges[rev] -= 1
                if not edges[rev]:
                    del edges[rev]
            else:
                edges[e] = edges.get(e, 0) + 1

    # Зшиваємо орієнтовані ребра в замкнені кільця.
    nxt: dict[int, list[int]] = {}
    for (i, j), n in edges.items():
        nxt.setdefault(i, []).extend([j] * n)
    out: list[list[tuple[float, float]]] = []
    while nxt:
        start = next(iter(nxt))
        ring, cur = [], start
        while cur in nxt:
            ring.append(cur)
            j = nxt[cur].pop()
            if not nxt[cur]:
                del nxt[cur]
            cur = j
            if cur == start:
                break
        if len(ring) >= 3:
            out.append([uniq[i] for i in ring])
    return out


def _d2(p, q) -> float:
    """Квадрат відстані між двома точками (км²)."""
    return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2


def build_regions(points: list[ParsedPoint]) -> list[RegionAgg]:
    """Group points by colour and build a convex-hull region for each group."""
    by_color: dict[str, list[ParsedPoint]] = {}
    for p in points:
        by_color.setdefault(p.color or "", []).append(p)

    regions: list[RegionAgg] = []
    for color, grp in by_color.items():
        letters: set[str] = set()
        nums: list[int] = []
        for p in grp:
            lt, nm = parse_code_parts(p.code)
            if lt:
                letters.add(lt.upper())
            if nm is not None:
                nums.append(nm)
        prefix = ",".join(sorted(letters))
        num_min = min(nums) if nums else None
        num_max = max(nums) if nums else None
        if num_min is not None and num_max is not None:
            rng = f"{num_min}" if num_min == num_max else f"{num_min}–{num_max}"
            label = f"{prefix} {rng}".strip()
        else:
            label = prefix

        outlines = [h for h in concave_outline([(p.lon, p.lat) for p in grp]) if len(h) >= 3]
        if len(outlines) == 1:
            ring = outlines[0] + [outlines[0][0]]
            hull_wkt = "POLYGON((" + ", ".join(f"{lon} {lat}" for lon, lat in ring) + "))"
        elif len(outlines) > 1:
            # Кілька роз'єднаних скупчень однакового кольору.
            parts = []
            for h in outlines:
                ring = h + [h[0]]
                parts.append("((" + ", ".join(f"{lon} {lat}" for lon, lat in ring) + "))")
            hull_wkt = "MULTIPOLYGON(" + ", ".join(parts) + ")"
        else:
            flat = concave_outline([(p.lon, p.lat) for p in grp])[0]
            if len(flat) == 2:
                hull_wkt = "LINESTRING(" + ", ".join(f"{lon} {lat}" for lon, lat in flat) + ")"
            elif len(flat) == 1:
                hull_wkt = f"POINT({flat[0][0]} {flat[0][1]})"
            else:
                hull_wkt = ""

        center_lat = sum(p.lat for p in grp) / len(grp)
        center_lon = sum(p.lon for p in grp) / len(grp)
        regions.append(RegionAgg(
            color=color, points=grp, hull_wkt=hull_wkt,
            code_prefix=prefix, num_min=num_min, num_max=num_max,
            label=label, center_lat=center_lat, center_lon=center_lon,
        ))
    return regions


def bbox_of(points: list[ParsedPoint]) -> tuple[float, float, float, float]:
    """Return (min_lat, min_lon, max_lat, max_lon)."""
    lats = [p.lat for p in points]
    lons = [p.lon for p in points]
    return (min(lats), min(lons), max(lats), max(lons))


# --------------------------------------------------------------------------- #
#  Dedup analysis
# --------------------------------------------------------------------------- #


def _bbox_overlap(a, b) -> bool:
    """True if two (min_lat, min_lon, max_lat, max_lon) boxes intersect."""
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


# --------------------------------------------------------------------------- #
#  Subunit hierarchy (for scoping the duplicate search by unit)
# --------------------------------------------------------------------------- #
# Якщо в назві палітри вказано підрозділ — звірку робимо лише з палітрами цього
# підрозділу ТА підрозділів вищого рівня. Полк/бригада 67-ї мсд → 67 мсд;
# 272 мсп → 47 тд. 164 омсбр і 67 мсд — самостійні (вище лише 25 А, палітр нема).
_UNIT_PARENTS: dict[str, set[str]] = {
    "36 мсп": {"67 мсд"},
    "37 мсп": {"67 мсд"},
    "31 мсп": {"67 мсд"},
    "19 тп":  {"67 мсд"},
    "189 орб": {"67 мсд"},
    "272 мсп": {"47 тд"},
}
# Токени підрозділів для розпізнавання в назві (довші/специфічніші — першими).
_UNIT_TOKENS: list[str] = [
    "164 омсбр", "189 орб", "272 мсп", "67 мсд", "47 тд",
    "36 мсп", "37 мсп", "31 мсп", "19 тп",
]
_COORD_PRECISION = 5   # ~1 м — точка вважається тією самою при збігу координат


def _norm_unit(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _units_in_name(name: str) -> set[str]:
    """Витягти токени підрозділів, згадані в назві палітри."""
    n = _norm_unit(name)
    return {tok for tok in _UNIT_TOKENS if tok in n}


def scope_units_for_name(name: str) -> set[str] | None:
    """Множина підрозділів для звірки: сам + вищий рівень. None → звірка по всіх
    (якщо підрозділ із назви не розпізнано)."""
    base = _units_in_name(name)
    if not base:
        return None
    scope = set(base)
    for u in base:
        scope |= _UNIT_PARENTS.get(u, set())
    return scope


def scope_label_for_name(name: str) -> str:
    scope = scope_units_for_name(name)
    return ", ".join(sorted(scope)) if scope else "усі підрозділи"


def _ckey(lat, lon) -> tuple[float, float]:
    return (round(float(lat), _COORD_PRECISION), round(float(lon), _COORD_PRECISION))


def analyze_duplicates(conn, parsed: ParsedPalette) -> list[dict]:
    """Знайти наявні палітри, що дублюють / розширюють / перетинають `parsed`.

    Алгоритм:
      1. Скоуп за підрозділом: якщо в назві є підрозділ — звіряємо лише з
         палітрами цього підрозділу + вищого рівня (теги palette_unit_links,
         fallback — назва). Інакше — з усіма.
      2. Для кожного СПІЛЬНОГО кольору: беремо 3 випадкові точки нової палітри
         цього кольору; якщо всі 3 збігаються координатами з наявною — звіряємо
         ВСІ точки кольору (перетин / чи нова ⊇ старої = розширення).
      3. У звіт — усі збіги (по кольорах: matched/new/existing + прапорець ⊇).

    Returns: список dict'ів {palette_id, name, kind, color_jaccard,
    new_is_superset, existing_point_count, matched_points, scope, colors[]}.
    kind ∈ {exact, superset, similar}.
    """
    if not parsed.points:
        return []

    scope = scope_units_for_name(parsed.name)
    scope_lbl = ", ".join(sorted(scope)) if scope else "усі"
    new_name_norm = _norm_unit(parsed.name)
    new_bbox = bbox_of(parsed.points)

    # нові точки за кольором → множини координатних ключів
    new_by_color: dict[str, set] = {}
    for p in parsed.points:
        new_by_color.setdefault(p.color or "", set()).add(_ckey(p.lat, p.lon))

    rows = conn.execute(
        "SELECT id, name, point_count, min_lat, min_lon, max_lat, max_lon "
        "FROM palettes WHERE is_archived = 0"
    ).fetchall()

    # теги підрозділів по палітрах (для скоупу)
    tag_map: dict[int, set[str]] = {}
    for tr in conn.execute(
        "SELECT l.palette_id AS pid, u.name AS uname "
        "FROM palette_unit_links l JOIN palette_units u ON u.id = l.unit_id"
    ).fetchall():
        tag_map.setdefault(int(tr["pid"]), set()).add(_norm_unit(tr["uname"]))

    candidates: list[dict] = []
    for r in rows:
        pid = int(r["id"])
        ex_name = r["name"] or ""
        same_name = _norm_unit(ex_name) == new_name_norm

        # ── 1) скоуп за підрозділом ──
        if scope is not None and not same_name:
            ptags = tag_map.get(pid, set())
            in_scope = bool(ptags & scope)
            if not in_scope and not ptags:
                in_scope = bool(_units_in_name(ex_name) & scope)
            if not in_scope:
                continue

        # геогр. пре-фільтр: без перетину bbox точки збігтися не можуть
        ex_bbox = (r["min_lat"], r["min_lon"], r["max_lat"], r["max_lon"])
        geo_ok = (None not in ex_bbox) and _bbox_overlap(new_bbox, ex_bbox)
        if not geo_ok and not same_name:
            continue

        # наявні точки за кольором
        ex_by_color: dict[str, set] = {}
        for cr in conn.execute(
            "SELECT color, lat, lon FROM palette_points WHERE palette_id = ?", (pid,)
        ).fetchall():
            if cr["lat"] is None or cr["lon"] is None:
                continue
            ex_by_color.setdefault(cr["color"] or "", set()).add(_ckey(cr["lat"], cr["lon"]))

        shared_colors = set(new_by_color) & set(ex_by_color)
        color_reports: list[dict] = []
        total_matched = tot_new = tot_ex = 0
        for color in sorted(shared_colors):
            nset, eset = new_by_color[color], ex_by_color[color]
            # ── 2) гейт: 3 випадкові точки кольору ──
            sample = random.sample(list(nset), min(3, len(nset)))
            sampled_ok = all(s in eset for s in sample)
            if not sampled_ok:
                color_reports.append({
                    "color": color, "sampled_ok": False, "matched": 0,
                    "new_count": len(nset), "existing_count": len(eset), "is_superset": False,
                })
                continue
            matched = len(nset & eset)
            is_sup = eset.issubset(nset)
            total_matched += matched; tot_new += len(nset); tot_ex += len(eset)
            color_reports.append({
                "color": color, "sampled_ok": True, "matched": matched,
                "new_count": len(nset), "existing_count": len(eset), "is_superset": is_sup,
            })

        union_colors = set(new_by_color) | set(ex_by_color)
        jaccard = (len(shared_colors) / len(union_colors)) if union_colors else 0.0
        verified = [c for c in color_reports if c["sampled_ok"]]

        # У звіт — лише те, що СПІВПАЛО ТОЧКАМИ (підтверджено координатами) або
        # має ту саму назву. Збіг лише за кольорами (без спільних точок) —
        # це інша палітра тієї ж зони, її не пропонуємо на заміну.
        if not (same_name or verified):
            continue

        colors_equal = set(new_by_color) == set(ex_by_color)
        all_verified = bool(shared_colors) and len(verified) == len(shared_colors)
        exact = (colors_equal and all_verified
                 and all(c["matched"] == c["new_count"] == c["existing_count"] for c in verified))
        superset = (not exact and all_verified
                    and all(c["is_superset"] for c in verified) and tot_new > tot_ex)
        kind = "exact" if (exact or (same_name and not verified)) else ("superset" if superset else "similar")

        candidates.append({
            "palette_id": pid,
            "name": str(ex_name),
            "kind": kind,
            "color_jaccard": round(jaccard, 3),
            "new_is_superset": bool(superset),
            "existing_point_count": int(r["point_count"] or 0),
            "matched_points": int(total_matched),
            "scope": scope_lbl,
            "colors": color_reports,
        })

    # найінформативніші — вгорі: більше збігів, дублі/розширення першими
    candidates.sort(key=lambda d: (
        -d.get("matched_points", 0),
        0 if d["kind"] in ("exact", "superset") else 1,
    ))
    return candidates


# --------------------------------------------------------------------------- #
#  Persistence
# --------------------------------------------------------------------------- #


def persist_palette(
    conn,
    parsed: ParsedPalette,
    *,
    unit_ids: list[int] | None = None,
    comment: str = "",
    replace_palette_ids: list[int] | None = None,
) -> int:
    """Insert palette + regions + points (+ rtree). Optionally delete replaced
    palettes first. Returns the new palette id. Caller commits."""
    now = datetime.utcnow().isoformat()

    for old_id in (replace_palette_ids or []):
        # ПОРЯДОК ВАЖЛИВИЙ: rtree — НЕ звичайна таблиця, FK-каскад її не чистить,
        # тож прибираємо її рядки ДО видалення палітри. Якщо спершу видалити
        # палітру, каскад знищить palette_points, підзапит нижче поверне
        # порожньо — і в індексі лишаться сироти (вони спотворюють пошук точок).
        conn.execute(
            "DELETE FROM palette_points_rtree WHERE id IN "
            "(SELECT id FROM palette_points WHERE palette_id = ?)",
            (int(old_id),),
        )
        conn.execute("DELETE FROM palettes WHERE id = ?", (int(old_id),))

    pts = parsed.points
    if pts:
        mn_lat, mn_lon, mx_lat, mx_lon = bbox_of(pts)
    else:
        mn_lat = mn_lon = mx_lat = mx_lon = None

    # Наступний порядковий id (#N) — max(seq_no)+1.
    try:
        row = conn.execute("SELECT COALESCE(MAX(seq_no), 0) + 1 AS n FROM palettes").fetchone()
        next_seq = int(row["n"] if not isinstance(row, tuple) else row[0])
    except Exception:
        next_seq = None

    cur = conn.execute(
        """
        INSERT INTO palettes (name, source_format, source_filename, comment,
            is_archived, imported_at, point_count, min_lat, min_lon, max_lat, max_lon, seq_no)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
        """,
        (parsed.name, parsed.source_format, parsed.source_filename, comment,
         now, len(pts), mn_lat, mn_lon, mx_lat, mx_lon, next_seq),
    )
    palette_id = int(cur.lastrowid)

    for uid in (unit_ids or []):
        conn.execute(
            "INSERT OR IGNORE INTO palette_unit_links (palette_id, unit_id) VALUES (?, ?)",
            (palette_id, int(uid)),
        )

    regions = build_regions(pts)
    for reg in regions:
        rcur = conn.execute(
            """
            INSERT INTO palette_regions (palette_id, color, hull_wkt, code_prefix,
                num_min, num_max, label, center_lat, center_lon, point_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (palette_id, reg.color, reg.hull_wkt, reg.code_prefix,
             reg.num_min, reg.num_max, reg.label, reg.center_lat, reg.center_lon,
             len(reg.points)),
        )
        region_id = int(rcur.lastrowid)
        for p in reg.points:
            pcur = conn.execute(
                """
                INSERT INTO palette_points (palette_id, region_id, code, code_fold,
                    color, lat, lon, mgrs, comment)
                VALUES (?, ?, ?, ?, ?, ?, ?, '', '')
                """,
                (palette_id, region_id, display_code(p.code), fold_code(p.code),
                 p.color, p.lat, p.lon),
            )
            point_id = int(pcur.lastrowid)
            conn.execute(
                "INSERT INTO palette_points_rtree (id, min_lat, max_lat, min_lon, max_lon) "
                "VALUES (?, ?, ?, ?, ?)",
                (point_id, p.lat, p.lat, p.lon, p.lon),
            )

    return palette_id
