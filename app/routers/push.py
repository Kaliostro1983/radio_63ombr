"""Proxy router — forwards requests to the chat-bot service (port 3001).

Endpoints:
  GET  /api/push/accounts        — list connected messenger accounts
  GET  /api/push/chats           — list chats for a platform
  POST /api/push/send            — send text + optional image to a chat

All endpoints require BOT_SERVICE_URL to be set in config.env
(e.g. BOT_SERVICE_URL=http://localhost:3001).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.config import settings

router = APIRouter()

_ERR_NOT_CFG = {"ok": False, "error": "BOT_SERVICE_URL не налаштовано в config.env"}


def _base() -> str:
    return (settings.bot_service_url or "").rstrip("/")


def _bot_get(path: str, query: str = "") -> Dict[str, Any]:
    url = _base() + path + ("?" + query if query else "")
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read())


def _bot_post(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(
        _base() + path,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _wrap_bot_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read())
        except Exception:
            detail = exc.read().decode(errors="replace")[:300]
        return JSONResponse({"ok": False, "error": detail}, status_code=502)
    return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)


# ---------------------------------------------------------------------------

@router.get("/api/push/accounts")
def api_push_accounts():
    if not settings.bot_service_url:
        return JSONResponse(_ERR_NOT_CFG, status_code=503)
    try:
        return _bot_get("/api/push/accounts")
    except Exception as exc:
        return _wrap_bot_error(exc)


@router.get("/api/push/chats")
def api_push_chats(
    platform: str = "whatsapp",
    refresh: int = 0,
    only_groups: int = 0,
):
    if not settings.bot_service_url:
        return JSONResponse(_ERR_NOT_CFG, status_code=503)
    q = urllib.parse.urlencode({
        "platform":    platform,
        "refresh":     refresh,
        "only_groups": only_groups,
    })
    try:
        return _bot_get("/api/push/chats", q)
    except Exception as exc:
        return _wrap_bot_error(exc)


@router.post("/api/push/send")
async def api_push_send(request: Request):
    if not settings.bot_service_url:
        return JSONResponse(_ERR_NOT_CFG, status_code=503)
    payload: Dict[str, Any] = await request.json()
    # Minimal validation
    if not payload.get("chat_id"):
        return JSONResponse({"ok": False, "error": "chat_id порожній"}, status_code=400)
    if not (payload.get("text") or payload.get("image_base64")):
        return JSONResponse({"ok": False, "error": "Текст та зображення порожні"}, status_code=400)
    try:
        return _bot_post("/api/push/send", payload)
    except Exception as exc:
        return _wrap_bot_error(exc)
