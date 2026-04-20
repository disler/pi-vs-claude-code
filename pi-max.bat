@echo off
REM pi-max: Everything loaded. Max verbosity, deep effort.
REM All disler extensions + pi-pai v3 + agent chains
cd /d "%~dp0"
pi -e extensions/subagent-widget.ts -e extensions/agent-chain.ts -e extensions/agent-team.ts -e extensions/tilldone.ts -e extensions/tool-counter.ts -e extensions/theme-cycler.ts -e extensions/session-replay.ts -e "%USERPROFILE%\Projects\pi-pai\src\extension.ts"
