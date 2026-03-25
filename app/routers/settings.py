"""UI router for application settings page."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["settings"])


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    """Render settings page."""
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "settings.html",
        {
            "request": request,
            "app_name": request.app.state.app_name,
        },
    )

