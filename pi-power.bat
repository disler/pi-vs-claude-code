@echo off
REM pi-power: The standard road. disler's extensions + pi-pai v3.
REM 
REM From disler/pi-vs-claude-code:
REM   subagent-widget: /sub background agents with live progress
REM   tilldone: task tracking discipline
REM   tool-counter: rich stats footer (model, branch, cost, tool tally)
REM   theme-cycler: Ctrl+X to cycle themes
REM
REM From arosstale/pi-pai v3 (merges Miessler + disler):
REM   /pai: 7-phase Algorithm with ISC, effort levels, learnings
REM   /ralph: simple iteration loops
REM   /rate: quality signals with auto-learning
REM   damage-control: 97+ bash patterns, zero-access/read-only/no-delete paths
REM   live TUI widget: mission, goals, loop progress, ratings
REM
REM NOTE: damage-control.ts removed — pi-pai v3 handles it with the same YAML.
cd /d "%~dp0"
pi -e extensions/subagent-widget.ts -e extensions/tilldone.ts -e extensions/tool-counter.ts -e extensions/theme-cycler.ts -e "%USERPROFILE%\Projects\pi-pai\src\extension.ts"
