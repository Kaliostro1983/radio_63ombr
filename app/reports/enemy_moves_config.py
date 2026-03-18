from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


CONFIG_PATH = _repo_root() / "reports_config.json"


DEFAULTS: dict[str, Any] = {
    "moves": {
        "source": "gsheet_csv",  # gsheet_csv | xlsx
        "spreadsheet_id": "",
        "gid": "",
        "xlsx_path": "",
    },
    "enemy_moves": {
        "title": "Звіт про переміщення ворога",
        "subtitle_template": "за результатами радіорозвідки ({date})",
        "group_header_template": "В зоні функціонування {group} виявлено наступні переміщення:",
        "line_template": "{move} (р/м:{freq}, {unit}).",
        "empty_text": "За наявними даними переміщень ворога не зафіксовано.",
        "filename_template": "Переміщення ворога ({date}).docx",
    }
}


def load_reports_config() -> dict[str, Any]:
    """Load local reports configuration (ignored by git)."""
    if not CONFIG_PATH.exists():
        return DEFAULTS
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return DEFAULTS
        merged = dict(DEFAULTS)
        merged.update(raw)
        return merged
    except Exception:
        return DEFAULTS


__all__ = ["CONFIG_PATH", "DEFAULTS", "load_reports_config"]

