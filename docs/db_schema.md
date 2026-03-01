# DB Schema (Radio Monitor)

Цей документ — “конституція” БД. Якщо щось змінюємо в схемі — спочатку правимо цей файл, потім міграцію/SCHEMA_SQL.

## Мета
- Зберігати сирі повідомлення (raw) для аудиту/перепарсу.
- Зберігати нормалізовані “перехоплення” для UI, фільтрів, пошуку.
- Не дублювати частоту/маску в таблиці messages: вони належать networks.
- Працювати так, щоб невідомі частоти автоматично створювали networks з дефолтами.

## Таблиці

### 1) networks
Довідник радіомереж.

Ключове:
- Унікальність: frequency (або net_key, якщо він є канонічним). В MVP допускаємо UNIQUE(frequency).
- Якщо перехоплення прийшло з частотою, якої нема — створюємо запис з дефолтними значеннями (“Невідомо”, 0/NULL).

Поля (узгоджені):
- id (PK)
- frequency TEXT NOT NULL UNIQUE
- mask TEXT NULL
- unit TEXT/або unit_id (дефолт “Невідомо”)
- zone TEXT/або zone_id (дефолт “Невідомо”)
- chat_id (за потреби)
- group_id (за потреби)
- status_id (FK на statuses/або інша таблиця) — дефолт
- comment TEXT NULL
- updated_at TEXT NOT NULL

Примітка: точний склад полів у networks залежить від того, що вже є в проєкті. Важливо: messages не має дублювати frequency/mask.

### 2) ingest_messages
Сирий журнал “як прийшло з платформи”.

Поля:
- id (PK)
- platform TEXT NOT NULL (whatsapp/signal)
- source_chat_id TEXT NOT NULL
- source_chat_name TEXT NULL
- source_message_id TEXT NOT NULL
- author TEXT NULL
- raw_text TEXT NOT NULL
- published_at_text TEXT NULL (якщо витягнули з шапки)
- published_at_platform TEXT NULL (з месенджера, пріоритетне)
- received_at TEXT NOT NULL (коли сервер прийняв)
- parse_status TEXT NOT NULL DEFAULT 'new' ('new'/'parsed'/'failed')
- parse_error TEXT NULL
- UNIQUE(platform, source_chat_id, source_message_id)

### 3) messages
Нормалізоване “перехоплення” для UI/пошуку.

Поля:
- id (PK)
- ingest_id INTEGER NOT NULL (FK -> ingest_messages.id)
- network_id INTEGER NOT NULL (FK -> networks.id)  <-- завжди має існувати, бо якщо нема — створюємо networks
- created_at TEXT NOT NULL   <-- час публікації (переважно published_at_platform, інакше published_at_text)
- received_at TEXT NOT NULL  <-- дублюємо з ingest для зручності фільтрів
- net_description TEXT NULL  <-- строка опису мережі з шапки (за наявності)
- body_text TEXT NOT NULL    <-- тільки текст перехоплення без шапки (для пошуку)
- comment TEXT NULL          <-- операторський коментар
- parse_confidence REAL DEFAULT 1.0
- is_valid INTEGER DEFAULT 1
- (опційно) UNIQUE(ingest_id) якщо 1:1 ingest->message

### 4) callsign_statuses
Довідник статусів позивних.

Поля:
- id (PK)
- name TEXT NOT NULL UNIQUE

Початкові значення:
- штурмовик
- оператор БпЛА
- штабник
- обозник
- сп

### 5) callsigns
Довідник позивних.

Поля:
- id (PK)
- network_id INTEGER NULL (FK -> networks.id)  <-- якщо не знаємо мережу, можна NULL, але в нашому потоці зазвичай відомо
- name TEXT NOT NULL
- status_id INTEGER NULL (FK -> callsign_statuses.id)
- comment TEXT NULL
- updated_at TEXT NOT NULL
- UNIQUE(network_id, name)

### 6) message_callsigns
Зв’язок “повідомлення ↔ позивний” з роллю.

Поля:
- id (PK) або без id (якщо хочеш composite PK) — обидва норм.
- message_id INTEGER NOT NULL (FK -> messages.id)
- callsign_id INTEGER NOT NULL (FK -> callsigns.id)
- role TEXT NOT NULL CHECK(role IN ('caller','callee'))
- UNIQUE(message_id, callsign_id, role)

Правило:
- caller завжди один (перевіряється в коді; за потреби додамо constraint логікою).

### 7) tags
Довідник тегів.

Поля:
- id (PK)
- name TEXT NOT NULL UNIQUE

### 8) message_tags
Зв’язок message ↔ tag.

Поля:
- message_id INTEGER NOT NULL (FK -> messages.id)
- tag_id INTEGER NOT NULL (FK -> tags.id)
- PRIMARY KEY(message_id, tag_id)  <-- унікальна комбінація

## Інваріанти (те, що не ламаємо)
- ingest_messages.raw_text зберігається завжди.
- messages.body_text = “текст без шапки”.
- messages НЕ містить frequency/mask.
- Якщо network не знайдено — створюємо networks з дефолтами.

## Тест після прочитання (для себе/для бота)
1) Я можу пояснити різницю між ingest_messages та messages однією фразою.
2) Я знаю, де лежить raw-text і де лежить body_text.
3) Я знаю, як теги прив’язуються до повідомлення (message_tags).
4) Я знаю, як caller/callee прив’язуються до повідомлення (message_callsigns.role).
5) Я знаю, що робимо, якщо частоти немає в networks (створюємо networks з дефолтами).