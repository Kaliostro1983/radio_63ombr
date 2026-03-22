# SYSTEM_CONTEXT.md

## Purpose

The project processes radio intercepts, stores normalized messages in SQLite, links callsigns, supports manual review in the UI, and provides peleng reporting.

## Main architecture

FastAPI application with layered structure:

routers → services → core / repositories → SQLite database

Frontend uses Jinja2 templates and vanilla JavaScript.

## Main domains

- radio networks
- intercept ingestion
- structured and template intercept parsing
- callsigns and callsign graph
- tags and word-based analytics
- etalons
- peleng batches and points
- XLSX import

## Main entrypoint

- `app/main.py` creates the FastAPI app, mounts static files, initializes the DB, and registers routers.

## Ingest pipeline

1. Raw message arrives from WhatsApp or XLSX.
2. Router `/api/ingest/whatsapp` forwards payload to `process_whatsapp_payload()`.
3. Raw payload is inserted into `ingest_messages`.
4. Format is detected.
5. Message goes through either:
   - structured alias pipeline, or
   - template intercept parser, or
   - peleng parser (`peleng_type`).
6. For template/structured intercepts: network is resolved.
7. For template/structured intercepts: duplicate is checked.
8. For template/structured intercepts: parsed message is inserted into `messages`.
9. For template/structured intercepts: callsigns are linked into `message_callsigns`.
10. For template/structured intercepts: callsign relationships are updated in `callsign_edges`.
11. For `peleng_type`: a row is inserted into `peleng_batches`, and `37...` rows are inserted into `peleng_points`.

## Supported message formats

### Template intercept
Typical structure:
- datetime
- frequency
- network description line
- callee
- caller
- body

Parser:
- `app/core/intercept_parser.py`

### Structured alias intercept
Typical structure:
- header line / alias text
- datetime
- recipients block
- sender block
- body

Parser:
- `app/core/structured_intercept_parser.py`

### Peleng intercept (`peleng_type`)
Typical structure:
- `frequency / datetime` in the first line
- optional descriptive lines
- one or more coordinate lines starting with `37`

Parser:
- `app/core/peleng_intercept_parser.py`

## Core database tables

### Networks and reference data
- `networks`
- `network_aliases`
- `network_changes`
- `network_tags`
- `statuses`
- `tags`
- `words`
- `chats`
- `groups`
- `etalons`

### Ingest and messages
- `ingest_messages`
- `messages`
- `message_tags`

### Callsigns
- `callsigns`
- `callsign_sources`
- `callsign_statuses`
- `callsign_status_map`
- `message_callsigns`
- `callsign_edges`

### Peleng
- `peleng_batches`
- `peleng_points`

### Import support
- `import_freq_chat`
- `import_networks`

## Actual duplicate rule

Current application logic checks duplicates by:
- `network_id`
- `created_at`
- `body_text`

This rule is implemented in the ingest pipeline and should not be changed casually.

## Network resolution rule

Current ingest flow expects an existing network.
If the network is not found, the intercept is skipped and marked with parse error.
Do not auto-create networks unless this behavior is explicitly changed across the project.

## Development rules for AI tools

1. Keep routers thin.
2. Put business logic in services.
3. Put parsing logic in core.
4. Do not duplicate parser logic in routers or services.
5. Keep DB schema synchronized with `app/core/db.py`.
6. When changing schema, prefer additive migrations for existing databases.
7. Do not rewrite large files unless required.
