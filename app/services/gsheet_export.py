"""Створення Google-таблиці з xlsx у заданій папці Google Диску.

Автентифікація — сервіс-акаунт Google Cloud. Ключ (JSON) читається з шляху
GDRIVE_SA_JSON (env) або з config/gdrive_service_account.json у корені проєкту.
Папку призначення потрібно розшарити на e-mail сервіс-акаунта (з правом
редагування), інакше Drive поверне 404/insufficientPermissions.
"""
from __future__ import annotations

import os
import re

_SCOPES = ["https://www.googleapis.com/auth/drive"]


def _sa_path() -> str:
    env = os.environ.get("GDRIVE_SA_JSON")
    if env:
        return env
    here = os.path.dirname(__file__)
    return os.path.normpath(os.path.join(here, "..", "..", "config", "gdrive_service_account.json"))


def _drive_service():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    path = _sa_path()
    if not os.path.exists(path):
        raise FileNotFoundError(
            "Немає ключа сервіс-акаунта Google. Розмістіть JSON-ключ у "
            f"{path} (або вкажіть шлях у GDRIVE_SA_JSON) і розшарте цільову "
            "папку Google Диску на e-mail сервіс-акаунта."
        )
    creds = service_account.Credentials.from_service_account_file(path, scopes=_SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def extract_folder_id(folder: str) -> str:
    """ID папки з посилання (…/folders/<ID>?…), з ?id=<ID> або як є."""
    folder = (folder or "").strip()
    m = re.search(r"/folders/([A-Za-z0-9_-]+)", folder)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([A-Za-z0-9_-]+)", folder)
    if m:
        return m.group(1)
    return folder


def create_sheet_from_xlsx(title: str, folder: str, xlsx_bytes: bytes, share_link: bool = True) -> dict:
    """Завантажує xlsx у Drive із конвертацією в Google-таблицю у папці folder.
    Повертає {"id", "url"}. share_link=True → доступ на перегляд за посиланням."""
    from googleapiclient.http import MediaInMemoryUpload

    svc = _drive_service()
    folder_id = extract_folder_id(folder)
    meta = {"name": title, "mimeType": "application/vnd.google-apps.spreadsheet"}
    if folder_id:
        meta["parents"] = [folder_id]
    media = MediaInMemoryUpload(
        xlsx_bytes,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        resumable=False,
    )
    f = svc.files().create(
        body=meta, media_body=media, fields="id,webViewLink",
        supportsAllDrives=True,
    ).execute()
    file_id = f["id"]
    if share_link:
        try:
            svc.permissions().create(
                fileId=file_id, body={"role": "reader", "type": "anyone"},
                supportsAllDrives=True,
            ).execute()
        except Exception:
            pass
    url = f.get("webViewLink") or f"https://docs.google.com/spreadsheets/d/{file_id}/edit"
    return {"id": file_id, "url": url}
