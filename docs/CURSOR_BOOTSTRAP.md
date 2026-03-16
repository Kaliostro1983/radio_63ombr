# Cursor Project Context --- radio_63ombr

Цей файл описує контекст проєкту radio_63ombr. Cursor повинен
використовувати цей файл як основний контекст перед аналізом коду.

## Проєкт

radio_63ombr --- це FastAPI + SQLite система для обробки
радіоперехоплень.

Основні функції:

-   ingest повідомлень (WhatsApp / XLSX)
-   парсинг перехоплень
-   визначення радіомереж
-   робота з позивними
-   граф зв'язків позивних
-   тегування повідомлень
-   peleng‑звіти
-   веб‑інтерфейс для аналізу

## Архітектура

Шарова структура:

routers → services → core → database

Frontend:

Jinja2 + vanilla JS

## Ключові модулі

Core:

-   app/core/db.py
-   app/core/intercept_parser.py
-   app/core/structured_intercept_parser.py
-   app/core/normalize.py
-   app/core/validators.py
-   app/core/callsign_normalizer.py

Services:

-   app/services/ingest_service.py
-   app/services/structured_intercept_service.py
-   app/services/network_service.py
-   app/services/callsign_service.py

Routers:

-   app/routers/ingest.py
-   app/routers/intercepts.py
-   app/routers/networks.py
-   app/routers/callsigns.py
-   app/routers/peleng.py

Models:

-   app/models/tables.py

Repositories:

-   app/repositories/network_aliases_repository.py
-   app/repositories/peleng_repo.py

## База даних

SQLite.

Основні таблиці:

networks\
network_aliases\
network_changes\
network_tags\
etalons

ingest_messages\
messages\
message_tags

callsigns\
callsign_sources\
callsign_statuses\
callsign_status_map\
message_callsigns\
callsign_edges

tags\
statuses\
words

chats\
groups

peleng_batches\
peleng_points

import_freq_chat\
import_networks

## Ingest pipeline

incoming message ↓ router /api/ingest/whatsapp ↓
services/ingest_service.process_whatsapp_payload ↓ insert
ingest_messages ↓ detect message format ↓ structured_intercept_service
OR intercept_parser ↓ resolve network ↓ duplicate check ↓ insert
messages ↓ link callsigns ↓ update callsign_edges

## Критичні правила системи

### 1. Автостворення мереж заборонене

Якщо мережа не знайдена, перехоплення не вставляється у messages.

### 2. Правило дубліката

Повідомлення є дублікатом якщо збігаються:

network_id\
created_at\
body_text

### 3. Граф позивних

У callsign_edges завжди виконується:

a_callsign_id \< b_callsign_id

### 4. Позивний НВ

Позивний "НВ" не створює ребер у callsign_edges.

### 5. Зміни в коді

Cursor повинен пропонувати зміни, але не застосовувати їх без
підтвердження користувача.

## Критичні місця аудиту

1.  Перевіряти UNIQUE index для: callsign_edges(network_id,
    a_callsign_id, b_callsign_id)

2.  Перевіряти використання parsed\["ok"\] у ingest_service

3.  Перевіряти оновлення updated_at у таблиці callsigns

## Технічні терміни

PRAGMA --- SQL‑команди SQLite для перегляду структури БД.

Payload --- JSON або словник повідомлення, який передається у
ingest_service.

## Поточна задача

Провести аудит:

DB layer + ingest layer

Перевірити:

-   відповідність db.py реальній SQLite схемі
-   відповідність tables.py реальній SQLite схемі
-   індекси БД
-   ingest pipeline
-   consistency графа позивних
