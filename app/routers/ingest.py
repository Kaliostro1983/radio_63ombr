from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.services.ingest_service import process_whatsapp_payload

router = APIRouter(prefix="/api", tags=["ingest"])


@router.post("/ingest/whatsapp")
async def ingest_whatsapp(request: Request):
    payload = await request.json()
    result = process_whatsapp_payload(payload)

    if not result.get("ok") and result.get("error"):
        return JSONResponse(result, status_code=400)

    return result

    

    
