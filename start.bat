@echo off
title YapOS
cd /d "%~dp0"

:run
node bot.js
if %errorlevel%==0 goto done
if %errorlevel%==2 goto token
echo.
echo YapOS stopped unexpectedly. Restarting in 5 seconds. Close this window to stop.
timeout /t 5 /nobreak >nul
goto run

:token
echo.
echo YapOS needs a working bot token. Put it in config.json, then run start.bat again.
pause
goto done

:done
