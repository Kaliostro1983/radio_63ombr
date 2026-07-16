"""Proxy router — forwards requests to the chat-bot service (port 3001).

Endpoints:
  GET  /api/push/accounts        — list connected messenger accounts
  GET  /api/push/chats           — list chats for a platform
  POST /api/push/send            — send text + optional image to a chat

All endpoints require BOT_SERVICE_URL to be set in config.env
(e.g. BOT_SERVICE_URL=http://localhost:3001).

Logging strategy для /api/push/send:
  - Кожен запит отримує короткий request_id (8 hex символів).
  - У journalctl пишемо `push_send_start` (з усіма параметрами запиту)
    і `push_send_done`/`push_send_error` з тривалістю та категорією помилки.
  - Паралельно в SQLite-таблицю `push_send_log` пишемо рядок на КОЖНУ
    спробу (успіх або фейл) — для подальшої агрегації частоти збоїв.
  - Категорії помилок: `validation`, `not_configured`, `timeout`,
    `connection_refused`, `dns`, `swbot_4xx`, `swbot_5xx`,
    `bad_response`, `other`.
"""

from __future__ import annotations

import json
import socket
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.access import require_capability
from app.core.config import settings
from app.core.db import get_conn
from app.core.logging import get_logger

router = APIRouter()

log = get_logger("push")

_ERR_NOT_CFG = {"ok": False, "error": "BOT_SERVICE_URL не налаштовано в config.env"}


def _base() -> str:
    return (settings.bot_service_url or "").rstrip("/")


def _bot_get(path: str, query: str = "") -> Dict[str, Any]:
    url = _base() + path + ("?" + query if query else "")
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read())


def _bot_post(path: str, payload: Dict[str, Any], timeout: int = 90,
              extra_headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        _base() + path,
        data=body,
        headers=headers,
        method="POST",
    )
    # Надсилання зображення через месенджер може тривати десятки секунд,
    # тому таймаут великий (раніше 15с → стабільні 502 на картах зі скріншотом).
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _wrap_bot_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read())
        except Exception:
            detail = exc.read().decode(errors="replace")[:300]
        return JSONResponse({"ok": False, "error": detail}, status_code=502)
    # Таймаут сокета (бот не відповів вчасно) — окреме зрозуміле повідомлення.
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return JSONResponse(
            {"ok": False, "error": "Бот-сервіс не відповів вчасно — надсилання могло не завершитися"},
            status_code=504,
        )
    return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)


def _classify_exception(exc: Exception) -> Tuple[str, int, str]:
    """Повертає (category, http_status, short_detail)."""
    if isinstance(exc, urllib.error.HTTPError):
        try:
            body = exc.read().decode(errors="replace")[:300]
        except Exception:
            body = ""
        cat = "swbot_4xx" if 400 <= exc.code < 500 else "swbot_5xx"
        return cat, exc.code, body or f"HTTP {exc.code}"
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "timeout", 504, "socket timeout"
    if isinstance(exc, urllib.error.URLError):
        reason = str(getattr(exc, "reason", "")) or "url error"
        low = reason.lower()
        if "refused" in low:
            return "connection_refused", 502, reason
        if "name or service" in low or "getaddrinfo" in low or "dns" in low:
            return "dns", 502, reason
        return "other", 502, reason
    if isinstance(exc, json.JSONDecodeError):
        return "bad_response", 502, "non-JSON response"
    return "other", 502, str(exc)[:300]


def _log_db(
    req_id: str,
    platform: str,
    chat_id: str,
    text_len: int,
    image_size: int,
    http_status: int,
    duration_ms: int,
    success: bool,
    error_category: str = "",
    error_detail: str = "",
) -> None:
    """Записує одну спробу у push_send_log. Best-effort: помилка DB не валить
    основний send-флоу."""
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO push_send_log "
                "(request_id, platform, chat_id, text_len, image_size, "
                " http_status, duration_ms, success, error_category, error_detail) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    req_id,
                    str(platform or "")[:32],
                    str(chat_id or "")[:128],
                    int(text_len or 0),
                    int(image_size or 0),
                    int(http_status or 0),
                    int(duration_ms or 0),
                    1 if success else 0,
                    str(error_category or "")[:32],
                    str(error_detail or "")[:500],
                ),
            )
            conn.commit()
    except Exception as exc:
        log.warning("push_send_log insert failed: %s", exc)


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


