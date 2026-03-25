@echo off
setlocal

title Bootstrap new PC (auto)

echo ========================================
echo   BOOTSTRAP RADIO_63OMBR
echo ========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git not found. Install Git first.
    pause
    exit /b 1
)

where py >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python launcher "py" not found. Install Python first.
    pause
    exit /b 1
)

set "BASE_DIR=%~dp0РЕР_ГОІ"
set "PROJECT_DIR=%BASE_DIR%\radio_63ombr"
set "REPO_URL=https://github.com/Kaliostro1983/radio_63ombr.git"

echo [INFO] Base folder: %BASE_DIR%
echo [INFO] Project folder: %PROJECT_DIR%
echo.

if not exist "%BASE_DIR%" (
    echo [INFO] Creating folder %BASE_DIR%
    mkdir "%BASE_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create folder %BASE_DIR%
        pause
        exit /b 1
    )
)

if exist "%PROJECT_DIR%\.git" (
    echo [INFO] Existing repository found. Updating...
    cd /d "%PROJECT_DIR%"
    git pull
    if errorlevel 1 (
        echo [ERROR] git pull failed
        pause
        exit /b 1
    )
) else (
    echo [INFO] Cloning repository...
    cd /d "%BASE_DIR%"
    git clone "%REPO_URL%" "radio_63ombr"
    if errorlevel 1 (
        echo [ERROR] git clone failed
        pause
        exit /b 1
    )
)

echo.
echo [INFO] Running first setup...
if exist "%PROJECT_DIR%\First run.bat" (
    call "%PROJECT_DIR%\First run.bat"
) else (
    echo [ERROR] First run.bat not found in %PROJECT_DIR%
    pause
    exit /b 1
)

endlocal