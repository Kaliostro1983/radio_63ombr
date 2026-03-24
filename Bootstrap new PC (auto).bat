@echo off
setlocal

echo ============================================
echo   63ombr - Bootstrap (auto mode)
echo ============================================
echo.

set "REPO_URL=https://github.com/Kaliostro1983/radio_63ombr.git"
set "TARGET_DIR=%USERPROFILE%\radio_63ombr"

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git not found in PATH.
  echo Install Git for Windows and run this script again.
  pause
  exit /b 1
)

where py >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python launcher 'py' not found.
  echo Install Python 3.10+ and run this script again.
  pause
  exit /b 1
)

echo Repo:   %REPO_URL%
echo Target: %TARGET_DIR%
echo.

if exist "%TARGET_DIR%\.git" (
  echo [1/4] Repository already exists, pulling latest changes...
  cd /d "%TARGET_DIR%"
  git pull
  if errorlevel 1 (
    echo [ERROR] git pull failed.
    pause
    exit /b 1
  )
) else (
  echo [1/4] Cloning repository...
  git clone "%REPO_URL%" "%TARGET_DIR%"
  if errorlevel 1 (
    echo [ERROR] git clone failed.
    pause
    exit /b 1
  )
  cd /d "%TARGET_DIR%"
)

echo [2/4] Checking setup scripts...
if not exist "First run.bat" (
  echo [ERROR] First run.bat is missing in repository root.
  pause
  exit /b 1
)

echo [3/4] Running initial project setup...
call "First run.bat"
if errorlevel 1 (
  echo [ERROR] First run setup failed.
  pause
  exit /b 1
)

echo [4/4] Bootstrap completed.
echo.
echo Required local/private files (if needed):
echo   - config.env (created from config.env.example if missing)
echo   - reports_config.json (not tracked)
echo   - peleng_report_config.json (not tracked)
echo   - Frequencies_63.xlsx (optional import source)
echo.
pause
endlocal
