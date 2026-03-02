# Claude Code vs Pi Agent — Feature Comparison

> Pi v0.52.10 vs Claude Code (Feb 2026)

---

## Design Philosophy

| Dimension                    | Claude Code                                                                                                                         | Pi Agent                                                                                                                                              | Winner      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Core Mantra                  | "Tool for every engineer" — batteries-included, accessible to all skill levels                                                      | "If I don't need it, it won't be built" — minimal, opinionated, built for one engineer's workflow                                                     | Both        |
| Approach to Features         | Ship everything built-in (sub-agents, teams, MCP, plan mode, todos, web search, notebooks, 10+ tools)                              | Ship the minimum (4 tools, ~200-token prompt). Everything else is opt-in via extensions or bash                                                       | Both        |
| Safety Philosophy            | Safe by default — deny-first permissions, 5 modes, filesystem sandbox, Haiku pre-screening of commands                             | YOLO by default — no permissions, no sandbox. "Security in coding agents is mostly theater; if it can write and run code, it's game over"             | Both        |
| System Prompt Trust Model    | Extensive guardrails (~10K tokens) — behavioral rules, formatting instructions, safety constraints, tool usage examples              | Trust the model (~200 tokens) — "frontier models have been RL-trained up the wazoo, they inherently understand what a coding agent is"                | Both        |
| Observability                | Abstracted — sub-agents are black boxes, compaction happens silently, system prompt not user-visible by default                      | Full transparency — every token visible, every tool call inspectable, no hidden orchestration, session HTML export                                     | Pi          |
| Context Engineering          | Managed for you — auto-compaction, sub-agents handle overflow, system decides what enters context                                   | User-controlled — minimal prompt overhead, no hidden injections, "exactly controlling what goes into context yields better outputs"                    | Pi          |
| Extensibility Model          | Shell hooks (external processes) + MCP protocol + Skills (markdown prompts) — loosely coupled, config-driven                        | TypeScript in-process extensions — same runtime, access full session state, block/modify/transform any event                                          | Both        |
| Target Audience              | Every engineer — beginner-friendly, enterprise-ready, guided workflows, progressive disclosure                                      | Power users — engineers who want control, understand tradeoffs, willing to build their own workflows                                                  | Both        |
| Multi-Model Stance           | Claude-first — optimized for Claude family, gateway workaround for others                                                           | Model-agnostic from day one — 324 models, 20+ providers, cross-provider context handoff, "we live in a multi-model world"                            | Pi          |
| Planning Approach            | Built-in plan mode — structured explore → plan → code phases, read-only mode, dedicated sub-agents                                  | No plan mode — "just tell the agent to think with you." Write plans to files for persistence, versioning, and cross-session reuse                     | Both        |
| Complexity Budget            | Complexity lives in the harness so you don't have to think about it — more magic, less wiring                                       | Complexity lives in your hands — minimal harness, you decide what to add and when. "Three similar lines of code is better than a premature abstraction" | Both        |

---

## Cost & Licensing

| Feature                | Claude Code                                                            | Pi Agent                                                                              | Winner |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| Tool License           | Proprietary                                                            | MIT (open source, fork/embed/self-host)                                               | Pi     |
| Subscription Cost      | $20-200/mo required or Dedicated Anthropic API Keys                    | $0 (MIT, BYO API keys)                                                                | Pi     |
| Cost Tracking          | Available via /cost command, customizable via statusline configuration | Real-time $/token/cache display in footer per session and customizable via extensions | Both   |
| Cost Optimization      | 3 models at 3 price tiers (Opus > Sonnet > Haiku) — single provider   | Mix cheap/expensive models per task across any provider, free tiers available         | Pi     |
| System Prompt Overhead | ~10,000+ tokens                                                        | ~200 tokens (more context for actual work)                                            | Pi     |


---

## Model & Provider Support

