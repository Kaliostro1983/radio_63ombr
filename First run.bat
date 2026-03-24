@echo off
setlocal

REM Run from repository root (directory of this script)
cd /d "%~dp0"

echo ============================================
echo   63ombr - First run setup
echo ============================================
echo.

where py >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python launcher 'py' not found.
  echo Install Python 3.10+ from python.org and rerun this file.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/7] Creating virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 (
    echo [ERROR] Failed to create virtual environment.
    pause
    exit /b 1
  )
) else (
  echo [1/7] Virtual environment already exists.
)

echo [2/7] Activating virtual environment...
call ".venv\Scripts\activate.bat"
if errorlevel 1 (
  echo [ERROR] Failed to activate .venv
  pause
  exit /b 1
)

echo [3/7] Upgrading pip...
python -m pip install --upgrade pip
if errorlevel 1 (
  echo [ERROR] pip upgrade failed.
  pause
  exit /b 1
)

echo [4/7] Installing requirements...
pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] Dependency installation failed.
  pause
  exit /b 1
)

if not exist "config.env" (
  echo [5/7] Creating config.env from config.env.example...
  copy /Y "config.env.example" "config.env" >nul
  if errorlevel 1 (
    echo [ERROR] Failed to create config.env
    pause
    exit /b 1
  )
) else (
  echo [5/7] config.env already exists.
)

echo [6/7] Initializing database...
python -m scripts.init_db
if errorlevel 1 (
  echo [ERROR] DB initialization failed.
  pause
  exit /b 1
)

if exist "Frequencies_63.xlsx" (
  echo [7/7] Importing Frequencies_63.xlsx...
  python -m scripts.import_from_excel
  if errorlevel 1 (
    echo [ERROR] XLSX import failed.
    pause
    exit /b 1
  )
) else (
  echo [7/7] Frequencies_63.xlsx not found - skipping XLSX import.
)

echo.
echo Setup completed successfully.
echo.
echo You can run the app with:
echo   start_localhost.bat
echo or:
echo   .venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-config uvicorn_log_config.json
echo.

set /p RUN_NOW=Start app now? (Y/N): 
if /I "%RUN_NOW%"=="Y" (
  set APP_CONFIG=config.env
  start http://127.0.0.1:8000
  uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-config uvicorn_log_config.json
)

pause
endlocal
