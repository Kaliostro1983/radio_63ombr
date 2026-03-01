from __future__ import annotations
import os
from dataclasses import dataclass
from dotenv import load_dotenv

@dataclass(frozen=True)
class Settings:
    app_name: str = "63ombr"
    db_path: str = "database/radio.db"
    backup_dir: str = "backups"
    backup_keep: int = 30
    freq_xlsx: str = "Frequencies_63.xlsx"
    etalon_xlsx: str = ""

def load_settings() -> Settings:
    env_path = os.getenv("APP_CONFIG", "config.env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
    return Settings(
        app_name=os.getenv("APP_NAME", "63ombr"),
        db_path=os.getenv("DB_PATH", "database/radio.db"),
        backup_dir=os.getenv("BACKUP_DIR", "backups"),
        backup_keep=int(os.getenv("BACKUP_KEEP", "30")),
        freq_xlsx=os.getenv("FREQ_XLSX", "Frequencies_63.xlsx"),
        etalon_xlsx=os.getenv("ETALON_XLSX", ""),
    )

settings = load_settings()
