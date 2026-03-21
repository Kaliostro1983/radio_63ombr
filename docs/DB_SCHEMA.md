# DB Schema --- radio_63ombr

Цей файл описує поточну структуру SQLite-бази проєкту `radio_63ombr` на
основі актуального schema dump. Його призначення --- бути швидкою
опорною картою для аудиту, розробки та роботи в Cursor.

## Джерело істини

Для цього документа джерелом істини є реальна SQLite schema dump, а не
припущення в коді. `db.py` і `tables.py` повинні відповідати цій схемі.

## Основні принципи

-   База даних: SQLite
-   Часові поля зберігаються як `TEXT`
-   Більшість зв'язків реалізовано через `FOREIGN KEY`
-   Частина цілісності підтримується на рівні БД, частина --- на рівні
    service layer
-   Для `callsign_edges` критично важливий інваріант:
    `a_callsign_id < b_callsign_id`

## Групи таблиць

### 1. Довідники

-   `statuses`
-   `tags`
-   `chats`
-   `groups`
-   `callsign_sources`
-   `callsign_statuses`

### 2. Радіомережі

-   `networks`
-   `network_aliases`
-   `network_changes`
-   `network_tags` (довідник)
-   `network_tag_links` (звʼязка many-to-many)
-   `etalons`

### 3. Ingest і повідомлення

-   `ingest_messages`
-   `messages`
-   `message_tags`

### 4. Позивні та граф

-   `callsigns`
-   `message_callsigns`
-   `callsign_edges`
-   `callsign_status_map`

### 5. Peleng

-   `peleng_batches`
-   `peleng_points`

### 6. Імпортні / технічні таблиці

-   `import_freq_chat`
-   `import_networks`
-   `words`
-   `landmark_types`
-   `landmarks`
-   `message_landmark_matches`
-   `message_landmark_queue`

------------------------------------------------------------------------

## Таблиці

## statuses

Призначення: довідник статусів радіомереж або інших сутностей
інтерфейсу.

Поля: - `id` --- PK - `name` --- унікальна назва статусу - `bg_color`
--- колір фону - `border_color` --- колір рамки

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## tags

Призначення: довідник тегів для повідомлень і словника тематичного
аналізу.

Поля: - `id` --- PK - `name` --- унікальна назва тегу - `template` ---
шаблон виводу або оформлення, `TEXT NOT NULL DEFAULT ''`

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## chats

Призначення: довідник чатів.

Поля: - `id` --- PK - `name` --- унікальна назва чату

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## groups

Призначення: довідник груп.

Поля: - `id` --- PK - `name` --- унікальна назва групи

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## callsign_sources

Призначення: довідник джерел походження позивного.

Поля: - `id` --- PK - `name` --- унікальна назва джерела

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## callsign_statuses

Призначення: довідник статусів позивних.

Поля: - `id` --- PK - `name` --- унікальна назва статусу - `icon` ---
іконка статусу

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## networks

Призначення: головна таблиця радіомереж.

