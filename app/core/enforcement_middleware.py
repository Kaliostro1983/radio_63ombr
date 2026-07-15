"""Гейт примусу доступу (Фаза 2B.4).

Рівень береться з `enforcement_level()` (app_settings, кеш ~5с):
- **off**       — нічого не блокується (default);
- **mutations** — гейтимо лише зміни (POST/PUT/PATCH/DELETE); перегляд відкритий;
- **full**      — гейтимо все (перегляд теж вимагає входу).

Правила при активному рівні (крім винятків):
1. не автентифікований (не залогінений / акаунт вимкнено): навігація → `/login`,
   інакше `401`;
2. автентифікований, але без активної ролі (пристрій «очікує»): навігація →
   екран очікування, інакше `403`.

Винятки (ніколи не гейтяться): статика, `/favicon.ico`, `/health`, сторінки входу
й самообслуговування (`/login`, `/logout`, `/setup`, `/api/me`, `/change-password`),
телеметрія (`/api/client-errors`) і **машинний інжест** (`/api/ingest/whatsapp`).

ВАЖЛИВО: цей middleware має бути «всередині» SessionMiddleware (додаватись ПЕРШИМ),
щоб на етапі запиту вже була доступна сесія.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse

from app.core.access import enforcement_level, resolve_actor

_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

_EXEMPT_PATHS = {
    "/login", "/logout", "/setup", "/api/me", "/change-password",
    "/favicon.ico", "/health", "/api/client-errors",
    "/ingest/whatsapp", "/api/ingest/whatsapp",
}
_EXEMPT_PREFIXES = ("/static/",)

_PENDING_HTML = """<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Очікування підтвердження</title>
<link rel="stylesheet" href="/static/app.css"></head><body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div style="max-width:440px;text-align:center;background:rgba(127,127,127,.06);border:1px solid var(--border);border-radius:14px;padding:32px">
    <h1 style="font-size:20px;margin:0 0 10px">Робоче місце очікує підтвердження</h1>
    <p style="opacity:.75;line-height:1.6;margin:0 0 18px">
      Ви увійшли, але цьому комп'ютеру ще не призначено роль. Зверніться до
      адміністратора, щоб він увімкнув це робоче місце в розділі «Пристрої».
    </p>
    <a href="/logout" style="display:inline-block;padding:9px 16px;border:1px solid var(--border);border-radius:8px;color:var(--fg);text-decoration:none">Вийти</a>
  </div>
</div></body></html>"""


def _exempt(path: str) -> bool:
    if path in _EXEMPT_PATHS:
        return True
    return any(path.startswith(p) for p in _EXEMPT_PREFIXES)


class EnforcementMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint):
        level = enforcement_level()
        if level == "off":
            return await call_next(request)

        path = request.url.path
        if _exempt(path):
            return await call_next(request)

        mutating = request.method in _MUTATING
        gated = mutating or level == "full"
        if not gated:
            # level == "mutations" і це читання (GET) → пропускаємо.
            return await call_next(request)

        actor = resolve_actor(request)
        navigational = (
            request.method == "GET"
            and "text/html" in request.headers.get("accept", "").lower()
            and not path.startswith("/api/")
        )

        if not actor.authenticated:
            if navigational:
                return RedirectResponse(url="/login", status_code=303)
            return JSONResponse({"ok": False, "error": "Потрібна авторизація"}, status_code=401)

        if not actor.authorized:
            if navigational:
                return HTMLResponse(_PENDING_HTML, status_code=200)
            return JSONResponse(
                {"ok": False, "error": "Робоче місце очікує підтвердження адміністратором"},
                status_code=403,
            )

        return await call_next(request)
