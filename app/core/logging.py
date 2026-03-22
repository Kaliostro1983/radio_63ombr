"""Logging utilities for the service.

This module defines a small wrapper around Python's standard `logging`
package:

- adds a custom log level `NOTICE` between INFO and WARNING;
- provides `get_logger` for consistently named loggers that **propagate**
  to the root logger so messages appear in the same console as uvicorn.

Per-logger handlers with `propagate=False` were removed: under uvicorn on
Windows, those often did not show up in the server terminal (or were
heavily buffered), while the root logger is configured by uvicorn.
"""

import logging
import sys

NOTICE = 25
logging.addLevelName(NOTICE, "NOTICE")


def _notice(self, message, *args, **kwargs):
    """Log a message with NOTICE severity on a Logger instance."""
    if self.isEnabledFor(NOTICE):
        self._log(NOTICE, message, args, **kwargs)


logging.Logger.notice = _notice  # type: ignore

_ROOT_FORMAT = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
_root_configured = False


def _ensure_root_logging() -> None:
    """Attach a stderr handler to root if missing; clear root-only NullHandlers."""
    global _root_configured
    root = logging.getLogger()
    if root.handlers:
        if all(isinstance(h, logging.NullHandler) for h in root.handlers):
            root.handlers.clear()
        else:
            _root_configured = True
            return
    if _root_configured:
        return
    logging.basicConfig(
        level=logging.INFO,
        format=_ROOT_FORMAT,
        stream=sys.stderr,
        force=False,
    )
    _root_configured = True


def get_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """Return a logger that propagates to the root (uvicorn) logging setup.

    Args:
        name: logger name (typically module/service name).
        level: minimum level for this logger (default: INFO).

    Returns:
        logging.Logger: configured logger.
    """
    _ensure_root_logging()
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.propagate = True
    return logger
