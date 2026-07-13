"""Адмін-сторінки масштабування (Фаза 2B.3): «Пристрої», «Користувачі».

Ці ендпоінти гейтяться на роль `admin` (навіть до глобального примусу 2B.4),
бо вони новостворені й керують доступом. Актор-адмін визначається із сесії
(логін → `users.role='admin'`).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from app.core.access import VALID_ROLES, is_admin, resolve_actor
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
