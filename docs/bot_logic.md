# Bot Logic (Node WhatsApp Collector)

## Ціль
- Слухати повідомлення тільки з whitelist-джерел.
- Передавати їх у FastAPI.
- Пересилати відібрані/підтверджені повідомлення тільки в whitelist-ціль.
- Мати kill switch (#go), щоб уникнути спаму та бану.

## Основні налаштування
- SOURCE_CHATS: масив chat_id джерел (whitelist)
- TARGET_CHAT: chat_id публікації (whitelist)
- SEND_PREFIX: "#go" (kill switch)
- Rate limit: мін. інтервал між відправками (наприклад 2 секунди)

## Події WhatsApp
Використовуємо message_create, щоб бачити і свої, і чужі повідомлення.
chatId визначається так:
- chatId = msg.fromMe ? msg.to : msg.from

## Алгоритм Node (коротко)
1) Отримали message_create
2) Обчислили chatId
3) Якщо chatId не в SOURCE_CHATS -> return (ніяких логів/побічних ефектів)
4) allowSend = rawText startsWith "#go"
5) textToSend = allowSend ? rawText без "#go" : rawText
6) POST в FastAPI (з published_at_platform і текстом)
7) Якщо allowSend == false -> не робимо forward (тільки запис у БД)
8) Якщо allowSend == true:
   - беремо actions з відповіді
   - ігноруємо action.chat_id
   - надсилаємо тільки в TARGET_CHAT
   - застосовуємо rate limit

## Як дізнатися chat_id
Тимчасовий режим “detector”:
- логувати message_create: chatId + body
- написати “1” у джерело і “2” у ціль
- скопіювати chatId

## Тест після прочитання
1) Я можу пояснити, чому ми не надсилаємо в action.chat_id.
2) Я знаю, як працює kill switch (#go) і як виглядає правильне повідомлення.
3) Я знаю, чому на старті можуть “проскакувати” повідомлення і чому це не має впливати на forward.
4) Я знаю, як визначити chatId для fromMe/не fromMe.
5) Я знаю, що робити, якщо FastAPI недоступний (бачимо ECONNREFUSED, forward не виконується).