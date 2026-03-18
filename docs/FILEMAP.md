# File map (radio_63ombr)

Цей документ — коротка мапа важливих файлів/папок проєкту.

## Entry points

- `app/main.py` — створення FastAPI app, підключення роутерів, startup (`init_db()`).
- `run_and_open.ps1` — Windows-скрипт: старт uvicorn → чек `/health` → відкриття `/home`.

## Routers (HTTP)

- `app/routers/health.py` — `GET /health` (readiness).
- `app/routers/home.py` — `/home` + `GET /api/home/activity` (активність р/м).
- `app/routers/networks.py` — сторінка “Радіомережі” (пошук/збереження), теги мереж, дати еталонки.
- `app/routers/intercepts.py` — пошук/перегляд перехоплень.
- `app/routers/xlsx_import.py` — імпорт перехоплень з XLSX (UI/API).
- `app/routers/reports.py` — генерація звітів (DOCX тощо).
- `app/routers/callsigns.py` — “Позивні” (UI/API).
- `app/routers/etalons.py` — “Еталонки” (UI/API).
- `app/routers/peleng.py` — “Пеленгація” (UI/API).

## Templates / Static

- `app/templates/base.html` — базовий шаблон + меню + модалки.
- `app/templates/home.html` — “Головна” (вкладки + UI фільтрів).
- `app/templates/networks.html` — “Радіомережі” (форма, кнопки-теги, дати).
- `app/static/home.js` — рендер таблиць активності.
- `app/static/app.css` — глобальні стилі (в т.ч. heatmap/пігулки).

## DB / schema

- `app/core/db.py` — `SCHEMA_SQL` + lightweight міграції (`_run_lightweight_migrations`).
- `docs/DB_SCHEMA.md` / `docs/db_schema.md` — опис поточної схеми SQLite (людська довідка).

## Ingest / parsing

- `app/services/ingest_service.py` — основний пайплайн ingest.
- `app/services/xlsx_import_service.py` — прогін XLSX-рядків через ingest + метрики/логи причин пропуску.
- `app/services/network_service.py` — резолв мережі (`ensure_network`).
- `app/core/intercept_parser.py` — парсер template-перехоплень (частота нормалізується).

