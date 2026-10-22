@echo off
if /I "%~1"=="check" (
  call "%~dp0run-fixed-slots-v1.cmd" eval-check
) else (
  call "%~dp0run-fixed-slots-v1.cmd" eval
)
exit /b %ERRORLEVEL%
