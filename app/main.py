"""FastAPI application entrypoint.

This module wires together the core infrastructure of the web application:
it creates the FastAPI app instance, configures middleware, mounts static
assets and templates, and registers all HTTP routers.

The resulting `app` object is used by uvicorn (or another ASGI server) as
the main application, for example:

    uvicorn app.main:app --reload

Routers included here expose UI pages (networks, callsigns, intercepts,
peleng) and API endpoints (ingest, XLSX import). On startup the module
initializes the SQLite database and optionally triggers automatic backups.
"""

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
from app.routers.reports import router as reports_router
from app.routers.home import router as home_router
from app.routers.health import router as health_router
from app.routers.landmarks import router as landmarks_router

from app.routers.ingest import router as ingest_router
from app.services.landmark_match_service import start_landmark_match_worker

from fastapi.templating import Jinja2Templates


def create_app() -> FastAPI:
    """Create and configure the FastAPI application instance.

    The function constructs the main ASGI app used by the project:

    - applies session middleware for cookie-based sessions;
    - registers Jinja2 templates and makes them available via `app.state`;
    - mounts the `/static` endpoint for JS/CSS/media files;
    - includes all feature routers (networks, callsigns, intercepts, peleng, ingest, XLSX import);
    - registers startup hooks to initialize the database and run backups;
    - exposes a root route that redirects to the networks listing.

    Returns:
        FastAPI: fully configured FastAPI application instance ready to be
        served by an ASGI server.
    """
    app = FastAPI(title=settings.app_name)

    app.add_middleware(SessionMiddleware, secret_key="change_me_please", same_site="lax")

    templates_dir = Path(__file__).parent / "templates"
    app.state.templates = Jinja2Templates(directory=str(templates_dir))
    app.state.templates.env.globals["app_version"] = peleng.read_version()
    app.state.app_name = settings.app_name

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    app.include_router(home_router)
    app.include_router(health_router)
    app.include_router(networks_router)
    app.include_router(all_networks_router)
    app.include_router(etalons_router)
    app.include_router(peleng.router)
    app.include_router(ingest_router)
    app.include_router(callsigns_router)
    app.include_router(intercepts_router)
    app.include_router(xlsx_import_router)
    app.include_router(reports_router)
    app.include_router(landmarks_router)


    @app.on_event("startup")
    def _startup():
        """Application startup hook.

        On process start this handler ensures that:

        - the SQLite schema exists and lightweight migrations are applied;
        - a database backup is performed if backup policy deems it necessary.
        """
        init_db()
        maybe_backup_db()
        if settings.landmark_auto_match_enabled:
            start_landmark_match_worker()

    @app.get("/")
    def root():
        """Redirect the root URL to the networks page.

        Returns:
            RedirectResponse: HTTP 302 redirect to `/networks`.
        """
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url="/home", status_code=302)

    return app

app = create_app()