@router.post("/api/client-errors")
async def api_client_errors(request: Request):
    """Прийом помилок з клієнта (Шар 3): передранні падіння до спроби надсилання,
    html2canvas failed, fetch timeout тощо. Best-effort, без валідації клієнта."""
    try:
        payload: Dict[str, Any] = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)

    page     = str(payload.get("page") or "")[:128]
    action   = str(payload.get("action") or "")[:64]
    category = str(payload.get("category") or "")[:32]
    detail   = str(payload.get("detail") or "")[:500]
    ua       = str(payload.get("user_agent") or "")[:256]
    extra    = payload.get("extra") or {}
    try:
        extra_json = json.dumps(extra, ensure_ascii=False)[:2000]
    except Exception:
        extra_json = ""

    log.warning(
        "client_error page=%s action=%s category=%s detail=%s",
        page, action, category, detail[:200],
    )

    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO client_error_log "
                "(page, action, error_category, detail, user_agent, extra_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (page, action, category, detail, ua, extra_json),
            )
            conn.commit()
    except Exception as exc:
        log.warning("client_error insert failed: %s", exc)
        return JSONResponse({"ok": False, "error": str(exc)[:200]}, status_code=500)
    return {"ok": True}


@router.post("/api/push/send")
async def api_push_send(request: Request):
    require_capability(request, "message.forward")
    req_id = uuid.uuid4().hex[:8]
    started = time.monotonic()
    payload: Dict[str, Any] = {}
    platform = chat_id = ""
    text_len = image_size = 0

    if not settings.bot_service_url:
        log.warning("push_send_error req_id=%s category=not_configured", req_id)
        _log_db(req_id, "", "", 0, 0, 503, 0, False, "not_configured", "BOT_SERVICE_URL")
        return JSONResponse(_ERR_NOT_CFG, status_code=503)

    try:
        payload = await request.json()
    except Exception as exc:
        log.warning("push_send_error req_id=%s category=validation msg=%s", req_id, exc)
        _log_db(req_id, "", "", 0, 0, 400, 0, False, "validation", f"bad json: {exc}"[:300])
        return JSONResponse({"ok": False, "error": "Невалідний JSON"}, status_code=400)

    platform = str(payload.get("platform") or "")
    chat_id  = str(payload.get("chat_id") or "")
    text_len = len(str(payload.get("text") or ""))
    image_size = len(str(payload.get("image_base64") or ""))

    log.info(
        "push_send_start req_id=%s platform=%s chat_id=%s text_len=%d image_size=%d",
        req_id, platform, chat_id[:64], text_len, image_size,
    )

    # Minimal validation
    if not chat_id:
        dur = int((time.monotonic() - started) * 1000)
        log.warning("push_send_error req_id=%s category=validation msg=chat_id_empty", req_id)
        _log_db(req_id, platform, "", text_len, image_size, 400, dur, False, "validation", "chat_id empty")
        return JSONResponse({"ok": False, "error": "chat_id порожній"}, status_code=400)
    if not (text_len or image_size):
        dur = int((time.monotonic() - started) * 1000)
        log.warning("push_send_error req_id=%s category=validation msg=empty_payload", req_id)
        _log_db(req_id, platform, chat_id, text_len, image_size, 400, dur, False, "validation", "text+image empty")
        return JSONResponse({"ok": False, "error": "Текст та зображення порожні"}, status_code=400)

    try:
        result = _bot_post(
            "/api/push/send",
            payload,
            extra_headers={"X-Request-Id": req_id},
        )
        dur = int((time.monotonic() - started) * 1000)
        ok = bool(result.get("ok"))
        if ok:
            log.info("push_send_done req_id=%s duration_ms=%d", req_id, dur)
            _log_db(req_id, platform, chat_id, text_len, image_size, 200, dur, True, "", "")
        else:
            err = str(result.get("error") or "")[:300]
            log.warning(
                "push_send_error req_id=%s category=bad_response duration_ms=%d msg=%s",
                req_id, dur, err,
            )
            _log_db(req_id, platform, chat_id, text_len, image_size, 200, dur, False,
                    "bad_response", err)
        return result
    except Exception as exc:
        dur = int((time.monotonic() - started) * 1000)
        category, http_status, detail = _classify_exception(exc)
        log.warning(
            "push_send_error req_id=%s category=%s duration_ms=%d status=%d msg=%s",
            req_id, category, dur, http_status, detail[:200],
        )
        _log_db(req_id, platform, chat_id, text_len, image_size, http_status, dur, False,
                category, detail)
        return _wrap_bot_error(exc)
