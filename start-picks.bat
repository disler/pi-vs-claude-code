@echo off
title Pi Picks
cd /d "%~dp0"

echo ============================
echo  Pi - Top 3 Extensions
echo ============================
echo.

start "pi-subagent" cmd /k "cd /d %~dp0 && pi -e extensions/subagent-widget.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-agent-team" cmd /k "cd /d %~dp0 && pi -e extensions/agent-team.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-damage-control" cmd /k "cd /d %~dp0 && pi -e extensions/damage-control.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts"

echo.
echo 3 Pi instances launched!
pause
