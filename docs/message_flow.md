# Message Flow (WhatsApp -> FastAPI -> DB -> Forward)

## Макро-ланцюг
WhatsApp (чат-джерело) -> Node Collector -> FastAPI ingest -> DB (ingest_messages + messages + links) -> (опціонально) forward у чат-публікацію.

## Вхідна подія (Node -> FastAPI)
Endpoint: POST /api/ingest/whatsapp

Payload (мінімум):
- platform = "whatsapp"
- chat_id
- chat_name (може бути пустим)
- message_id
- author
- published_at_platform (ISO)
- text (raw_text)

## Обробка на FastAPI
Кроки:
1) Insert ingest_messages:
   - raw_text = payload.text
   - published_at_platform = payload.published_at_platform
   - received_at = now
   - parse_status='new'

2) Parse:
   - витягнути published_at_text (якщо є в шапці)
   - витягнути frequency/mask (якщо є)
   - витягнути net_description (рядок опису)
   - витягнути caller + callees
   - витягнути body_text = все після першого порожнього рядка (якщо нема — body_text=raw_text)

3) Ensure network exists:
   - знайти networks по frequency (та/або mask/net_key)
   - якщо нема -> INSERT networks з дефолтами для невідомих полів

4) Insert messages:
   - ingest_id (FK)
   - network_id (FK)
   - created_at = published_at_platform || published_at_text || received_at
   - received_at = received_at
   - net_description
   - body_text
   - parse_confidence

5) Ensure callsigns exist + link:
   - upsert callsign(name, network_id)
   - INSERT message_callsigns(message_id, callsign_id, role='caller'/'callee')

6) Update ingest_messages.parse_status='parsed' (або failed + parse_error)

7) Response actions:
   - Для безпечного режиму: actions повертаємо ТІЛЬКИ якщо Node дозволив (#go), або якщо повідомлення пройшло критерії валідності.
   - Для MVP можна повертати 1 action: send_message.

## Затримки
- delivery_delay = received_at - published_at_platform
- template_skew = published_at_platform - published_at_text (якщо published_at_text є)

## Тест після прочитання
1) Я можу назвати 7 кроків обробки на бекенді в правильному порядку.
2) Я знаю, як формується body_text.
3) Я знаю, де рахується delivery_delay.
4) Я знаю, коли ми створюємо networks автоматично.
5) Я знаю, за яких умов бекенд має повертати actions (щоб не спамити).