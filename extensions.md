# Extensions Reference

This document summarizes every TypeScript file currently in `extensions/`, including each extension’s purpose and key behavior.

## `extensions/agent-chain.ts`
- **Purpose:** Sequential multi-agent pipeline orchestrator.
- **Key behavior:**
  - Loads chains from `.pi/agents/agent-chain.yaml`.
  - Registers `run_chain` tool that executes chain steps in order (`$INPUT` / `$ORIGINAL` prompt templating).
  - Spawns sub-agent `pi` processes with persistent per-agent session files in `.pi/agent-sessions/`.
  - Renders a step-by-step chain progress widget (pending/running/done/error + elapsed + last output line).
  - Provides `/chain` and `/chain-list` commands.
  - Overrides system prompt to encourage direct work for trivial tasks and `run_chain` for substantial work.

## `extensions/agent-team.ts`
- **Purpose:** Dispatcher-only team orchestration with specialist agents.
- **Key behavior:**
  - Loads agents from `agents/`, `.claude/agents/`, `.pi/agents/` and teams from `.pi/agents/teams.yaml`.
  - Registers `dispatch_agent` tool (primary agent delegates all implementation work).
  - Runs each specialist as a subprocess with resumable session files in `.pi/agent-sessions/`.
  - Renders agent grid cards with status, elapsed time, context usage, and latest work line.
  - Commands: `/agents-team`, `/agents-list`, `/agents-grid`.
  - Restricts active tools to `dispatch_agent` on session start.

## `extensions/cross-agent.ts`
- **Purpose:** Cross-ecosystem discovery/import of commands, skills, and agents.
- **Key behavior:**
  - Scans local/global `.claude`, `.gemini`, `.codex` directories (plus `.pi/agents`) for:
    - `commands/*.md` (registered as runnable Pi slash commands)
    - `skills/` and `agents/*.md` (listed for discovery)
  - Parses frontmatter and expands command argument placeholders (`$1`, `$@`, `$ARGUMENTS`).
  - Shows a styled startup summary panel with counts and discovered items.

## `extensions/damage-control.ts`
- **Purpose:** Rule-based safety guardrail for tool usage.
- **Key behavior:**
  - Loads policy from `.pi/damage-control-rules.yaml`.
  - Intercepts `tool_call` events and blocks/asks confirmation based on:
    - dangerous bash regex patterns
    - zero-access paths
    - read-only paths
    - no-delete paths
  - Applies path resolution + wildcard matching heuristics.
  - Logs enforcement outcomes to `damage-control-log` and aborts blocked turns.

## `extensions/minimal.ts`
- **Purpose:** Minimal UI footer.
- **Key behavior:**
  - Replaces footer with model ID and compact context bar: `[###-------] 30%`.
  - Lightweight, display-only extension.

## `extensions/permission-gate.ts`
- **Purpose:** Interactive permission gate for higher-risk tool usage.
- **Key behavior:**
  - Intercepts `tool_call` events and applies per-tool rules:
    - `bash`: prompts only for dangerous patterns (`rm -rf`, `sudo`, permissive chmod/chown patterns)
    - `write`: prompts only when target path is outside `cwd`
    - `edit`: always prompts
    - `read`: allowed without prompt
  - In non-interactive mode (no UI), blocks any operation that would require confirmation.

## `extensions/pi-pi.ts`
- **Purpose:** Meta-agent orchestrator for building Pi components via parallel experts.
- **Key behavior:**
  - Loads expert agent definitions from `.pi/agents/pi-pi/` (excluding orchestrator file).
  - Registers `query_experts` tool to run multiple expert subprocesses in parallel.
  - Aggregates per-expert outputs/status/timings into one response.
  - Displays a colored expert dashboard with live research progress.
  - Commands: `/experts`, `/experts-grid`.
  - Builds system prompt from `.pi/agents/pi-pi/pi-orchestrator.md` template placeholders.

