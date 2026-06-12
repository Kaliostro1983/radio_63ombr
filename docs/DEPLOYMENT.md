\# Розгортання та інфраструктура



Цей документ описує серверне середовище та процедури розгортання проєкту.

Прикріпіть його до нового діалогу з AI разом з `docs/ARCHITECTURE.md` та `docs/SYSTEM\_CONTEXT.md`.



\---



\## 1. Інфраструктура



| Параметр | Значення |

|----------|----------|

| Сервер | `ocheret-63` |

| ОС | Ubuntu 24.04 LTS |

| Tailscale IP | `100.120.93.120` |

| Доступ | SSH через Tailscale: `ssh shaen@100.120.93.120` |

| Користувач | `shaen` |



\---



\## 2. Розташування проєкту



| Компонент | Шлях |

|-----------|------|

| radio\_63ombr (FastAPI) | `\~/Armor/radio\_63ombr` |

| Python venv | `\~/Armor/radio\_63ombr/venv` |



\---



\## 3. Середовище



| Компонент | Версія |

|-----------|--------|

| Python | 3.12.3 |

| Uvicorn | з `requirements.txt` |



\---



\## 4. Systemd сервіс



Сервіс запускається автоматично після перезавантаження.



```bash

\# Статус

sudo systemctl status radio63



\# Перезапуск

sudo systemctl restart radio63



\# Логи

journalctl -u radio63 -f

```



Файл: `/etc/systemd/system/radio63.service`

```ini

\[Unit]

Description=Radio 63 FastAPI

After=network.target



\[Service]

User=shaen

WorkingDirectory=/home/shaen/Armor/radio\_63ombr

ExecStart=/home/shaen/Armor/radio\_63ombr/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

Restart=always



\[Install]

WantedBy=multi-user.target

```



\---



\## 5. Порти



| Сервіс | Порт |

|--------|------|

| FastAPI | `8000` |



API доступне з Windows за адресою: `http://100.120.93.120:8000`



\---



\## 6. Змінні середовища



Файл: `\~/Armor/radio\_63ombr/.env` (скопійовано з `config.env.example`)



```env

APP\_NAME=63ombr

DB\_PATH=database/radio.db

BACKUP\_DIR=backups

BACKUP\_KEEP=30

FREQ\_XLSX=Frequencies\_63.xlsx

ETALON\_XLSX=

```



\---



\## 7. Запуск вручну (для розробки)



```bash

cd \~/Armor/radio\_63ombr

source venv/bin/activate

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

```



\---



\## 8. Клієнти що звертаються до цього API



\- \*\*SWBot\*\* (`\~/Armor/SWBot`) — надсилає повідомлення з WhatsApp/Signal на `POST /api/ingest/whatsapp`

\- Контракт описано в `docs/BOT\_INGEST\_API.md`



\---



\## 9. Швидкий контекст для AI (новий діалог)



\- \*\*Сервер:\*\* Ubuntu 24.04, `ocheret-63`, SSH: `shaen@100.120.93.120`

\- \*\*Проєкт:\*\* `\~/Armor/radio\_63ombr`, systemd сервіс `radio63`, порт `8000`

\- \*\*Стек:\*\* Python 3.12, FastAPI, Uvicorn, SQLite

\- \*\*Клієнт:\*\* SWBot надсилає повідомлення на `POST /api/ingest/whatsapp`

\- \*\*Вказівка для асистента:\*\* \*«Інфраструктура описана в `docs/DEPLOYMENT.md`, архітектура — в `docs/ARCHITECTURE.md` та `docs/SYSTEM\_CONTEXT.md`»\*