Поля: - `id` --- PK - `frequency` --- частота, унікальна - `mask` ---
маска - `unit` --- підрозділ - `zone` --- зона - `chat_id` --- FK →
`chats.id` - `group_id` --- FK → `groups.id` - `status_id` --- FK →
`statuses.id` - `comment` --- коментар - `updated_at` --- час останнього
оновлення - `net_key` --- додатковий ключ мережі

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(frequency)` -
`FOREIGN KEY(chat_id) REFERENCES chats(id)` -
`FOREIGN KEY(group_id) REFERENCES groups(id)` -
`FOREIGN KEY(status_id) REFERENCES statuses(id)`

Примітка: - ingest pipeline не повинен автостворювати записи в цій
таблиці.

------------------------------------------------------------------------

## network_aliases

Призначення: альтернативні назви мереж для structured intercept.

Поля:
- `id` — PK
- `network_id` — FK → `networks.id`
- `alias_text` — оригінальний текст alias, унікальний у межах активних записів
- `is_archived` — прапорець архівності
- `created_at` — час створення

Ключі та обмеження:
- `PRIMARY KEY(id)`
- `UNIQUE(network_id, alias_text)` або інша обрана унікальність (за фактичною схемою)
- `FOREIGN KEY(network_id) REFERENCES networks(id)`

Критично:
- пошук structured intercept виконується за `alias_text`, без окремого нормалізованого поля.
- для уникнення колізій у lookup рекомендовано (або обов'язково, якщо так вирішено в проєкті)
  тримати `alias_text` унікальним серед **активних** записів: `UNIQUE(alias_text) WHERE is_archived = 0` (partial UNIQUE index).

------------------------------------------------------------------------

## network_changes

Призначення: журнал змін мережі.

Поля: - `id` --- PK - `network_id` --- FK → `networks.id` - `changed_at`
--- час зміни - `changed_by` --- хто змінив - `field` --- назва поля -
`old_value` --- старе значення - `new_value` --- нове значення

Ключі та обмеження: - `PRIMARY KEY(id)` -
`FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE`

------------------------------------------------------------------------

## network_tags

Призначення: довідник тегів **саме для радіомереж** (UI-мітки). Не плутати з
`tags`, які використовуються для тематичного аналізу текстів.

Поля:
- `id` — PK
- `name` — унікальна назва тегу

Ключі та обмеження:
- `PRIMARY KEY(id)`
- `UNIQUE(name)`

------------------------------------------------------------------------

## network_tag_links

Призначення: зв'язка many-to-many між мережами і `network_tags`.

Поля:
- `network_id` — FK → `networks.id`
- `tag_id` — FK → `network_tags.id`

Ключі та обмеження:
- `PRIMARY KEY(network_id, tag_id)`
- `FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE`
- `FOREIGN KEY(tag_id) REFERENCES network_tags(id) ON DELETE CASCADE`

------------------------------------------------------------------------

## etalons

Призначення: еталонний опис мережі.

Поля: - `id` --- PK - `network_id` --- FK → `networks.id`, унікальний -
`start_date` - `end_date` - `correspondents` - `callsigns` - `purpose` -
`operation_mode` - `traffic_type` - `raw_import_text` - `updated_at`

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(network_id)` -
`FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE`

------------------------------------------------------------------------

## ingest_messages

Призначення: сирий ingest до будь-якого парсингу.

Поля: - `id` --- PK - `platform` --- джерело, наприклад WhatsApp /
XLSX - `source_chat_id` - `source_chat_name` - `source_message_id` -
`source_file_name` - `source_row_number` - `raw_text` -
`normalized_text` - `published_at_text` - `received_at` -
`message_format` - `parse_status` - `parse_error`

Ключі та обмеження: - `PRIMARY KEY(id)` -
`UNIQUE(platform, source_message_id)`

Примітка: - це перший рівень захисту від повторного ingest одного й того
самого повідомлення з джерела.

------------------------------------------------------------------------

## messages

Призначення: нормалізовані повідомлення після успішного парсингу і
визначення мережі.

Поля: - `id` --- PK - `ingest_id` --- FK → `ingest_messages.id` -
`network_id` --- FK → `networks.id` - `created_at` --- час самого
повідомлення - `received_at` --- час отримання системою -
`net_description` --- текстовий опис мережі - `body_text` --- тіло
перехоплення - `comment` - `parse_confidence` - `is_valid` -
`delay_sec` - `need_approve` - `tags_json`

Ключі та обмеження: - `PRIMARY KEY(id)` -
`FOREIGN KEY(ingest_id) REFERENCES ingest_messages(id)` -
`FOREIGN KEY(network_id) REFERENCES networks(id)`

Критично: - бізнес-правило дубліката:
`(network_id, created_at, body_text)`

------------------------------------------------------------------------

## message_tags

Призначення: зв'язка many-to-many між повідомленнями і тегами.

Поля: - `message_id` --- FK → `messages.id` - `tag_id` --- FK →
`tags.id`

Ключі та обмеження: - `PRIMARY KEY(message_id, tag_id)` -
`FOREIGN KEY(message_id) REFERENCES messages(id)` -
`FOREIGN KEY(tag_id) REFERENCES tags(id)`

------------------------------------------------------------------------

## callsigns

Призначення: позивні в межах конкретної мережі.

