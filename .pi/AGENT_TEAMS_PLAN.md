# Agent Teams with Collaboration for Pi (Inspired by Claude Code)

## Goal
Add **agent teams with collaboration** to Pi via an extension so users can delegate a single objective to multiple role-based agents (e.g., Planner, Implementer, Reviewer) and receive a coordinated final result.

Success criteria:
- Team run can be started/stopped from Pi commands
- Agents collaborate via shared tasks/messages/artifacts
- User can observe progress and intervene when needed
- Final response includes synthesis + traceability (what each agent did)

---

## Prerequisite (fix agent loading)
Before team orchestration, ensure agent definitions load reliably.

Required fixes:
1. **Stable agent discovery** from `.pi/agents/` (local repo) and optional user-level path.
2. **Schema validation** for agent files with clear errors (missing role/system/model/tools).
3. **Deterministic precedence** when duplicate IDs exist (project overrides user/global).
4. **Hot-reload behavior**: reload agents on command or file change, without restarting Pi.
5. **Diagnostics command** (`/agents doctor`) to list loaded agents, invalid configs, and source paths.

Definition of done for prerequisite:
- `/agents list` always reflects current files
- invalid agent files fail gracefully with actionable error messages
- team command can resolve all referenced agent IDs without ambiguity

---

## Feature Parity Targets
Practical parity targets vs Claude Code-style agent teams (not exact clone):

1. **Role-based team composition**
   - coordinator/planner + specialists (implementer/reviewer/tester)
2. **Task decomposition + ownership**
   - objective split into tasks with owner + status
3. **Inter-agent collaboration**
   - messages/handoffs between agents
4. **Shared artifacts**
   - notes, patches, command/test outputs attached to tasks
5. **Human checkpoints**
   - approvals for risky actions (exec/write/merge)
6. **Run controls**
   - start/status/pause/resume/stop
7. **Traceable output**
   - final synthesis with per-agent contributions and unresolved risks

---

## Architecture
Extension-first architecture in `extensions/agent-team.ts`.

### 1) Control Layer (Pi extension API)
- Register commands: `/team`, `/team-run`, `/team-status`, `/team-stop`, `/team-resume`
- Register collaboration tools (`team_send_message`, `team_update_task`, etc.)
- Hook Pi events to enforce policies and inject context

### 2) Orchestrator Layer
- Team lifecycle manager (create run, execute steps, terminate)
- Scheduler (MVP: round-robin + dependency gating)
- Budget/policy enforcement (turns, duration, tool calls)
- Final synthesis pass by coordinator

### 3) Agent Runner Layer
- Per-agent execution profile:
  - system prompt
  - model/thinking level
  - allowed tools
  - optional workspace scope
- One-turn bounded execution contract for predictable orchestration

### 4) State + Persistence
- In-memory state for active run
- Durable run log on disk (`events.ndjson`)
- Task/artifact snapshots for recovery/resume

### 5) Observability + UX
- TUI status pane (active agent, queue, blocked tasks)
- concise timeline entries for decisions/handoffs/failures
- run summary generated at completion or stop

---

## Config/File Layout

```text
extensions/
  agent-team.ts

.pi/
  AGENT_TEAMS_PLAN.md
  agents/
    planner.md
    implementer.md
    reviewer.md
    team-default.json
  agent-sessions/
    teams/
      <runId>/
        run.json
        tasks.json
        events.ndjson
        artifacts/
          <artifactId>.json
```

### Team config (practical JSON)
Example `.pi/agents/team-default.json`:

```json
{
  "id": "default-team",
  "name": "Default Team",
  "coordinator": "planner",
  "agents": ["planner", "implementer", "reviewer"],
  "policies": {
    "maxTurns": 40,
    "maxDurationSec": 1800,
    "maxToolCalls": 120,
    "requireHumanApprovalFor": ["exec", "write"],
    "conflictPolicy": "human_required"
  }
}
```

