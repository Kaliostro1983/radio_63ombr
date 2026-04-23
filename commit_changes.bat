@echo off
setlocal enabledelayedexpansion

title Commit changes — radio_63ombr

set "PROJECT_DIR=%~dp0"

echo ========================================
echo   COMMIT CHANGES — RADIO_63OMBR
echo ========================================
echo.

cd /d "%PROJECT_DIR%"

if not exist ".git" (
    echo [ERROR] .git folder not found. Not a git repository.
    pause
    exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git not found in PATH. Install Git first.
    pause
    exit /b 1
)

echo [INFO] Current status:
echo ----------------------------------------
git status --short
echo ----------------------------------------
echo.

git diff --cached --quiet && git diff --quiet
if not errorlevel 1 (
    git ls-files --others --exclude-standard | findstr /r "." >nul 2>nul
    if errorlevel 1 (
        echo [INFO] Nothing to commit. Working tree is clean.
        pause
        exit /b 0
    )
)

set /p "COMMIT_MSG=Commit message: "

if "!COMMIT_MSG!"=="" (
    echo [ERROR] Commit message cannot be empty.
    pause
    exit /b 1
)

echo.
echo [INFO] Staging all changes...
git add -A

if errorlevel 1 (
    echo [ERROR] git add failed.
    pause
    exit /b 1
)

echo [INFO] Committing...
git commit -m "!COMMIT_MSG!"

if errorlevel 1 (
    echo [ERROR] Commit failed.
    pause
    exit /b 1
)

echo.
echo [OK] Committed successfully.
echo.
git log --oneline -3
echo.
pause

endlocal
