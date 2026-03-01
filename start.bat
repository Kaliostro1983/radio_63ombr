@echo off
title 63ombr FastAPI Server
cd /d D:\Armor\radio_63ombr
call .venv\Scripts\activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
pause