---

## settings.json flags
Add feature flags to allow staged rollout and safe defaults.

Recommended keys:

```json
{
  "agentTeams.enabled": false,
  "agentTeams.defaultTeam": "default-team",
  "agentTeams.maxParallelAgents": 2,
  "agentTeams.maxTurns": 40,
  "agentTeams.maxDurationSec": 1800,
  "agentTeams.requireHumanApprovalFor": ["exec", "write"],
  "agentTeams.persistRuns": true,
  "agentTeams.verboseTimeline": true,
  "agentTeams.autoSummarizeArtifacts": true
}
```

Behavior notes:
- `enabled=false` => commands visible but execution blocked with guidance
- team config policy can override global defaults only within hard safety caps

---

## Commands
Actionable command surface:

- `/team`  
  Show current team settings, loaded agents, and quick actions.

- `/team-run <objective> [--team <id>] [--resume <runId>]`  
  Start a new team run (or resume existing).

- `/team-status [runId]`  
  Show run state: active agent, task counts, blockers, budget usage.

- `/team-pause [runId]`  
  Pause scheduler after current turn.

- `/team-resume [runId]`  
  Continue paused run.

- `/team-stop [runId]`  
  Stop run and emit partial synthesis.

- `/team-approve <decisionId>` / `/team-deny <decisionId>`  
  Resolve human checkpoint decisions.

- `/team-runs`  
  List recent runs with status and duration.

---

## TUI UX
Keep UX minimal but informative.

### Team status panel
Display:
- run ID + status
- objective (truncated)
- active agent
- tasks: todo / in_progress / blocked / done
- budgets: turns, time, tool calls

### Timeline entries
Emit concise entries for:
- task created/reassigned/completed
- handoff between agents
- tool call blocked by policy
- decision required/resolved
- retries/failures

### Human checkpoint prompt
When approval required:
- show proposed action, rationale, impacted files/commands
- provide clear options: approve / deny / edit request

### Final summary card
Include:
- objective result
- per-agent contribution bullets
- changed files + key artifacts
- remaining risks / follow-ups

---

## Milestones (M1-M3)

## M1 — MVP Orchestration
Scope:
- team config loading
- basic run lifecycle + persistence
- round-robin scheduler
- 3 default roles (planner/implementer/reviewer)
- commands: run/status/stop
- final synthesis

Exit criteria:
- completes a medium coding task end-to-end
- logs are persisted and replayable
- stop is safe and deterministic

## M2 — Collaboration + Safety
Scope:
- explicit task graph with dependencies
- inter-agent message/handoff tools
- artifact store + context injection from artifacts
- policy gates in `tool_call`/`tool_result`
- human approvals for exec/write
- pause/resume support

Exit criteria:
- disallowed actions are blocked
- decision flow is robust
- task reassignment works after failure

## M3 — Quality + Scale
Scope:
- better scheduler heuristics (skill/confidence/cost aware)
- conflict detection for overlapping edits
- richer TUI (filters, drill-down)
- team templates for common workflows
- benchmark harness vs single-agent baseline

Exit criteria:
- measurable quality lift on selected tasks
- acceptable latency/cost overhead
- clear operational playbook for users

---

## Immediate Next Steps
1. **Implement agent loading prerequisite first**
   - add `/agents doctor`
   - finalize schema + precedence rules
2. **Create extension skeleton** `extensions/agent-team.ts`
   - command registration
   - run state model
   - persistence paths
3. **Implement M1 run loop**
   - coordinator plans tasks
   - bounded per-agent turns
   - final synthesis output
4. **Add basic TUI status panel + timeline events**
5. **Dogfood on 3 real tasks**
   - feature add
   - bug fix
   - refactor + tests
6. **Capture findings and lock M2 scope**

---

This plan is intentionally incremental: deliver usable orchestration quickly (M1), then harden collaboration/safety (M2), then optimize quality/cost (M3).
