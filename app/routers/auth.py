"""Автентифікація особи (Фаза 2B.2, варіант B).

Маршрути:
- `GET  /login`  — сторінка входу;
- `POST /login`  — перевірка логін+пароль → сесія;
- `GET  /logout` — вихід;
- `GET/POST /setup` — задати пароль користувачу, **лише з 127.0.0.1** (break-glass
  для першого пароля bootstrap-адміна через SSH-тунель).

Блокування доступу тут НЕМАЄ (це крок 2B.4). Залогінитись можна, але поки не
обов'язково. Паролі задають самі користувачі; у відкритому вигляді не зберігаються.
"""

from __future__ import annotations

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.core.access import (
    current_login,
    set_user_password,
    verify_user_credentials,
)

router = APIRouter(tags=["auth"])

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in _LOCAL_HOSTS


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if current_login(request):
        return RedirectResponse(url="/home", status_code=303)
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "login.html",
        {"request": request, "app_name": request.app.state.app_name, "error": ""},
    )


@router.post("/login", response_class=HTMLResponse)
def login_submit(
    request: Request,
    login: str = Form(default=""),
    password: str = Form(default=""),
):
    user = verify_user_credentials(login, password)
    if not user:
        templates = request.app.state.templates
        return templates.TemplateResponse(
            "login.html",
            {
                "request": request,
                "app_name": request.app.state.app_name,
                "error": "Невірний логін або пароль (або акаунт вимкнено).",
            },
            status_code=401,
        )
    request.session["login"] = user["login"]
    return RedirectResponse(url="/home", status_code=303)


@router.get("/logout")
def logout(request: Request):
    try:
        request.session.pop("login", None)
    except Exception:
        pass
    return RedirectResponse(url="/login", status_code=303)


@router.get("/setup", response_class=HTMLResponse)
def setup_page(request: Request):
    if not _is_local(request):
        return HTMLResponse("Доступно лише з 127.0.0.1 (SSH-тунель).", status_code=403)
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "setup.html",
        {"request": request, "app_name": request.app.state.app_name, "msg": "", "error": ""},
    )


@router.post("/setup", response_class=HTMLResponse)
def setup_submit(
    request: Request,
    login: str = Form(default="admin"),
    password: str = Form(default=""),
    password2: str = Form(default=""),
):
    if not _is_local(request):
        return HTMLResponse("Доступно лише з 127.0.0.1 (SSH-тунель).", status_code=403)
    templates = request.app.state.templates

    def _render(msg: str = "", error: str = "", status: int = 200):
        return templates.TemplateResponse(
            "setup.html",
            {"request": request, "app_name": request.app.state.app_name, "msg": msg, "error": error},
            status_code=status,
        )

    pw = password or ""
    if len(pw) < 8:
        return _render(error="Пароль має бути не коротший за 8 символів.", status=400)
    if pw != (password2 or ""):
        return _render(error="Паролі не збігаються.", status=400)
    if set_user_password(login, pw):
        return _render(msg=f"Пароль для «{login}» встановлено. Тепер можна увійти на /login.")
    return _render(error=f"Користувача «{login}» не знайдено.", status=404)
