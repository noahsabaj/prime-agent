@echo off
REM Windows source runner for cmd.exe. Delegates to prime-agent.ps1 so both
REM shells share one implementation.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0prime-agent.ps1" %*
exit /b %ERRORLEVEL%
