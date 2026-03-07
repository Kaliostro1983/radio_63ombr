from pathlib import Path

def read_version() -> str:
    root = Path(__file__).resolve().parents[2]
    p = root / "VERSION"
    if not p.exists():
        return "0.0.0"
    return p.read_text().strip()