| Feature                            | Claude Code                                                                                                                                           | Pi Agent                                                                                                                                          | Winner |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Official Providers                 | 4 platforms (Anthropic API, AWS Bedrock, Google Vertex, Foundry) — all serving Claude models                                                          | 20+ native (Anthropic, OpenAI, Google, Groq, xAI, OpenRouter, Azure, Bedrock, Vertex, Mistral, MiniMax, Kimi, Cerebras, ZAI, HuggingFace, custom) | Pi     |
| Non-Anthropic / Self-Hosted Models | Via ANTHROPIC_BASE_URL gateway — routes to any OpenAI-compatible backend (OpenRouter, LiteLLM, local TGI, vLLM). Functional but unofficial workaround | Native first-class support for all providers + local (Ollama, vLLM, LM Studio via models.json). No proxy needed                                   | Pi     |
| Built-in Models                    | ~6 aliases (opus, sonnet, haiku, opusplan, sonnet[1m], default) mapping to Claude family                                                              | 324 (confirmed via ModelRegistry) across all providers                                                                                            | Pi     |
| Model Switching Mid-Session        | Yes — `/model <alias\|name>` command, `--model` flag at startup, ANTHROPIC_MODEL env var                                                              | Yes — Ctrl+P cycle, Ctrl+L fuzzy selector, session.setModel() in SDK                                                                              | Tie    |
| OAuth/Subscription Login           | Anthropic subscriptions (Pro, Max, Teams, Enterprise)                                                                                                 | Claude Pro, ChatGPT Plus, GitHub Copilot, Gemini CLI, Antigravity — all via /login and API keys                                                   | Pi     |
| Thinking/Effort Levels             | 3 effort levels (low/medium/high) on Opus 4.6 via `/model` slider, env var, or settings                                                               | 5 unified levels (off/minimal/low/medium/high) across ALL thinking capable models, Shift+Tab to cycle                                             | Pi     |

---

## Agent Harness

| Feature                  | Claude Code                                                                                                                | Pi Agent                                                                                                                                            | Winner      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Source Code              | Closed source (proprietary)                                                                                                | Open source (MIT license)                                                                                                                           | Pi          |
| System Prompt Size       | ~10,000+ tokens (extensive tool descriptions, behavioral rules, safety guardrails)                                         | ~200 tokens (minimal — trusts frontier models to code without hand-holding)                                                                         | Pi          |
| Default Tools            | 10+ (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, NotebookEdit, Task)                                         | 4 (read, write, edit, bash) + 3 optional (grep, find, ls)                                                                                           | Both        |
| Agent Architecture       | Monorepo TypeScript CLI — single package with built-in tool execution, sub-agents, and team coordination                   | 4-package monorepo (pi-ai, pi-agent-core, pi-tui, pi-coding-agent) — modular separation of LLM abstraction, agent loop, TUI, and CLI                | Both        |
| Sub-Agent Support        | Native Task tool — 7 parallel sub-agents, permission inheritance, typed agent roles (Explore, Plan, Bash, general-purpose) | None built-in, but available through extension that spawns separate pi processes in single/parallel/chain modes with different models per sub-agent | Claude Code |
| Agent Teams              | Native team coordination (lead + workers, shared task lists, message passing, broadcast)                                   | None built-in, but achievable through SDK orchestration scripts or RPC mode driving multiple pi processes                                           | Claude Code |
| Default Permission Model | 5 modes (default, plan, acceptEdits, bypassPermissions, dontAsk) — deny-first with filesystem/network sandbox              | None by default ("YOLO mode") — runs everything without asking. Permission-gate extension available but opt-in                                      | Claude Code |
| Memory File              | CLAUDE.md (project root, nested dirs, user-level) — auto-loaded, hierarchical                                              | AGENTS.md — similar convention, compatible with ~/.claude/skills cross-tool standard                                                                | Tie         |
| Cost Visibility          | Available via /cost command, customizable via statusline configuration                                                     | Immediately visible in footer by default, further customizable via extensions and getSessionStats() API                                             | Tie         |
| Hooks System             | Shell-command hooks (PreToolUse, PostToolUse, Stop, Notification) — external scripts, pass/fail                            | TypeScript extension events (20+ types) — in-process async handlers that block, modify, transform, access session state, render UI                  | Pi          |
| Session Format           | Linear conversation                                                                                                        | JSONL tree with id/parentId (branching, forking, labels via /tree and /fork)                                                                        | Pi          |
| Extension State          | No built-in state persistence for extensions                                                                               | pi.appendEntry() persists custom data to session, survives restart                                                                                  | Pi          |

---

## Tools & Capabilities

