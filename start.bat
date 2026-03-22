@echo off
title 63ombr FastAPI Server
cd /d D:\Armor\radio_63ombr
call .venv\Scripts\activate
set PYTHONUNBUFFERED=1
start http://127.0.0.1:8000
uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-config uvicorn_log_config.json
pause