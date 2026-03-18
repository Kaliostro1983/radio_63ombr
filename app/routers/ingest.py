"""HTTP router for ingest endpoints.

This router exposes API endpoints that accept incoming intercept payloads
from external sources (e.g., a WhatsApp bot integration).

The router is intentionally thin: it validates/parses the HTTP request
payload and forwards it to the service layer (`process_whatsapp_payload`),
returning a JSON response.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.services.ingest_service import process_whatsapp_payload

router = APIRouter(prefix="/api", tags=["ingest"])


@router.post("/ingest/whatsapp")
async def ingest_whatsapp(request: Request):
    """Ingest a WhatsApp-style JSON payload.

    The endpoint expects a JSON body that is passed as-is to
    `process_whatsapp_payload`.

    Args:
        request: FastAPI request containing a JSON payload.

    Returns:
        dict | JSONResponse: service result dict. If the service reports a
        hard error (`ok=False` + `error`), returns HTTP 400.
    """
    payload = await request.json()
    result = process_whatsapp_payload(payload)

    if not result.get("ok") and result.get("error"):
        return JSONResponse(result, status_code=400)

    return result

    

    
