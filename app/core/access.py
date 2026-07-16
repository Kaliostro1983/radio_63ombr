"""Access layer: device-based identity, coarse audit, enforcement level.

Модель (спрощена, без логінів/паролів):
- Ідентичність і роль беруться ВИКЛЮЧНО з ПРИСТРОЮ (`device_key` cookie-токен →
  `devices.role` + `devices.mask`). Адмін = пристрій із роллю `admin`.
- Авторство правок / актор аудиту = Маска пристрою.
- Аварійний доступ (break-glass) — із `127.0.0.1` (обробляється в роутерах/гейті).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Mapping, Optional

from app.core.db import get_db

VALID_ROLES = ("admin", "analyst", "operator")

DEVICE_COOKIE = "device_key"

# Рівень примусу доступу. Джерело істини — app_settings['access_enforce_level'];
# env ENFORCE_ACCESS — fallback. Значення: off | mutations | full.
_ENFORCE_LEVELS = ("off", "mutations", "full")
_ENFORCE_SETTING_KEY = "access_enforce_level"
_ENFORCE_CACHE: dict = {"val": None, "ts": 0.0}
_ENFORCE_TTL = 5.0


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


@dataclass
class Actor:
    """Розв'язаний актор запиту (за пристроєм)."""
    author: str                # Маска пристрою — «хто» (для аудиту/авторства)
    device_key: Optional[str]  # робоче місце (cookie-токен), None якщо немає
    role: Optional[str]        # роль пристрою
    role_enabled: bool         # пристрій увімкнений

    @property
    def authorized(self) -> bool:
        """Пристрій має активну роль."""
        return self.role in VALID_ROLES and self.role_enabled


def resolve_actor_parts(
    cookies: Mapping[str, str],
    client_ip: Optional[str],
) -> Actor:
    """Обчислити актора з примітивів (щоб можна було викликати поза event-loop).

    Ідентичність — лише з пристрою (`device_key` cookie). Автор = Маска пристрою
    (fallback: label → короткий ключ → IP).
    """
    device_key = cookies.get(DEVICE_COOKIE) or None
    author = ""
    role: Optional[str] = None
    role_enabled = False

    if device_key:
        try:
            conn = get_db()
            try:
                row = conn.execute(
                    "SELECT mask, label, role, enabled FROM devices WHERE device_key = ?",
                    (device_key,),
                ).fetchone()
                if row:
                    author = (row["mask"] or "").strip() or (row["label"] or "").strip()
                    if row["role"]:
                        role, role_enabled = row["role"], bool(row["enabled"])
            finally:
                conn.close()
        except Exception:
            pass
        if not author:
            author = device_key[:8]

    if not author:
        author = client_ip or "unknown"

    return Actor(author=author, device_key=device_key, role=role, role_enabled=role_enabled)


def resolve_actor(request) -> Actor:
    """Зручна обгортка для роутів: приймає FastAPI Request."""
    client_ip = request.client.host if request.client else None
    return resolve_actor_parts(request.cookies, client_ip)


def is_admin(request) -> bool:
    """True, якщо пристрій має роль admin (і увімкнений)."""
    a = resolve_actor(request)
    return a.role == "admin" and a.role_enabled


# ── Мінімальні капабіліті (Фаза 3, мінімальний гейт) ─────────────────────────
# Узгоджені обмеження ролі «оператор» (§3.1 плану): без пересилання в
# месенджери (message.forward) та без збереження/зміни аналітичних висновків
# (conclusion.write). admin/analyst мають обидві.
_ROLE_CAPS = {
    "admin": {"message.forward", "conclusion.write"},
    "analyst": {"message.forward", "conclusion.write"},
    "operator": set(),
}

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def require_capability(request, cap: str) -> None:
    """Гейт мутуючого ендпоінта: 403, якщо роль пристрою не має капабіліті.

    Правила:
    - примус off → не блокує (єдиний рубильник відкату — як у EnforcementMiddleware);
    - 127.0.0.1 → break-glass, не блокує;
    - інакше роль пристрою мусить мати `cap` у _ROLE_CAPS.
    """
    if enforcement_level() == "off":
        return
    client_ip = request.client.host if request.client else ""
    if client_ip in _LOCAL_HOSTS:
        return
    actor = resolve_actor(request)
    if actor.authorized and cap in _ROLE_CAPS.get(actor.role or "", set()):
        return
    from fastapi import HTTPException
    raise HTTPException(
        status_code=403,
        detail="Роль вашого робочого місця не дозволяє цю дію. Зверніться до адміністратора.",
    )


def device_mask_for_key(device_key: Optional[str]) -> str:
    """Текст авторства (Маска пристрою). Fallback: mask → label → короткий ключ."""
    if not device_key:
        return ""
    try:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT mask, label FROM devices WHERE device_key = ?", (device_key,)
            ).fetchone()
            if row:
                val = (row["mask"] or "").strip() or (row["label"] or "").strip()
                if val:
                    return val
        finally:
            conn.close()
    except Exception:
        pass
    return device_key[:8]


def current_device_mask(request) -> str:
    """Маска поточного пристрою (для запису «хто змінив»)."""
    dk = request.cookies.get(DEVICE_COOKIE) or getattr(request.state, "device_key", None)
    return device_mask_for_key(dk)


def record_request(
    request_id: Optional[str],
    method: str,
    path: str,
    status: int,
    cookies: Mapping[str, str],
    client_ip: Optional[str],
) -> None:
    """Записати грубий рядок аудиту для одного (не-GET) запиту. Best-effort."""
    try:
        actor = resolve_actor_parts(cookies, client_ip)
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO audit_log "
                "(request_id, actor, actor_role, device_key, ip, method, path, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    request_id,
                    actor.author,
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
    """Авто-реєстрація/оновлення робочого місця. Best-effort.

    Невідомий `device_key` додається як `pending` (роль NULL, `enabled=0`) —
    доступ призначить адмін. Наявний — лише оновлює last_seen/ip.
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
