"""Word-based tagging and approval hints for messages.

This module implements a lightweight text analyzer driven by database
tables:

- `words` holds (tag_id, word, probability, exceptions)
- `tags` holds (id, name, template)

The analyzer scans message text, finds matches by prefix-ish word regexes,
applies exceptions (negative matches), and returns:

- a suggested comment template (from the top-scoring tag),
- whether the message should be flagged as "need approve",
- a JSON payload with match details suitable for storing in `messages.tags_json`.

Usage in the system:

- The ingest pipeline (service layer) can call `load_rules` once and then
  `analyze_text` per message, optionally persisting tags via `persist_message_tags`.
"""

# app/core/text_tag_analyzer.py
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class TagRule:
    """Single word rule associated with a tag."""
    tag_id: int
    tag_name: str
    template: str
    word: str
    probability: int
    exceptions: tuple[str, ...]


@dataclass(frozen=True)
class TagMatch:
    """Aggregated match for a tag built from multiple word matches."""
    tag_id: int
    tag_name: str
    template: str
    score: int
    matched_words: list[str]


@dataclass(frozen=True)
class AnalyzeResult:
    """Result of analyzing a message text against tag rules."""
    comment: str
    need_approve: bool
    tags_json: str
    matches: list[TagMatch]


def _prefix_regex(word: str) -> re.Pattern[str]:
    """Build a regex that matches a word as a prefix of a token.

    For very short words (<3), the match is exact (`\\bword\\b`) to reduce
    false positives. For longer words, the match is prefix-based to catch
    inflections and suffixes (`\\bword[\\w\\-]*`).

    Args:
        word: word token from rule or exception list.

    Returns:
        re.Pattern[str]: compiled regex pattern.
    """
    raw = (word or "").strip().lower().replace("ё", "е")
    escaped = re.escape(raw)
    if len(raw) < 3:
        pattern = rf"\b{escaped}\b"
    else:
        pattern = rf"\b{escaped}[\w\-]*"
    return re.compile(pattern, flags=re.IGNORECASE | re.UNICODE)


def _normalize_text(text: str) -> str:
    """Normalize input text for matching (lowercase + 'ё'->'е')."""
    return (text or "").strip().lower().replace("ё", "е")


def _parse_exceptions(raw: str | None) -> tuple[str, ...]:
    """Parse exceptions value stored in DB into a tuple of strings.

    The DB field may contain:
    - JSON list of strings, or
    - a single raw string.

    Args:
        raw: raw DB value.

    Returns:
        tuple[str, ...]: normalized exception tokens.
    """
    if not raw:
        return ()
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return tuple(str(x).strip().lower() for x in data if str(x).strip())
    except json.JSONDecodeError:
        pass
    value = str(raw).strip().lower()
    return (value,) if value else ()


def load_rules(conn: sqlite3.Connection) -> list[TagRule]:
    """Load tag rules from the database.

    Args:
        conn: open SQLite connection.

    Returns:
        list[TagRule]: rules joined from `words` and `tags`.
    """
    rows = conn.execute(
        """
        SELECT
            t.id,
            t.name,
            t.template,
            w.word,
            w.probability,
            w.exceptions
        FROM words w
        JOIN tags t ON t.id = w.tag_id
        ORDER BY t.id, w.id
        """
    ).fetchall()

    result: list[TagRule] = []
    for row in rows:
        result.append(
            TagRule(
                tag_id=int(row[0]),
                tag_name=str(row[1]),
                template=str(row[2] or ""),
                word=str(row[3]),
                probability=1 if int(row[4] or 0) == 1 else 0,
                exceptions=_parse_exceptions(row[5]),
            )
        )
    return result


def analyze_text(text: str, rules: Iterable[TagRule]) -> AnalyzeResult:
    """Analyze text against tag rules and return matches.

    Args:
        text: message text to analyze.
        rules: iterable of TagRule records, typically loaded from DB.

    Returns:
        AnalyzeResult: match list, JSON payload, suggestion comment, and
        approval flag.
    """
    text_norm = _normalize_text(text)
    grouped: dict[int, TagMatch] = {}

    for rule in rules:
        if not _prefix_regex(rule.word).search(text_norm):
            continue

        blocked = False
        for exc in rule.exceptions:
            if _prefix_regex(exc).search(text_norm):
                blocked = True
                break
        if blocked:
            continue

        current = grouped.get(rule.tag_id)
        if current is None:
            grouped[rule.tag_id] = TagMatch(
                tag_id=rule.tag_id,
                tag_name=rule.tag_name,
                template=rule.template,
                score=rule.probability,
                matched_words=[rule.word],
            )
            continue

        grouped[rule.tag_id] = TagMatch(
            tag_id=current.tag_id,
            tag_name=current.tag_name,
            template=current.template,
            score=current.score + rule.probability,
            matched_words=current.matched_words + [rule.word],
        )

    matches = [m for m in grouped.values() if m.score > 0]
    matches.sort(key=lambda x: (-x.score, x.tag_name))

    need_approve = any(m.score == 1 for m in matches)
    leader = matches[0] if matches else None
    comment = leader.template if leader else ""

    tags_json = json.dumps(
        [
            {
                "tag_id": m.tag_id,
                "tag": m.tag_name,
                "score": m.score,
                "matched_words": m.matched_words,
            }
            for m in matches
        ],
        ensure_ascii=False,
    )

    return AnalyzeResult(
        comment=comment,
        need_approve=need_approve,
        tags_json=tags_json,
        matches=matches,
    )


def persist_message_tags(
    conn: sqlite3.Connection,
    message_id: int,
    matches: Iterable[TagMatch],
) -> None:
    """Persist tag matches for a message into the `message_tags` table.

    The function replaces existing rows for the message.

    Args:
        conn: open SQLite connection.
        message_id: ID of the message in `messages`.
        matches: tag matches to persist.
    """
    rows = [
        (
            message_id,
            m.tag_id,
            m.score,
            json.dumps(m.matched_words, ensure_ascii=False),
        )
        for m in matches
    ]

    conn.execute("DELETE FROM message_tags WHERE message_id = ?", (message_id,))
    if rows:
        conn.executemany(
            """
            INSERT INTO message_tags (
                message_id,
                tag_id,
                score,
                matched_words
            )
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )