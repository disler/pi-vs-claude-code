# Extensions Reference

A practical catalog of everything in `extensions/`.

- How to run an extension: `pi -e extensions/<name>.ts`
- You can stack multiple extensions by repeating `-e`.
- `extensions/themeMap.ts` is a shared utility module (not a standalone extension).

---

## Quick index

| File | Type | What it does |
|---|---|---|
| `agent-chain.ts` | Extension | Sequential multi-agent chain runner |
| `agent-team.ts` | Extension | Dispatcher-based specialist team orchestration |
| `cross-agent.ts` | Extension | Imports/discovers commands, skills, and agents from other ecosystems |
| `damage-control.ts` | Extension | Policy guardrail for risky tool calls |
| `minimal.ts` | Extension | Minimal compact footer |
| `permission-gate.ts` | Extension | Interactive confirmation gate for risky tool calls |
| `pi-pi.ts` | Extension | Parallel expert-orchestrator workflow |
| `pure-focus.ts` | Extension | Removes footer for distraction-free UI |
| `purpose-gate.ts` | Extension | Requires explicit purpose before work |
| `session-replay.ts` | Extension | Timeline replay overlay for current session |
| `subagent-widget.ts` | Extension | Background subagents with live widgets |
| `system-select.ts` | Extension | Runtime system prompt/persona selection |
| `theme-cycler.ts` | Extension | Keyboard + command theme switching |
| `themeMap.ts` | Utility | Shared theme/title defaults for extensions |
| `tilldone.ts` | Extension | Enforced task workflow and gating |
| `tool-counter-widget.ts` | Extension | Live per-tool call chips widget |
| `tool-counter.ts` | Extension | Rich footer with usage/cost/tool metrics |

---

## Extension details

### `extensions/agent-chain.ts`
**Purpose:** Sequential multi-agent pipeline orchestrator.

**Key behavior**
- Loads chains from `.pi/agents/agent-chain.yaml`.
- Registers `run_chain` tool to execute steps in order (`$INPUT` and `$ORIGINAL` templating).
- Spawns sub-agent `pi` processes with persistent per-agent session files in `.pi/agent-sessions/`.
- Renders step-by-step chain progress (pending/running/done/error + elapsed + last output line).
- Adds `/chain` and `/chain-list` commands.
- Adjusts system prompt to favor direct work for trivial tasks and `run_chain` for larger work.

### `extensions/agent-team.ts`
**Purpose:** Dispatcher-only team orchestration with specialist agents.

**Key behavior**
- Loads agents from `agents/`, `.claude/agents/`, `.pi/agents/`, and teams from `.pi/agents/teams.yaml`.
- Registers `dispatch_agent` so the primary agent delegates implementation.
- Runs specialists as subprocesses with resumable session files in `.pi/agent-sessions/`.
- Renders an agent grid with status, elapsed time, context usage, and latest work line.
- Adds `/agents-team`, `/agents-list`, and `/agents-grid` commands.
- Restricts active tools to `dispatch_agent` on session start.

### `extensions/cross-agent.ts`
**Purpose:** Cross-ecosystem discovery/import of commands, skills, and agents.

**Key behavior**
- Scans local/global `.claude`, `.gemini`, `.codex` directories (plus `.pi/agents`) for:
  - `commands/*.md` (registered as runnable Pi slash commands)
  - `skills/` and `agents/*.md` (listed for discovery)
- Parses frontmatter and expands argument placeholders (`$1`, `$@`, `$ARGUMENTS`).
- Shows a startup summary panel with counts and discovered items.

### `extensions/damage-control.ts`
**Purpose:** Rule-based safety guardrail for tool usage.

**Key behavior**
- Loads policy from `.pi/damage-control-rules.yaml`.
- Intercepts `tool_call` events and blocks/asks confirmation based on:
  - dangerous bash regex patterns
  - zero-access paths
  - read-only paths
  - no-delete paths
- Applies path resolution + wildcard matching heuristics.
- Logs enforcement results to `damage-control-log` and aborts blocked turns.

### `extensions/minimal.ts`
**Purpose:** Minimal UI footer.

**Key behavior**
- Replaces footer with model ID and compact context bar: `[###-------] 30%`.
- Lightweight display-only extension.

### `extensions/permission-gate.ts`
**Purpose:** Interactive permission gate for higher-risk tool usage.

**Key behavior**
- Intercepts `tool_call` events with per-tool rules:
  - `bash`: prompts only for dangerous patterns (`rm -rf`, `sudo`, permissive chmod/chown patterns)
  - `write`: always prompts
  - `edit`: always prompts
  - `read`: always allowed
