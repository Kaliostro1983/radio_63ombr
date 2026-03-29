from __future__ import annotations
from datetime import datetime
from app.core.db import init_db, get_conn

STATUSES = ["Спостерігається", "За межами", "Мертва", "Досліджується", "Не інформативна"]
CHATS = ["Очерет", "Галявина", "ЦВО", "ОРК-ФМ", "Каменярі"]
GROUPS = [
    "31 мсп 67 мсд 25 ЗА",
    "36 мсп 67 мсд 25 ЗА",
    "37 мсп 67 мсд 25 ЗА",
    "19 тп 67 мсд 25 ЗА",
    "164 омсбр 25 ЗА",
]
TAGS = ["Шд", "БпЛА", "Арта", "СП/ПВН"]

def upsert(table: str, values):
    with get_conn() as conn:
        for v in values:
            conn.execute(f"INSERT OR IGNORE INTO {table}(name) VALUES (?)", (v,))

def main():
    init_db()
    upsert("statuses", STATUSES)
    upsert("chats", CHATS)
    upsert("groups", GROUPS)
    upsert("tags", TAGS)

if __name__ == "__main__":
    main()
