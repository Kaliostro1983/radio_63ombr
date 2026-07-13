"""Device-identity middleware (Фаза 2B.1 — не блокує).

Видає кожному браузеру/ПК постійний `device_key` (httpOnly-cookie) на першому
візиті й авто-реєструє пристрій у таблиці `devices` як `pending`. Роль пристрою
призначає адмін пізніше (§2.5). Тут НІЧОГО не блокується — лише встановлюється
cookie й оновлюється last_seen (з троттлінгом, щоб не писати в БД на кожен запит).
"""

from __future__ import annotations

import time
import uuid

from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request

from app.core.access import DEVICE_COOKIE, register_device

# Троттлінг запису last_seen: не частіше ніж раз на N секунд на пристрій.
_SEEN: dict[str, float] = {}
_THROTTLE_SEC = 60.0
# ~2 роки; пристрій — стабільна прив'язка робочого місця.
_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2


def _is_navigational(request: Request) -> bool:
    """Чи це реальне відкриття сторінки браузером (а не API/XHR/curl/бот).

    Лише такі запити отримують новий `device_key` + реєстрацію, інакше таблиця
    `devices` засмічується безкукішними API/health/favicon/curl-запитами.
    """
    if request.method != "GET":
        return False
    path = request.url.path
    if (
        path.startswith("/static/")
        or path.startswith("/api/")
        or path in ("/favicon.ico", "/health")
    ):
        return False
    return "text/html" in request.headers.get("accept", "").lower()


class DeviceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint):
        device_key = request.cookies.get(DEVICE_COOKIE)
        issue_new = False

        if not device_key:
            # Новий пристрій реєструємо ЛИШЕ на навігаційному завантаженні сторінки.
            if _is_navigational(request):
                device_key = uuid.uuid4().hex
                issue_new = True
            else:
                request.state.device_key = None
                return await call_next(request)

        request.state.device_key = device_key

        try:
            now = time.monotonic()
            if issue_new or (now - _SEEN.get(device_key, 0.0)) > _THROTTLE_SEC:
                _SEEN[device_key] = now
                client_ip = request.client.host if request.client else None
                await run_in_threadpool(register_device, device_key, client_ip)
        except Exception:
            pass

        response = await call_next(request)

        if issue_new:
            # secure=False — поки HTTP у межах Tailscale (HTTPS-хардненг — пізніше).
            response.set_cookie(
                DEVICE_COOKIE,
                device_key,
                max_age=_COOKIE_MAX_AGE,
                httponly=True,
                samesite="lax",
                path="/",
            )
        return response