- In non-interactive mode (no UI), blocks operations that would require confirmation.

### `extensions/pi-pi.ts`
**Purpose:** Meta-agent orchestrator for parallel expert workflows.

**Key behavior**
- Loads expert definitions from `.pi/agents/pi-pi/` (excluding orchestrator file).
- Registers `query_experts` to run multiple expert subprocesses in parallel.
- Aggregates outputs/status/timings into a unified response.
- Displays a colored expert dashboard with live progress.
- Adds `/experts` and `/experts-grid` commands.
- Builds system prompt from `.pi/agents/pi-pi/pi-orchestrator.md` placeholders.

### `extensions/pure-focus.ts`
**Purpose:** Distraction-free mode.

**Key behavior**
- Removes footer rendering entirely.
- Keeps UI focused on conversation/editor.

### `extensions/purpose-gate.ts`
**Purpose:** Force explicit session purpose before work begins.

**Key behavior**
- Prompts until non-empty purpose text is provided.
- Blocks user input until purpose is set.
- Shows a persistent `PURPOSE` widget banner.
- Injects purpose into system prompt.

### `extensions/session-replay.ts`
**Purpose:** Timeline replay UI for the current session.

**Key behavior**
- Registers `/replay` command for a custom timeline overlay.
- Parses branch messages into `user` / `assistant` / `tool` history items.
- Supports keyboard navigation, expansion, and close controls.
- Shows timestamps and elapsed intervals.

### `extensions/subagent-widget.ts`
**Purpose:** Background subagent spawning with live stacked widgets.

**Key behavior**
- Registers tools: `subagent_create`, `subagent_continue`, `subagent_remove`, `subagent_list`.
- Registers slash commands: `/sub`, `/subcont`, `/subrm`, `/subclear`.
- Spawns background `pi` subprocesses with persistent sessions.
- Streams output and tool counts into per-subagent widgets.
- Sends an automatic follow-up when a subagent finishes.

### `extensions/system-select.ts`
**Purpose:** Runtime selection of active system prompt persona.

**Key behavior**
- Scans project/global agent directories across `.pi`, `.claude`, `.gemini`, `.codex`.
- `/system` selects an agent prompt or resets to default.
- Prepends selected agent content to default system prompt.
- Restricts active tools to agent-declared tools when specified.

### `extensions/theme-cycler.ts`
**Purpose:** Interactive theme switching via keyboard and command.

**Key behavior**
- Shortcuts: `Ctrl+X` (next), `Ctrl+Q` (previous).
- `/theme` opens picker; `/theme <name>` sets directly.
- Updates status line with current theme.
- Shows temporary color-swatch widget on switch.

### `extensions/themeMap.ts` (utility)
**Purpose:** Shared utility for extension defaults (theme + terminal title).

**Key behavior**
- Defines `THEME_MAP` mapping extension name → preferred theme.
- Exposes `applyExtensionTheme()` with fallback behavior.
- Exposes `applyExtensionDefaults()` for mapped theme/title.
- Derives the primary extension from CLI args so stacked extensions do not override primary theme/title.

### `extensions/tilldone.ts`
**Purpose:** Enforced task-discipline workflow (“work till done”).

**Key behavior**
- Registers `tilldone` tool with actions: `new-list`, `add`, `toggle`, `remove`, `update`, `list`, `clear`.
- Blocks non-`tilldone` tool calls unless tasks exist and one task is `inprogress`.
- Persists/reconstructs task state from tool-result history across branch/session changes.
- Provides a current-task widget, multi-line footer summary, status line updates, and `/tilldone` overlay.
- Nudges the agent after completion if tasks remain incomplete.

### `extensions/tool-counter-widget.ts`
**Purpose:** Live tool-call counter widget above the editor.

**Key behavior**
- Tracks `tool_execution_end` counts by tool.
- Assigns per-tool colored ANSI chips.
- Renders compact totals + per-tool badges.

### `extensions/tool-counter.ts`
**Purpose:** Rich two-line metrics footer.

**Key behavior**
- Tracks per-tool execution counts.
- Computes cumulative assistant token usage/cost from current branch.
- Displays:
  - line 1: model + context bar + token/cost totals
  - line 2: cwd/git branch + tool call tally
- Subscribes to branch changes for live refresh.

---

## Notes

- Several extensions orchestrate subprocesses and persist sessions under `.pi/agent-sessions/`.
- Safety-focused extensions (`damage-control`, `permission-gate`) can be combined with orchestration extensions.
- UI-focused extensions (`minimal`, `pure-focus`, `tool-counter*`, `theme-cycler`) are mostly composable, but footer-replacing extensions may override each other.