### Built-in Tools (Tool-by-Tool)

| Tool              | Claude Code                                                                                       | Pi Agent                                                                                   | Winner      |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| Read              | Built-in — reads files with optional offset/limit, images, PDFs, notebooks                        | Built-in (`read`) — reads files with optional range, auto-resizes images                   | Tie         |
| Write             | Built-in — creates or overwrites files                                                            | Built-in (`write`) — creates or overwrites files                                           | Tie         |
| Edit              | Built-in — exact string replacement with replace_all option                                       | Built-in (`edit`) — surgical find-and-replace, returns unified diff                        | Tie         |
| Bash              | Built-in — shell execution with timeout, background mode, description                             | Built-in (`bash`) — shell execution with streaming output and abort                        | Tie         |
| Glob              | Built-in — fast file pattern matching, sorted by modification time                                | Not built-in. Optional `find` tool available via `--tools` flag                            | Claude Code |
| Grep              | Built-in — ripgrep-powered search with regex, context lines, output modes                         | Not built-in by default. Optional `grep` tool available via `--tools` flag                 | Tie         |
| WebSearch         | Built-in — web search with domain filtering, returns formatted results                            | Not built-in, customizable via extensions                                                  | Claude Code |
| WebFetch          | Built-in — fetches URL content, converts HTML to markdown, AI processing                          | Not built-in, customizable via extensions                                                  | Claude Code |
| NotebookEdit      | Built-in — Jupyter notebook cell editing (replace, insert, delete)                                | Not built-in, customizable via extensions                                                  | Claude Code |
| Task (Sub-agents) | Built-in — spawns typed sub-agents (Explore, Plan, Bash, general-purpose) with parallel execution | Not built-in, customizable via extensions. Subagent extension spawns separate pi processes | Claude Code |
| ls                | Not a dedicated tool (use Bash or Glob)                                                           | Optional built-in (`ls`) via `--tools` flag                                                | Tie         |

### Tool System Capabilities

| Feature               | Claude Code                                                     | Pi Agent                                                                        | Winner      |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------- |
| Tool Observability    | Sub-agent tool calls opaque                                     | Every tool call, token, and dollar visible                                      | Pi          |
| Custom Tools          | Via MCP servers (external process, JSON-RPC)                    | pi.registerTool() in-process TypeScript, streaming results, custom rendering    | Pi          |
| Tool Override         | Not possible                                                    | Register tool with same name to replace built-in (e.g., audited read)           | Pi          |
| MCP Support           | Native first-class, lazy loading (95% context reduction), OAuth | Not built-in (by design, argues 7-14k token overhead); available via extensions | Claude Code |
| Tool Count Philosophy | More tools = more capable out of the box (10+)                  | Fewer tools = smaller system prompt (~1000 tokens), trusts frontier models      | Both        |

---

## Hooks & Event System

> Claude Code: **14 hook events**, 3 handler types (command, prompt, agent) — shell-based, JSON stdin/stdout
> Pi: **25 extension events** across 7 categories — in-process TypeScript with full API access

### Architecture

| Feature                  | Claude Code                                                                                                | Pi Agent                                                 | Winner |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| Hook Language            | Shell commands (any language), LLM prompts, or agent subprocesses                                          | TypeScript (in-process, zero-build via jiti)             | Pi     |
| Handler Types            | 3: command (shell), prompt (LLM eval), agent (multi-turn subagent)                                         | 1: async TypeScript handler with full session/UI access  | Both   |
| Hook Configuration       | JSON in settings files (.claude/settings.json, managed policy, plugin hooks.json, skill/agent frontmatter) | TypeScript code in extension files                       | Both   |
| Can Modify Tool Input    | Yes — updatedInput in PreToolUse/PermissionRequest                                                         | Yes — return modified args from tool_call handler        | Tie    |
| Async/Background Hooks   | Yes — async: true on command hooks (non-blocking, results delivered next turn)                             | Yes — handlers are async by default, can fire-and-forget | Tie    |
| Inter-Hook Communication | No built-in                                                                                                | Yes — pi.events shared event bus between extensions      | Pi     |

### Hook-by-Hook Mapping

