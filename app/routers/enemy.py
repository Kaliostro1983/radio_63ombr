"""Мета-огляд противника — інтелект-карта структури армій рф.

Гібрид: СТРУКТУРА (хто кому підпорядкований) — персистентна таблиця `enemy_oob`
(seed із ENEMY_OOB_SEED нижче при першому запуску), редагується з UI (CRUD);
ЖИВА СТАТИСТИКА (к-сть р/м, позивних, остання активність) — автоматично з БД
(`groups` → `networks` → `callsigns`/`messages`), агрегується вгору по дереву.
Символи — APP-6 (milsymbol) з полів ech/branch (на клієнті).

Сторінка: GET /enemy.
API:
  GET    /api/enemy/structure         → вузли (зі стат. + к-сть дітей) + ребра
  GET    /api/enemy/networks?node=X   → р/м підрозділу (вузол + нащадки)
  GET    /api/enemy/intercepts?network_id=X → останні перехоплення р/м
  POST   /api/enemy/node              → додати вузол
  PUT    /api/enemy/node/{id}         → редагувати поля вузла
  DELETE /api/enemy/node/{id}         → видалити вузол із піддеревом
"""

from __future__ import annotations

import secrets
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from app.core.db import get_conn

router = APIRouter(tags=["enemy"])


