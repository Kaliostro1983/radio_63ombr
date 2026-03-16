# PIPELINE.md

## Intercept Processing Pipeline

The system processes intercepts through a deterministic pipeline.  
All new ingestion logic must follow this order.

external source
↓
router (ingest)
↓
services/ingest_service.process_whatsapp_payload()
↓
insert_ingest_message (store raw payload)
↓
detect_message_format
↓
structured_intercept_service OR template parser
↓
network resolution
↓
duplicate detection
↓
insert message
↓
link callsigns
↓
UI availability

---

## Step-by-step

### 1. Raw message arrives
Source examples:
- WhatsApp bot
- XLSX import
- other integrations

Router:

app/routers/ingest.py

Endpoint:

POST /api/ingest/whatsapp

---

### 2. Raw message stored

Function:

insert_ingest_message()

Table:

ingest_messages

Purpose:

- preserve raw message
- guarantee traceability
- allow re-processing

---

### 3. Detect message format

Function:

detect_message_format()

Possible formats:

template
structured_alias
nonstandard_type_1
unknown

---

### 4. Structured intercept processing

Service:

services/structured_intercept_service.py

Parser:

core/structured_intercept_parser.py

Steps:

1 detect alias header
2 resolve network via alias
3 normalize callsigns
4 build structured payload

---

### 5. Template intercept processing

Parser:

core/intercept_parser.py

Supported template:

datetime
frequency
network description
callee
caller
body

---

### 6. Network resolution

Function:

ensure_network()

If network not found → intercept skipped

---

### 7. Duplicate detection

Function:

find_duplicate_message()

Duplicate rule:

network_id + created_at + body_text

---

### 8. Insert parsed message

Function:

insert_message()

Table:

messages

---

### 9. Link callsigns

Function:

link_message_callsigns()

Creates:

message_callsigns rows
callsign_edges relationships

---

### 10. Message becomes visible

UI routes:

/intercepts
/intercepts-explorer