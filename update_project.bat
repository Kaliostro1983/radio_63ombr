@echo off
setlocal

title Update radio_63ombr

set "PROJECT_DIR=%~dp0"

echo ========================================
echo   UPDATE RADIO_63OMBR
echo ========================================
echo.

if not exist "%PROJECT_DIR%" (
    echo [ERROR] Project folder not found:
    echo %PROJECT_DIR%
    pause
    exit /b 1
)

if not exist "%PROJECT_DIR%\.git" (
    echo [ERROR] .git folder not found. This is not a git repository:
    echo %PROJECT_DIR%
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"
echo [INFO] Pulling latest changes from GitHub...
git pull

if errorlevel 1 (
    echo [ERROR] Update failed
    pause
    exit /b 1
)

echo.
echo [OK] Project updated successfully
pause

endlocal