from __future__ import annotations

from typing import Dict, Any
from openpyxl import load_workbook
from pathlib import Path

from uuid import uuid4


from app.services.ingest_service import process_whatsapp_payload


TARGET_COLUMN = "р\\обмін"


def _normalize_header(value) -> str:
    if value is None:
        return ""
    return str(value).strip().lower()


def import_xlsx(file_path: str) -> Dict[str, Any]:
    
    import_session_id = uuid4().hex

    wb = load_workbook(filename=file_path, read_only=True, data_only=True)
    sheet = wb.worksheets[0]

    rows = sheet.iter_rows(values_only=True)

    try:
        header = next(rows)
    except StopIteration:
        raise ValueError("XLSX file is empty")

    headers = [_normalize_header(x) for x in header]

    if TARGET_COLUMN not in headers:
        raise ValueError("Column 'р/обмін' not found")

    col_index = headers.index(TARGET_COLUMN)

    summary = {
        "total_rows": 0,
        "processed": 0,
        "inserted": 0,
        "duplicates": 0,
        "failed": 0,
        "skipped": 0,
    }

    filename = Path(file_path).name

    for row_number, row in enumerate(rows, start=2):

        summary["total_rows"] += 1

        if col_index >= len(row):
            summary["skipped"] += 1
            continue

        text = row[col_index]

        if text is None:
            summary["skipped"] += 1
            continue

        text = str(text).strip()

        if not text:
            summary["skipped"] += 1
            continue

        payload = {
            "platform": "xlsx",
            "chat_id": "xlsx_import",
            "chat_name": filename,
            "message_id": f"{import_session_id}:{filename}:{row_number}",
            "text": text,
        }

        try:

            result = process_whatsapp_payload(payload)

            summary["processed"] += 1

            if result.get("duplicate"):
                summary["duplicates"] += 1
            else:
                summary["inserted"] += 1

        except Exception:
            summary["failed"] += 1

    return summary