| Lifecycle Point               | Claude Code Hook                                                                        | Pi Extension Event(s)                                                 | Notes                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Session starts                | `SessionStart` (matcher: startup/resume/clear/compact)                                  | `session_start`                                                       | CC can persist env vars via CLAUDE_ENV_FILE. Both can inject context          |
| User submits prompt           | `UserPromptSubmit` — can block prompt, add context                                      | `input` — can block, transform text, or handle entirely               | Pi also distinguishes source: interactive/rpc/extension                       |
| Before tool executes          | `PreToolUse` — allow/deny/ask, modify input                                             | `tool_call` — block with reason, modify args, typed per-tool          | Both can intercept and modify. Pi has typed narrowing via isToolCallEventType |
| Permission dialog shown       | `PermissionRequest` — auto-allow/deny on behalf of user                                 | N/A (Pi has no permission system by default)                          | CC-only — Pi runs YOLO by default, permission-gate is an extension            |
| After tool succeeds           | `PostToolUse` — feedback to Claude, modify MCP output                                   | `tool_result` — modify results, log, transform output                 | Comparable                                                                    |
| After tool fails              | `PostToolUseFailure` — add context about the failure                                    | `tool_result` (isError flag)                                          | CC has a dedicated event; Pi uses same event with error flag                  |
| Tool execution streaming      | N/A                                                                                     | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Pi-only — real-time streaming of tool execution progress                      |
| Bash spawn intercept          | N/A                                                                                     | BashSpawnHook — modify command, cwd, env before bash executes         | Pi-only — intercepts at process spawn level                                   |
| User runs bash directly       | N/A                                                                                     | `user_bash` — fired when user types shell commands (!! prefix)        | Pi-only                                                                       |
| Notification sent             | `Notification` (matcher: permission_prompt/idle_prompt/auth_success/elicitation_dialog) | N/A (use ctx.ui.notify in any handler)                                | CC-only as a hook event                                                       |
| Subagent spawned              | `SubagentStart` (matcher: agent type)                                                   | N/A (Pi has no built-in subagents)                                    | CC-only                                                                       |
| Subagent finished             | `SubagentStop` — can prevent subagent from stopping                                     | N/A                                                                   | CC-only                                                                       |
| Agent stops responding        | `Stop` — can force Claude to continue                                                   | N/A (use turn_end or agent_end to react)                              | CC can block stopping; Pi can't but can queue follow-ups                      |
| Teammate goes idle            | `TeammateIdle` — can force teammate to continue                                         | N/A (Pi has no built-in teams)                                        | CC-only                                                                       |
| Task marked complete          | `TaskCompleted` — can block completion                                                  | N/A (Pi has no built-in task system)                                  | CC-only                                                                       |
| Before compaction             | `PreCompact` (matcher: manual/auto)                                                     | `session_before_compact` — can provide custom compaction entirely     | Pi can fully replace compaction logic                                         |
| After compaction              | N/A                                                                                     | `session_compact`                                                     | Pi-only                                                                       |
| Before session branching      | N/A                                                                                     | `session_before_fork`, `session_before_switch`, `session_before_tree` | Pi-only — session tree architecture                                           |
| After session branching       | N/A                                                                                     | `session_fork`, `session_switch`, `session_tree`                      | Pi-only                                                                       |
| Session ends                  | `SessionEnd` (matcher: clear/logout/exit/other) — no decision control                   | `session_shutdown`                                                    | Both fire on exit; neither can block                                          |
| Before agent processes prompt | N/A                                                                                     | `before_agent_start` — can modify system prompt, images, prompt text  | Pi-only — dynamic system prompt per-turn                                      |
| Agent turn lifecycle          | N/A                                                                                     | `agent_start`, `agent_end`, `turn_start`, `turn_end`                  | Pi-only — granular agent lifecycle                                            |
| Message streaming             | N/A                                                                                     | `message_start`, `message_update`, `message_end`                      | Pi-only — token-by-token streaming access                                     |
| Model changed                 | N/A                                                                                     | `model_select` (source: set/cycle/restore)                            | Pi-only — react to model switches                                             |
| Context window access         | N/A                                                                                     | `context` — deep copy of messages, can filter/prune                   | Pi-only — direct context manipulation                                         |

---

## Extensions & Customization

