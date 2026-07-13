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


def _skip(path: str) -> bool:
    return (
        path.startswith("/static/")
        or path.startswith("/api/events")
        or path in ("/favicon.ico", "/health")
    )


class DeviceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint):
        if _skip(request.url.path):
            return await call_next(request)

        device_key = request.cookies.get(DEVICE_COOKIE)
        is_new = not device_key
        if is_new:
            device_key = uuid.uuid4().hex
        request.state.device_key = device_key

        try:
            now = time.monotonic()
            if is_new or (now - _SEEN.get(device_key, 0.0)) > _THROTTLE_SEC:
                _SEEN[device_key] = now
                client_ip = request.client.host if request.client else None
                await run_in_threadpool(register_device, device_key, client_ip)
        except Exception:
            pass

        response = await call_next(request)

        if is_new:
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
