# app/core/structured_intercept_parser.py

import re

DATETIME_RE = re.compile(r"\d{2}\.\d{2}\.\d{4}\s+\d{1,2}:\d{2}:\d{2}")
RECIPIENTS_PREFIX = "Отримувач(і):"
SENDER_PREFIX = "Відправник:"


def _split_recipient_chunks(values: list[str]) -> list[str]:
    result: list[str] = []

    for value in values:
        parts = [p.strip() for p in value.split(",")]
        for part in parts:
            if part:
                result.append(part)

    return result


def parse_structured_intercept(raw_text: str) -> dict:
    lines = [line.rstrip() for line in raw_text.splitlines()]
    nonempty_lines = [line.strip() for line in lines if line.strip()]

    header_line_1 = nonempty_lines[0] if len(nonempty_lines) > 0 else None
    header_line_2 = nonempty_lines[1] if len(nonempty_lines) > 1 else None

    # datetime
    published_at = None
    for line in nonempty_lines:
        m = DATETIME_RE.search(line)
        if m:
            published_at = m.group(0)
            break

    sender = None
    recipients_chunks: list[str] = []

    i = 0
    sender_index = None

    while i < len(nonempty_lines):
        line = nonempty_lines[i]

        if line.startswith(RECIPIENTS_PREFIX):
            value = line.split(":", 1)[1].strip()
            if value:
                recipients_chunks.append(value)

            i += 1
            while i < len(nonempty_lines):
                next_line = nonempty_lines[i]

                if next_line.startswith(SENDER_PREFIX):
                    break

                recipients_chunks.append(next_line)
                i += 1
            continue

        if line.startswith(SENDER_PREFIX):
            sender = line.split(":", 1)[1].strip() or None
            sender_index = i
            break

        i += 1

    recipients = _split_recipient_chunks(recipients_chunks)

    # body starts after sender
    body_lines: list[str] = []

    if sender_index is not None:
        j = sender_index + 1

        while j < len(nonempty_lines) and not nonempty_lines[j].strip():
            j += 1

        if j < len(nonempty_lines):
            body_lines = nonempty_lines[j:]

    body = "\n".join(body_lines).strip()

    return {
        "header_line_1": header_line_1,
        "header_line_2": header_line_2,
        "published_at_text": published_at,
        "sender_raw": sender,
        "recipients_raw": recipients,
        "body": body,
        "message_format": "structured_alias",
    }