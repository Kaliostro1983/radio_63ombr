"""Coarse audit middleware (Фаза 1 — лог-онлі).

Пише один рядок у `audit_log` на КОЖЕН змінюючий (не-GET) запит: хто (актор),
роль, пристрій, метод, шлях, статус, request_id, IP. Нічого не блокує; збій
запису аудиту не впливає на обробку запиту.

DB-запис виноситься у threadpool, щоб синхронний SQLite не блокував event-loop.
"""

from __future__ import annotations

import uuid

from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request

from app.core.access import record_request

# Методи, які змінюють дані — саме їх фіксуємо (GET/HEAD/OPTIONS пропускаємо).
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def _skip(path: str) -> bool:
    return path.startswith("/static/") or path == "/favicon.ico"


class AuditLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint):
        request_id = uuid.uuid4().hex[:12]
        request.state.request_id = request_id

        response = await call_next(request)

        try:
            if request.method in _MUTATING and not _skip(request.url.path):
                # Знімок примітивів ДО виходу з обробника (Request потім чіпати не варто).
                headers = {k: v for k, v in request.headers.items()}
                cookies = dict(request.cookies)
                client_ip = request.client.host if request.client else None
                try:
                    session_login = request.session.get("login")
                except Exception:
                    session_login = None
                await run_in_threadpool(
                    record_request,
                    request_id,
                    request.method,
                    request.url.path,
                    response.status_code,
                    headers,
                    cookies,
                    client_ip,
                    session_login,
                )
        except Exception:
            pass

        response.headers["X-Request-Id"] = request_id
        return response