| Feature                        | Claude Code                                | Pi Agent                                                                        | Winner |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------- | ------ |
| Extension Language             | Shell scripts (hooks), Markdown (commands) | TypeScript (zero-build via jiti)                                                | Pi     |
| Slash Commands                 | .claude/commands/*.md prompt templates     | Prompt templates + /skill:name + extension-registered commands                  | Tie    |
| Package Distribution           | Plugin marketplace — `/plugin` commands, git-based sharing | pi install npm:/git:/local, pi config TUI, npm gallery                          | Both   |
| Skills (Agent Skills Standard) | Yes (auto-invocation)                      | Yes (progressive disclosure, cross-tool compat with ~/.claude/skills)           | Tie    |
| Themes                         | Minimally customizable                     | 51 color tokens, hot-reload, dark/light built-in, community themes via packages | Pi     |
| Custom Keyboard Shortcuts      | ~/.claude/keybindings.json                 | pi.registerShortcut() in extensions                                             | Tie    |
| Custom CLI Flags               | Not possible                               | pi.registerFlag() adds custom flags to CLI                                      | Pi     |
| Custom Providers               | Not possible                               | pi.registerProvider() with OAuth support                                        | Pi     |
| Custom Editors                 | Not possible                               | Modal editor (vim), emacs bindings, rainbow editor via extensions               | Pi     |

---

## UI & Terminal

| Feature         | Claude Code                             | Pi Agent                                                                  | Winner |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------- | ------ |
| Custom Header   | No                                      | ctx.ui.setHeader() replaces logo/keybinding hints with custom component   | Pi     |
| Custom Footer   | Configurable statusline (tokens, cost, model) | ctx.ui.setFooter() with git branch, token stats, cost tracking, anything  | Pi     |
| Status Line     | Configurable statusline (tokens, cost, model) | ctx.ui.setStatus() with themed colors, turn tracking, custom data         | Pi     |
| Widgets         | No                                      | ctx.ui.setWidget() above/below editor with custom content                 | Pi     |
| Overlays        | No                                      | Full overlay applications (Doom, Space Invaders, QA test overlays)        | Pi     |
| Dialogs         | Basic permission prompts                | ctx.ui.select(), confirm(), input(), editor() + custom rendering          | Pi     |
| Rendering       | Standard terminal with known issues     | Standard terminal with known issues                                       | Both   |
| Message Queuing | Supported — queue messages while agent works | Enter = steer (interrupt), Alt+Enter = follow-up (queue after completion) | Both   |

---

## Programmatic & SDK

| Feature              | Claude Code                    | Pi Agent                                                                      | Winner |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------- | ------ |
| Non-Interactive Mode | claude --print                 | pi -p (+ stdin auto-activates)                                                | Tie    |
| JSON Streaming       | --output-format stream-json    | --mode json (JSONL events with full lifecycle)                                | Tie    |
| RPC Mode             | None                           | --mode rpc (26+ commands, bidirectional JSON protocol, any language)          | Pi     |
| Node.js SDK          | @anthropic-ai/claude-agent-sdk | @mariozechner/pi-coding-agent (createAgentSession, full internal API)         | Tie    |
| Mid-Stream Control   | ClaudeSDKClient.interrupt() — stop and redirect | steer() interrupts, followUp() queues messages while agent works              | Pi     |
| Session Stats API    | Limited                        | getSessionStats() returns tokens (in/out/cache), cost, tool calls per session | Pi     |
| HTML Export          | /export — session to HTML      | --export, /export, session.exportToHtml()                                     | Both   |
| SDK Examples         | Docs-based                     | 12 official examples from minimal to full-control in package                  | Pi     |

---

## Multi-Agent & Orchestration

| Feature                   | Claude Code                                          | Pi Agent                                                                       | Winner      |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- |
| Sub-Agents                | Native Task tool, 7 parallel, permission inheritance | Subagent extension (single/parallel/chain modes), spawns separate pi processes | Claude Code |
| Agent Teams               | Native team coordination (lead + workers)            | No built-in equivalent; use orchestration scripts                              | Claude Code |
| Multi-Model Orchestration | Not possible (single provider)                       | Different models per sub-agent (scout on flash, worker on opus)                | Pi          |

---

## Enterprise & Platform

| Feature                | Claude Code                                                     | Pi Agent                                                           | Winner      |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| IDE Integration        | VS Code, JetBrains, Cursor (inline diffs, @mentions)            | Terminal-only (could integrate via RPC)                            | Claude Code |
| Web/Mobile/Desktop     | claude.ai/code, iOS app, desktop app                            | Terminal only                                                      | Claude Code |
| Enterprise SSO/Audit   | Yes (SSO, MFA, audit logs, admin dashboard)                     | No                                                                 | Claude Code |
| Permissions/Sandboxing | 5 modes, deny-first rules, filesystem/network sandbox           | None by default ("YOLO mode"); permission-gate extension with Tab-to-add-feedback messaging | Claude Code |
| Git Integration        | Deep (commits, PRs, merge conflicts, GitHub Actions, GitLab CI) | Via bash; git-checkpoint extension available                       | Claude Code |
| Slack/Chat Integration | Native @Claude mentions to PRs                                  | pi-mom Slack bot package                                           | Claude Code |

---

## Sharing & Distribution

| Feature                    | Claude Code                                                                                                         | Pi Agent                                                                                                          | Winner      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------- |
| Package System             | Plugin marketplace — `/plugin` commands, `.claude-plugin/plugin.json` manifest                                      | `pi install npm:/git:/local` — `package.json` with `pi` key, `pi-package` npm keyword                            | Both        |
| What's Bundled             | Skills, agents, hooks, MCP servers, LSP servers                                                                     | Extensions, skills, prompt templates, themes                                                                      | Both        |
| Distribution Sources       | Marketplace (GitHub repo, git URL, npm, pip, direct URL, local path)                                                | npm registry, git (GitHub/GitLab/SSH), local paths — no intermediate marketplace needed                           | Both        |
| Discovery                  | Official `claude-plugins-official` marketplace + team/community marketplaces via `extraKnownMarketplaces`           | npm search (`pi-package` keyword) + gallery at shittycodingagent.ai/packages with video/image previews            | Both        |
| Scope                      | User, project, local, managed (enterprise) — namespaced as `plugin-name:skill-name`                                | Global (`~/.pi/`) or project (`.pi/`, `-l` flag) — project settings auto-install missing packages on startup      | Tie         |
| Config UI                  | `/plugin` slash commands for install/browse/manage                                                                  | `pi config` interactive TUI for enable/disable per-resource                                                       | Tie         |
| Try Without Installing     | No equivalent                                                                                                       | `pi -e npm:@foo/bar` — ephemeral install for current session only                                                 | Pi          |
| Cross-Tool Portability     | Agent Skills standard (agentskills.io) — shared with VS Code, Codex, Cursor, GitHub                                | No cross-tool standard — Pi-specific extensions                                                                   | Claude Code |
| Enterprise Controls        | `strictKnownMarketplaces`, allowlists by repo/URL/host regex, managed plugin deployment                            | No enterprise controls — trust-based, review source before installing                                             | Claude Code |
| Git-Based Sharing          | `.claude/` directory (settings, skills, agents, rules, hooks) committed to repo — team gets config on clone         | `.pi/settings.json` with packages — team gets packages auto-installed on startup                                  | Tie         |
| Update Mechanism           | Marketplace auto-updates at startup (configurable)                                                                  | `pi update` for non-pinned packages, version pinning with `@version`                                             | Tie         |
| Package Filtering          | Plugin resources loaded as-is (namespaced to prevent conflicts)                                                     | Glob patterns + `!exclusions` per resource type, force-include/exclude exact paths                                | Pi          |

---

## Community & Ecosystem

| Feature          | Claude Code                                                           | Pi Agent                                                                     |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Creator          | Anthropic — $1B+ ARR, enterprise AI company                          | Mario Zechner — libGDX creator (24.8K stars), solo maintainer                |
| Traction         | Enterprise adoption, deep IDE integrations, massive user base         | 11.5K stars, 3.17M monthly npm downloads, 208 versions                       |
| Endorsements     | Enterprise customers, Anthropic ecosystem                             | Armin Ronacher (Flask/Ruff) uses + contributes, powers OpenClaw (145K stars) |
| Release Velocity | Regular releases                                                      | 10+ releases in 8 days, new model support within hours                       |