# ─────────────────────────────────────────────────────────────────────────────
# SEED: початкова структура (OOB). Заливається в таблицю `enemy_oob` лише якщо
# вона порожня; далі джерело істини — таблиця (редагується з UI).
# ─────────────────────────────────────────────────────────────────────────────
ENEMY_OOB_SEED: List[Dict[str, Any]] = [
    {"id": "root", "label": "Противник", "full": "Наш сектор: Лиман – Торське – Ямпіль", "root": True},

    {"id": "25za", "label": "25 ЗА", "full": "25-та загальновійськова армія", "ech": "army", "branch": "hq", "prov": "osint", "parent": "root"},
    {"id": "20za", "label": "20 ЗА", "full": "20-та гв. загальновійськова армія (штаб Воронеж)", "ech": "army", "branch": "hq", "prov": "osint", "parent": "root"},
    {"id": "1ta",  "label": "1 ТА",  "full": "1-ша гв. танкова армія", "ech": "army", "branch": "hq", "prov": "osint", "parent": "root"},
    {"id": "3za",  "label": "3 ЗА",  "full": "3-тя загальновійськова армія", "ech": "army", "branch": "hq", "prov": "osint", "parent": "root"},

    {"id": "upr25", "label": "упр", "full": "Управління 25 ЗА", "ech": "brigade", "branch": "hq", "prov": "osint", "parent": "25za"},
    {"id": "73abr",  "label": "73 абр",  "full": "73-тя окрема артилерійська бригада · 25 ЗА", "ech": "brigade", "branch": "artillery", "prov": "db", "parent": "upr25", "gid": 15},
    {"id": "552krc", "label": "552 крц", "full": "552-й командно-розвідувальний центр · 25 ЗА", "ech": "company", "branch": "signal", "prov": "osint", "parent": "upr25"},
    {"id": "896ppo", "label": "896 кп ППО", "full": "896-й командний пункт ППО · 25 ЗА", "ech": "regiment", "branch": "airdefense", "prov": "osint", "parent": "upr25"},

    {"id": "67msd", "label": "67 мсд", "full": "67-ма мотострілецька дивізія · 25 ЗА", "ech": "division", "branch": "infantry", "prov": "db", "parent": "25za"},
    {"id": "31msp", "label": "31 мсп", "full": "31-й мсп «Башкортостан» · 67 мсд 25 ЗА", "ech": "regiment", "branch": "infantry", "prov": "db", "parent": "67msd", "gid": 1},
    {"id": "36msp", "label": "36 мсп", "full": "36-й мсп · 67 мсд 25 ЗА", "ech": "regiment", "branch": "infantry", "prov": "db", "parent": "67msd", "gid": 2},
    {"id": "37msp", "label": "37 мсп", "full": "37-й мсп · 67 мсд 25 ЗА", "ech": "regiment", "branch": "infantry", "prov": "db", "parent": "67msd", "gid": 3},
    {"id": "19tp",  "label": "19 тп",  "full": "19-й танковий полк · 67 мсд 25 ЗА", "ech": "regiment", "branch": "armor", "prov": "db", "parent": "67msd", "gid": 4},
    {"id": "189orb","label": "189 орб","full": "189-й окремий розвід. батальйон · 67 мсд", "ech": "battalion", "branch": "recon", "prov": "db", "parent": "67msd", "gid": 9},
    {"id": "67msd_upr", "label": "упр", "full": "Управління 67 мсд", "ech": "company", "branch": "hq", "prov": "db", "parent": "67msd"},
    {"id": "83sap", "label": "83 сап", "full": "83-й самохідний артполк · 67 мсд", "ech": "regiment", "branch": "artillery", "prov": "db", "parent": "67msd"},
    {"id": "9isp",  "label": "416 оісб", "full": "416-й окремий інженерно-саперний батальйон · 67 мсд", "ech": "battalion", "branch": "engineer", "prov": "db", "parent": "67msd"},
    {"id": "67msd_345optadn", "label": "345 оптадн", "full": "345-й окремий протитанковий артилерійський дивізіон · 67 мсд", "ech": "battalion", "branch": "antitank", "prov": "db", "parent": "67msd"},
    {"id": "67msd_482ozrdn",  "label": "482 озрдн",  "full": "482-й окремий зенітний ракетний дивізіон · 67 мсд", "ech": "battalion", "branch": "airdefense", "prov": "db", "parent": "67msd"},
    {"id": "67msd_28omedb", "label": "28 омедб", "full": "28-й окремий медичний батальйон · 67 мсд", "ech": "battalion", "branch": "medical", "prov": "db", "parent": "67msd"},
    {"id": "67msd_448obmz", "label": "448 обмз", "full": "448-й окремий батальйон матеріального забезпечення · 67 мсд", "ech": "battalion", "branch": "support", "prov": "db", "parent": "67msd"},
    {"id": "67msd_349obz",  "label": "349 обз",  "full": "349-й окремий батальйон звʼязку · 67 мсд", "ech": "battalion", "branch": "signal", "prov": "db", "parent": "67msd"},
    {"id": "67msd_orvb",    "label": "орвб",     "full": "Окремий ремонтно-відновлювальний батальйон · 67 мсд", "ech": "battalion", "branch": "maint", "prov": "db", "parent": "67msd"},
    {"id": "176rhbz","label": "ор РХБз","full": "Окрема рота РХБ захисту · 67 мсд", "ech": "company", "branch": "cbrn", "prov": "db", "parent": "67msd"},
    {"id": "67msd_oreb",   "label": "ор РЕБ",   "full": "Окрема рота РЕБ · 67 мсд", "ech": "company", "branch": "ew", "prov": "db", "parent": "67msd"},
    {"id": "67msd_orbpla", "label": "ор БПЛА",  "full": "Окрема рота БПЛА · 67 мсд", "ech": "company", "branch": "uav", "prov": "db", "parent": "67msd"},

    {"id": "164", "label": "164 омсбр", "full": "164-та окрема мотострілецька бригада · 25 ЗА (Алейськ)", "ech": "brigade", "branch": "infantry", "prov": "db", "parent": "25za", "gid": 5},
    {"id": "149oremvb", "label": "149 оремвб", "full": "149-й окремий ремонтно-евакуаційний батальйон · 164 омсбр", "ech": "battalion", "branch": "maint", "prov": "osint", "parent": "164"},
    {"id": "48tpch",    "label": "48 тпч",    "full": "48-ма тилова польова частина · 164 омсбр", "ech": "battalion", "branch": "support", "prov": "osint", "parent": "164"},

    {"id": "169", "label": "169 омсбр", "full": "169-та окрема мотострілецька бригада · 25 ЗА (Юрга)", "ech": "brigade", "branch": "infantry", "prov": "db", "parent": "25za", "gid": 6},
    {"id": "963ormz", "label": "963 ормз", "full": "963-тя окрема рота матеріального забезпечення · 169 омсбр", "ech": "company", "branch": "support", "prov": "osint", "parent": "169"},
    {"id": "26bru",   "label": "26 бру",  "full": "26-та бригада управління · 25 ЗА", "ech": "brigade", "branch": "signal", "prov": "osint", "parent": "169"},

    {"id": "11otbr", "label": "11 отбр", "full": "11-та окрема танкова бригада · 25 ЗА", "ech": "brigade", "branch": "armor", "prov": "osint", "parent": "25za"},
    {"id": "55zrbr", "label": "55 зрбр", "full": "55-та зенітно-ракетна бригада · 25 ЗА", "ech": "brigade", "branch": "airdefense", "prov": "osint", "parent": "11otbr"},
    {"id": "6obps",  "label": "6 об БпС","full": "6-й окремий батальйон БпС · 25 ЗА", "ech": "battalion", "branch": "uav", "prov": "osint", "parent": "11otbr"},

    {"id": "71bps", "label": "71 опБпС", "full": "71-й окремий полк БпС (армійський ISR/ударні БпЛА)", "ech": "regiment", "branch": "uav", "prov": "db", "parent": "25za", "gid": 11},
    {"id": "2bbps", "label": "2 бБпС", "full": "2-й батальйон БпС · 71 опБпС", "ech": "battalion", "branch": "uav", "prov": "db", "parent": "71bps", "gid": 8},

    # ── 20 ЗА: штатна структура з OSINT (Вікіпедія) ──
    # 144 мсд (Єльня)
    {"id": "144msd", "label": "144 мсд", "full": "144-та гв. мотострілецька дивізія (Єльня)", "ech": "division", "branch": "infantry", "prov": "trophy", "parent": "20za"},
    {"id": "254msp", "label": "254 мсп", "full": "254-й мсп · 144 мсд 20 ЗА (з трофейної рації)", "ech": "regiment", "branch": "infantry", "prov": "trophy", "parent": "144msd"},
    {"id": "144msd_283msp", "label": "283 мсп", "full": "283-й мотострілецький полк · 144 мсд 20 ЗА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_488msp", "label": "488 мсп", "full": "488-й мотострілецький полк · 144 мсд 20 ЗА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_59tp",   "label": "59 тп",   "full": "59-й танковий полк · 144 мсд 20 ЗА", "ech": "regiment", "branch": "armor", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_856sap", "label": "856 сап", "full": "856-й гв. самохідний артилерійський полк · 144 мсд 20 ЗА", "ech": "regiment", "branch": "artillery", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_1259optadn", "label": "1259 оптадн", "full": "1259-й окремий протитанковий артилерійський дивізіон (Єльня) · 144 мсд", "ech": "battalion", "branch": "antitank", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_340oisb", "label": "340 оісб", "full": "340-й окремий інженерно-саперний батальйон (Єльня) · 144 мсд", "ech": "battalion", "branch": "engineer", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_686obz", "label": "686 обз", "full": "686-й окремий батальйон звʼязку (Шаталове) · 144 мсд", "ech": "battalion", "branch": "signal", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_1032obmz", "label": "1032 обмз", "full": "1032-й окремий батальйон матеріального забезпечення (Почеп) · 144 мсд", "ech": "battalion", "branch": "support", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_150omedb", "label": "150 омедб", "full": "150-й окремий медичний батальйон (Почеп) · 144 мсд", "ech": "battalion", "branch": "medical", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_orbla", "label": "ор БЛА", "full": "Окрема рота БЛА · 144 мсд", "ech": "company", "branch": "uav", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_oreb", "label": "ор РЕБ", "full": "Окрема рота РЕБ · 144 мсд", "ech": "company", "branch": "ew", "prov": "osint", "parent": "144msd"},
    {"id": "144msd_orhbz", "label": "ор РХБЗ", "full": "Окрема рота РХБ захисту · 144 мсд", "ech": "company", "branch": "cbrn", "prov": "osint", "parent": "144msd"},

    # 3 мсд (Богучар/Валуйки)
    {"id": "3msd",   "label": "3 мсд",   "full": "3-тя мотострілецька Вісленська дивізія (Богучар/Валуйки)", "ech": "division", "branch": "infantry", "prov": "osint", "parent": "20za"},
    {"id": "3msd_252msp", "label": "252 мсп", "full": "252-й мотострілецький полк · 3 мсд 20 ЗА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "3msd"},
    {"id": "3msd_752msp", "label": "752 мсп", "full": "752-й мотострілецький полк · 3 мсд 20 ЗА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "3msd"},
    {"id": "3msd_237tp",  "label": "237 тп",  "full": "237-й танковий полк · 3 мсд 20 ЗА", "ech": "regiment", "branch": "armor", "prov": "osint", "parent": "3msd"},
    {"id": "3msd_99sap",  "label": "99 сап",  "full": "99-й самохідний артилерійський полк · 3 мсд 20 ЗА", "ech": "regiment", "branch": "artillery", "prov": "osint", "parent": "3msd"},

    # 20 ЗА — армійські окремі частини
    {"id": "236abr", "label": "236 абр", "full": "236-та гв. артилерійська бригада (Коломна) · 20 ЗА", "ech": "brigade", "branch": "artillery", "prov": "osint", "parent": "20za"},
    {"id": "448rbr", "label": "448 рбр", "full": "448-ма ракетна бригада (Курськ) · 20 ЗА", "ech": "brigade", "branch": "artillery", "prov": "osint", "parent": "20za"},
    {"id": "53zrbr", "label": "53 зрбр", "full": "53-тя зенітна ракетна бригада, в/ч 32406 (Курськ, Бук-М1) · 20 ЗА", "ech": "brigade", "branch": "airdefense", "prov": "osint", "parent": "20za"},
    {"id": "9bru",   "label": "9 бру",   "full": "9-та гв. бригада управління (Вороніж) · 20 ЗА", "ech": "brigade", "branch": "signal", "prov": "osint", "parent": "20za"},
    {"id": "16isp",  "label": "16 ісп",  "full": "16-й інженерно-саперний полк (Богучар) · 20 ЗА", "ech": "regiment", "branch": "engineer", "prov": "osint", "parent": "20za"},
    {"id": "20za_oreb", "label": "об РЕБ", "full": "Окремий батальйон РЕБ · 20 ЗА", "ech": "battalion", "branch": "ew", "prov": "osint", "parent": "20za"},

    # ── 1 ТА: штатна структура з OSINT (Spatial Illusions OOB) ──
    {"id": "1ta_upr", "label": "упр", "full": "Управління (штаб) 1 ТА", "ech": "brigade", "branch": "hq", "prov": "osint", "parent": "1ta"},

    # 2 мсд
    {"id": "2msd",        "label": "2 мсд",     "full": "2-га мотострілецька дивізія · 1 ТА", "ech": "division", "branch": "infantry", "prov": "osint", "parent": "1ta"},
    {"id": "2msd_1gvmsp", "label": "1 гв мсп",  "full": "1-й гв. мотострілецький Севастопольський полк · 2 мсд 1 ТА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "2msd"},
    {"id": "2msd_15gvmsp","label": "15 гв мсп", "full": "15-й гв. мотострілецький Шавлинський полк · 2 мсд 1 ТА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "2msd"},
    {"id": "2msd_1tp",    "label": "1 тп",      "full": "1-й танковий полк · 2 мсд 1 ТА", "ech": "regiment", "branch": "armor", "prov": "osint", "parent": "2msd"},
    {"id": "2msd_147sap", "label": "147 сап",   "full": "147-й самохідний артилерійський полк · 2 мсд 1 ТА", "ech": "regiment", "branch": "artillery", "prov": "osint", "parent": "2msd"},

    # 4 тд
    {"id": "4td",         "label": "4 тд",     "full": "4-та танкова дивізія · 1 ТА", "ech": "division", "branch": "armor", "prov": "osint", "parent": "1ta"},
    {"id": "4td_12tp",    "label": "12 тп",    "full": "12-й танковий полк · 4 тд 1 ТА", "ech": "regiment", "branch": "armor", "prov": "osint", "parent": "4td"},
    {"id": "4td_13tp",    "label": "13 тп",    "full": "13-й танковий полк · 4 тд 1 ТА", "ech": "regiment", "branch": "armor", "prov": "osint", "parent": "4td"},
    {"id": "4td_423msp",  "label": "423 мсп",  "full": "423-й мотострілецький полк · 4 тд 1 ТА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "4td"},
    {"id": "4td_275sap",  "label": "275 сап",  "full": "275-й самохідний артилерійський полк · 4 тд 1 ТА", "ech": "regiment", "branch": "artillery", "prov": "osint", "parent": "4td"},
    {"id": "4td_538zrp",  "label": "538 зрп",  "full": "538-й зенітний ракетний полк · 4 тд 1 ТА", "ech": "regiment", "branch": "airdefense", "prov": "osint", "parent": "4td"},
    {"id": "4td_137orb",  "label": "137 орб",  "full": "137-й окремий розвідувальний батальйон · 4 тд 1 ТА", "ech": "battalion", "branch": "recon", "prov": "osint", "parent": "4td"},
    {"id": "4td_413obz",  "label": "413 обз",  "full": "413-й окремий батальйон звʼязку · 4 тд 1 ТА", "ech": "battalion", "branch": "signal", "prov": "osint", "parent": "4td"},
    {"id": "4td_330oisb", "label": "330 оісб", "full": "330-й окремий інженерно-саперний Тарнопольський батальйон · 4 тд 1 ТА", "ech": "battalion", "branch": "engineer", "prov": "osint", "parent": "4td"},
    {"id": "4td_1088obmz","label": "1088 обмз","full": "1088-й окремий батальйон матеріального забезпечення · 4 тд 1 ТА", "ech": "battalion", "branch": "support", "prov": "osint", "parent": "4td"},
    {"id": "4td_165omedb","label": "165 омедб","full": "165-й окремий медичний батальйон · 4 тд 1 ТА", "ech": "battalion", "branch": "medical", "prov": "osint", "parent": "4td"},

    # 47 тд (153 тп і 272 мсп — з даними БД, решта з OSINT)
    {"id": "47td",   "label": "47 тд",  "full": "47-ма танкова дивізія · 1 ТА", "ech": "division", "branch": "armor", "prov": "db", "parent": "1ta"},
    {"id": "47td_26tp",    "label": "26 тп",    "full": "26-й танковий полк · 47 тд 1 ТА", "ech": "regiment", "branch": "armor", "prov": "osint", "parent": "47td"},
    {"id": "153tp",  "label": "153 тп", "full": "153-й танковий полк · 47 тд 1 ТА", "ech": "regiment", "branch": "armor", "prov": "db", "parent": "47td", "gid": 14},
    {"id": "47td_245msp",  "label": "245 мсп",  "full": "245-й мотострілецький полк · 47 тд 1 ТА", "ech": "regiment", "branch": "infantry", "prov": "osint", "parent": "47td"},
    {"id": "272msp", "label": "272 мсп","full": "272-й мсп · 47 тд 1 ТА", "ech": "regiment", "branch": "infantry", "prov": "db", "parent": "47td", "gid": 10},
    {"id": "47td_744sap",  "label": "744 сап",  "full": "744-й самохідний артилерійський полк · 47 тд 1 ТА", "ech": "regiment", "branch": "artillery", "prov": "osint", "parent": "47td"},
    {"id": "47td_63ozrdn", "label": "63 озрдн", "full": "63-й окремий зенітний ракетний дивізіон · 47 тд 1 ТА", "ech": "battalion", "branch": "airdefense", "prov": "osint", "parent": "47td"},
    {"id": "47td_375optadn","label": "375 оптадн","full": "375-й окремий протитанковий артилерійський дивізіон · 47 тд 1 ТА", "ech": "battalion", "branch": "antitank", "prov": "osint", "parent": "47td"},
    {"id": "47td_1077obmz","label": "1077 обмз","full": "1077-й окремий батальйон матеріального забезпечення · 47 тд 1 ТА", "ech": "battalion", "branch": "support", "prov": "osint", "parent": "47td"},

    # 1 ТА — армійські окремі частини
    {"id": "96orbr",  "label": "96 орбр",   "full": "96-та окрема розвідувальна бригада · 1 ТА", "ech": "brigade", "branch": "recon", "prov": "osint", "parent": "1ta"},
    {"id": "288abr",  "label": "288 абр",   "full": "288-ма артилерійська бригада · 1 ТА", "ech": "brigade", "branch": "artillery", "prov": "osint", "parent": "1ta"},
    {"id": "112rbr",  "label": "112 рбр",   "full": "112-та ракетна бригада · 1 ТА", "ech": "brigade", "branch": "artillery", "prov": "osint", "parent": "1ta"},
    {"id": "49zrbr",  "label": "49 зрбр",   "full": "49-та зенітна ракетна бригада · 1 ТА", "ech": "brigade", "branch": "airdefense", "prov": "osint", "parent": "1ta"},
    {"id": "60bru",   "label": "60 бр упр", "full": "60-та бригада управління · 1 ТА", "ech": "brigade", "branch": "signal", "prov": "osint", "parent": "1ta"},
    {"id": "69obrmtz","label": "69 обр МТЗ","full": "69-та окрема бригада матеріально-технічного забезпечення · 1 ТА", "ech": "brigade", "branch": "support", "prov": "osint", "parent": "1ta"},
    {"id": "1ta_isp", "label": "ісп",       "full": "Інженерно-саперний полк · 1 ТА", "ech": "regiment", "branch": "engineer", "prov": "osint", "parent": "1ta"},
    {"id": "20prhbz", "label": "20 п РХБз", "full": "20-й полк РХБ захисту · 1 ТА", "ech": "regiment", "branch": "cbrn", "prov": "osint", "parent": "1ta"},
    {"id": "231obreb","label": "231 обРЕБ", "full": "231-й окремий батальйон РЕБ · 1 ТА", "ech": "battalion", "branch": "ew", "prov": "osint", "parent": "1ta"},

    {"id": "7omsbr", "label": "7 омсбр", "full": "7-ма окрема мотострілецька бригада · 3 ЗА", "ech": "brigade", "branch": "infantry", "prov": "db", "parent": "3za", "gid": 16},
    {"id": "201osp", "label": "201 осп", "full": "201-й окремий стрілецький полк · 7 омсбр 3 ЗА", "ech": "regiment", "branch": "infantry", "prov": "db", "parent": "7omsbr", "gid": 13},

    # ── Нижній рівень: батальйони/роти/батареї полків 67 мсд (за даними користувача + перехоплень) ──
    {"id": "31msp_shtz", "label": "ШтЗ",  "full": "Штурмовий загін · 31 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "31msp"},
    {"id": "31msp_1msb", "label": "1 мсб", "full": "1-й мотострілецький батальйон · 31 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "31msp"},
    {"id": "31msp_2msb", "label": "2 мсб", "full": "2-й мотострілецький батальйон · 31 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "31msp"},
    {"id": "31msp_3msb", "label": "3 мсб", "full": "3-й мотострілецький батальйон · 31 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "31msp"},

    {"id": "36msp_shtz",  "label": "ШтЗ",   "full": "Штурмовий загін · 36 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "36msp"},
    {"id": "36msp_1msb",  "label": "1 мсб",  "full": "1-й мотострілецький батальйон · 36 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "36msp"},
    {"id": "36msp_2msb",  "label": "2 мсб",  "full": "2-й мотострілецький батальйон · 36 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "36msp"},
    {"id": "36msp_3msb",  "label": "3 мсб",  "full": "3-й мотострілецький батальйон · 36 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "36msp"},
    {"id": "36msp_rr",    "label": "рр",     "full": "Розвідувальна рота · 36 мсп", "ech": "company", "branch": "recon", "prov": "db", "parent": "36msp"},
    {"id": "36msp_ovbps", "label": "овБпС",  "full": "Окремий взвод БпС · 36 мсп", "ech": "company", "branch": "uav", "prov": "db", "parent": "36msp"},
    {"id": "36msp_zrbatr","label": "зрбатр", "full": "Зенітна ракетна батарея · 36 мсп", "ech": "company", "branch": "airdefense", "prov": "db", "parent": "36msp"},

    {"id": "37msp_shtz",  "label": "ШтЗ",   "full": "Штурмовий загін · 37 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "37msp"},
    {"id": "37msp_1msb",  "label": "1 мсб",  "full": "1-й мотострілецький батальйон · 37 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "37msp"},
    {"id": "37msp_2msb",  "label": "2 мсб",  "full": "2-й мотострілецький батальйон · 37 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "37msp"},
    {"id": "37msp_3msb",  "label": "3 мсб",  "full": "3-й мотострілецький батальйон · 37 мсп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "37msp"},
    {"id": "37msp_isr",   "label": "іср",    "full": "Інженерно-саперна рота · 37 мсп", "ech": "company", "branch": "engineer", "prov": "db", "parent": "37msp"},
    {"id": "37msp_zrbatr","label": "зрбатр", "full": "Зенітна ракетна батарея · 37 мсп", "ech": "company", "branch": "airdefense", "prov": "db", "parent": "37msp"},

    # ── Нижній рівень 164 омсбр (за даними перехоплень) ──
    {"id": "164_shrstorm", "label": "ШР «Шторм»", "full": "Штурмова рота «Шторм» · 164 омсбр", "ech": "company", "branch": "infantry", "prov": "db", "parent": "164"},
    {"id": "164_1msb", "label": "1 мсб", "full": "1-й мотострілецький батальйон · 164 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "164"},
    {"id": "164_2msb", "label": "2 мсб", "full": "2-й мотострілецький батальйон · 164 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "164"},
    {"id": "164_3msb", "label": "3 мсб", "full": "3-й мотострілецький батальйон · 164 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "164"},
    {"id": "164_isb",  "label": "ісб",  "full": "Інженерно-саперний батальйон · 164 омсбр", "ech": "battalion", "branch": "engineer", "prov": "db", "parent": "164"},
    {"id": "164_zdn",  "label": "здн",  "full": "Зенітний дивізіон · 164 омсбр", "ech": "battalion", "branch": "airdefense", "prov": "db", "parent": "164"},

    # ── Нижній рівень 169 омсбр (за даними перехоплень) ──
    {"id": "169_shtz", "label": "ШтЗ",  "full": "Штурмовий загін «Шторм» · 169 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "169"},
    {"id": "169_1msb", "label": "1 мсб", "full": "1-й мотострілецький батальйон · 169 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "169"},
    {"id": "169_2msb", "label": "2 мсб", "full": "2-й мотострілецький батальйон · 169 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "169"},
    {"id": "169_3msb", "label": "3 мсб", "full": "3-й мотострілецький батальйон · 169 омсбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "169"},

    # ── Нижній рівень 19 тп (за даними перехоплень) ──
    {"id": "19tp_shtz",   "label": "ШтЗ",    "full": "Штурмовий загін «Шторм» · 19 тп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "19tp"},
    {"id": "19tp_msb",    "label": "мсб",     "full": "Мотострілецький батальйон · 19 тп", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "19tp"},
    {"id": "19tp_rr",     "label": "рр",      "full": "Розвідувальна рота · 19 тп", "ech": "company", "branch": "recon", "prov": "db", "parent": "19tp"},
    {"id": "19tp_zrbatr", "label": "зрбатр",  "full": "Зенітна ракетна батарея · 19 тп", "ech": "company", "branch": "airdefense", "prov": "db", "parent": "19tp"},

    # ── 11 отбр: з перехоплень згадано лише штурмовий загін ──
    {"id": "11otbr_shtz", "label": "ШтЗ", "full": "Штурмовий загін · 11 отбр", "ech": "battalion", "branch": "infantry", "prov": "db", "parent": "11otbr"},

    # ── 73 абр: штатна структура з OSINT (профіль РСЗВ + 152-мм гаубиці) ──
    {"id": "73abr_upr",   "label": "упр",   "full": "Управління 73 абр", "ech": "company", "branch": "hq", "prov": "osint", "parent": "73abr"},
    {"id": "73abr_1sadn", "label": "1 садн", "full": "1-й самохідний артилерійський дивізіон (152-мм) · 73 абр", "ech": "battalion", "branch": "artillery", "prov": "osint", "parent": "73abr"},
    {"id": "73abr_2sadn", "label": "2 садн", "full": "2-й самохідний артилерійський дивізіон (152-мм) · 73 абр", "ech": "battalion", "branch": "artillery", "prov": "osint", "parent": "73abr"},
    {"id": "73abr_rdn",   "label": "рдн",   "full": "Реактивний артилерійський дивізіон (РСЗВ) · 73 абр", "ech": "battalion", "branch": "artillery", "prov": "osint", "parent": "73abr"},
    {"id": "73abr_buar",  "label": "БУАР",  "full": "Батарея управління та артилерійської розвідки · 73 абр", "ech": "company", "branch": "recon", "prov": "osint", "parent": "73abr"},
    {"id": "73abr_rz",    "label": "рз",    "full": "Рота (взвод) забезпечення · 73 абр", "ech": "company", "branch": "support", "prov": "osint", "parent": "73abr"},
]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS enemy_oob(
  id TEXT PRIMARY KEY, label TEXT NOT NULL, full TEXT DEFAULT '',
  ech TEXT, branch TEXT, prov TEXT DEFAULT 'osint', parent TEXT,
  gid INTEGER, sort INTEGER DEFAULT 0, is_root INTEGER DEFAULT 0
)
"""

_ECH_OK = {"army", "division", "brigade", "regiment", "battalion", "company"}
_BRANCH_OK = {"hq", "infantry", "armor", "artillery", "antitank", "airdefense", "recon",
              "engineer", "cbrn", "signal", "ew", "maint", "medical", "support", "uav"}


def _ensure(conn) -> None:
    conn.execute(_SCHEMA)
    cnt = conn.execute("SELECT COUNT(*) c FROM enemy_oob").fetchone()["c"]
    if not cnt:
        for i, n in enumerate(ENEMY_OOB_SEED):
            conn.execute(
                "INSERT OR IGNORE INTO enemy_oob(id,label,full,ech,branch,prov,parent,gid,sort,is_root) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (n["id"], n["label"], n.get("full", ""), n.get("ech"), n.get("branch"),
                 n.get("prov", "osint"), n.get("parent"), n.get("gid"), i, 1 if n.get("root") else 0),
            )
        conn.commit()


def _load(conn):
    """Повертає (nodes, by_id, kids) зі структури в БД."""
    _ensure(conn)
    rows = conn.execute("SELECT * FROM enemy_oob ORDER BY sort, id").fetchall()
    nodes = [{
        "id": r["id"], "label": r["label"], "full": r["full"] or "",
        "ech": r["ech"], "branch": r["branch"], "prov": r["prov"] or "osint",
        "parent": r["parent"], "gid": r["gid"], "root": bool(r["is_root"]),
    } for r in rows]
    by_id = {n["id"]: n for n in nodes}
    kids: Dict[str, List[str]] = {}
    for n in nodes:
        if n["parent"]:
            kids.setdefault(n["parent"], []).append(n["id"])
    return nodes, by_id, kids


def _descendant_gids(by_id, kids, node_id: str) -> List[int]:
    out: List[int] = []
    stack = [node_id]
    while stack:
        nid = stack.pop()
        n = by_id.get(nid)
        if not n:
            continue
        if n.get("gid"):
            out.append(int(n["gid"]))
        stack.extend(kids.get(nid, []))
    return out


def _group_stats(conn) -> Dict[int, Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT g.id gid,
          (SELECT COUNT(*) FROM networks n WHERE n.group_id = g.id) nets,
          (SELECT COUNT(*) FROM callsigns c JOIN networks nn ON nn.id = c.network_id WHERE nn.group_id = g.id) cs,
          (SELECT MAX(m.created_at) FROM messages m JOIN networks nn ON nn.id = m.network_id WHERE nn.group_id = g.id) last
        FROM groups g
        """
    ).fetchall()
    return {int(r["gid"]): {"nets": r["nets"] or 0, "cs": r["cs"] or 0, "last": (r["last"] or "")[:10]} for r in rows}


def _descendant_ids(kids, node_id: str) -> List[str]:
    """Усі id вузла + нащадків (для агрегації статистики по прив'язці мереж)."""
    out: List[str] = []
    stack = [node_id]
    while stack:
        x = stack.pop()
        out.append(x)
        stack.extend(kids.get(x, []))
    return out


def _node_group_id(by_id, node_id: str) -> Optional[int]:
    """group_id = gid найближчого предка-або-себе, що має gid (формування)."""
    cur = node_id
    while cur:
        n = by_id.get(cur)
        if not n:
            return None
        if n.get("gid"):
            return int(n["gid"])
        cur = n.get("parent")
    return None


def _node_path(by_id, node_id: str) -> str:
    """Шлях «25 ЗА › 164 омсбр › 3 мсб» (без кореня)."""
    parts: List[str] = []
    cur = node_id
    while cur:
        n = by_id.get(cur)
        if not n or n.get("root"):
            break
        parts.append(n["label"])
        cur = n.get("parent")
    return " › ".join(reversed(parts))


def _net_stats(conn):
    """Статистика мереж для карти:
      by_node[enemy_node_id] = {nets,cs,last} — мережі, прив'язані до вузла;
      by_group[group_id]     = {...}          — мережі БЕЗ прив'язки (enemy_node_id IS NULL),
                                                 що лягають на рівень формування.
    Безпечно працює і до появи колонки enemy_node_id (тоді все як by_group)."""
    try:
        has_col = any(r["name"] == "enemy_node_id" for r in conn.execute("PRAGMA table_info(networks)"))
    except Exception:
        has_col = False
    col = "nw.enemy_node_id" if has_col else "NULL"
    by_node: Dict[str, Dict[str, Any]] = {}
    by_group: Dict[int, Dict[str, Any]] = {}
    rows = conn.execute(
        f"""
        SELECT {col} AS nid, nw.group_id AS gid,
          (SELECT COUNT(*) FROM callsigns c WHERE c.network_id = nw.id) AS cs,
          (SELECT MAX(m.created_at) FROM messages m WHERE m.network_id = nw.id) AS last
        FROM networks nw
        """
    ).fetchall()
    for r in rows:
        nid = r["nid"]
        last = (r["last"] or "")[:10]
        cs = r["cs"] or 0
        if nid:
            d = by_node.setdefault(str(nid), {"nets": 0, "cs": 0, "last": ""})
        elif r["gid"] is not None:
            d = by_group.setdefault(int(r["gid"]), {"nets": 0, "cs": 0, "last": ""})
        else:
            continue
        d["nets"] += 1
        d["cs"] += cs
        if last > d["last"]:
            d["last"] = last
    return by_node, by_group


def resolve_node(conn, node_id: str):
    """Для networks.py: {node_id,label,full,path,group_id} або None."""
    _nodes, by_id, _kids = _load(conn)
    n = by_id.get(node_id)
    if not n:
        return None
    return {
        "node_id": node_id, "label": n["label"], "full": n.get("full", ""),
        "path": _node_path(by_id, node_id), "group_id": _node_group_id(by_id, node_id),
    }


# ── Сторінка ────────────────────────────────────────────────────────────────

@router.get("/enemy", response_class=HTMLResponse)
def enemy_page(request: Request):
    templates = request.app.state.templates
    return templates.TemplateResponse(
        "enemy.html", {"request": request, "app_name": request.app.state.app_name}
    )


# ── Структура + статистика ──────────────────────────────────────────────────

@router.get("/api/enemy/structure")
def api_enemy_structure():
    with get_conn() as conn:
        nodes, by_id, kids = _load(conn)
        by_node, by_group = _net_stats(conn)

    # «Власна» статистика вузла = мережі, прив'язані саме до нього (enemy_node_id)
    # + мережі рівня формування без прив'язки (enemy_node_id IS NULL, group_id=gid).
    own: Dict[str, Dict[str, Any]] = {}
    for n in nodes:
        if n["root"]:
            continue
        o = {"nets": 0, "cs": 0, "last": ""}
        nn = by_node.get(n["id"])
        if nn:
            o["nets"] += nn["nets"]; o["cs"] += nn["cs"]; o["last"] = max(o["last"], nn["last"])
        if n.get("gid"):
            gg = by_group.get(int(n["gid"]))
            if gg:
                o["nets"] += gg["nets"]; o["cs"] += gg["cs"]; o["last"] = max(o["last"], gg["last"])
        own[n["id"]] = o

    out = []
    for n in nodes:
        d = {
            "id": n["id"], "label": n["label"], "full": n["full"], "root": n["root"],
            "ech": n["ech"], "branch": n["branch"], "prov": n["prov"], "parent": n["parent"],
            "kids": len(kids.get(n["id"], [])), "has_db": False,
        }
        if not n["root"]:
            ids = _descendant_ids(kids, n["id"])
            nets = sum(own.get(i, {}).get("nets", 0) for i in ids)
            cs = sum(own.get(i, {}).get("cs", 0) for i in ids)
            last = max((own.get(i, {}).get("last", "") for i in ids), default="")
            if nets or cs or last:
                d["stats"] = {"nets": nets, "cs": cs, "last": last}
                d["has_db"] = True
        out.append(d)

    edges = [{"source": n["parent"], "target": n["id"]} for n in nodes if n["parent"]]
    return {"ok": True, "nodes": out, "edges": edges}


@router.get("/api/enemy/nodes-flat")
def api_enemy_nodes_flat():
    """Плаский список вузлів структури (без кореня) з шляхом і формуванням —
    для селектора підрозділу в картці р/м."""
    with get_conn() as conn:
        nodes, by_id, _kids = _load(conn)
    out = []
    for n in nodes:
        if n["root"]:
            continue
        out.append({
            "id": n["id"], "label": n["label"], "path": _node_path(by_id, n["id"]),
            "group_id": _node_group_id(by_id, n["id"]), "ech": n["ech"], "branch": n["branch"],
        })
    out.sort(key=lambda x: x["path"])
    return {"ok": True, "nodes": out}


@router.get("/api/enemy/networks")
def api_enemy_networks(node: str = Query(default="")):
    with get_conn() as conn:
        _nodes, by_id, kids = _load(conn)
        n = by_id.get(node)
        if not n:
            return {"ok": False, "error": "node not found", "networks": []}
        node_ids = _descendant_ids(kids, node)
        gids = _descendant_gids(by_id, kids, node)
        has_col = any(r["name"] == "enemy_node_id" for r in conn.execute("PRAGMA table_info(networks)"))
        wheres, params = [], []
        if has_col and node_ids:
            wheres.append("nw.enemy_node_id IN (%s)" % ",".join("?" * len(node_ids)))
            params += node_ids
        # Фолбек: мережі рівня формування без прив'язки до вузла.
        if gids:
            if has_col:
                wheres.append("(nw.enemy_node_id IS NULL AND nw.group_id IN (%s))" % ",".join("?" * len(gids)))
            else:
                wheres.append("nw.group_id IN (%s)" % ",".join("?" * len(gids)))
            params += gids
        if not wheres:
            return {"ok": True, "networks": [], "label": n["label"]}
        rows = conn.execute(
            f"""
            SELECT nw.id nid, nw.frequency freq, nw.unit unit,
              (SELECT COUNT(*) FROM callsigns c WHERE c.network_id = nw.id) cs,
              (SELECT MAX(m.created_at) FROM messages m WHERE m.network_id = nw.id) last
            FROM networks nw WHERE {" OR ".join(wheres)}
            ORDER BY cs DESC, nw.frequency LIMIT 80
            """,
            params,
        ).fetchall()
    out = [{"id": r["nid"], "freq": r["freq"] or "", "unit": r["unit"] or "",
            "cs": r["cs"] or 0, "last": (r["last"] or "")[:10]} for r in rows]
    return {"ok": True, "networks": out, "label": n["label"]}


@router.get("/api/enemy/intercepts")
def api_enemy_intercepts(network_id: int = Query(default=0), limit: int = Query(default=15)):
    if not network_id:
        return {"ok": True, "intercepts": []}
    limit = max(1, min(int(limit or 15), 50))
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT m.id, m.created_at AS dt, m.net_description AS net, m.body_text AS body, n.frequency AS freq,
              (SELECT GROUP_CONCAT(c.name, ', ') FROM message_callsigns mc JOIN callsigns c ON c.id = mc.callsign_id
                 WHERE mc.message_id = m.id AND mc.role = 'caller') AS caller,
              (SELECT GROUP_CONCAT(c.name, ', ') FROM message_callsigns mc JOIN callsigns c ON c.id = mc.callsign_id
                 WHERE mc.message_id = m.id AND mc.role IN ('callee','mentioned')) AS callee
            FROM messages m LEFT JOIN networks n ON n.id = m.network_id
            WHERE m.network_id = ? ORDER BY m.created_at DESC LIMIT ?
            """,
            (network_id, limit),
        ).fetchall()
    out = [{"id": r["id"], "dt": r["dt"], "freq": r["freq"] or "", "net": r["net"] or "",
            "body": (r["body"] or "").strip(), "caller": r["caller"] or "", "callee": r["callee"] or ""}
           for r in rows]
    return {"ok": True, "intercepts": out}


# ── Редагування структури (CRUD) ────────────────────────────────────────────

class NodeAdd(BaseModel):
    parent: str
    label: str
    full: str = ""
    ech: Optional[str] = None
    branch: Optional[str] = None
    prov: str = "osint"


class NodeEdit(BaseModel):
    label: Optional[str] = None
    full: Optional[str] = None
    ech: Optional[str] = None
    branch: Optional[str] = None
    prov: Optional[str] = None


def _clean_ech(v):
    v = (v or "").strip().lower()
    return v if v in _ECH_OK else None


def _clean_branch(v):
    v = (v or "").strip().lower()
    return v if v in _BRANCH_OK else None


@router.post("/api/enemy/node")
def api_enemy_add(body: NodeAdd):
    label = (body.label or "").strip()
    if not label:
        return JSONResponse({"ok": False, "error": "Вкажіть назву"}, status_code=400)
    with get_conn() as conn:
        _nodes, by_id, _kids = _load(conn)
        if body.parent not in by_id:
            return JSONResponse({"ok": False, "error": "Батьківський вузол не знайдено"}, status_code=400)
        nid = "n" + secrets.token_hex(4)
        while nid in by_id:
            nid = "n" + secrets.token_hex(4)
        mx = conn.execute("SELECT COALESCE(MAX(sort), 0) m FROM enemy_oob").fetchone()["m"]
        prov = (body.prov or "osint").strip().lower()
        if prov not in ("osint", "db", "trophy"):
            prov = "osint"
        conn.execute(
            "INSERT INTO enemy_oob(id,label,full,ech,branch,prov,parent,sort,is_root) VALUES(?,?,?,?,?,?,?,?,0)",
            (nid, label, (body.full or "").strip(), _clean_ech(body.ech), _clean_branch(body.branch),
             prov, body.parent, int(mx) + 1),
        )
        conn.commit()
    return {"ok": True, "id": nid}


@router.put("/api/enemy/node/{nid}")
def api_enemy_edit(nid: str, body: NodeEdit):
    with get_conn() as conn:
        _nodes, by_id, _kids = _load(conn)
        n = by_id.get(nid)
        if not n:
            return JSONResponse({"ok": False, "error": "Вузол не знайдено"}, status_code=404)
        sets, params = [], []
        if body.label is not None:
            lab = body.label.strip()
            if not lab:
                return JSONResponse({"ok": False, "error": "Назва не може бути порожньою"}, status_code=400)
            sets.append("label=?"); params.append(lab)
        if body.full is not None:
            sets.append("full=?"); params.append(body.full.strip())
        if body.ech is not None:
            sets.append("ech=?"); params.append(_clean_ech(body.ech))
        if body.branch is not None:
            sets.append("branch=?"); params.append(_clean_branch(body.branch))
        if body.prov is not None:
            p = body.prov.strip().lower()
            sets.append("prov=?"); params.append(p if p in ("osint", "db", "trophy") else "osint")
        if sets:
            params.append(nid)
            conn.execute(f"UPDATE enemy_oob SET {', '.join(sets)} WHERE id=?", params)
            conn.commit()
    return {"ok": True, "id": nid}


@router.delete("/api/enemy/node/{nid}")
def api_enemy_del(nid: str):
    with get_conn() as conn:
        _nodes, by_id, kids = _load(conn)
        n = by_id.get(nid)
        if not n:
            return JSONResponse({"ok": False, "error": "Вузол не знайдено"}, status_code=404)
        if n["root"]:
            return JSONResponse({"ok": False, "error": "Кореневий вузол видалити не можна"}, status_code=400)
        dead, stack = [], [nid]
        while stack:
            x = stack.pop()
            dead.append(x)
            stack.extend(kids.get(x, []))
        ph = ",".join("?" * len(dead))
        conn.execute(f"DELETE FROM enemy_oob WHERE id IN ({ph})", dead)
        conn.commit()
    return {"ok": True, "deleted": dead}
