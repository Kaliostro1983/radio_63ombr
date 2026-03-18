"""Application version helper.

This module reads the runtime version from `docs/VERSION`. The value is
exposed in the UI (templates) and can be used by endpoints/pages to show
the currently deployed build.
"""

from pathlib import Path

def read_version() -> str:
    """Read the application version string from `docs/VERSION`.

    Returns:
        str: version string (e.g. "0.5.0"). If the file is missing, returns
        "0.0.0".
    """
    root = Path(__file__).resolve().parents[2]
    p = root / "docs" / "VERSION"
    if not p.exists():
        return "0.0.0"
    return p.read_text(encoding="utf-8").strip() or "0.0.0"