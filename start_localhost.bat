@echo off
setlocal

REM ---- Create venv if missing ----
if not exist .venv (
  py -3 -m venv .venv
)

call .venv\Scripts\activate

REM ---- Install deps ----
pip install -r requirements.txt

REM ---- Copy config if missing ----
if not exist config.env (
  copy config.env.example config.env >nul
)

REM ---- Initialize DB + seed + (optional) import ----
python -m scripts.init_db
python -m scripts.import_from_excel

REM ---- Run server on localhost only ----
set APP_CONFIG=config.env
uvicorn app.main:app --host 127.0.0.1 --port 8000

endlocal
