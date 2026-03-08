from __future__ import annotations

import tempfile
from fastapi import APIRouter, UploadFile, File, HTTPException

from app.services.xlsx_import_service import import_xlsx

router = APIRouter(prefix="/api/import", tags=["xlsx"])


@router.post("/xlsx")
async def import_xlsx_endpoint(file: UploadFile = File(...)):

    if not file.filename.endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files supported")

    try:

        with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        result = import_xlsx(tmp_path)

        return {
            "ok": True,
            "result": result
        }

    except Exception as e:

        raise HTTPException(
            status_code=400,
            detail=str(e)
        )