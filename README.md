# pi-vs-cc

A collection of [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) extensions that showcase UI customization, multi-agent orchestration, safety auditing, and cross-agent integrations — hedging against the leader in agentic coding, Claude Code.

<div align="center">
  <img src="./images/pi-logo.png" alt="pi-vs-cc" width="700">
</div>

---

## Quick Start (2 minutes)

```bash
# 1) Install deps
bun install

# 2) Configure API keys (Pi does not auto-load .env)
cp .env.sample .env

# 3) Launch a curated setup
just ext-minimal
# or: just ext-agent-team
```

## Table of Contents

- [Prerequisites](#prerequisites)
- [API Keys](#api-keys)
- [Installation](#installation)
- [Extensions](#extensions)
- [Usage](#usage)
- [Project Structure](#project-structure)
- [Skills](#skills)
- [Multi-Agent Orchestration](#multi-agent-orchestration)
- [Safety & Permissions](#safety--permissions)
- [Extension Author Reference](#extension-author-reference)
- [Hooks & Events](#hooks--events)
- [Resources](#resources)

## Prerequisites

All three are required:

| Tool             | Purpose                   | Install                                                     |
| ---------------- | ------------------------- | ----------------------------------------------------------- |
| **Bun** ≥ 1.3.2  | Runtime & package manager | [bun.sh](https://bun.sh)                                   |
| **just**         | Task runner               | `brew install just`                                         |
| **pi**           | Pi Coding Agent CLI       | [Pi docs](https://github.com/mariozechner/pi-coding-agent)  |

---

## API Keys

Pi does **not** auto-load `.env` files — keys must be present in your shell environment **before** launching Pi:

```bash
cp .env.sample .env   # copy the template, then fill in your keys
```

| Provider   | Variable             | Get your key                                                                                               |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| OpenAI     | `OPENAI_API_KEY`     | [platform.openai.com](https://platform.openai.com/api-keys)                                                |
| Anthropic  | `ANTHROPIC_API_KEY`  | [console.anthropic.com](https://console.anthropic.com/settings/keys)                                       |
| Google     | `GEMINI_API_KEY`     | [aistudio.google.com](https://aistudio.google.com/app/apikey)                                              |
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai/keys)                                                                |
| Others     | varies               | [Pi Providers docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) |

### Sourcing your keys

**Option A — Source manually each session:**
```bash
source .env && pi
```

**Option B — Shell alias (add to `~/.zshrc` or `~/.bashrc`):**
```bash
alias pi='source $(pwd)/.env && pi'
```

**Option C — Use `just` (auto-wired via `set dotenv-load`):**
```bash
just pi           # .env is loaded automatically for every recipe
just ext-minimal  # works for all recipes
```

---

## Installation

```bash
bun install
```

---

## Extensions

### UI & Display

| Extension               | File                                | Description                                                                              |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **pure-focus**          | `extensions/pure-focus.ts`          | Removes footer and status line — distraction-free mode                                   |
| **minimal**             | `extensions/minimal.ts`             | Compact footer with model name and 10-block context meter `[###-------] 30%`             |
| **tool-counter**        | `extensions/tool-counter.ts`        | Two-line footer: model + context + token/cost on line 1, cwd/branch + tool tally on line 2 |
| **tool-counter-widget** | `extensions/tool-counter-widget.ts` | Above-editor widget showing per-tool call counts with background colors                  |
| **theme-cycler**        | `extensions/theme-cycler.ts`        | Ctrl+X/Ctrl+Q and `/theme` command to cycle/switch between custom themes                 |
| **session-replay**      | `extensions/session-replay.ts`      | Scrollable timeline overlay of session history — custom dialog UI showcase                |

### Workflow & Discipline

| Extension          | File                           | Description                                                                                     |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| **purpose-gate**   | `extensions/purpose-gate.ts`   | Prompts for session intent on startup; persistent purpose widget; blocks prompts until answered  |
| **tilldone**       | `extensions/tilldone.ts`       | Task discipline — define tasks before working; tracks completion with live progress in footer    |

### Multi-Agent Orchestration

| Extension           | File                            | Description                                                                                      |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| **agent-team**      | `extensions/agent-team.ts`      | Dispatcher orchestrator — delegates to specialist agents via `dispatch_agent`; grid dashboard     |
| **agent-chain**     | `extensions/agent-chain.ts`     | Sequential pipeline — chains agents where each step's output feeds the next; `/chain` to run     |
| **subagent-widget** | `extensions/subagent-widget.ts` | `/sub <task>` spawns background subagents with streaming live-progress widgets                    |
| **pi-pi**           | `extensions/pi-pi.ts`          | Meta-agent that builds Pi extensions using parallel research experts                              |

### Safety & Permissions

| Extension          | File                           | Description                                                                                                 |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **permission-gate** | `extensions/permission-gate.ts` | Confirmation prompts for dangerous bash and write/edit ops; compact status (`🔐 GUARDED` / `🔓 AUTO-EDIT`); Ctrl+Shift+E toggle; `/perm-mode` + style |
| **damage-control** | `extensions/damage-control.ts` | Real-time safety auditing — intercepts dangerous patterns and enforces path rules from `damage-control-rules.yaml` |

### Integration

| Extension        | File                          | Description                                                                                                  |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **cross-agent**  | `extensions/cross-agent.ts`   | Scans `.claude/`, `.gemini/`, `.codex/` dirs for commands, skills, and agents; registers them in Pi           |
| **system-select** | `extensions/system-select.ts` | `/system` command to switch between agent personas from `.pi/agents/`, `.claude/agents/`, `.gemini/agents/`  |

### Shared Utilities

| Module             | File                           | Description                                                                                      |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| **permission-ipc** | `extensions/permission-ipc.ts` | File-based IPC for relaying permission prompts from headless subagents to the parent session      |
| **themeMap**       | `extensions/themeMap.ts`       | Per-extension default theme assignments — maps extension filenames to `.pi/themes/` JSON themes   |

---

## Usage

### Run a single extension

```bash
pi -e extensions/<name>.ts
```

### Stack multiple extensions

Extensions compose — pass multiple `-e` flags:

```bash
pi -e extensions/minimal.ts -e extensions/cross-agent.ts
```

### Use `just` recipes

Run `just` with no arguments to list all available recipes:

```bash
just
```

Common recipes:

```bash
just pi                      # Plain Pi, no extensions
just ext-pure-focus          # Distraction-free mode
just ext-minimal             # Minimal context meter footer
just ext-cross-agent         # Cross-agent command loading + minimal footer
just ext-purpose-gate        # Purpose gate + minimal footer
just ext-tool-counter        # Rich two-line footer with tool tally
just ext-tool-counter-widget # Per-tool widget above the editor
just ext-subagent-widget     # Subagent spawner with live progress widgets
just ext-tilldone            # Task discipline system with live progress
just ext-agent-team          # Multi-agent orchestration grid dashboard
just ext-system-select       # Agent persona switcher via /system
just ext-damage-control      # Safety auditing + minimal footer
just ext-agent-chain         # Sequential pipeline orchestrator
just ext-pi-pi               # Meta-agent with parallel research experts
just ext-session-replay      # Scrollable timeline overlay
just ext-theme-cycler        # Theme cycler + minimal footer
just all                     # Open every extension in its own terminal window
```

The `open` recipe spins up a new terminal window with any combination of stacked extensions (omit `.ts`):

```bash
just open purpose-gate minimal tool-counter-widget
```

---

## Project Structure

```
pi-vs-cc/
├── extensions/          # Pi extension source files (.ts)
├── specs/               # Feature specifications for extensions
├── .pi/
│   ├── agent-sessions/  # Ephemeral session files (gitignored)
│   ├── agents/          # Agent definitions for team and chain extensions
│   │   ├── pi-pi/       # Expert agents for the pi-pi meta-agent
│   │   ├── agent-chain.yaml  # Pipeline definitions for agent-chain
│   │   ├── teams.yaml        # Team rosters for agent-team
│   │   └── *.md              # Agent personas (builder, planner, reviewer, scout,
│   │                         #   red-team, code-simplifier, documenter, bowser)
│   ├── skills/          # Custom skills (bowser, skill-development)
│   ├── themes/          # Custom themes (.json) for theme-cycler & themeMap
│   ├── damage-control-rules.yaml
│   └── settings.json
├── justfile             # Task definitions
├── CLAUDE.md            # Conventions and tooling reference (for agents)
├── COMPARISON.md        # Claude Code vs Pi feature comparison
├── RESERVED_KEYS.md     # Keybinding reference for extension authors
├── THEME.md             # Color token conventions
└── TOOLS.md             # Built-in tool function signatures
```

---

## Skills

This workspace ships custom skills under `.pi/skills/`:

- `bowser` — headless browser automation and scraping via Playwright CLI
- `skill-development` — guidance for creating and organizing new skills

These skills are available to agents when the triggering task matches each skill's description.

---

## Multi-Agent Orchestration

Pi's architecture makes it easy to coordinate multiple autonomous agents. This playground includes three orchestration patterns:

### Subagent Widget (`/sub`)

Offloads isolated tasks to background Pi agents while you continue working. Each subagent reports streaming progress via a live-updating widget above the editor.

### Agent Teams (`/team`)

A dispatcher-only orchestrator. The primary agent never answers directly — it reviews your request, selects a specialist from a defined roster, and delegates via `dispatch_agent`.

- **Team rosters** are configured in `.pi/agents/teams.yaml`. Each key maps to a list of agent names:
  - `full` — scout, planner, builder, reviewer, code-simplifier, documenter
  - `plan-build` — planner, builder, reviewer
  - `info` — scout, documenter, reviewer
  - `frontend` — planner, builder, bowser
  - `pi-pi` — ext-expert, theme-expert, skill-expert, config-expert, tui-expert, prompt-expert, agent-expert
- **Agent personas** live in `.pi/agents/*.md` — each defines a specialist's system prompt and capabilities.
- The **pi-pi** team delegates to Pi framework experts in `.pi/agents/pi-pi/` for building high-quality extensions with parallel documentation research.

### Agent Chains (`/chain`)

A sequential pipeline orchestrator. Unlike the dynamic dispatcher, chains follow a fixed sequence where each step's output feeds into the next.

- Workflows are defined in `.pi/agents/agent-chain.yaml` as a list of steps, each specifying an `agent` and `prompt`.
- `$INPUT` injects the previous step's output; `$ORIGINAL` always contains the user's initial prompt.
- Example: `plan-build-review` feeds your prompt to the planner → passes the plan to the builder → sends the code to the reviewer.

---

## Safety & Permissions

### Damage Control

The `damage-control` extension intercepts every tool call and evaluates it against `.pi/damage-control-rules.yaml`:

- **Dangerous commands** — regex patterns block destructive bash commands (`rm -rf`, `git reset --hard`, `DROP DATABASE`). Some rules use `ask: true` to pause for confirmation instead of blocking outright.
- **Zero-access paths** — prevents reading or writing sensitive files (`.env`, `~/.ssh/`, `*.pem`).
- **Read-only paths** — allows reading but blocks writes to system files and lockfiles.
- **No-delete paths** — allows modification but prevents deletion of critical config (`.git/`, `Dockerfile`).

### Permission Gate

The `permission-gate` extension adds interactive approval flows for write/edit operations and dangerous bash commands:

- **Allow once**, **Always allow this file (session)**, or **Deny** for each write/edit.
- **Message to agent** — attach feedback when approving or denying; appended to tool results so the active agent/subagent sees it in-turn.
- **Mode labels** — standardized UI badges: `🔐 GUARDED` and `🔓 AUTO-EDIT`.
- **Compact status by default** — persistent status stays short; use `/perm-mode style [compact|medium|verbose]` to change verbosity.
- **Auto-edit mode** — Ctrl+Shift+E toggles pre-approval for all write/edit ops; `/perm-mode` to view or set.
- **IPC support** — headless subagents relay permission prompts to the parent session via `permission-ipc`.

---

## Extension Author Reference

| Doc | Description |
| --- | --- |
| **[COMPARISON.md](COMPARISON.md)** | Feature-by-feature comparison of Claude Code vs Pi across 12 categories |
| **[RESERVED_KEYS.md](RESERVED_KEYS.md)** | Reserved, overridable, and safe keybindings for extensions |
| **[THEME.md](THEME.md)** | Color tokens (`success`, `accent`, `warning`, `dim`, `muted`) and their UI roles |
| **[TOOLS.md](TOOLS.md)** | Function signatures for built-in tools (`read`, `bash`, `edit`, `write`) |

---

## Hooks & Events

Side-by-side comparison of lifecycle hooks in [Claude Code](https://docs.anthropic.com/en/docs/claude-code/hooks) vs [Pi Agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#events):

| Category            | Claude Code                                                      | Pi Agent                                                                                                                | Available In |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Session**         | `SessionStart`, `SessionEnd`                                     | `session_start`, `session_shutdown`                                                                                     | Both         |
| **Input**           | `UserPromptSubmit`                                               | `input`                                                                                                                 | Both         |
| **Tool**            | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`                | `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`                       | Both         |
| **Bash**            | —                                                                | `BashSpawnHook`, `user_bash`                                                                                            | Pi           |
| **Permission**      | `PermissionRequest`                                              | —                                                                                                                       | CC           |
| **Compact**         | `PreCompact`                                                     | `session_before_compact`, `session_compact`                                                                             | Both         |
| **Branching**       | —                                                                | `session_before_fork`, `session_fork`, `session_before_switch`, `session_switch`, `session_before_tree`, `session_tree` | Pi           |
| **Agent / Turn**    | —                                                                | `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`                                              | Pi           |
| **Message**         | —                                                                | `message_start`, `message_update`, `message_end`                                                                        | Pi           |
| **Model / Context** | —                                                                | `model_select`, `context`                                                                                               | Pi           |
| **Sub-agents**      | `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted` | —                                                                                                                       | CC           |
| **Config**          | `ConfigChange`                                                   | —                                                                                                                       | CC           |
| **Worktree**        | `WorktreeCreate`, `WorktreeRemove`                               | —                                                                                                                       | CC           |
| **System**          | `Stop`, `Notification`                                           | —                                                                                                                       | CC           |

---

## Troubleshooting

- **`pi` says missing API key**: make sure your shell actually loaded `.env` (`source .env`) before launching Pi.
- **Permission prompts appear but feedback seems ignored**: run `/reload` after extension changes, then verify `permission-gate.ts` is loaded in your current stack.
- **A `just ext-*` recipe doesn't include your extension**: check `justfile`; some utilities (like `permission-gate`) are currently intended for stacked/manual use.
- **Theme not changing**: ensure `.pi/themes/*.json` exists and `theme-cycler` is in your extension stack.

---

## Resources

### Pi Documentation

| Doc                                                                                                     | Description                  |
| ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [README.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)              | Overview and getting started |
| [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) | Extension system             |
| [sdk.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)               | TypeScript SDK reference     |
| [rpc.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)               | RPC protocol specification   |
| [json.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md)             | JSON event stream format     |
| [providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)   | API keys and provider setup  |
| [models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)         | Custom models (Ollama, vLLM) |
| [skills.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)         | Skills (Agent Skills standard) |
| [settings.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)     | Configuration                |
| [compaction.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) | Context compaction           |

### Learn More

| Resource | Description |
| -------- | ----------- |
| [Mario's Twitter](https://x.com/badlogicgames) | Creator of Pi Coding Agent |
| [Tactical Agentic Coding](https://agenticengineer.com/tactical-agentic-coding?y=pivscc) | Learn tactical agentic coding patterns |
| [IndyDevDan YouTube](https://www.youtube.com/@indydevdan) | Agentic coding tutorials and strategies |
