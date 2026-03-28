"""Application version helper.

This module reads the runtime version from `docs/VERSION`. The value is
exposed in the UI (templates) and can be used by endpoints/pages to show
the currently deployed build.

Git revision (short hash, dirty marker) is read once at process start for
the status bar so deployments can be distinguished even when `docs/VERSION`
matches another checkout.
"""

from __future__ import annotations

import subprocess
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


def read_git_revision() -> tuple[str, str]:
    """Return ``(short_display, full_hash)`` for the repository HEAD.

    ``short_display`` is ``git rev-parse --short HEAD``, with a trailing
    ``+`` if the working tree has local changes. Both strings are empty if
    git is unavailable or the directory is not a clone.
    """
    root = Path(__file__).resolve().parents[2]
    try:
        r_short = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if r_short.returncode != 0:
            return ("", "")
        short = (r_short.stdout or "").strip()
        if not short:
            return ("", "")

        r_full = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        full = (r_full.stdout or "").strip() if r_full.returncode == 0 else ""

        r_dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        dirty = bool((r_dirty.stdout or "").strip())
        display = f"{short}+" if dirty else short
        return (display, full)
    except (OSError, subprocess.TimeoutExpired):
        return ("", "")