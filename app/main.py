from __future__ import annotations
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from pathlib import Path

from app.core.config import settings
from app.core.backup import maybe_backup_db
from app.core.db import init_db
from app.routers.networks import router as networks_router
from app.routers.all_networks import router as all_networks_router
from app.routers.etalons import router as etalons_router
from app.routers import peleng
from app.routers.callsigns import router as callsigns_router
from fastapi.templating import Jinja2Templates

from app.routers.intercepts import router as intercepts_router
from app.routers.xlsx_import import router as xlsx_import_router

from app.routers.ingest import router as ingest_router

from fastapi.templating import Jinja2Templates

templates = Jinja2Templates(directory="app/templates")
templates.env.globals["app_version"] = peleng.read_version()

def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name)

    app.add_middleware(SessionMiddleware, secret_key="change_me_please", same_site="lax")

    templates_dir = Path(__file__).parent / "templates"
    app.state.templates = Jinja2Templates(directory=str(templates_dir))
    app.state.app_name = settings.app_name

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    app.include_router(networks_router)
    app.include_router(all_networks_router)
    app.include_router(etalons_router)
    app.include_router(peleng.router)
    app.include_router(ingest_router)
    app.include_router(callsigns_router)
    app.include_router(intercepts_router)
    app.include_router(xlsx_import_router)


    @app.on_event("startup")
    def _startup():
        init_db()
        maybe_backup_db()

    @app.get("/")
    def root():
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url="/networks", status_code=302)

    return app

app = create_app()
