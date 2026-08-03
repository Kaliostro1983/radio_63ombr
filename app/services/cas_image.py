"""Server-side PNG generator for the Casualties table screenshots."""
from __future__ import annotations

import io
from typing import Dict, List, Tuple

_FONT_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "C:/Windows/Fonts/arial.ttf",
]
_FONT_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]
# Times New Roman-подібні серифні шрифти (Liberation Serif — метрично сумісний).
_FONT_SERIF_REG = [
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "C:/Windows/Fonts/times.ttf",
]
_FONT_SERIF_BOLD = [
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "C:/Windows/Fonts/timesbd.ttf",
]


def _font(paths: List[str], size: int):
    from PIL import ImageFont
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _tw(draw, text: str, font) -> int:
    bb = draw.textbbox((0, 0), text, font=font)
    return bb[2] - bb[0]


def build_cas_image(
    units: List[Dict],
    entries_map: Dict[str, Tuple[int, int]],
    mode: str,
    entry_date: str,
) -> io.BytesIO:
    from PIL import Image, ImageDraw

    S = 2        # retina scale
    PAD = 14     # outer padding (logical px)
    TITLE_H = 42
    HDR_H = 30
    SEC_H = 26
    ROW_H = 26

    if mode == "morning":
        columns = [
            ("Підрозділ",   0, "name"),     # width=0 → computed below
            ("08:00–16:00", 96, "morning"),
        ]
    else:
        columns = [
            ("Підрозділ",   0, "name"),
            ("16:00–08:00", 96, "night"),
            ("08:00–08:00", 96, "total"),
        ]

    # Collect visible rows per section
    SECTIONS = [("irr", "БЕЗПОВОРОТНІ ВТРАТИ"), ("san", "САНІТАРНІ ВТРАТИ")]
    table_rows: list = []
    for cat, label in SECTIONS:
        visible = []
        for u in units:
            m, n = entries_map.get(f"{cat}_{u['id']}", (0, 0))
            t = m + n
            if mode == "morning" and not m:
                continue
            if mode == "night" and not t:
                continue
            visible.append((u["name"], m, n, t))
        if visible:
            table_rows.append(("sec", cat, label))
            for item in visible:
                table_rows.append(("row", cat) + tuple(item))

    # Load fonts (need them to measure name widths)
    fr = _font(_FONT_REG,  12 * S)
    fb = _font(_FONT_BOLD, 12 * S)
    ft = _font(_FONT_BOLD, 14 * S)

    # Compute name column width from longest visible name
    tmp_img = Image.new("RGB", (1, 1))
    tmp_draw = ImageDraw.Draw(tmp_img)
    min_name_w = _tw(tmp_draw, "Підрозділ", fb) + 20 * S
    max_name_w = max(
        (_tw(tmp_draw, r[2], fr) for r in table_rows if r[0] == "row"),
        default=min_name_w,
    ) + 20 * S
    name_w_px = max(min_name_w, max_name_w)  # logical pixels * S already

    # Patch name column width (already in scaled pixels)
    columns[0] = (columns[0][0], name_w_px // S, columns[0][2])

    TW = sum(w for _, w, _ in columns)

    # Expand TW if title text is wider than the table
    mode_lbl = "08:00–16:00" if mode == "morning" else "16:00–08:00"
    title_str = f"Таблиця втрат  ·  {entry_date}  ·  {mode_lbl}"
    title_min_w = (_tw(tmp_draw, title_str, ft) + 32 * S) // S
    TW = max(TW, title_min_w)

    # Compute image height
    img_h = PAD + TITLE_H + HDR_H
    for r in table_rows:
        img_h += SEC_H if r[0] == "sec" else ROW_H
    img_h += PAD

    img = Image.new("RGB", ((TW + 2 * PAD) * S, img_h * S), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Palette
    C = {
        "title":    (30,  58,  138),
        "title_fg": (255, 255, 255),
        "hdr":      (241, 243, 246),
        "hdr_fg":   (55,  65,  81),
        "irr":      (255, 242, 242),
        "irr_sec":  (254, 226, 226),
        "irr_fg":   (153, 27,  27),
        "san":      (240, 253, 244),
        "san_sec":  (220, 252, 231),
        "san_fg":   (20,  83,  45),
        "row_fg":   (17,  24,  39),
        "border":   (209, 213, 219),
        "frame":    (100, 116, 139),
    }

    def cell(x, y, w, h, bg, text, font, fg, align="center"):
        draw.rectangle([x, y, x + w - 1, y + h - 1], fill=bg)
        if not text:
            return
        tw = _tw(draw, text, font)
        th = draw.textbbox((0, 0), text, font=font)[3] - draw.textbbox((0, 0), text, font=font)[1]
        if align == "right":
            tx = x + w - tw - 8 * S
        elif align == "left":
            tx = x + 10 * S
        else:
            tx = x + (w - tw) // 2
        ty = y + (h - th) // 2
        draw.text((tx, ty), text, font=font, fill=fg)

    x0 = PAD * S
    y = PAD * S
    top = y

    # ── Title ──────────────────────────────────────────────────────────────────
    mode_lbl = "08:00–16:00" if mode == "morning" else "16:00–08:00"
    cell(x0, y, TW * S, TITLE_H * S,
         C["title"], f"Таблиця втрат  ·  {entry_date}  ·  {mode_lbl}",
         ft, C["title_fg"])
    y += TITLE_H * S

    # ── Column headers ─────────────────────────────────────────────────────────
    xr = x0
    for lbl, w, _ in columns:
        cell(xr, y, w * S, HDR_H * S, C["hdr"], lbl, fb, C["hdr_fg"])
        xr += w * S
    y += HDR_H * S

    # ── Data rows ──────────────────────────────────────────────────────────────
    for r in table_rows:
        if r[0] == "sec":
            _, cat, label = r
            bg = C["irr_sec"] if cat == "irr" else C["san_sec"]
            fg = C["irr_fg"]  if cat == "irr" else C["san_fg"]
            cell(x0, y, TW * S, SEC_H * S, bg, label, fb, fg, "left")
            y += SEC_H * S
        else:
            _, cat, name, m, n, t = r
            bg = C["irr"] if cat == "irr" else C["san"]
            xr = x0
            for _, w, key in columns:
                val = {"name": name, "morning": str(m) if m else "",
                       "night": str(n) if n else "", "total": str(t) if t else ""}[key]
                al  = "right" if key == "name" else "center"
                fn  = fb if key == "total" else fr
                cell(xr, y, w * S, ROW_H * S, bg, val, fn, C["row_fg"], al)
                xr += w * S
            y += ROW_H * S

    bottom = y

    # ── Grid lines ─────────────────────────────────────────────────────────────
    # Horizontal: one between every row band (title already has its own bg, start from hdr)
    yy = top + TITLE_H * S
    for r in [None] + table_rows:  # None = header row
        draw.line([(x0, yy), (x0 + TW * S - 1, yy)], fill=C["border"], width=S)
        if r is None:
            yy += HDR_H * S
        elif r[0] == "sec":
            yy += SEC_H * S
        else:
            yy += ROW_H * S

    # Vertical column dividers
    xr = x0
    for _, w, _ in columns[:-1]:
        xr += w * S
        draw.line([(xr, top + TITLE_H * S), (xr, bottom - 1)], fill=C["border"], width=S)

    # Outer frame
    draw.rectangle([x0, top, x0 + TW * S - 1, bottom - 1],
                   outline=C["frame"], width=2 * S)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf


def build_casualty_report_image(sections, period_label, tot_200, tot_300):
    """PNG звіту «Втрати 2» за період.

    sections     — [(cat, label, [(unit_name, count), ...]), ...] де cat ∈ irr/san
    period_label — рядок періоду для синьої шапки
    tot_200/300  — загальні підсумки (у синій секції)

    Колонка значень — «Втрати, в/с». Ширина таблиці визначається шапкою; уся
    вільна ширина праворуч віддається лівій колонці «Підрозділ».
    """
    from PIL import Image, ImageDraw

    S = 2
    PAD = 14
    TITLE_H = 40    # синя шапка — «Таблиця втрат · період»
    HDR_H = 30
    SEC_H = 26
    ROW_H = 26
    SUM_H = 30      # підсумковий рядок унизу

    # Весь текст таблиці — Times New Roman (Liberation Serif).
    fr   = _font(_FONT_SERIF_REG,  12 * S)
    fb   = _font(_FONT_SERIF_BOLD, 12 * S)
    ft   = _font(_FONT_SERIF_BOLD, 14 * S)
    fsum = _font(_FONT_SERIF_BOLD, 13 * S)

    table_rows = []
    for cat, label, items in sections:
        if not items:
            continue
        table_rows.append(("sec", cat, label))
        for name, cnt in items:
            table_rows.append(("row", cat, name, cnt))

    tmp = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    # Колонка значень — за шириною заголовка «Втрати, в/с».
    val_w = max(96, (_tw(tmp, "Втрати, в/с", fb) + 24 * S) // S)
    min_name_w = _tw(tmp, "Підрозділ", fb) + 20 * S
    max_name_w = max(
        (_tw(tmp, r[2], fr) for r in table_rows if r[0] == "row"),
        default=min_name_w,
    ) + 20 * S
    name_w = max(min_name_w, max_name_w) // S

    total = tot_200 + tot_300
    title_str = f"Таблиця втрат  ·  {period_label}"
    sum_str = f"Загалом: {total} в/с (безповоротні: {tot_200} в/с, санітарні: {tot_300} в/с)"

    TW = name_w + val_w
    TW = max(TW,
             (_tw(tmp, title_str, ft) + 32 * S) // S,
             (_tw(tmp, sum_str, fsum) + 24 * S) // S)
    # Ширину перерозподіляємо між колонками (загальна TW незмінна):
    # −30 праворуч→ліворуч (раніше), потім +50 ліворуч→праворуч.
    val_w = max(60, val_w - 30 + 50)
    name_w = TW - val_w

    img_h = PAD + TITLE_H + HDR_H
    for r in table_rows:
        img_h += SEC_H if r[0] == "sec" else ROW_H
    if not table_rows:
        img_h += ROW_H  # місце під «немає даних»
    img_h += SUM_H + PAD

    img = Image.new("RGB", ((TW + 2 * PAD) * S, img_h * S), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    C = {
        "title": (30, 58, 138), "title_fg": (255, 255, 255),
        "hdr": (241, 243, 246), "hdr_fg": (55, 65, 81),
        "irr": (255, 242, 242), "irr_sec": (254, 226, 226), "irr_fg": (153, 27, 27),
        "san": (240, 253, 244), "san_sec": (220, 252, 231), "san_fg": (20, 83, 45),
        "row_fg": (17, 24, 39), "border": (209, 213, 219),
    }

    def cell(x, y, w, h, bg, text, font, fg, align="center"):
        draw.rectangle([x, y, x + w - 1, y + h - 1], fill=bg)
        if not text:
            return
        tw = _tw(draw, text, font)
        th = draw.textbbox((0, 0), text, font=font)[3] - draw.textbbox((0, 0), text, font=font)[1]
        tx = x + w - tw - 8 * S if align == "right" else (x + 10 * S if align == "left" else x + (w - tw) // 2)
        draw.text((tx, y + (h - th) // 2), text, font=font, fill=fg)

    x0 = PAD * S
    y = PAD * S
    top = y
    cell(x0, y, TW * S, TITLE_H * S, C["title"], title_str, ft, C["title_fg"]); y += TITLE_H * S
    cell(x0, y, name_w * S, HDR_H * S, C["hdr"], "Підрозділ", fb, C["hdr_fg"])
    # Заголовок колонки значень — підбираємо шрифт під (звужену) колонку.
    fvh = fb
    for _sz in (12, 11, 10, 9):
        _f = _font(_FONT_SERIF_BOLD, _sz * S)
        if _tw(tmp, "Втрати, в/с", _f) <= (val_w - 10) * S:
            fvh = _f
            break
    cell(x0 + name_w * S, y, val_w * S, HDR_H * S, C["hdr"], "Втрати, в/с", fvh, C["hdr_fg"]); y += HDR_H * S

    hdr_bottom = y
    if not table_rows:
        cell(x0, y, TW * S, ROW_H * S, (255, 255, 255), "За період даних немає", fr, C["row_fg"]); y += ROW_H * S
    for r in table_rows:
        if r[0] == "sec":
            _, cat, label = r
            cell(x0, y, TW * S, SEC_H * S, C["irr_sec"] if cat == "irr" else C["san_sec"], label, fb,
                 C["irr_fg"] if cat == "irr" else C["san_fg"], "center"); y += SEC_H * S
        else:
            _, cat, name, cnt = r
            bg = C["irr"] if cat == "irr" else C["san"]
            cell(x0, y, name_w * S, ROW_H * S, bg, name, fr, C["row_fg"], "center")
            cell(x0 + name_w * S, y, val_w * S, ROW_H * S, bg, str(cnt) if cnt else "", fr, C["row_fg"], "center")
            y += ROW_H * S
    rows_bottom = y

    # ── Підсумковий рядок унизу — на всю ширину, ліворуч ──
    cell(x0, y, TW * S, SUM_H * S, C["hdr"], sum_str, fsum, C["row_fg"], "left"); y += SUM_H * S
    bottom = y

    # Горизонтальні лінії у зоні таблиці (заголовок + рядки), і під підсумком.
    yy = hdr_bottom
    draw.line([(x0, hdr_bottom - HDR_H * S), (x0 + TW * S - 1, hdr_bottom - HDR_H * S)], fill=C["border"], width=S)
    draw.line([(x0, yy), (x0 + TW * S - 1, yy)], fill=C["border"], width=S)
    walk = [None] if not table_rows else table_rows
    for r in walk:
        yy += ROW_H * S if (r is None or r[0] != "sec") else SEC_H * S
        draw.line([(x0, yy), (x0 + TW * S - 1, yy)], fill=C["border"], width=S)
    draw.line([(x0, bottom - 1), (x0 + TW * S - 1, bottom - 1)], fill=C["border"], width=S)
    # Вертикальний роздільник — лише в зоні таблиці (не через підсумок).
    draw.line([(x0 + name_w * S, hdr_bottom - HDR_H * S), (x0 + name_w * S, rows_bottom - 1)], fill=C["border"], width=S)
    # Рамка по периметру — тієї ж товщини, що й основні лінії.
    draw.rectangle([x0, top, x0 + TW * S - 1, bottom - 1], outline=C["border"], width=S)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf
