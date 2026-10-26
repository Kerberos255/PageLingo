@echo off
setlocal EnableExtensions DisableDelayedExpansion
if /I "%~1"=="--help" goto :help
if /I "%~1"=="/?" goto :help
for %%I in ("%~dp0.") do set "PLMT_ROOT=%%~fI"
set "PLMT_ACTION=auto"
if not "%~1"=="" set "PLMT_ACTION=%~1"
if /I not "%PLMT_ACTION%"=="auto" if /I not "%PLMT_ACTION%"=="status" if /I not "%PLMT_ACTION%"=="check" if /I not "%PLMT_ACTION%"=="retry" goto :help
if /I "%PLMT_ROOT:~0,2%"=="C:" goto :system_drive
set "TEMP=%PLMT_ROOT%\.tmp"
set "TMP=%TEMP%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%PLMT_ROOT%\.venv\Scripts\python.exe" goto :python_missing
"%PLMT_ROOT%\.venv\Scripts\python.exe" -B -u "%PLMT_ROOT%\tools\mt-control\launcher.py" --root "%PLMT_ROOT%" %PLMT_ACTION%
set "PLMT_EXIT=%ERRORLEVEL%"
if "%PLMT_EXIT%"=="10" set "PLMT_EXIT=0"
if /I "%PLMT_ACTION%"=="status" exit /b %PLMT_EXIT%
echo.
pause
exit /b %PLMT_EXIT%
:help
echo PageLingo-MT - one entry, current GPU task
echo   x.cmd          Start the current task once, or show its status.
echo   x.cmd status   Read status without training.
echo   x.cmd check    Preflight only, when no task is running.
echo   x.cmd retry    Explicitly repeat a completed or failed task.
echo All task caches and outputs stay on the project drive.
exit /b 0
:system_drive
echo Use the project on its non-C drive.
exit /b 2
:python_missing
echo Missing the existing project .venv. No dependencies were installed.
exit /b 2
