"""Import service for palettes (наборів кодованих точок).

Pipeline:
    bytes (KML/KMZ/GeoJSON) → parse placemarks → ParsedPoint[]
                            → group by colour   → convex-hull regions
                            → dedup analysis vs existing palettes
                            → persist (palettes / palette_regions / palette_points
                               / palette_points_rtree)

The parser is dependency-free (xml.etree + zipfile + json).
"""

from __future__ import annotations

import csv
import io
import json
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


def _typical_spacing(pts: list[tuple[float, float]]) -> float:
    """Характерна відстань між сусідніми точками (медіана по найближчих).

    Крок НЕ можна брати з різниць унікальних довгот/широт: сітки палітр
    побудовані в MGRS і відносно градусної сітки ПОВЕРНУТІ, тож унікальних
    координат тисячі, а медіана їхніх різниць виходить мікроскопічною — обриси
    тоді збираються навколо кожної точки окремо.

    Тому рахуємо відстань до найближчого сусіда для вибірки точок, шукаючи
    сусідів через хеш-сітку (без цього було б O(n²)).
    """
    n = len(pts)
    if n < 2:
        return 0.0
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    w = max(xs) - min(xs); h = max(ys) - min(ys)
    if w <= 0 and h <= 0:
        return 0.0
    # Початкова оцінка: середня щільність по bbox.
    guess = ((w * h) / n) ** 0.5 if (w > 0 and h > 0) else (max(w, h) / n)
    if guess <= 0:
        return 0.0

    minx, miny = min(xs), min(ys)
    buckets: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for p in pts:
        buckets.setdefault((int((p[0] - minx) / guess), int((p[1] - miny) / guess)), []).append(p)

    step_sample = max(1, n // 2000)          # вибірка до ~2000 точок
    dists: list[float] = []
    for idx in range(0, n, step_sample):
        px, py = pts[idx]
        bx, by = int((px - minx) / guess), int((py - miny) / guess)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for qx, qy in buckets.get((bx + dx, by + dy), ()):
                    if qx == px and qy == py:
                        continue
                    d2 = (qx - px) ** 2 + (qy - py) ** 2
                    if best is None or d2 < best:
                        best = d2
        if best:
            dists.append(best ** 0.5)
    if not dists:
        return guess
    dists.sort()
    return dists[len(dists) // 2]


def _drop_collinear(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Прибрати проміжні точки на прямих ділянках ЗАМКНЕНОГО кільця.

    Обрис по сітці складається лише з горизонтальних і вертикальних відрізків,
    тож злиття колінеарних сегментів дає ТОЧНО ту саму фігуру, але з мінімумом
    вершин (для Г-подібної області — 6 замість 80). Навмисно не використовуємо
    Дугласа–Пекера: на замкненому кільці його базова лінія вироджена (перша й
    остання точки збігаються), через що зрізаються прямі кути.
    """
    n = len(ring)
    if n < 3:
        return ring
    out = []
    for i in range(n):
        ax, ay = ring[i - 1]
        bx, by = ring[i]
        cx, cy = ring[(i + 1) % n]
        # b лежить на відрізку a→c (векторний добуток ≈ 0) → пропускаємо
        if abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 1e-12:
            out.append((bx, by))
    return out if len(out) >= 3 else ring


def concave_outline(pts: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Увігнуті межі набору точок (lon, lat) — обводять ФАКТИЧНЕ покриття.

    Опукла оболонка «роздувається» назовні: вона накриває порожні ділянки й
    неминуче перетинає сусідні області, коли їхні точки чергуються. ГОІ малює
    саме увігнуті межі, тож повторюємо це.

    Алгоритм (точки палітр лежать сіткою, тож він і швидкий, і точний):
      1. визначаємо крок сітки та «займані» комірки;
      2. збираємо межові ребра — сторони комірок, за якими немає сусіда;
      3. зшиваємо ребра в кільця, беремо найбільше за площею;
      4. спрощуємо Дугласом–Пекером, щоб прибрати сходинки.

    Повертає СПИСОК кілець (кожне — без дублювання першої точки): група може
    складатися з кількох окремих скупчень. Якщо сітку розпізнати не вдалося —
    повертає одне кільце опуклої оболонки.
    """
    uniq = sorted(set(pts))
    # Для кількох точок сітка не має сенсу — комірки не стикаються, і межа
    # вироджується в цятки. Опукла оболонка тут і точніша, і чесніша.
    if len(uniq) < 8:
        return [convex_hull(uniq)]

    # Комірка трохи більша за характерну відстань — щоб сусідні точки
    # (зокрема на повернутій сітці) потрапляли в суміжні комірки й область
    # не розсипалася на окремі цятки.
    base = _typical_spacing(uniq)
    if base <= 0:
        return [convex_hull(uniq)]

    minx = min(p[0] for p in uniq)
    miny = min(p[1] for p in uniq)

    # Крок підбираємо за ПОКРИТТЯМ ТОЧОК: якщо група має щільніші згустки,
    # характерна відстань занижена, решта сітки розсипається на одиничні
    # комірки, і відкидання «шуму» лишило б купу точок поза межею. Тож
    # збільшуємо крок, доки збережені скупчення не накриють майже всі точки.
    step = base * 1.25
    keep: list[list[tuple[float, float]]] = []
    for _ in range(10):
        traced = _trace_kept_rings(uniq, minx, miny, step)
        if traced is None:
            return [convex_hull(uniq)]
        keep, coverage, n_parts = traced
        if coverage >= 0.97 and n_parts <= 8:
            break
        step *= 1.5
    if not keep:
        return [convex_hull(uniq)]

    out: list[list[tuple[float, float]]] = []
    for r in keep:
        latlon = [(minx + gx * step, miny + gy * step) for gx, gy in r]
        # Межа має читатися як обрис району, а не як контур кожної комірки:
        # прибираємо дрібні зубці, тоді згладжуємо кути.
        simple = _simplify_ring(_drop_collinear(latlon), step * 2.0)
        smooth = _decimate(_chaikin(simple, 1), step * 0.5)
        if len(smooth) >= 3:
            out.append(smooth)
    return out or [convex_hull(uniq)]


def _simplify_ring(
    ring: list[tuple[float, float]], tol: float
) -> list[tuple[float, float]]:
    """Спрощення замкненого кільця (Дуглас–Пекер).

    Кільце ріжемо на два ланцюги по найвіддаленішій парі вершин: на замкненому
    контурі базова лінія вироджена, і алгоритм зрізав би прямі кути.
    """
    if len(ring) < 8:
        return ring
    x0, y0 = ring[0]
    far = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    xf, yf = ring[far]
    far2 = max(range(len(ring)), key=lambda i: (ring[i][0] - xf) ** 2 + (ring[i][1] - yf) ** 2)
    a, b = sorted((far, far2))
    if b - a < 2 or len(ring) - (b - a) < 2:
        return ring
    out = _rdp(ring[a:b + 1], tol) + _rdp(ring[b:] + ring[:a + 1], tol)[1:-1]
    return out if len(out) >= 3 else ring


def _rdp(chain: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Дуглас–Пекер для НЕзамкненого ланцюга."""
    if len(chain) < 3:
        return chain
    (x1, y1), (x2, y2) = chain[0], chain[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = (dx * dx + dy * dy) ** 0.5
    best, bi = -1.0, 0
    for i in range(1, len(chain) - 1):
        px, py = chain[i]
        d = (abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm) if norm else (
            ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5)
        if d > best:
            best, bi = d, i
    if best <= tol:
        return [chain[0], chain[-1]]
    return _rdp(chain[:bi + 1], tol) + _rdp(chain[bi:], tol)[1:]


def _despike(cells: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """Прибрати з набору комірок голки та засипати дрібні виїмки.

    Поодинокі точки збоку тягнуть за собою «вусики» завширшки в одну комірку —
    на карті це схоже на шипи. Морфологічне відкриття (ерозія→дилатація) їх
    зрізає, закриття (дилатація→ерозія) згладжує зубчастий край.
    """
    def dilate(s):
        out = set(s)
        for ix, iy in s:
            out.update(((ix + 1, iy), (ix - 1, iy), (ix, iy + 1), (ix, iy - 1)))
        return out

    def erode(s):
        return {(ix, iy) for ix, iy in s
                if (ix + 1, iy) in s and (ix - 1, iy) in s
                and (ix, iy + 1) in s and (ix, iy - 1) in s}

    opened = dilate(erode(cells))
    if len(opened) < len(cells) * 0.5:
        # Витягнута чи тонка область — відкриття зʼїло б її, лишаємо як є.
        opened = cells
    closed = erode(dilate(opened))
    if len(closed) < 4:
        closed = opened
    # Ще один шар назовні — спрощення й згладжування підтягують межу всередину,
    # і без запасу крайні точки опинилися б поза власною областю.
    return dilate(closed)


def _components(cells: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    """Звʼязні (по 4 сусідах) скупчення комірок."""
    seen: set[tuple[int, int]] = set()
    parts: list[set[tuple[int, int]]] = []
    for c in cells:
        if c in seen:
            continue
        stack, comp = [c], set()
        seen.add(c)
        while stack:
            ix, iy = stack.pop()
            comp.add((ix, iy))
            for n in ((ix + 1, iy), (ix - 1, iy), (ix, iy + 1), (ix, iy - 1)):
                if n in cells and n not in seen:
                    seen.add(n)
                    stack.append(n)
        parts.append(comp)
    return parts


def _chaikin(ring: list[tuple[float, float]], passes: int = 2) -> list[tuple[float, float]]:
    """Згладжування Чайкіна (зрізання кутів) для замкненого кільця."""
    for _ in range(passes):
        nxt: list[tuple[float, float]] = []
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            nxt.append((x1 * 0.75 + x2 * 0.25, y1 * 0.75 + y2 * 0.25))
            nxt.append((x1 * 0.25 + x2 * 0.75, y1 * 0.25 + y2 * 0.75))
        ring = nxt
    return ring


def _decimate(ring: list[tuple[float, float]], min_dist: float) -> list[tuple[float, float]]:
    """Прорідити кільце: викинути вершини, ближчі за min_dist до попередньої."""
    if len(ring) < 4:
        return ring
    out = [ring[0]]
    for x, y in ring[1:]:
        px, py = out[-1]
        if (x - px) ** 2 + (y - py) ** 2 >= min_dist * min_dist:
            out.append((x, y))
    return out if len(out) >= 3 else ring


def _ring_signed_area(ring: list[tuple[float, float]]) -> float:
    """Знакова площа кільця: >0 — зовнішній контур, <0 — дірка."""
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        s += x1 * y2 - x2 * y1
    return s / 2


def _trace_kept_rings(
    pts: list[tuple[float, float]], minx: float, miny: float, step: float
) -> tuple[list[list[tuple[float, float]]], float, int] | None:
    """Комірки сітки → кільця межових ребер вагомих скупчень (у координатах сітки).

    Повертає (кільця, частка накритих точок, кількість скупчень) або None,
    якщо сітка вироджена (усе в одну комірку або занадто дрібна).
    """
    counts: dict[tuple[int, int], int] = {}
    for x, y in pts:
        c = (round((x - minx) / step), round((y - miny) / step))
        counts[c] = counts.get(c, 0) + 1
    if len(counts) < 4 or len(counts) > 400_000:
        return None

    # Скупчення, що містять менше 0.5% точок, відкидаємо як шум; решту
    # зберігаємо ВСІ — інакше частина точок лишилася б поза будь-якою межею.
    parts = _components(set(counts))
    parts.sort(key=lambda p: sum(counts[c] for c in p), reverse=True)
    total = len(pts)
    kept = [p for p in parts if sum(counts[c] for c in p) >= total * 0.005][:24]
    if not kept:
        kept = parts[:1]
    covered = sum(counts[c] for p in kept for c in p)
    cells = _despike({c for p in kept for c in p})

    # Межові ребра, орієнтовані проти годинникової — так кільця зшиваються.
    edges: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for ix, iy in cells:
        if (ix, iy - 1) not in cells:
            edges.setdefault((ix - .5, iy - .5), []).append((ix + .5, iy - .5))
        if (ix + 1, iy) not in cells:
            edges.setdefault((ix + .5, iy - .5), []).append((ix + .5, iy + .5))
        if (ix, iy + 1) not in cells:
            edges.setdefault((ix + .5, iy + .5), []).append((ix - .5, iy + .5))
        if (ix - 1, iy) not in cells:
            edges.setdefault((ix - .5, iy + .5), []).append((ix - .5, iy - .5))

    rings: list[list[tuple[float, float]]] = []
    while edges:
        start = next(iter(edges))
        ring, cur = [], start
        while True:
            nxts = edges.get(cur)
            if not nxts:
                break
            nxt = nxts.pop()
            if not nxts:
                edges.pop(cur, None)
            ring.append(cur)
            cur = nxt
            if cur == start:
                break
        if len(ring) >= 4:
            rings.append(ring)
    # Дірки (відʼємна площа) лишаємо лише помітні — дрібні лише засмічують межу.
    outer = [r for r in rings if _ring_signed_area(r) > 0]
    if not outer:
        return None
    biggest = max(_ring_signed_area(r) for r in outer)
    out = outer + [r for r in rings if -_ring_signed_area(r) >= biggest * 0.05][:8]
    return out, covered / total, len(kept)


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


def analyze_duplicates(conn, parsed: ParsedPalette) -> list[dict]:
    """Find existing palettes that look like duplicates / supersets of `parsed`.

    Returns a list of candidate dicts: {palette_id, name, kind, color_jaccard,
    new_is_superset, existing_point_count}. `kind` ∈ {exact, similar}.
    """
    if not parsed.points:
        return []
    new_colors = {(p.color or "") for p in parsed.points}
    new_codes = {fold_code(p.code) for p in parsed.points if p.code}
    new_bbox = bbox_of(parsed.points)

    rows = conn.execute(
        "SELECT id, name, point_count, min_lat, min_lon, max_lat, max_lon "
        "FROM palettes WHERE is_archived = 0"
    ).fetchall()

    candidates: list[dict] = []
    for r in rows:
        ex_bbox = (r["min_lat"], r["min_lon"], r["max_lat"], r["max_lon"])
        if None in ex_bbox or not _bbox_overlap(new_bbox, ex_bbox):
            # Different geography → not a duplicate. (Same name still flags below.)
            if (r["name"] or "").strip().lower() != parsed.name.strip().lower():
                continue

        ex_colors = {
            (cr["color"] or "")
            for cr in conn.execute(
                "SELECT DISTINCT color FROM palette_points WHERE palette_id = ?", (r["id"],)
            ).fetchall()
        }
        ex_codes = {
            fold_code(cr["code"])
            for cr in conn.execute(
                "SELECT code FROM palette_points WHERE palette_id = ?", (r["id"],)
            ).fetchall()
            if cr["code"]
        }
        union = new_colors | ex_colors
        jaccard = (len(new_colors & ex_colors) / len(union)) if union else 0.0
        new_superset = bool(ex_codes) and ex_codes.issubset(new_codes)
        same_name = (r["name"] or "").strip().lower() == parsed.name.strip().lower()
        exact = same_name or (ex_codes == new_codes and ex_codes)

        if exact or jaccard >= 0.5 or new_superset:
            candidates.append({
                "palette_id": int(r["id"]),
                "name": str(r["name"] or ""),
                "kind": "exact" if exact else "similar",
                "color_jaccard": round(jaccard, 3),
                "new_is_superset": new_superset,
                "existing_point_count": int(r["point_count"] or 0),
            })
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
