"""Адмін-сторінки масштабування (Фаза 2B.3): «Пристрої», «Користувачі».

Ці ендпоінти гейтяться на роль `admin` (навіть до глобального примусу 2B.4),
бо вони новостворені й керують доступом. Актор-адмін визначається із сесії
(логін → `users.role='admin'`).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from app.core.access import (
    VALID_ROLES,
    current_login,
    is_admin,
    resolve_actor,
    set_user_password,
)
from app.core.db import get_conn

router = APIRouter(tags=["admin"])


def _require_admin_api(request: Request):
    """Гейт для JSON-ендпоінтів: 403 якщо не адмін."""
    if not is_admin(request):
        raise HTTPException(status_code=403, detail="Лише для адміністратора")


def _page_guard(request: Request):
    """Гейт для HTML-сторінок: редірект на /login (не залогінений) або 403."""
    actor = resolve_actor(request)
    if not actor.login_verified:
        return RedirectResponse(url="/login", status_code=303)
    if actor.role != "admin":
        return HTMLResponse("403 — лише для адміністратора", status_code=403)
    return None


# ── Пристрої ─────────────────────────────────────────────────────────
@router.get("/admin/devices", response_class=HTMLResponse)
def admin_devices_page(request: Request):
    guard = _page_guard(request)
    if guard is not None:
        return guard
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "admin_devices.html",
        {"request": request, "app_name": request.app.state.app_name},
    )


@router.get("/api/admin/devices")
def api_admin_devices_list(request: Request):
    _require_admin_api(request)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT device_key, label, role, enabled, first_seen_at, last_seen_at, last_ip "
            "FROM devices ORDER BY (role IS NULL) DESC, last_seen_at DESC"
        ).fetchall()
    return {
        "ok": True,
        "roles": list(VALID_ROLES),
        "devices": [
            {
                "device_key": r["device_key"],
                "label": r["label"] or "",
                "role": r["role"] or "",
                "enabled": int(r["enabled"] or 0),
                "first_seen_at": r["first_seen_at"] or "",
                "last_seen_at": r["last_seen_at"] or "",
                "last_ip": r["last_ip"] or "",
            }
            for r in rows
        ],
    }


@router.post("/api/admin/devices/update")
async def api_admin_devices_update(request: Request):
    _require_admin_api(request)
    body = await request.json()
    device_key = str(body.get("device_key") or "").strip()
    if not device_key:
        raise HTTPException(status_code=400, detail="device_key обов'язковий")

    role = body.get("role")
    role = (str(role).strip() or None) if role is not None else None
    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Невідома роль")
    label = str(body.get("label") or "").strip()
    enabled = 1 if body.get("enabled") else 0

    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE devices SET role = ?, label = ?, enabled = ? WHERE device_key = ?",
            (role, label, enabled, device_key),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Пристрій не знайдено")
    return {"ok": True}


@router.post("/api/admin/devices/delete")
async def api_admin_devices_delete(request: Request):
    _require_admin_api(request)
    body = await request.json()
    device_key = str(body.get("device_key") or "").strip()
    if not device_key:
        raise HTTPException(status_code=400, detail="device_key обов'язковий")
    with get_conn() as conn:
        conn.execute("DELETE FROM devices WHERE device_key = ?", (device_key,))
    return {"ok": True}


# ── Користувачі ──────────────────────────────────────────────────────
def _admin_count(conn) -> int:
    return int(
        conn.execute(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND enabled = 1"
        ).fetchone()[0]
    )


@router.get("/admin/users", response_class=HTMLResponse)
def admin_users_page(request: Request):
    guard = _page_guard(request)
    if guard is not None:
        return guard
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "admin_users.html",
        {"request": request, "app_name": request.app.state.app_name},
    )


@router.get("/api/admin/users")
def api_admin_users_list(request: Request):
    _require_admin_api(request)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT login, display_name, role, enabled, pw_hash, must_change_pw, "
            "created_at, last_seen_at FROM users ORDER BY login"
        ).fetchall()
    return {
        "ok": True,
        "roles": list(VALID_ROLES),
        "me": current_login(request),
        "users": [
            {
                "login": r["login"],
                "display_name": r["display_name"] or "",
                "role": r["role"] or "",
                "enabled": int(r["enabled"] or 0),
                "has_password": bool(r["pw_hash"]),
                "must_change_pw": int(r["must_change_pw"] or 0),
                "created_at": r["created_at"] or "",
                "last_seen_at": r["last_seen_at"] or "",
            }
            for r in rows
        ],
    }


@router.post("/api/admin/users/create")
async def api_admin_users_create(request: Request):
    _require_admin_api(request)
    body = await request.json()
    login = str(body.get("login") or "").strip().lower()
    if not login:
        raise HTTPException(status_code=400, detail="Логін обов'язковий")
    role = body.get("role")
    role = (str(role).strip() or None) if role is not None else None
    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Невідома роль")
    display_name = str(body.get("display_name") or "").strip()

    with get_conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM users WHERE lower(login) = ?", (login,)
        ).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="Такий логін уже існує")
        conn.execute(
            "INSERT INTO users (login, display_name, role, enabled, created_by) "
            "VALUES (?, ?, ?, 1, ?)",
            (login, display_name, role, current_login(request) or "admin"),
        )
    return {"ok": True}


@router.post("/api/admin/users/update")
async def api_admin_users_update(request: Request):
    _require_admin_api(request)
    body = await request.json()
    login = str(body.get("login") or "").strip().lower()
    if not login:
        raise HTTPException(status_code=400, detail="Логін обов'язковий")
    role = body.get("role")
    role = (str(role).strip() or None) if role is not None else None
    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Невідома роль")
    display_name = str(body.get("display_name") or "").strip()
    enabled = 1 if body.get("enabled") else 0

    me = (current_login(request) or "").lower()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT role, enabled FROM users WHERE lower(login) = ?", (login,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Користувача не знайдено")
        # Захист від самоблокування / втрати останнього адміна.
        was_admin = row["role"] == "admin" and int(row["enabled"] or 0) == 1
        loses_admin = was_admin and (role != "admin" or enabled == 0)
        if loses_admin and _admin_count(conn) <= 1:
            raise HTTPException(
                status_code=400, detail="Не можна прибрати останнього активного адміністратора"
            )
        if login == me and enabled == 0:
            raise HTTPException(status_code=400, detail="Не можна вимкнути власний акаунт")
        conn.execute(
            "UPDATE users SET display_name = ?, role = ?, enabled = ? WHERE lower(login) = ?",
            (display_name, role, enabled, login),
        )
    return {"ok": True}


@router.post("/api/admin/users/password")
async def api_admin_users_password(request: Request):
    """Адмін задає ТИМЧАСОВИЙ пароль користувачу (той міняє його сам на /change-password)."""
    _require_admin_api(request)
    body = await request.json()
    login = str(body.get("login") or "").strip().lower()
    password = str(body.get("password") or "")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Пароль має бути не коротший за 8 символів")
    if not set_user_password(login, password):
        raise HTTPException(status_code=404, detail="Користувача не знайдено")
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET must_change_pw = 1 WHERE lower(login) = ?", (login,)
        )
    return {"ok": True}


@router.post("/api/admin/users/delete")
async def api_admin_users_delete(request: Request):
    _require_admin_api(request)
    body = await request.json()
    login = str(body.get("login") or "").strip().lower()
    me = (current_login(request) or "").lower()
    if not login:
        raise HTTPException(status_code=400, detail="Логін обов'язковий")
    if login == me:
        raise HTTPException(status_code=400, detail="Не можна видалити власний акаунт")
    with get_conn() as conn:
        row = conn.execute(
            "SELECT role, enabled FROM users WHERE lower(login) = ?", (login,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Користувача не знайдено")
        if row["role"] == "admin" and int(row["enabled"] or 0) == 1 and _admin_count(conn) <= 1:
            raise HTTPException(
                status_code=400, detail="Не можна видалити останнього активного адміністратора"
            )
        conn.execute("DELETE FROM users WHERE lower(login) = ?", (login,))
    return {"ok": True}
