from __future__ import annotations

"""
Configuration loader for peleng DOCX report.

Sensitive or unit‑specific strings (headers, table captions, unit names,
equipment names, output filename pattern, seed posts, etc.) are expected to be
provided in an external JSON config file that is NOT committed to the repo.

Runtime config path (ignored by git):
    <repo_root>/peleng_report_config.json

Example JSON structure (all keys are optional; any missing ones fall back
to the safe defaults defined in this module):

{
  "header_form_label": "Форма 1.2.13",
  "header_title": "ДОНЕСЕННЯ",
  "header_sub_template": "за результатами ... станом на 24:00 {date} року",

  "section1_text": "1. Склад сил і засобів, ...",
  "section2_text": "2. Зміни в стані засобів пеленгування ...",
  "section2_no_changes_text": "В стані та положенні засобів пеленгації змін немає.",
  "section3_text": "3. Загальна кількість викритих ...",
  "section4_text": "4. Результати визначення місцеположень ...",

  "table1_headers": [
    "№ з/п",
    "Військова частина (підрозділ)",
    "Район розташування, номер бойового посту",
    "Озброєння, військова техніка, яка залучена",
    "Хід виконання розвідувальних завдань"
  ],
  "table1_group_label": "3 АК",

  "table2_headers": [
    "№ з/п",
    "Військова частина (підрозділ)",
    "Район розташування, номер бойового посту",
    "Озброєння, військова техніка, яка залучена",
    "Кількість отриманих пеленгів (напрямків)",
    "Примітка"
  ],
  "table2_group_label": "3 АК",

  "default_unit": "А3719\\n(63 омбр)",
  "default_equipment": "“Пластун”",
  "default_task_progress": "Відповідно до плану бойового застосування",

  "results_table_headers": [
    "№",
    "Частота (МГц)",
    "Назва підрозділу",
    "Дата та час",
    "Координати"
  ],

  "output_filename_pattern": "форма_1.2.13 {date}.docx",

  "posts_seed": [
    {
      "id": "post_1",
      "active": true,
      "name": "МІКОЛАЇВКА",
      "bp_number": "0000",
      "unit": "А3719\\n(63 омбр)",
      "equipment": "“Пластун”"
    },
    {
      "id": "post_2",
      "active": true,
      "name": "МАЯКИ",
      "bp_number": "0001",
      "unit": "А3719\\n(63 омбр)",
      "equipment": "“Пластун”"
    }
  ]
}

You can keep your local JSON with real values out of git; only this loader
module is committed.
"""

from pathlib import Path
import json
from typing import Any, Dict, List


def _repo_root() -> Path:
    """Return repository root directory (two levels above this file)."""
    return Path(__file__).resolve().parents[2]


CONFIG_PATH = _repo_root() / "peleng_report_config.json"


DEFAULT_CONFIG: Dict[str, Any] = {
    # Header
    "header_form_label": "Форма 1.2.13",
    "header_title": "ДОНЕСЕННЯ",
    "header_sub_template": (
        "за результатами функціонування тактичної радіопеленгаторної мережі у зоні "
        "відповідальності станом на 24:00 {date} року"
    ),
    # Sections
    "section1_text": (
        "1. Склад сил і засобів, які розгорнуті для визначення місцеположення "
        "джерел (об’єктів) розвідки."
    ),
    "section2_text": (
        "2. Зміни в стані засобів пеленгування (вихід з ладу, зміна технічних позицій, "
        "розгортання нових засобів, втрати та заходи щодо відновлення)."
    ),
    "section2_no_changes_text": "В стані та положенні засобів пеленгації змін немає.",
    "section3_text": (
        "3. Загальна кількість викритих (підтверджених) районів, кількість отриманих "
        "пеленгів (напрямків)."
    ),
    "section4_text": "4. Результати визначення місцеположень джерел (об’єктів) розвідки.",
    # Tables
    "table1_headers": [
        "№ з/п",
        "Військова частина (підрозділ)",
        "Район розташування, номер бойового посту",
        "Озброєння, військова техніка, яка залучена",
        "Хід виконання розвідувальних завдань",
    ],
    "table1_group_label": "3 АК",
    "table2_headers": [
        "№ з/п",
        "Військова частина (підрозділ)",
        "Район розташування, номер бойового посту",
        "Озброєння, військова техніка, яка залучена",
        "Кількість отриманих пеленгів (напрямків)",
        "Примітка",
    ],
    "table2_group_label": "3 АК",
    # Defaults for posts
    "default_unit": "А3719\n(63 омбр)",
    "default_equipment": "“Пластун”",
    "default_task_progress": "Відповідно до плану бойового застосування",
    # Results table
    "results_table_headers": [
        "№",
        "Частота (МГц)",
        "Назва підрозділу",
        "Дата та час",
        "Координати",
    ],
    # Output filename
    "output_filename_pattern": "форма_1.2.13 {date}.docx",
    # Seed posts (empty by default; can be provided in local JSON)
    "posts_seed": [],  # type: ignore[list-item]
}


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        return raw
    except Exception:
        # On any error, fall back to defaults only.
        return {}


def load_config() -> Dict[str, Any]:
    """
    Load peleng report configuration.

    Values from JSON (if present) override DEFAULT_CONFIG on a shallow level.
    For list/dict fields you override the whole value (no deep merge).
    """
    user_conf = _load_json(CONFIG_PATH)
    merged: Dict[str, Any] = dict(DEFAULT_CONFIG)
    merged.update(user_conf)
    return merged


def get_posts_seed(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return posts_seed list from config, with type safety and fallback."""
    seed = config.get("posts_seed", [])
    if isinstance(seed, list):
        # Ensure each item is a dict
        return [x for x in seed if isinstance(x, dict)]
    return []


__all__ = ["load_config", "get_posts_seed", "CONFIG_PATH", "DEFAULT_CONFIG"]

