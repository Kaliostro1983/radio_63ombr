"""Logging utilities for the service.

This module defines a small wrapper around Python's standard `logging`
package:

- adds a custom log level `NOTICE` between INFO and WARNING;
- provides `get_logger` to create consistently formatted, stdout-based
  loggers used across routers/services.

It intentionally avoids global logging configuration side effects beyond
the custom level and the per-logger handler initialization.
"""

import logging
import sys
from typing import Optional

NOTICE = 25
logging.addLevelName(NOTICE, "NOTICE")


def _notice(self, message, *args, **kwargs):
    """Log a message with NOTICE severity on a Logger instance."""
    if self.isEnabledFor(NOTICE):
        self._log(NOTICE, message, args, **kwargs)


logging.Logger.notice = _notice  # type: ignore


def get_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """Return a configured logger with a consistent stdout formatter.

    The function is idempotent for a given logger name: if handlers are
    already attached, the existing logger is returned without changes.

    Args:
        name: logger name.
        level: initial log level (default: INFO).

    Returns:
        logging.Logger: configured logger instance.
    """
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(level)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
    )
    logger.addHandler(handler)
    logger.propagate = False
    return logger