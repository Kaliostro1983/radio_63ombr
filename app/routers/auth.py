"""Ідентичність за пристроєм (device-only, без логінів/паролів).

Лишається лише `GET /api/me` — для навігації (показати адмін-пункти) та
відлагодження. Роль/автор беруться з пристрою (`device_key` cookie).
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.core.access import current_device_mask, resolve_actor

router = APIRouter(tags=["auth"])


@router.get("/api/me")
def api_me(request: Request):
    """Хто я (за пристроєм). Не блокує."""
    actor = resolve_actor(request)
    return {
        "ok": True,
        "device_key": actor.device_key,
        "mask": current_device_mask(request),
        "role": actor.role,
        "is_admin": actor.role == "admin" and actor.role_enabled,
        "authorized": actor.authorized,
    }
