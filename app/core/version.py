"""Application version helper.

This module reads the runtime version from `docs/VERSION`. The value is
exposed in the UI (templates) and can be used by endpoints/pages to show
the currently deployed build.

Git revision for the status bar is resolved via :func:`read_git_revision`
(typically on each HTML render): HEAD is read from ``.git`` on disk so a new
local commit shows up without restarting the server; ``APP_GIT_REVISION``
still overrides for container/CI builds.
"""

from __future__ import annotations

import os
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


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _git_dot_dir(root: Path) -> Path | None:
    """Resolve the real `.git` directory (handles worktrees: `.git` as a file)."""
    marker = root / ".git"
    if not marker.exists():
        return None
    if marker.is_dir():
        return marker
    if not marker.is_file():
        return None
    line = marker.read_text(encoding="utf-8", errors="replace").strip()
    if not line.startswith("gitdir:"):
        return None
    rel = line.split(":", 1)[1].strip()
    if not rel:
        return None
    resolved = Path(rel)
    if not resolved.is_absolute():
        resolved = (root / rel).resolve()
    return resolved if resolved.is_dir() else None


def _revision_from_git_files(root: Path) -> tuple[str, str]:
    """Read HEAD commit from `.git` without invoking the ``git`` executable."""
    git_dir = _git_dot_dir(root)
    if git_dir is None:
        return ("", "")
    head_path = git_dir / "HEAD"
    if not head_path.is_file():
        return ("", "")
    line = head_path.read_text(encoding="utf-8", errors="replace").strip()
    if not line:
        return ("", "")
    full = ""
    if line.startswith("ref:"):
        ref = line.split(":", 1)[1].strip()
        ref_file = git_dir / ref
        if ref_file.is_file():
            full = ref_file.read_text(encoding="utf-8", errors="replace").strip()
        else:
            packed = git_dir / "packed-refs"
            if packed.is_file():
                needle = f" {ref}"
                for pline in packed.read_text(encoding="utf-8", errors="replace").splitlines():
                    if pline.endswith(needle):
                        full = pline.split()[0].strip()
                        break
    else:
        full = line
    if len(full) < 7:
        return ("", "")
    short = full[:7]
    return (short, full)


def _git_worktree_dirty(root: Path) -> bool:
    try:
        r = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return r.returncode == 0 and bool((r.stdout or "").strip())
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False


def read_git_revision() -> tuple[str, str]:
    """Return ``(short_display, full_hash)`` for the repository HEAD.

    Resolution order:

    1. Environment ``APP_GIT_REVISION`` (and optional ``APP_GIT_REVISION_FULL``)
       for CI/containers or copies without ``.git``.
    2. Parse ``.git/HEAD`` on disk (no ``git`` binary required). Reflects the
       current checkout immediately after ``git commit`` without restarting
       the app. A trailing ``+`` is added when ``git status --porcelain`` is
       non-empty (requires ``git`` on ``PATH``).
    3. If step 2 fails, fall back to ``git rev-parse`` / ``git status``.

    Both strings are empty if nothing can be resolved.
    """
    root = _repo_root()

    env_short = (os.environ.get("APP_GIT_REVISION") or "").strip()
    if env_short:
        env_full = (os.environ.get("APP_GIT_REVISION_FULL") or "").strip()
        return (env_short, env_full or env_short)

    short, full = _revision_from_git_files(root)
    if short and full:
        display = f"{short}+" if _git_worktree_dirty(root) else short
        return (display, full)

    try:
        r_short = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if r_short.returncode == 0:
            short = (r_short.stdout or "").strip()
            if short:
                r_full = subprocess.run(
                    ["git", "rev-parse", "HEAD"],
                    cwd=str(root),
                    capture_output=True,
                    text=True,
                    timeout=3,
                    check=False,
                )
                full = (r_full.stdout or "").strip() if r_full.returncode == 0 else ""

                dirty = _git_worktree_dirty(root)
                display = f"{short}+" if dirty else short
                return (display, full)
    except FileNotFoundError:
        pass
    except (OSError, subprocess.TimeoutExpired):
        pass

    return ("", "")