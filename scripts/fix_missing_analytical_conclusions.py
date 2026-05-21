"""One-time fix: create analytical_conclusions for ingest_messages that were
marked duplicate_content but whose analytical conclusion was never saved.

Run once from project root:
    python scripts/fix_missing_analytical_conclusions.py
"""
from __future__ import annotations
import json, re, sqlite3, sys
from pathlib import Path

# Allow importing app code
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.analytical_intercept_parser import parse_analytical_intercept

DB_PATH = Path(__file__).resolve().parent.parent / "database" / "radio.db"

RE_DUP_MSG = re.compile(r"duplicate of message_id=(\d+)")


def main():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    # Find all analytical_type rows that were marked as duplicate_content
    rows = db.execute(
        """
        SELECT id, raw_text, parse_error
        FROM ingest_messages
        WHERE message_format = 'analytical_type'
          AND parse_status   = 'duplicate_content'
        """
    ).fetchall()

    print(f"Found {len(rows)} duplicate analytical ingest rows to check.")

    saved = 0
    skipped_no_msg = 0
    skipped_no_conclusion = 0
    already_exists = 0

    for row in rows:
        raw_text = row["raw_text"] or ""
        parse_error = row["parse_error"] or ""

        # Extract the target message_id from the parse_error field
        m = RE_DUP_MSG.search(parse_error)
        if not m:
            skipped_no_msg += 1
            continue
        target_msg_id = int(m.group(1))

        # Parse the analytical conclusion from raw_text
        parsed = parse_analytical_intercept(raw_text)
        if not parsed.get("ok"):
            skipped_no_conclusion += 1
            continue

        conclusion_text = (parsed.get("analytical_conclusion") or "").strip()
        if not conclusion_text:
            skipped_no_conclusion += 1
            continue

        mgrs_list = list(parsed.get("analytical_mgrs") or [])

        # Fetch network_id and created_at from the target message
        msg_row = db.execute(
            "SELECT network_id, created_at FROM messages WHERE id = ?",
            (target_msg_id,)
        ).fetchone()
        if not msg_row:
            skipped_no_msg += 1
            continue

        network_id = msg_row["network_id"]
        created_at = msg_row["created_at"]

        # Check if a conclusion for this message already exists
        existing = db.execute(
            "SELECT id FROM analytical_conclusions WHERE message_id = ? LIMIT 1",
            (target_msg_id,)
        ).fetchone()
        if existing:
            already_exists += 1
            continue

        # Insert the missing conclusion
        db.execute(
            """
            INSERT OR IGNORE INTO analytical_conclusions
                (message_id, network_id, created_at, conclusion_text, mgrs_json, type_id)
            VALUES (?, ?, ?, ?, ?, 0)
            """,
            (target_msg_id, network_id, created_at,
             conclusion_text, json.dumps(mgrs_list, ensure_ascii=False))
        )
        saved += 1

    db.commit()
    db.close()

    print(f"Done.")
    print(f"  Saved new conclusions : {saved}")
    print(f"  Already existed       : {already_exists}")
    print(f"  No message found      : {skipped_no_msg}")
    print(f"  No conclusion in text : {skipped_no_conclusion}")


if __name__ == "__main__":
    main()