Поля: - `id` --- PK - `network_id` --- FK → `networks.id`, nullable -
`name` --- текст позивного - `status_id` --- FK →
`callsign_statuses.id` - `comment` - `updated_at` - `last_seen_dt` -
`callsign_status_id` - `source_id` --- FK → `callsign_sources.id`

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(network_id, name)` -
`FOREIGN KEY(network_id) REFERENCES networks(id)` -
`FOREIGN KEY(status_id) REFERENCES callsign_statuses(id)` -
`source_id INTEGER REFERENCES callsign_sources(id)`

Критично: - унікальність позивного існує в межах мережі, а не глобально.

------------------------------------------------------------------------

## callsign_status_map

Призначення: many-to-many зв'язка позивних і статусів.

Поля: - `callsign_id` --- FK → `callsigns.id` - `status_id` --- FK →
`callsign_statuses.id`

Ключі та обмеження: - `PRIMARY KEY(callsign_id, status_id)` -
`FOREIGN KEY(callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE` -
`FOREIGN KEY(status_id) REFERENCES callsign_statuses(id) ON DELETE CASCADE`

------------------------------------------------------------------------

## message_callsigns

Призначення: зв'язка повідомлення з позивними і ролями.

Поля: - `message_id` --- FK → `messages.id` - `callsign_id` --- FK →
`callsigns.id` - `role` --- роль у повідомленні: `caller` / `callee`

Ключі та обмеження: - `PRIMARY KEY(message_id, callsign_id, role)` -
`FOREIGN KEY(message_id) REFERENCES messages(id)` -
`FOREIGN KEY(callsign_id) REFERENCES callsigns(id)`

Критично: - одна й та сама пара `(message_id, callsign_id)` може
існувати більше одного разу тільки якщо відрізняється `role`.

------------------------------------------------------------------------

## callsign_edges

Призначення: агрегований граф зв'язків між позивними всередині мережі.

Поля: - `id` --- PK - `network_id` --- FK → `networks.id` -
`a_callsign_id` --- FK → `callsigns.id` - `b_callsign_id` --- FK →
`callsigns.id` - `first_seen_dt` - `last_seen_dt` - `cnt` --- кількість
взаємодій

Ключі та обмеження: - `PRIMARY KEY(id)` -
`CHECK(a_callsign_id < b_callsign_id)` -
`FOREIGN KEY(network_id) REFERENCES networks(id) ON DELETE CASCADE` -
`FOREIGN KEY(a_callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE` -
`FOREIGN KEY(b_callsign_id) REFERENCES callsigns(id) ON DELETE CASCADE`

Критично: - порядок пари має бути нормалізований:
`a_callsign_id < b_callsign_id` - для коректної роботи upsert у service
layer має бути `UNIQUE(network_id, a_callsign_id, b_callsign_id)` (через constraint або UNIQUE index)

------------------------------------------------------------------------

## peleng_batches

Призначення: шапка пакета peleng-даних.

Поля: - `id` --- PK - `event_dt` - `network_id` --- FK → `networks.id`

Ключі та обмеження: - `PRIMARY KEY(id)` -
`FOREIGN KEY(network_id) REFERENCES networks(id)`

------------------------------------------------------------------------

## peleng_points

Призначення: точки одного peleng batch.

Поля: - `id` --- PK - `batch_id` --- FK → `peleng_batches.id` - `mgrs`

Ключі та обмеження: - `PRIMARY KEY(id)` -
`FOREIGN KEY(batch_id) REFERENCES peleng_batches(id) ON DELETE CASCADE`

------------------------------------------------------------------------

## import_freq_chat

Призначення: технічна таблиця для імпорту частот і чатів.

Поля: - `frequency` - `mask3` - `mask_sh` - `chat_name` - `chat_id`

Примітка: - технічна імпортна таблиця, не є частиною основного ingest
lifecycle.

------------------------------------------------------------------------

## import_networks

Призначення: технічна таблиця для імпорту мереж.

Поля: - `frequency` - `mask` - `comment` - `chat_name` - `unit` -
`group_name` - `zone` - `status_name` - `status_id` - `chat_id` -
`group_id`

Примітка: - використовується як staging table для імпорту.

------------------------------------------------------------------------

## words

Призначення: словник слів для тематичної класифікації / аналізу.

Поля: - `id` --- PK - `tag_id` --- FK → `tags.id` - `word` -
`probability` - `exceptions`

Ключі та обмеження: - `PRIMARY KEY(id)` -
`FOREIGN KEY(tag_id) REFERENCES tags(id)`

Примітка: - `exceptions` зберігається як JSON-рядок у `TEXT`.

------------------------------------------------------------------------

## landmark_types

Призначення: довідник типів об'єктів-орієнтирів (landmark).

Поля: - `id` --- PK - `name` --- унікальна назва типу

Ключі та обмеження: - `PRIMARY KEY(id)` - `UNIQUE(name)`

------------------------------------------------------------------------

## landmarks

Призначення: словник ключових слів-орієнтирів та їх геометрії для
прив'язки перехоплень до координат/полігонів.

Поля:
- `id` --- PK
- `name` --- назва орієнтиру
- `key_word` --- ключове слово (нормалізоване, lower-case)
- `location_wkt` --- геометрія у форматі WKT (`POINT(...)`, `POLYGON(...)`, ...)
- `location_kind` --- тип геометрії (опційно)
- `comment` --- коментар
- `date_creation` --- дата/час створення
- `updated_at` --- дата/час останнього оновлення
- `id_group` --- FK → `groups.id` (nullable)
- `id_type` --- FK → `landmark_types.id`
- `is_active` --- прапорець активності

Ключі та обмеження:
- `PRIMARY KEY(id)`
- `CHECK(key_word = lower(trim(key_word)))`
- `FOREIGN KEY(id_group) REFERENCES groups(id)`
- `FOREIGN KEY(id_type) REFERENCES landmark_types(id)`

Критично:
- у БД `key_word` зберігається вже нормалізованим у lower-case;
- геометрія зберігається у `location_wkt` (WKT), інтерпретація робиться на рівні сервісу/UI.

------------------------------------------------------------------------

## message_landmark_matches

Призначення: результати матчингу тексту повідомлень до орієнтирів.

Поля:
- `id` --- PK
- `id_message` --- FK → `messages.id`
- `id_landmark` --- FK → `landmarks.id`
- `matched_text` --- фактично знайдений фрагмент
- `start_pos` --- позиція початку збігу (для хайлайту)
- `end_pos` --- позиція завершення збігу (для хайлайту)
- `created_at` --- час створення матчу
- `matcher_version` --- версія матчера/правил

Ключі та обмеження:
- `PRIMARY KEY(id)`
- `FOREIGN KEY(id_message) REFERENCES messages(id) ON DELETE CASCADE`
- `FOREIGN KEY(id_landmark) REFERENCES landmarks(id) ON DELETE CASCADE`
- `UNIQUE(id_message, id_landmark, start_pos, end_pos)` (через UNIQUE index)

------------------------------------------------------------------------

## message_landmark_queue

Призначення: черга фонового пост-оброблення повідомлень для keyword-matching
по `landmarks`.

Заповнення черги та робота воркера **керуються конфігурацією** `LANDMARK_AUTO_MATCH`
(див. `docs/PIPELINE.md`): за замовчуванням автоматична обробка вимкнена.

Поля:
- `message_id` --- PK/FK → `messages.id`
- `status` --- стан (`pending`, `processing`, `done`, `error`)
- `attempts` --- кількість спроб обробки
- `last_error` --- текст останньої помилки
- `queued_at` --- час постановки в чергу
- `processed_at` --- час успішної обробки
- `updated_at` --- час останньої зміни стану

Ключі та обмеження:
- `PRIMARY KEY(message_id)`
- `FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE`

------------------------------------------------------------------------

## Критичні індекси, які треба тримати під контролем

Мінімально очікувані:

-   `network_aliases(network_id, alias_text)` --- для structured alias lookup
-   `messages(network_id, created_at)` --- для пошуку і дедуплікації
-   `callsigns(network_id, name)` --- для upsert позивних
-   `callsign_edges(network_id, a_callsign_id, b_callsign_id)` ---
    бажано UNIQUE для коректного upsert edges
-   `landmarks(key_word)` --- для пошуку keyword у словнику
-   `message_landmark_matches(id_message)` --- швидке отримання хітів для повідомлення
-   `message_landmark_matches(id_landmark)` --- аналітика по конкретному landmark
-   `message_landmark_queue(status, queued_at)` --- вибірка pending/error для воркера

------------------------------------------------------------------------

## Критичні інваріанти схеми

1.  `callsigns` унікальні в межах мережі: `(network_id, name)`
2.  `message_callsigns` унікальні за `(message_id, callsign_id, role)`
3.  `message_tags` унікальні за `(message_id, tag_id)`
4.  `callsign_edges` не повинні мати дзеркальних пар
5.  ingest не створює нові мережі
6.  duplicate rule для `messages` живе в service layer:
    `(network_id, created_at, body_text)`

------------------------------------------------------------------------

## Що треба перевіряти під час аудиту

-   чи `db.py` відповідає реальній схемі
-   чи `tables.py` відповідає реальній схемі
-   чи є всі потрібні індекси
-   чи upsert-логіка сервісів спирається на реальні constraints
-   чи service layer не покладається на constraint, якого реально немає
    в SQLite

------------------------------------------------------------------------

## Рекомендовані пов'язані документи

-   `docs/CURSOR_BOOTSTRAP.md`
-   `docs/INVARIANTS.md`
-   `docs/ARCHITECTURE.md`
-   `docs/PIPELINE.md`
-   `docs/FILE_MAP.md`
