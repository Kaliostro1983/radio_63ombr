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
from fastapi.responses import Response, FileResponse

from app.core.http_request_log_middleware import HttpRequestLogMiddleware
from app.core.audit_middleware import AuditLogMiddleware
from app.core.enforcement_middleware import EnforcementMiddleware
from app.core.device_middleware import DeviceMiddleware
from app.core.config import settings
from app.core.version import read_git_revision
from app.core.backup import maybe_backup_db
from app.core.db import init_db
from app.core.access import bootstrap_admin
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
from app.routers.import_export import router as import_export_router
from app.routers.conclusions import router as conclusions_router
from app.routers.dictionary import router as dictionary_router
from app.routers.push import router as push_router
from app.routers.casualties import router as casualties_router
from app.routers.faq import router as faq_router
from app.routers.overview import router as overview_router
from app.routers.auth import router as auth_router
from app.routers.admin import router as admin_router
from app.routers.palettes import router as palettes_router
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

    # Масштабування, Фаза 2B.4: гейт примусу. Додається ПЕРШИМ, щоб бути
    # «всередині» SessionMiddleware і бачити сесію на етапі запиту. Рівень —
    # off/mutations/full з app_settings (default off, тож наразі no-op).
    app.add_middleware(EnforcementMiddleware)
    app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")
    app.add_middleware(HttpRequestLogMiddleware)
    # Масштабування, Фаза 1: грубий аудит кожного не-GET запиту (лог-онлі).
    app.add_middleware(AuditLogMiddleware)
    # Масштабування, Фаза 2B.1: видача device_key + авто-реєстрація пристрою (не блокує).
    app.add_middleware(DeviceMiddleware)

    templates_dir = Path(__file__).parent / "templates"
    app.state.templates = Jinja2Templates(directory=str(templates_dir))
    app.state.templates.env.globals["app_version"] = peleng.read_version()
    # Callable: revision is read on each render so local commits show without restarting uvicorn.
    app.state.templates.env.globals["get_app_git_revision"] = read_git_revision
    app.state.app_name = settings.app_name

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(home_router)
    app.include_router(health_router)
    app.include_router(networks_router)
    app.include_router(all_networks_router)
    app.include_router(etalons_router)
    app.include_router(peleng.router)
    app.include_router(ingest_router)
    app.include_router(import_export_router)
    app.include_router(callsigns_router)
    app.include_router(intercepts_router)
    app.include_router(xlsx_import_router)
    app.include_router(reports_router)
    app.include_router(landmarks_router)
    app.include_router(conclusions_router)
    app.include_router(dictionary_router)
    app.include_router(push_router)
    app.include_router(casualties_router)
    app.include_router(overview_router)
    app.include_router(palettes_router)
    app.include_router(faq_router)


    @app.on_event("startup")
    def _startup():
        """Application startup hook.

        On process start this handler ensures that:

        - the SQLite schema exists and lightweight migrations are applied;
        - a database backup is performed if backup policy deems it necessary.
        """
        init_db()
        # Масштабування, Фаза 1: засіяти bootstrap-адміна (щоб не заблокувати себе).
        bootstrap_admin()
        maybe_backup_db()
        if settings.landmark_auto_match_enabled:
            start_landmark_match_worker()
        # Background re-send of conclusions whose one-shot ingest Delta send
        # failed (transient blip). Self-heals recent failures, throttled.
        from app.services.ingest_service import start_delta_resend_worker
        start_delta_resend_worker()

    @app.get("/")
    def root():
        """Redirect the root URL to the networks page.

        Returns:
            RedirectResponse: HTTP 302 redirect to `/networks`.
        """
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url="/home", status_code=302)

    @app.get("/favicon.ico", include_in_schema=False)
    def favicon():
        """Serve favicon for browser tab (avoid noisy 404 logs)."""
        favicon_path = Path(__file__).parent / "static" / "favicon.ico"
        if favicon_path.exists():
            return FileResponse(str(favicon_path))
        return Response(status_code=204)

    return app

app = create_app()
