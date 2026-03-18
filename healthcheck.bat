@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Change to script directory
cd /d "%~dp0"

:menu
echo.
echo ======================================
echo   Healthcheck DB invariants - menu
echo ======================================
echo   1 ^) Перевірка дублікатів messages
echo   2 ^) Перевірка графа позивних (edges)
echo   3 ^) Перевірка lifecycle (messages -> ingest)
echo   4 ^) Вийти
echo.
set /p choice=Оберіть пункт (1-4) та натисніть Enter: 

if "%choice%"=="1" goto run_duplicates
if "%choice%"=="2" goto run_edges
if "%choice%"=="3" goto run_lifecycle
if "%choice%"=="4" goto end

echo.
echo Невірний вибір. Спробуйте ще раз.
pause
goto menu

:run_duplicates
echo.
echo === Запуск перевірки дублікатів messages ===
python -m scripts.healthcheck_invariants duplicates
echo.
pause
goto menu

:run_edges
echo.
echo === Запуск перевірки графа позивних (edges) ===
python -m scripts.healthcheck_invariants edges
echo.
pause
goto menu

:run_lifecycle
echo.
echo === Запуск перевірки lifecycle (messages -> ingest) ===
python -m scripts.healthcheck_invariants lifecycle
echo.
pause
goto menu

:end
echo.
echo Завершення роботи healthcheck.
endlocal
exit /b 0

