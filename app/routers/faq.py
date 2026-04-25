"""Router for the FAQ page."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["faq"])


@router.get("/faq", response_class=HTMLResponse)
def faq_page(request: Request):
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "faq.html",
        {"request": request, "app_name": request.app.state.app_name},
    )
