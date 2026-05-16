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
