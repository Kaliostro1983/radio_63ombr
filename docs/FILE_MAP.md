# FILE_MAP.md

## Entry Point

app/main.py

Creates FastAPI application and registers routers.

---

## Routers

Location:

app/routers/

Main routers:

networks.py  
all_networks.py  
etalons.py  
callsigns.py  
intercepts.py  
ingest.py  
xlsx_import.py  
peleng.py
landmarks.py  
home.py  
reports.py (HTML `/reports` → редірект на `/home?tab=reports`; POST `/reports/enemy-moves` без змін)  
etalons.py (`/etalons/panel` — еталонка для iframe на `/networks`, без залежності від `?embed=1` після POST)

Routers must remain thin and contain only request/response logic.

---

## Services

Location:

app/services/

Purpose:

Business logic of the system.

Main services:

ingest_service.py  
structured_intercept_service.py  
callsign_service.py  
network_service.py  
network_search.py  
xlsx_import_service.py  
peleng_report_service.py
landmark_match_service.py

---

## Core

Location:

app/core/

Contains reusable logic.

Key modules:

intercept_parser.py  
structured_intercept_parser.py  
normalize.py  
validators.py  
time_utils.py  
callsign_normalizer.py  
config.py (including `LANDMARK_AUTO_MATCH` for optional landmark matching)  
db.py  
http_request_log_middleware.py (middleware: лог кожного HTTP-запиту на вході)  
logging.py

---

## Repositories

Location:

app/repositories/

Specialized database access.

Example:

network_aliases_repository.py

---

## Models

Location:

app/models/

Contains database table definitions.

tables.py

---

## Frontend

Templates:

app/templates  
(`etalons_inner.html` — вміст еталонок; `etalons_embed.html` + `embed_shell.html` — варіант без сайдбару для iframe)

Static files:

app/static

JS modules:

intercepts_explorer.js  
intercepts_search.js  
callsigns.js  
home.js (вкладки Головної: активність, огляд, звіти)  
peleng.js
landmarks.js

---

## Reports

Peleng reporting subsystem:

app/peleng_report

Modules:

parser.py  
report.py  
runner.py  
mgrs.py