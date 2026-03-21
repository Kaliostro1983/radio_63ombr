
# ARCHITECTURE.md

## Project Overview

Radio intercept processing system built with:

- FastAPI
- SQLite
- Jinja2 templates
- Vanilla JavaScript frontend

The system receives radio intercept messages from external sources (WhatsApp / XLSX import), parses them, links callsigns, and stores structured data in the database.

The application also provides a UI for exploring intercepts, editing metadata, and generating peleng reports.

Application entrypoint:

app/main.py

---

# High-Level Architecture

The application follows layered architecture:

Routers → Services → Core / Repositories → Database

Frontend:

Templates (Jinja2)
Static JS/CSS

---

# Application Entrypoint

File: app/main.py

Responsibilities:

- create FastAPI application
- configure middleware
- mount static files
- initialize database
- register routers

Registered routers:

- networks
- all_networks
- etalons
- peleng
- ingest
- callsigns
- intercepts
- xlsx_import
- landmarks

---

# Router Layer

Location:

app/routers/

Routers define HTTP endpoints and must remain thin.

Routers should:

- accept request
- validate input
- call service layer
- return response

Routers must not contain business logic.

Example endpoint:

POST /api/ingest/whatsapp

Receives payload and forwards it to the ingest service.

---

# Service Layer

Location:

app/services/

Services implement application logic.

## ingest_service.py

Main pipeline for processing intercept messages.

Responsibilities:

- ingest raw message
- detect message format
- parse message
- resolve radio network
- deduplicate messages
- insert message into database
- link callsigns

Main function:

process_whatsapp_payload()

---

## structured_intercept_service.py

Handles intercepts that follow structured alias format.

Responsibilities:

- parse structured intercept
- resolve network by alias
- normalize callsigns
- produce parsed payload

---

# Core Layer

Location:

app/core/

Contains reusable logic used by services.

Core modules must not depend on routers.

## intercept_parser.py

Parser for template intercept format.

Expected structure:

1. datetime
2. frequency
3. network description line
4. callee
5. caller
6. body

Handles several variants including broken templates.

---

## structured_intercept_parser.py

Parser for structured alias intercept format.

Extracts:

- header
- datetime
- sender
- recipients
- message body

---

## normalize

Utility functions for:

- frequency normalization
- callsign normalization
- text normalization

---

## validators

Functions for:

- detecting intercept format
- validating message structure

---

## db

Database connection helpers.

---

# Repository Layer

Location:

app/repositories/

Used for specialized database queries.

Example:

network_aliases_repository

Used to resolve radio networks by alias.

---

# Database

Location:

database/radio.db

Primary entities:

- messages
- ingest_messages
- networks
- callsigns
- message_callsigns
- callsign_edges

Relationships:

messages → networks  
messages → ingest_messages  
messages → message_callsigns  
message_callsigns → callsigns  

---

# Intercept Processing Pipeline

Main data pipeline:

external message
↓
router ingest
↓
process_whatsapp_payload()
↓
insert_ingest_message
↓
detect message format
↓
structured parser OR template parser
↓
resolve network
↓
deduplicate message
↓
insert message
↓
link callsigns

---

# Intercept Formats

The system supports two intercept formats.

## Template intercept

Example structure:

27.02.2026 16:43:47
166.8000
укх ... р/м ...
callee
caller
message body

Parsed by:

core/intercept_parser.py

---

## Structured intercept

Example structure:

header line
alias
datetime
Отримувач(і):
Відправник:
message body

Parsed by:

core/structured_intercept_parser.py

---

# Frontend

Location:

app/templates  
app/static

Templates render pages:

- intercepts_search.html
- intercepts_explorer.html
- callsigns.html
- networks.html
- landmarks.html
- peleng.html

Frontend JavaScript handles:

- intercept search
- intercept explorer
- callsign editing
- landmarks editing/search
- XLSX import

---

# Key Development Rules

1. Routers must stay thin.
2. Business logic must live in services.
3. Parsing logic must live in core.
4. Database access should be centralized.
5. Do not duplicate intercept parsing logic.
6. Avoid full-file rewrites unless necessary.

---

# Important Modules

Core intercept processing:

services/ingest_service.py  
core/intercept_parser.py  
core/structured_intercept_parser.py  
services/structured_intercept_service.py  

UI for intercept exploration:

routers/intercepts.py  
templates/intercepts_explorer.html  
static/intercepts_explorer.js  

UI for landmarks management:
routers/landmarks.py  
templates/landmarks.html  
static/landmarks.js  

Landmark keyword matching worker:
services/landmark_match_service.py  

Automatic landmark matching (queue + background worker) is controlled by `LANDMARK_AUTO_MATCH` in `config.env` (default: off). See `docs/PIPELINE.md`.

---

# Current Focus Areas

Active development areas:

- intercept explorer UI
- callsign linking
- structured intercept support
- search by frequency and mask

