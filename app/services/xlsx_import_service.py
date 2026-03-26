"""XLSX import service for intercepts.

This module implements importing intercept messages from an Excel file.

Usage in the system:

- The web UI allows uploading an `.xlsx` file.
- The router forwards the file path (or uploaded content) to this service.
- The service reads the workbook, extracts message text from a target
  column, and feeds each row into the same ingest pipeline
  (`process_whatsapp_payload`) as real-time sources.

The import result is a summary dict containing counts for processed rows,
inserted messages, duplicates, failures, and skips.
"""

from __future__ import annotations

from typing import Dict, Any
from openpyxl import load_workbook
from pathlib import Path
from uuid import uuid4

from app.services.ingest_service import process_whatsapp_payload
from app.core.logging import get_logger


log = get_logger("xlsx_import_service")


TARGET_COLUMN = "р\\обмін"


def _normalize_header(value) -> str:
    """Normalize an XLSX header cell into a comparable string."""
    if value is None:
        return ""
    return str(value).strip().lower()


def _normalize_cell_text(value: Any) -> str:
    """Normalize an XLSX cell value into clean text for parsing.

    The function:
    - normalizes Windows-style line endings;
    - removes common invisible Unicode characters that break parsers.

    Args:
        value: raw cell value.

    Returns:
        str: cleaned text (may be empty).
    """
    if value is None:
        return ""

    text = str(value)

    # Excel/Windows line endings -> unix
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # прибираємо сміттєві unicode-символи, які часто ламають парсер
    text = text.replace("\u00a0", " ")   # NBSP
    text = text.replace("\u200b", "")    # zero-width space
    text = text.replace("\ufeff", "")    # BOM

    return text.strip()


def import_xlsx(file_path: str) -> Dict[str, Any]:
    """Import intercept messages from an XLSX file.

    Args:
        file_path: path to `.xlsx` file.

    Returns:
        Dict[str, Any]: summary metrics including:
        `total_rows`, `processed`, `inserted`, `duplicates`, `failed`, `skipped`.

    Raises:
        ValueError: if the file is empty or target column is missing.
    """
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
        "reasons": {},
        "reason_samples": {},
    }

    skip_reasons: dict[str, int] = {}
    reason_samples: dict[str, set[str]] = {}
    missing_network_samples: set[str] = set()
    net_line_invalid_count: int = 0

    filename = Path(file_path).name

    def _sample_text(row_no: int, text: str) -> str:
        # Keep row number so user can locate it in XLSX.
        raw = str(text or "")
        # Keep newlines (do not glue), but cap size.
        lines = raw.splitlines()
        head = lines[:8]
        clipped = "\n".join(head)
        if len(lines) > 8:
            clipped += "\n…"
        if len(clipped) > 500:
            clipped = clipped[:500].rstrip() + "…"
        return f"рядок {row_no}:\n{clipped}"

    for row_number, row in enumerate(rows, start=2):
        summary["total_rows"] += 1

        if col_index >= len(row):
            summary["skipped"] += 1
            reason = "xlsx_row_missing_target_column"
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
            continue

        text = _normalize_cell_text(row[col_index])
        if not text:
            summary["skipped"] += 1
            reason = "xlsx_empty_cell"
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
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

            if not result.get("ok", False):
                summary["failed"] += 1
                continue

            if result.get("duplicate"):
                summary["duplicates"] += 1
                continue

            if result.get("message_row_id"):
                summary["inserted"] += 1
                continue

            if result.get("peleng_batch_id"):
                summary["inserted"] += 1
                continue

            summary["skipped"] += 1
            reason = str(result.get("reason") or "skipped")
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
            if reason == "net_line_invalid":
                net_line_invalid_count += 1
            elif len(reason_samples.get(reason, set())) < 5:
                s = reason_samples.setdefault(reason, set())
                s.add(_sample_text(row_number, text))
            if reason == "network_not_found":
                details = result.get("details") or {}
                freq = str(details.get("frequency") or "").strip()
                mask = str(details.get("mask") or "").strip()
                token = freq or mask or text[:80]
                if token:
                    missing_network_samples.add(token)

        except Exception:
            summary["failed"] += 1

    summary["reasons"] = skip_reasons
    summary["reason_samples"] = {
        k: sorted(v)[:5]
        for k, v in reason_samples.items()
        if k not in ("duplicate_message", "duplicate", "duplicates")
    }

    if missing_network_samples:
        sample = sorted(missing_network_samples)[:50]
        log.warning(
            "XLSX import: network_not_found for %d unique tokens. Samples: %s",
            len(missing_network_samples),
            ", ".join(sample),
        )

    # net_line_invalid is a parsing-quality signal; don't spam sample lines.
    # Print exactly one INFO message at the end (if present).
    if net_line_invalid_count > 0:
        log.info(
            "XLSX import: net_line_invalid occurred %d times (parsing degraded, frequency matching was still attempted).",
            net_line_invalid_count,
        )

    if skip_reasons:
        # Use NOTICE so it shows up even when INFO is filtered out.
        log.notice(
            "XLSX import skip reasons breakdown (%d kinds):",
            len(skip_reasons),
        )
        for k, v in sorted(skip_reasons.items(), key=lambda kv: (-kv[1], kv[0])):
            if k == "net_line_invalid":
                # Already reported once as INFO above.
                log.notice("  • %s: count=%d", k, v)
                continue

            samples = sorted(reason_samples.get(k, set()))
            log.notice("  • %s: count=%d", k, v)
            for i, s in enumerate(samples[:5], start=1):
                log.notice("      sample %d: %s", i, s)

    log.notice(
        "XLSX import done: total=%d processed=%d inserted=%d duplicates=%d skipped=%d failed=%d",
        summary["total_rows"],
        summary["processed"],
        summary["inserted"],
        summary["duplicates"],
        summary["skipped"],
        summary["failed"],
    )
    return summary