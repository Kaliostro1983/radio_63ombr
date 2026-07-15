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
import time
from dataclasses import dataclass
from typing import Mapping, Optional

from app.core.db import get_db
from app.core.passwords import hash_password, verify_password

VALID_ROLES = ("admin", "analyst", "operator")

DEVICE_COOKIE = "device_key"
SESSION_LOGIN_KEY = "login"

# Рівень примусу доступу (2B.4). Джерело істини — app_settings['access_enforce_level'];
# env ENFORCE_ACCESS — лише fallback. Значення: off | mutations | full.
_ENFORCE_LEVELS = ("off", "mutations", "full")
_ENFORCE_SETTING_KEY = "access_enforce_level"
_ENFORCE_CACHE: dict = {"val": None, "ts": 0.0}
_ENFORCE_TTL = 5.0  # сек — щоб зміну підхоплювало швидко, але не бити БД щоразу


def enforcement_level() -> str:
    """Поточний рівень примусу (кешовано ~5с). Читає app_settings, fallback — env."""
    now = time.monotonic()
    if _ENFORCE_CACHE["val"] is not None and (now - _ENFORCE_CACHE["ts"]) < _ENFORCE_TTL:
        return _ENFORCE_CACHE["val"]

    val = None
    try:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?", (_ENFORCE_SETTING_KEY,)
            ).fetchone()
            if row and row["value"]:
                v = str(row["value"]).strip().lower()
                if v in _ENFORCE_LEVELS:
                    val = v
        finally:
            conn.close()
    except Exception:
        val = None

    if val is None:
        env = (os.getenv("ENFORCE_ACCESS") or "").strip().lower()
        if env == "full":
            val = "full"
        elif env in ("1", "true", "yes", "on", "mutations"):
            val = "mutations"
        else:
            val = "off"

    _ENFORCE_CACHE["val"] = val
    _ENFORCE_CACHE["ts"] = now
    return val

# Заголовки Tailscale, що несуть саме ЛОГІН користувача (не назву пристрою).
_LOGIN_HEADERS = (
    "tailscale-user-login",
    "x-tailscale-user-login",
    "tailscale-user",
    "x-tailscale-user",
)


@dataclass
class Actor:
    """Розв'язаний актор запиту."""
    login: str                 # хто (для аудиту)
    login_verified: bool       # True — залогінений (сесія); False — fallback (IP)
    user_known: bool           # логін є в таблиці users
    user_enabled: bool         # акаунт користувача активний
    device_key: Optional[str]  # робоче місце (cookie), None якщо немає
    role: Optional[str]        # ефективна роль: users.role override → devices.role
    role_source: str           # 'user' | 'device' | 'none'
    role_enabled: bool         # носій ролі (user-override або device) активний

    @property
    def authenticated(self) -> bool:
        """Особа підтверджена й акаунт активний."""
        return self.login_verified and self.user_known and self.user_enabled

    @property
    def authorized(self) -> bool:
        """Має активну роль (з пристрою або override) поверх автентифікації."""
        return self.authenticated and (self.role in VALID_ROLES) and self.role_enabled


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
    session_login: Optional[str] = None,
) -> Actor:
    """Обчислити актора з примітивів (щоб можна було викликати поза event-loop).

    Варіант B (§7.1): особа (актор) = залогінений app-логін із сесії; якщо не
    залогінений — fallback на Tailscale-заголовок або IP (для спостереження).
    Роль — переважно з ПРИСТРОЮ (§7.6); `users.role` — override (зазвичай admin).
    Нічого не блокує — лише повертає структуру для логування/майбутнього примусу.
    """
    if session_login:
        login, verified = session_login, True
    else:
        hdr = _login_from_headers(headers)
        if hdr:
            login, verified = hdr, True
        else:
            login, verified = (client_ip or "unknown"), False

    device_key = cookies.get(DEVICE_COOKIE) or None

    user_known = False
    user_enabled = False
    role: Optional[str] = None
    role_source = "none"
    role_enabled = False

    try:
        conn = get_db()
        try:
            # 1) Особа (лише для ВЕРИФІКОВАНОГО логіну) + override ролі.
            if verified:
                urow = conn.execute(
                    "SELECT role, enabled FROM users WHERE lower(login) = ?",
                    (login.strip().lower(),),
                ).fetchone()
                if urow:
                    user_known = True
                    user_enabled = bool(urow["enabled"])
                    if urow["role"]:
                        role, role_source, role_enabled = urow["role"], "user", user_enabled
            # 2) Інакше — роль із пристрою (§7.6).
            if role is None and device_key:
                drow = conn.execute(
                    "SELECT role, enabled FROM devices WHERE device_key = ?", (device_key,)
                ).fetchone()
                if drow and drow["role"]:
                    role, role_source, role_enabled = drow["role"], "device", bool(drow["enabled"])
        finally:
            conn.close()
    except Exception:
        pass

    return Actor(
        login=login,
        login_verified=verified,
        user_known=user_known,
        user_enabled=user_enabled,
        device_key=device_key,
        role=role,
        role_source=role_source,
        role_enabled=role_enabled,
    )


def _session_login(request) -> Optional[str]:
    try:
        v = request.session.get(SESSION_LOGIN_KEY)
        return v or None
    except Exception:
        return None


def resolve_actor(request) -> Actor:
    """Зручна обгортка для роутів: приймає FastAPI Request."""
    client_ip = request.client.host if request.client else None
    return resolve_actor_parts(
        request.headers, request.cookies, client_ip, _session_login(request)
    )


def current_login(request) -> Optional[str]:
    """Логін залогіненої особи із сесії (None якщо не залогінений)."""
    return _session_login(request)


def is_admin(request) -> bool:
    """True, якщо залогінена особа має ефективну роль admin."""
    return resolve_actor(request).role == "admin"


# ── App-логін особи (Фаза 2B.2) ──────────────────────────────────────
def get_user(login: str) -> Optional[dict]:
    """Повний рядок користувача або None. Логін нечутливий до регістру."""
    login = (login or "").strip().lower()
    if not login:
        return None
    try:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT login, display_name, role, enabled, pw_hash, pw_salt, pw_algo, "
                "must_change_pw FROM users WHERE lower(login) = ?",
                (login,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception:
        return None


def verify_user_credentials(login: str, password: str) -> Optional[dict]:
    """Перевірити логін+пароль. Повертає {login, role, display_name} або None."""
    row = get_user(login)
    if not row or not row.get("enabled"):
        return None
    if not verify_password(password, row.get("pw_algo"), row.get("pw_salt"), row.get("pw_hash")):
        return None
    return {"login": row["login"], "role": row["role"], "display_name": row["display_name"]}


def set_user_password(login: str, password: str) -> bool:
    """Задати/скинути пароль користувача. Повертає True якщо оновлено."""
    login = (login or "").strip().lower()
    if not login or not password:
        return False
    algo, salt, h = hash_password(password)
    try:
        conn = get_db()
        try:
            cur = conn.execute(
                "UPDATE users SET pw_algo = ?, pw_salt = ?, pw_hash = ?, must_change_pw = 0 "
                "WHERE lower(login) = ?",
                (algo, salt, h, login),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()
    except Exception:
        return False


def record_request(
    request_id: Optional[str],
    method: str,
    path: str,
    status: int,
    headers: Mapping[str, str],
    cookies: Mapping[str, str],
    client_ip: Optional[str],
    session_login: Optional[str] = None,
) -> None:
    """Записати грубий рядок аудиту для одного (не-GET) запиту. Best-effort."""
    try:
        actor = resolve_actor_parts(headers, cookies, client_ip, session_login)
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
