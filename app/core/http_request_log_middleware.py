"""Console request lines to stderr before the response starts (uvicorn access runs later)."""

from __future__ import annotations

import os
import sys

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request

_ENV_LOG_STATIC = os.environ.get("63OMBR_HTTP_LOG_STATIC", "").strip().lower() in (
    "1",
    "true",
    "yes",
)


def _stderr_line(msg: str) -> None:
    try:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()
    except OSError:
        pass


def _skip_path(path: str) -> bool:
    if _ENV_LOG_STATIC:
        return False
    if path == "/favicon.ico":
        return True
    return path.startswith("/static/")


class HttpRequestLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint):
        path = request.url.path
        quiet = _skip_path(path)
        path_qs = path
        if request.url.query:
            path_qs = f"{path_qs}?{request.url.query}"

        client = request.client.host if request.client else "-"
        if not quiet:
            _stderr_line(f"63ombr HTTP >> {client} {request.method} {path_qs}")
        try:
            response = await call_next(request)
        except Exception:
            if not quiet:
                _stderr_line(f"63ombr HTTP !! {request.method} {path_qs} (exception)")
            raise
        if not quiet:
            _stderr_line(f"63ombr HTTP << {request.method} {path_qs} {response.status_code}")
        return response