## `extensions/pure-focus.ts`
- **Purpose:** Distraction-free mode.
- **Key behavior:**
  - Removes footer rendering entirely (empty footer output).
  - Keeps interface focused on conversation/editor only.

## `extensions/purpose-gate.ts`
- **Purpose:** Force explicit session purpose before work begins.
- **Key behavior:**
  - On startup, repeatedly prompts user for purpose text until provided.
  - Blocks user input until purpose is set.
  - Displays persistent “PURPOSE” widget banner.
  - Injects purpose into system prompt for focus enforcement.

## `extensions/session-replay.ts`
- **Purpose:** Timeline replay UI for current session.
- **Key behavior:**
  - Registers `/replay` command showing a custom overlay timeline.
  - Parses session branch messages into `user` / `assistant` / `tool` history items.
  - Supports keyboard navigation, expansion, and close controls.
  - Shows timestamps and elapsed intervals between events.

## `extensions/subagent-widget.ts`
- **Purpose:** Background subagent spawning with live stacked widgets.
- **Key behavior:**
  - Registers tools: `subagent_create`, `subagent_continue`, `subagent_remove`, `subagent_list`.
  - Registers equivalent slash commands: `/sub`, `/subcont`, `/subrm`, `/subclear`.
  - Spawns background `pi` subprocesses with persistent session files (for continuation).
  - Streams output/tool counts into per-subagent widgets.
  - Sends follow-up message automatically when a subagent finishes.

## `extensions/system-select.ts`
- **Purpose:** Runtime selection of active system prompt persona.
- **Key behavior:**
  - Scans project/global agent directories across `.pi`, `.claude`, `.gemini`, `.codex`.
  - `/system` command allows selecting an agent prompt or resetting to default.
  - Prepends selected agent body to default system prompt.
  - Restricts active tool set to agent-declared tools when specified.

## `extensions/theme-cycler.ts`
- **Purpose:** Interactive theme switching via keyboard and command.
- **Key behavior:**
  - Shortcuts: `Ctrl+X` (next theme), `Ctrl+Q` (previous theme).
  - `/theme` opens picker; `/theme <name>` sets directly.
  - Updates status line with current theme.
  - Shows temporary color-swatch widget after switching.

## `extensions/themeMap.ts`
- **Purpose:** Shared utility for extension defaults (theme + terminal title).
- **Key behavior:**
  - Defines `THEME_MAP` from extension name → preferred theme.
  - Exposes `applyExtensionTheme()` with fallback behavior.
  - Exposes `applyExtensionDefaults()` to apply mapped theme and title.
  - Derives primary extension from CLI args so stacked extensions don’t override the primary theme/title.

## `extensions/tilldone.ts`
- **Purpose:** Enforced task-discipline workflow (“work till done”).
- **Key behavior:**
  - Registers `tilldone` tool with actions: `new-list`, `add`, `toggle`, `remove`, `update`, `list`, `clear`.
  - Blocks all non-`tilldone` tool calls unless tasks exist and one task is `inprogress`.
  - Persists/reconstructs task state from tool-result history on branch/session changes.
  - Provides rich UI:
    - current-task widget
    - multi-line footer summary
    - status line updates
    - `/tilldone` overlay viewer
  - Nudges agent after completion if tasks remain incomplete.

## `extensions/tool-counter-widget.ts`
- **Purpose:** Live tool-call counter widget above editor.
- **Key behavior:**
  - Tracks `tool_execution_end` counts by tool.
  - Assigns per-tool colored ANSI background chips.
  - Renders compact widget: total calls + per-tool badges.

## `extensions/tool-counter.ts`
- **Purpose:** Rich two-line metrics footer.
- **Key behavior:**
  - Tracks per-tool execution counts.
  - Computes cumulative assistant token usage and cost from session branch.
  - Displays:
    - line 1: model + context bar + token/cost totals
    - line 2: cwd/git branch + tool call tally
  - Subscribes to branch changes for live footer refresh.
