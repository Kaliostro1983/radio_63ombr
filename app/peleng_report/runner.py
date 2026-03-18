"""Offline peleng report runner.

This module provides a script-style entrypoint for generating peleng DOCX
reports from a text file (typically exported/copied from WhatsApp).

Usage:
    python -m app.peleng_report.runner path\\to\\input.txt

If no input file is provided, the runner attempts to find the newest `.txt`
file in a set of candidate directories (see `_resolve_input_path`).

The runner also maintains `posts.json` (a small runtime config file
describing peleng posts) and writes a parse diagnostics log on errors or
suspicious input.
"""

# src/pelengreport/runner.py
from __future__ import annotations

from pathlib import Path
from datetime import datetime
import sys
import json
import logging
import traceback
import subprocess
import os

from .parser import parse_whatsapp_text, ParseDiag
from .report import build_docx
from .config import load_config, get_posts_seed


_CFG = load_config()


def _repo_root() -> Path:
    """Return repository root directory."""
    # .../src/pelengreport/runner.py -> .../src -> .../
    return Path(__file__).resolve().parents[2]


def _module_dir() -> Path:
    """Return directory of this module."""
    return Path(__file__).resolve().parent


def _next_free_path(path: Path) -> Path:
    """Return a non-existing path by appending ' (n)' if needed."""
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    i = 2
    while True:
        cand = path.with_name(f"{stem} ({i}){suffix}")
        if not cand.exists():
            return cand
        i += 1


def _resolve_input_path(arg: str | None) -> Path:
    """Resolve input .txt file path from CLI arg or default search."""
    root = _repo_root()

    if arg:
        p = Path(arg)
        if not p.is_absolute():
            cand = Path.cwd() / p
            if cand.exists():
                return cand
            cand = root / p
            if cand.exists():
                return cand
        if p.exists():
            return p
        raise FileNotFoundError(f"Не знайдено вхідний файл: {p}")

    # ✅ Твоя вимога: за замовчуванням ./data у поточній теці
    candidates_dirs = [
        Path.cwd() / "data",
        Path.cwd(),
        root / "src" / "pelengreport" / "data",
        root / "pelengreport" / "data",
    ]

    txt_files: list[Path] = []
    for d in candidates_dirs:
        if d.exists():
            txt_files += list(d.glob("*.txt")) + list(d.glob("*.TXT"))

    if not txt_files:
        raise FileNotFoundError(
            "Не знайдено *.txt у жодному з каталогів:\n"
            + "\n".join(f" - {d}" for d in candidates_dirs)
            + "\n\nПередай шлях явно, напр.:\n"
            "  python -m src.pelengreport.runner src\\pelengreport\\data\\peleng.txt"
        )

    txt_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return txt_files[0]


def _posts_path() -> Path:
    return _repo_root() / "posts.json"


def _ensure_posts_json() -> Path:
    p = _posts_path()
    if p.exists():
        return p

    seed = get_posts_seed(_CFG)
    if not seed:
        # If no seed provided in config, create an empty list that user can edit.
        seed = []
    p.write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def load_posts(active_only: bool = True) -> list[dict]:
    """Load posts configuration from `posts.json`.

    Args:
        active_only: if True, return only posts with `active=true`.

    Returns:
        list[dict]: list of post objects.
    """
    path = _ensure_posts_json()
    posts = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(posts, list):
        raise ValueError("posts.json має містити список об'єктів")
    if active_only:
        posts = [x for x in posts if bool(x.get("active", False))]
    return posts


def _open_file(path: Path) -> None:
    try:
        os.startfile(str(path))  # type: ignore[attr-defined]
    except Exception:
        pass


def _open_folder_select(path: Path) -> None:
    try:
        subprocess.run(["explorer", "/select,", str(path)], check=False)
    except Exception:
        pass


def _write_parse_log_and_open(
    log_path: Path,
    input_txt: Path,
    lines: list[str],
    records_count: int,
    diag: ParseDiag,
    exc: Exception | None,
) -> None:
    """Write a diagnostic log file for parse failures and open it in OS.

    Args:
        log_path: path to write diagnostic log.
        input_txt: input file being parsed.
        lines: raw input lines.
        records_count: number of records parsed.
        diag: parse diagnostic object.
        exc: optional exception raised during parsing.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    parts: list[str] = []
    parts.append(f"Parse log generated: {now}")
    parts.append(f"Input file: {input_txt}")
    parts.append(f"Total lines: {len(lines)}")
    parts.append(f"Parsed records: {records_count}")
    parts.append("")

    if diag.errors:
        parts.append("DIAG errors:")
        for e in diag.errors[:50]:
            parts.append(f"- {e}")
        parts.append("")

    if diag.suspicious_headers:
        parts.append("Suspicious headers (first 20):")
        for s in diag.suspicious_headers[:20]:
            parts.append(s.rstrip("\n"))
        parts.append("")

    if diag.coord_break_lines:
        parts.append("Coord-break lines (first 20):")
        for s in diag.coord_break_lines[:20]:
            parts.append(s.rstrip("\n"))
        parts.append("")

    if exc is not None:
        parts.append("Exception:")
        parts.append(f"{type(exc).__name__}: {exc}")
        parts.append(traceback.format_exc())
        parts.append("")

    parts.append("File head (first 40 lines):")
    for s in lines[:40]:
        parts.append(s.rstrip("\n"))

    log_path.write_text("\n".join(parts), encoding="utf-8")
    _open_file(log_path)


def run(input_txt: Path, out_dir: Path | None = None) -> Path:
    """Parse input text and generate a DOCX report.

    Args:
        input_txt: path to input `.txt` file.
        out_dir: optional output directory (default: `<repo>/build`).

    Returns:
        Path: path to the generated DOCX report.
    """
    root = _repo_root()
    out_dir = Path(out_dir or (root / "build"))
    out_dir.mkdir(parents=True, exist_ok=True)

    log_path = out_dir / "parse_error.log"

    posts = load_posts(active_only=True)
    if not posts:
        raise RuntimeError("Немає активних постів у posts.json. Увімкни хоча б 1 пост.")

    today = datetime.now().strftime("%d.%m.%Y")
    pattern = str(_CFG["output_filename_pattern"])
    out_name = pattern.format(date=today)
    out_path = _next_free_path(out_dir / out_name)

    print(f"[i] Using input: {input_txt}")

    with open(input_txt, "r", encoding="utf-8-sig") as f:
        lines = f.readlines()

    diag = ParseDiag()
    exc: Exception | None = None
    records: list[dict] = []

    try:
        records = list(parse_whatsapp_text(lines, diag=diag))
        logging.warning(f"Знайдено {len(records)} записів у вхідному файлі.")
    except Exception as e:
        exc = e

    # ✅ Твоя вимога: якщо помилка або 0 записів — чистимо/пишемо лог і відкриваємо
    if exc is not None or len(records) == 0 or diag.errors or diag.suspicious_headers:
        _write_parse_log_and_open(
            log_path=log_path,
            input_txt=input_txt,
            lines=lines,
            records_count=len(records),
            diag=diag,
            exc=exc,
        )

    if exc is not None:
        raise RuntimeError(f"Помилка парсингу. Дивись лог: {log_path}") from exc

    if len(records) == 0:
        raise RuntimeError(f"Не розпізнано жодного пеленга. Дивись лог: {log_path}")

    build_docx(records, out_path, posts=posts)

    # відкрити папку + файл
    _open_folder_select(out_path)
    _open_file(out_path)

    print(f"[OK] Report saved to: {out_path}")
    return out_path


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    inp = _resolve_input_path(arg)
    run(inp)