"""Import landmarks from CSV into SQLite database.

Expected CSV contains many fields; importer uses only required columns:
- name -> landmarks.name
- normalized lowercase name -> landmarks.key_word
- coordinates (WKT) -> landmarks.location_wkt
- observation_datetime (or current UTC) -> landmarks.date_creation
- optional comments -> landmarks.comment

Usage examples:
    python -m scripts.import_landmarks_csv
    python -m scripts.import_landmarks_csv --db ./database/radio.db --csv ./database/data.csv
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Iterable


DEFAULT_DB = Path("database/radio.db")
DEFAULT_CSV_CANDIDATES = ("data.csv", "data.scv")
DEFAULT_TYPE_NAME = "imported_csv"


def now_iso() -> str:
    """Return UTC ISO timestamp."""
    return datetime.utcnow().isoformat()


def normalize_keyword(value: str) -> str:
    """Normalize keyword for storage: trim + collapse spaces + lowercase."""
    parts = [p for p in (value or "").strip().split() if p]
    return " ".join(parts).lower()


def location_kind_from_wkt(wkt: str) -> str:
    """Infer location kind from WKT prefix."""
    s = (wkt or "").strip().upper()
    if s.startswith("POINT"):
        return "point"
    if s.startswith("POLYGON"):
        return "polygon"
    if s.startswith("MULTIPOINT"):
        return "multipoint"
    if s.startswith("MULTIPOLYGON"):
        return "multipolygon"
    if s.startswith("LINESTRING"):
        return "linestring"
    if s.startswith("MULTILINESTRING"):
        return "multilinestring"
    return "other"


def safe_get(row: dict, key: str) -> str:
    """Read and trim value from CSV row by key."""
    return str(row.get(key, "") or "").strip()


def resolve_csv_path(explicit_csv: str | None) -> Path:
    """Resolve CSV path from explicit arg or default file names in CWD."""
    if explicit_csv:
        p = Path(explicit_csv)
        if not p.exists():
            raise FileNotFoundError(f"CSV file not found: {p}")
        return p

    for name in DEFAULT_CSV_CANDIDATES:
        p = Path(name)
        if p.exists():
            return p
    raise FileNotFoundError(
        "CSV file not found. Expected one of: "
        + ", ".join(DEFAULT_CSV_CANDIDATES)
        + " in current directory."
    )


def ensure_schema_minimal(conn: sqlite3.Connection) -> None:
    """Fail fast if required tables are missing."""
    required = ("landmark_types", "landmarks")
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)",
        required,
    ).fetchall()
    found = {str(r[0]) for r in rows}
    missing = [t for t in required if t not in found]
    if missing:
        raise RuntimeError(
            "Required tables are missing: "
            + ", ".join(missing)
            + ". Start application once to run DB init/migrations."
        )


def ensure_landmark_type(conn: sqlite3.Connection, type_name: str) -> int:
    """Ensure landmark_types row exists and return its id."""
    row = conn.execute(
        "SELECT id FROM landmark_types WHERE name = ? LIMIT 1",
        (type_name,),
    ).fetchone()
    if row:
        return int(row[0])

    cur = conn.execute(
        "INSERT INTO landmark_types(name) VALUES (?)",
        (type_name,),
    )
    return int(cur.lastrowid)


def iter_csv_rows(csv_path: Path) -> Iterable[dict]:
    """Yield CSV rows as dicts."""
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            yield row


def build_comment(row: dict) -> str:
    """Build optional comment from known source columns."""
    candidates = [
        safe_get(row, "staff_comments"),
        safe_get(row, "comment 1"),
        safe_get(row, "comment 2"),
        safe_get(row, "comment 3"),
        safe_get(row, "comment 4"),
    ]
    parts = [c for c in candidates if c]
    return " | ".join(parts)[:2000]


def import_landmarks(db_path: Path, csv_path: Path, type_name: str) -> tuple[int, int, int]:
    """Import rows into landmarks table.

    Returns:
        tuple(total_rows, inserted_rows, skipped_rows)
    """
    total = 0
    inserted = 0
    skipped = 0

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        ensure_schema_minimal(conn)
        type_id = ensure_landmark_type(conn, type_name)

        existing = conn.execute(
            "SELECT name, key_word, location_wkt, id_type FROM landmarks"
        ).fetchall()
        existing_keys = {
            (
                str(r["name"] or "").strip(),
                str(r["key_word"] or "").strip(),
                str(r["location_wkt"] or "").strip(),
                int(r["id_type"]),
            )
            for r in existing
        }

        payload = []
        for row in iter_csv_rows(csv_path):
            total += 1
            name = safe_get(row, "name")
            location_wkt = safe_get(row, "coordinates")
            if not name or not location_wkt:
                skipped += 1
                continue

            key_word = normalize_keyword(name)
            if not key_word:
                skipped += 1
                continue

            date_creation = safe_get(row, "observation_datetime") or now_iso()
            updated_at = now_iso()
            comment = build_comment(row)
            location_kind = location_kind_from_wkt(location_wkt)

            dedup_key = (name, key_word, location_wkt, type_id)
            if dedup_key in existing_keys:
                skipped += 1
                continue
            existing_keys.add(dedup_key)

            payload.append(
                (
                    name,
                    key_word,
                    location_wkt,
                    location_kind,
                    comment,
                    date_creation,
                    updated_at,
                    None,  # id_group
                    type_id,
                    1,  # is_active
                )
            )

        if payload:
            conn.executemany(
                """
                INSERT INTO landmarks (
                    name, key_word, location_wkt, location_kind, comment,
                    date_creation, updated_at, id_group, id_type, is_active
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                payload,
            )
            inserted = len(payload)

        conn.commit()
        return total, inserted, skipped
    finally:
        conn.close()


def main() -> int:
    """CLI entrypoint."""
    parser = argparse.ArgumentParser(description="Import landmarks from CSV into SQLite.")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to SQLite DB file.")
    parser.add_argument(
        "--csv",
        default=None,
        help="Path to CSV file. If omitted, tries data.csv/data.scv in current folder.",
    )
    parser.add_argument(
        "--type-name",
        default=DEFAULT_TYPE_NAME,
        help="landmark_types.name used for imported rows.",
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: DB file not found: {db_path}")
        return 2

    try:
        csv_path = resolve_csv_path(args.csv)
    except Exception as exc:
        print(f"ERROR: {exc}")
        return 2

    try:
        total, inserted, skipped = import_landmarks(db_path, csv_path, args.type_name)
        print("Import completed.")
        print(f"DB: {db_path}")
        print(f"CSV: {csv_path}")
        print(f"Rows total: {total}")
        print(f"Inserted:   {inserted}")
        print(f"Skipped:    {skipped}")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
