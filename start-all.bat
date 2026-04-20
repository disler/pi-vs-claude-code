@echo off
title Pi vs CC Launcher
cd /d "%~dp0"

echo ========================================
echo  Pi vs Claude Code - Extension Launcher
echo ========================================
echo.

start "pi-minimal" cmd /k "cd /d %~dp0 && pi -e extensions/minimal.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-damage-control" cmd /k "cd /d %~dp0 && pi -e extensions/damage-control.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-subagent" cmd /k "cd /d %~dp0 && pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-agent-team" cmd /k "cd /d %~dp0 && pi -e extensions/agent-team.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-agent-chain" cmd /k "cd /d %~dp0 && pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-tilldone" cmd /k "cd /d %~dp0 && pi -e extensions/tilldone.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-tool-counter" cmd /k "cd /d %~dp0 && pi -e extensions/tool-counter.ts"
timeout /t 1 >nul

start "pi-purpose-gate" cmd /k "cd /d %~dp0 && pi -e extensions/purpose-gate.ts -e extensions/minimal.ts"
timeout /t 1 >nul

start "pi-pi" cmd /k "cd /d %~dp0 && pi -e extensions/pi-pi.ts -e extensions/theme-cycler.ts"
timeout /t 1 >nul

start "pi-session-replay" cmd /k "cd /d %~dp0 && pi -e extensions/session-replay.ts -e extensions/minimal.ts"

echo.
echo All 10 Pi instances launched!
echo Close this window whenever you want.
pause
