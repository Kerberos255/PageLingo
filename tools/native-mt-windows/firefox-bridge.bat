@echo off
setlocal
if not "%~2"=="pagelingo@kerberos255" exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start.ps1" -FirefoxBridge
exit /b %errorlevel%
