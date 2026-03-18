"""SQLite safety helpers for low-level DB interaction.

This module provides a thin wrapper around `cursor.execute` that adds
contextual logging for database errors without changing behaviour of the
underlying sqlite3 driver (exceptions are re-raised).

The goal is to have a single place where DB execution failures are
formatted, making it easier to debug issues in production while keeping
application logic unchanged.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable, Optional


def safe_execute(
    cursor: sqlite3.Cursor | sqlite3.Connection,
    sql: str,
    params: Optional[Iterable[Any]] = None,
    module: str = "",
    function: str = "",
    stage: str = "execute",
):
    """Execute a SQL statement and re-raise sqlite3 errors with context.

    Args:
        cursor: sqlite3 cursor or connection object exposing `.execute`.
        sql: SQL statement to execute.
        params: optional parameters for the statement.
        module: optional module name (for diagnostics only).
        function: optional function name (for diagnostics only).
        stage: optional stage label (e.g. "init", "query", "migration").

    Returns:
        The result of `cursor.execute(...)` if successful.

    Raises:
        sqlite3.Error: re-raised after printing a formatted error message.
    """
    try:
        if params is not None:
            return cursor.execute(sql, params)
        return cursor.execute(sql)
    except sqlite3.Error as e:
        print(
            "[DB ERROR]\n"
            f"module: {module}\n"
            f"function: {function}\n"
            f"stage: {stage}\n"
            f"query: {sql}\n"
            f"error: {e}"
        )
        raise

