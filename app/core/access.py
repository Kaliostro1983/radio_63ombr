"""Access layer: actor identity resolution, coarse audit, bootstrap.

Масштабування, Фаза 1 (лог-онлі — НІЧОГО не блокує):

- `resolve_actor_parts()` / `resolve_actor()` — обчислює, ХТО робить запит
  (login), з якого ПРИСТРОЮ (device_key) і яка ЕФЕКТИВНА роль. Роль береться
  переважно з пристрою (§7.6); `users.role` — необов'язковий override
  (зазвичай лише для admin / break-glass).
- `record_request()` — пише грубий рядок у `audit_log` для кожного не-GET
  запиту (викликається з middleware, best-effort).
- `bootstrap_admin()` — засіває bootstrap-адміна, щоб не заблокувати себе у
  наступних фазах.

Примусу прав тут НЕМАЄ — він з'явиться у Фазі 3 (`require(capability)`).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional

from app.core.db import get_db

VALID_ROLES = ("admin", "analyst", "operator")

DEVICE_COOKIE = "device_key"

# Заголовки Tailscale, що несуть саме ЛОГІН користувача (не назву пристрою).
_LOGIN_HEADERS = (
    "tailscale-user-login",
    "x-tailscale-user-login",
    "tailscale-user",
    "x-tailscale-user",
)


@dataclass
class Actor:
    """Розв'язаний актор запиту (Фаза 1 — інформаційно, без примусу)."""
    login: str                 # хто (для аудиту)
    login_verified: bool       # True — з identity-заголовка; False — fallback (IP)
    device_key: Optional[str]  # робоче місце (cookie/Tailscale), None якщо немає
    role: Optional[str]        # ефективна роль: users.role override → devices.role
    role_source: str           # 'user' | 'device' | 'none'
    enabled: bool              # чи активний носій ролі


def _login_from_headers(headers: Mapping[str, str]) -> Optional[str]:
    """Витягти логін користувача з ідентичних Tailscale-заголовків (якщо є)."""
    for name, value in headers.items():
        if name.lower() in _LOGIN_HEADERS and value and value.strip():
            return value.strip()
    return None


def resolve_actor_parts(
    headers: Mapping[str, str],
    cookies: Mapping[str, str],
    client_ip: Optional[str],
) -> Actor:
    """Обчислити актора з примітивів (щоб можна було викликати поза event-loop).

    Фаза 1: identity-проксі ще не налаштовано, тож зазвичай логін = fallback IP.
    Нічого не блокує — лише повертає структуру для логування/майбутнього примусу.
    """
    login_hdr = _login_from_headers(headers)
    if login_hdr:
        login, verified = login_hdr, True
    else:
        login, verified = (client_ip or "unknown"), False

    device_key = cookies.get(DEVICE_COOKIE) or None

    role: Optional[str] = None
    role_source = "none"
    enabled = False

    try:
        conn = get_db()
        try:
            # 1) Override на рівні користувача (зазвичай лише admin / break-glass).
            if login_hdr:
                urow = conn.execute(
                    "SELECT role, enabled FROM users WHERE login = ?", (login,)
                ).fetchone()
                if urow and urow["role"]:
                    role, role_source, enabled = urow["role"], "user", bool(urow["enabled"])
            # 2) Інакше — роль із пристрою (§7.6).
            if role is None and device_key:
                drow = conn.execute(
                    "SELECT role, enabled FROM devices WHERE device_key = ?", (device_key,)
                ).fetchone()
                if drow and drow["role"]:
                    role, role_source, enabled = drow["role"], "device", bool(drow["enabled"])
        finally:
            conn.close()
    except Exception:
        # Фаза 1 не має падати через відсутність таблиць/БД.
        pass

    return Actor(
        login=login,
        login_verified=verified,
        device_key=device_key,
        role=role,
        role_source=role_source,
        enabled=enabled,
    )


def resolve_actor(request) -> Actor:
    """Зручна обгортка для роутів: приймає FastAPI Request."""
    client_ip = request.client.host if request.client else None
    return resolve_actor_parts(request.headers, request.cookies, client_ip)


def record_request(
    request_id: Optional[str],
    method: str,
    path: str,
    status: int,
    headers: Mapping[str, str],
    cookies: Mapping[str, str],
    client_ip: Optional[str],
) -> None:
    """Записати грубий рядок аудиту для одного (не-GET) запиту. Best-effort."""
    try:
        actor = resolve_actor_parts(headers, cookies, client_ip)
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO audit_log "
                "(request_id, actor, actor_role, device_key, ip, method, path, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    request_id,
                    actor.login,
                    actor.role,
                    actor.device_key,
                    client_ip,
                    method,
                    path,
                    int(status) if status is not None else None,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        # Аудит не повинен впливати на обробку запиту.
        pass


def register_device(device_key: str, ip: Optional[str]) -> None:
    """Авто-реєстрація/оновлення робочого місця (Фаза 2B.1). Best-effort.

    Невідомий `device_key` додається як `pending` (роль NULL, `enabled=0`) —
    доступ призначить адмін пізніше (§2.5). Наявний — лише оновлює last_seen/ip.
    Нічого не блокує.
    """
    if not device_key:
        return
    try:
        conn = get_db()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO devices (device_key, first_seen_at, last_seen_at, last_ip) "
                "VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)",
                (device_key, ip),
            )
            conn.execute(
                "UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP, last_ip = ? WHERE device_key = ?",
                (ip, device_key),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def bootstrap_admin() -> None:
    """Засіяти bootstrap-адміна (щоб не заблокувати себе в наступних фазах).

    Логін береться з env `BOOTSTRAP_ADMIN_LOGIN` (default `admin`). Рядок
    створюється лише якщо його ще немає (`INSERT OR IGNORE`).
    """
    login = (os.getenv("BOOTSTRAP_ADMIN_LOGIN") or "admin").strip()
    if not login:
        return
    try:
        conn = get_db()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO users (login, display_name, role, enabled, created_by) "
                "VALUES (?, ?, 'admin', 1, 'bootstrap')",
                (login, "Bootstrap admin"),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
