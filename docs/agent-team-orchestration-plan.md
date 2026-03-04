# Agent Team Orchestration — Implementation Plan

> Coordinate multiple Pi agent sessions working together as a team, with a team lead, independent teammates, shared task list, and inter-agent mailbox.

## Overview

Evolve the existing dispatcher model (`agent-team.ts`) into full team orchestration:

- One session acts as the **team lead**, coordinating work and synthesizing results
- **Teammates** are independent, long-lived Pi sessions that work autonomously
- A **shared task list** lets agents claim, track, and complete work items with dependency management
- A **mailbox system** enables direct inter-agent messaging without going through the lead

Builds on existing infrastructure: subagent spawning (`child_process.spawn`), JSON streaming, file-based IPC (`permission-ipc.ts`), session persistence, grid dashboard TUI, and the agent definition format (`.md` frontmatter + `teams.yaml`).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        USER                                  │
│  (interacts with lead via grid dashboard, detail overlays,   │
│   and select dialogs — same TUI as agent-team.ts)            │
└──────────────┬──────────────────────────────────┬───────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────┐              ┌───────────────────────┐
│     TEAM LEAD        │              │   TEAMMATE N          │
│  (primary Pi session)│◄────────────►│  (child Pi process)   │
│                      │   mailbox    │                       │
│  Tools:              │              │  Tools:               │
│  - spawn_teammate    │              │  - send_message       │
│  - send_message      │              │  - broadcast          │
│  - broadcast         │              │  - claim_task         │
│  - create_task       │              │  - complete_task      │
│  - assign_task       │              │  - update_task        │
│  - update_task       │              │  - list_tasks         │
│  - complete_task     │              │  - list_teammates     │
│  - shutdown_teammate │              │  - request_shutdown   │
│  - cleanup_team      │              │  + all agent tools    │
│  + dispatch_agent    │              │    (read,write,bash…) │
└──────────┬───────────┘              └───────────┬───────────┘
           │                                      │
           ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   SHARED FILE LAYER                          │
│                                                              │
│  ~/.pi/teams/{team-id}/                                      │
│  ├── config.json          # Team metadata + member registry  │
│  ├── tasks/                                                  │
│  │   ├── task-{uuid}.json # Individual task files            │
│  │   └── ...                                                 │
│  ├── mailbox/                                                │
│  │   ├── msg-{uuid}.json  # Immutable message files          │
│  │   └── acks/{recipient}/{msgId}.ack.json # Delivery ack    │
│  └── members/                                                │
│      └── {name}.heartbeat.json # Teammate heartbeat          │
│                                                              │
│  .pi/agent-sessions/                                         │
│  ├── team-{id}-lead.json  # Lead session                     │
│  └── team-{id}-{name}.json# Teammate sessions                │
└─────────────────────────────────────────────────────────────┘
```

---

## Component 1: Team Configuration & Lifecycle

### 1.1 Team Config File

**Location:** `~/.pi/teams/{team-id}/config.json`

```typescript
interface TeamConfig {
  schemaVersion: number;         // Schema compatibility (e.g. 1)
  version: number;               // Optimistic concurrency counter
  id: string;                    // UUID
  name: string;                  // Human-readable name
  createdAt: string;             // ISO timestamp
  leadSessionId: string;         // Session file reference
  status: "active" | "shutting_down" | "cleaned_up";
  lastReconciledAt?: string;     // ISO timestamp after startup reconciliation
  members: TeamMember[];
}

interface TeamMember {
  name: string;                  // e.g., "security-reviewer"
  agentId: string;               // References .md agent definition
  agentType: string;             // e.g., "reviewer", "builder"
  sessionFile: string;           // Path to session JSON
  pid: number | null;            // OS process ID when running
  status: "starting" | "idle" | "working" | "shutting_down" | "stopped";
  currentTaskId: string | null;  // Task currently being worked on
  spawnedAt: string;             // ISO timestamp
  planMode: boolean;             // If true, read-only until lead approves plan
}
```

### 1.2 Lifecycle

| Phase | Action | Details |
|-------|--------|---------|
| **Create** | `create_team` tool or `/team-create` | Generates team ID, writes versioned `config.json`, creates directories |
| **Spawn** | `spawn_teammate` tool | Launches child `pi` process, registers in `config.json`, passes team context via `--append-system-prompt` |
| **Operate** | Agents work, message, claim tasks | File-based coordination via shared task list + immutable mailbox + ack files |
| **Shutdown** | `shutdown_teammate` tool | Sends shutdown request via mailbox; teammate can accept/reject |
| **Cleanup** | `cleanup_team` tool or `/team-cleanup` | Verifies all teammates stopped, archives team dir to `~/.pi/teams-archive/{team-id}-{timestamp}/`, then prunes archives by retention policy |

### 1.3 Spawning a Teammate

Build on the existing `dispatchAgent()` pattern from `agent-team.ts`. Key difference: teammates are **long-lived** processes, not fire-and-forget dispatches. They persist, receive messages, and claim multiple tasks.

```typescript
function spawnTeammate(ctx, teamConfig, agentDef, spawnPrompt) {
  const sessionFile = `.pi/agent-sessions/team-${teamConfig.id}-${agentDef.name}.json`;

  const args = [
    "--mode", "json",
    "-p", spawnPrompt,
    "--tools", agentDef.tools,
    "--model", agentDef.model || ctx.model,
    "--session", sessionFile,
    "--append-system-prompt", buildTeammateSystemPrompt(teamConfig, agentDef),
    "-e", "extensions/permission-gate.ts",
    "-e", "extensions/team-worker.ts",
  ];

  const proc = spawn("pi", args, {
    env: {
      ...process.env,
      PI_IPC_DIR: ipcDir,
      PI_TEAM_DIR: `~/.pi/teams/${teamConfig.id}`,
      PI_TEAMMATE_NAME: agentDef.name,
      PI_TEAM_LEAD: "false",
      PI_TEAM_PLAN_MODE: agentDef.planMode ? "true" : "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // updateTeamConfig() applies optimistic concurrency with version increment
  updateTeamConfig(teamConfig.id, draft => {
    draft.members.push({ name: agentDef.name, pid: proc.pid, ... });
  });

  startEventStream(proc, ctx, agentDef.name);
  return proc;
}
```

---

## Component 2: Shared Task List

### 2.1 Task Schema

**Location:** `~/.pi/teams/{team-id}/tasks/task-{uuid}.json`

```typescript
interface Task {
  schemaVersion: number;         // Schema compatibility (e.g. 1)
  version: number;               // Optimistic concurrency counter
  id: string;                    // UUID
  title: string;                 // Short description
  description: string;           // Detailed instructions
  status: "pending" | "in_progress" | "completed" | "failed";
  assignee: string | null;       // Teammate name, or null for unassigned
  createdBy: string;             // "lead" or teammate name
  createdAt: string;             // ISO timestamp
  updatedAt: string;
  completedAt: string | null;
  dependencies: string[];        // Task IDs that must complete first
  result: string | null;         // Summary of work done
  priority: number;              // 1 (highest) to 5 (lowest)
  tags: string[];                // e.g., ["frontend", "security"]
}
```

### 2.2 Task Operations

| Operation | Who | Mechanism |
|-----------|-----|-----------|
| **Create** | Lead | `create_task` tool — writes versioned `task-{uuid}.json` |
| **Assign** | Lead | `assign_task` tool — hard-assigns `assignee` while keeping `status="pending"` by default; optional `startNow=true` sets `status="in_progress"` if dependencies are resolved |
| **Self-claim** | Teammate | `claim_task` tool — atomic claim with file lock + version check |
| **Update** | Assignee | `update_task` tool — modifies task notes/details with version bump |
| **Complete** | Assignee | `complete_task` tool — sets status, `completedAt`, result summary |
| **List** | Anyone | `list_tasks` tool — reads all task files, returns filtered view + blocked status |
| **Requeue failed** | Lead | `requeue_task` command/tool — `failed -> pending` with audit note |

### 2.3 File Locking for Task Claims

Prevent race conditions when multiple teammates try to claim the same task:

```typescript
async function claimTask(teamDir: string, taskId: string, claimant: string): Promise<boolean> {
  const taskFile = `${teamDir}/tasks/task-${taskId}.json`;

  return withFileLock(taskFile, { timeoutMs: 5000 }, () => {
    const task = readJsonSafe<Task>(taskFile);

    if (!task || task.status !== "pending" || task.assignee !== null) return false;

    // Check dependencies resolved
    const allDepsComplete = task.dependencies.every(depId => {
      const dep = readTask(teamDir, depId);
      return dep?.status === "completed";
    });
    if (!allDepsComplete) return false;

    task.assignee = claimant;
    task.status = "in_progress";
    task.updatedAt = new Date().toISOString();
    task.version += 1;
    writeAtomicJson(taskFile, task);
    return true;
  });
}
```

### 2.4 Dependency Management

Tasks can declare dependencies. A task with unresolved dependencies stays `pending` and cannot be claimed. When a dependency completes, blocked tasks automatically become claimable. The `list_tasks` tool returns a `blocked: boolean` field for each task.

```json
{
  "id": "task-003",
  "title": "Write integration tests for auth module",
  "dependencies": ["task-001", "task-002"],
  "status": "pending"
}
```

---

## Component 3: Mailbox System

### 3.1 Message Schema

**Location:** `~/.pi/teams/{team-id}/mailbox/msg-{uuid}.json`

```typescript
interface TeamMessage {
  schemaVersion: number;         // Schema compatibility (e.g. 1)
  id: string;                    // UUID
  from: string;                  // Sender name ("lead" or teammate name)
  to: string | "*";             // Recipient name, or "*" for broadcast
  type: "message" | "shutdown_request" | "shutdown_response"
        | "plan_approval_request" | "plan_approval_response"
        | "idle_notification" | "task_update";
  content: string;               // Message body
  metadata?: Record<string, any>;// Type-specific data
  createdAt: string;
}

interface MessageAck {
  schemaVersion: number;         // Schema compatibility (e.g. 1)
  msgId: string;
  recipient: string;
  ackedAt: string;
}
```

### 3.2 Message Operations

| Operation | Tool/API | Description |
|-----------|----------|-------------|
| **Send** | `send_message` | Write immutable message file for one recipient |
| **Broadcast** | `broadcast` | Write immutable message file addressed to `"*"` |
| **Poll** | (automatic) | Each agent watches mailbox for new messages addressed to it |
| **Ack** | `ackMessage()` | Write `mailbox/acks/{recipient}/{msgId}.ack.json` after delivery |
| **List unread** | `listUnreadMessages()` | Derived as `messages - recipient acks` |

### 3.3 Message Delivery (Immutable + Ack Files)

Build on the existing file-based IPC pattern from `permission-ipc.ts`, but keep message files immutable.

```typescript
// Writer side (any agent)
function sendMessage(teamDir: string, message: TeamMessage): void {
  const file = `${teamDir}/mailbox/msg-${message.id}.json`;
  writeAtomicJson(file, message); // immutable after write
}

// Reader side (each agent runs a watcher)
function startMailboxWatcher(teamDir: string, myName: string, onMessage: (msg: TeamMessage) => void) {
  const seen = new Set<string>(); // in-memory dedupe in addition to persisted acks

  return setInterval(() => {
    const unread = listUnreadMessages(teamDir, myName);
    for (const msg of unread) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);

      onMessage(msg);
      ackMessage(teamDir, myName, msg.id); // write ack file
    }
  }, 500);
}
```

### 3.4 Message Injection into Agent Context

```typescript
function onMessageReceived(ctx, msg: TeamMessage) {
  if (msg.type === "shutdown_request") {
    ctx.pi.sendMessage({
      content: `[TEAM] Shutdown requested by ${msg.from}: ${msg.content}\n` +
               `Call request_shutdown(approved: true) to exit, or (approved: false, reason: "...") to stay.`,
      deliverAs: "followUp",
      triggerTurn: true,
    });
  } else if (msg.type === "message") {
    ctx.pi.sendMessage({
      content: `[TEAM] Message from ${msg.from}:\n${msg.content}`,
      deliverAs: "followUp",
      triggerTurn: true,
    });
  }
}
```

---

## Component 4: Team Lead Extension

### 4.1 File: `extensions/team-lead.ts`

The lead extension evolves from the current `agent-team.ts`. The primary agent becomes a coordinator with both `dispatch_agent` (quick one-offs) and team orchestration tools.

#### Registered Tools (lead-only)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_team` | `name, description` | Initialize team directory and config |
| `spawn_teammate` | `name, agentId, prompt, planMode?` | Launch a new teammate process |
| `create_task` | `title, description, dependencies?, priority?, assignee?` | Add task to shared list |
| `assign_task` | `taskId, assignee, startNow?` | Hard-assign task to teammate without auto-start by default; if `startNow=true`, task starts immediately only when dependencies are resolved |
| `send_message` | `to, content` | Send a direct message to a teammate |
| `broadcast` | `content` | Send a message to all teammates |
| `approve_plan` | `teammate, approved, feedback?` | Approve or reject a teammate's plan |
| `shutdown_teammate` | `name` | Request graceful shutdown |
| `cleanup_team` | (none) | Archive-then-remove team resources (fails if teammates still active); archives kept 14 days by default |
| `list_tasks` | `status?, assignee?` | View task list with filters |
| `list_teammates` | (none) | View all teammates with status |

#### System Prompt Injection

Injected via `before_agent_start` event — dynamically includes active team members, their statuses, current task assignments, and the full task list.

#### TUI: Team Dashboard

```
┌─ Team: code-review ────────────────────────────────────────┐
│                                                             │
│  ┌─ security-reviewer ──┐  ┌─ perf-reviewer ──────┐       │
│  │ ● Working             │  │ ◐ Idle                │       │
│  │ Task: Review auth     │  │ Last: Reviewed DB     │       │
│  │ ▓▓▓▓▓▓░░░░ 62%       │  │ ▓▓▓▓▓▓▓▓▓▓ Done      │       │
│  │ > Checking JWT...     │  │ Ready for next task   │       │
│  └───────────────────────┘  └───────────────────────┘       │
│                                                             │
│  Tasks: 3/5 complete │ Messages: 12 │ Tokens: ~45K         │
└─────────────────────────────────────────────────────────────┘
```

#### Commands

| Command | Description |
|---------|-------------|
| `/team-create [name]` | Create a new team interactively |
| `/team-status` | Show team dashboard summary |
| `/team-tasks` | Show task list overlay with status filters |
| `/team-messages` | Show recent mailbox activity |
| `/team-cleanup` | Shut down teammates, archive team state, and clean up |

---

## Component 5: Teammate Worker Extension

### 5.1 File: `extensions/team-worker.ts`

Loaded by each spawned teammate. Provides coordination tools, mailbox watcher, and heartbeat updates.

#### Environment Variables (set by lead at spawn)

| Variable | Purpose |
|----------|---------|
| `PI_TEAM_DIR` | Path to team directory |
| `PI_TEAMMATE_NAME` | This teammate's name |
| `PI_TEAM_LEAD` | `"false"` for teammates |
| `PI_IPC_DIR` | Permission IPC directory |
| `PI_TEAM_PLAN_MODE` | `"true"` if teammate must plan before implementing |

#### Registered Tools (teammate-only)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `claim_task` | `taskId` | Self-claim an unassigned, unblocked task |
| `complete_task` | `taskId, result` | Mark a task complete with summary |
| `update_task` | `taskId, notes` | Add progress notes |
| `list_tasks` | `status?, assignee?` | View the shared task list |
| `list_teammates` | (none) | View other team members |
| `send_message` | `to, content` | Message lead or another teammate |
| `broadcast` | `content` | Message all team members |
| `request_shutdown` | `approved, reason?` | Accept or reject a shutdown request |
| `submit_plan` | `plan` | Submit plan for lead approval (plan mode only) |

#### Plan Mode

When `PI_TEAM_PLAN_MODE=true`:

1. Teammate's tools restricted to **read-only** (`read, grep, find, ls`) + coordination tools
2. System prompt instructs: analyze the task, create a detailed plan, then call `submit_plan`
3. `submit_plan` sends a `plan_approval_request` message to the lead
4. Lead reviews and sends `plan_approval_response` (approved/rejected with feedback)
5. On approval: tools upgraded to full set, plan mode disabled
6. On rejection: teammate revises plan based on feedback

#### Auto-behaviors

```typescript
// On idle: try to self-claim next available task
pi.on("agent_idle", () => {
  const nextTask = findClaimableTask(teamDir, myName);
  if (nextTask) {
    claimTask(teamDir, nextTask.id, myName);
    pi.sendMessage({
      content: `[TEAM] You claimed task: ${nextTask.title}\n\n${nextTask.description}`,
      deliverAs: "followUp",
      triggerTurn: true,
    });
  } else {
    sendMessage(teamDir, {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      from: myName,
      to: "lead",
      type: "idle_notification",
      content: `${myName} has finished all tasks and is idle.`,
      createdAt: new Date().toISOString(),
    });
  }
});

// Heartbeat update loop
setInterval(() => {
  writeAtomicJson(`${teamDir}/members/${myName}.heartbeat.json`, {
    schemaVersion: 1,
    teammate: myName,
    pid: process.pid,
    status: getCurrentStatus(),
    timestamp: new Date().toISOString(),
  });
}, 2000);
```

#### System Prompt Injection

Injected via `before_agent_start` — includes teammate name, team name, role instructions (work on tasks, communicate, claim next task on completion), current task details, and list of other teammates.

---

## Component 6: Hooks Integration

### 6.1 TeammateIdle Hook

Fires when a teammate is about to go idle. Exit code 2 sends feedback and keeps the teammate working.

```typescript
async function onTeammateIdle(teammate: TeamMember): Promise<"idle" | "continue"> {
  const hookResult = await runHook("TeammateIdle", {
    teammate: teammate.name,
    completedTasks: getCompletedTasks(teammate.name),
    teamStatus: getTeamStatus(),
  });
  if (hookResult.exitCode === 2) {
    sendMessage(teamDir, {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      from: "lead",
      to: teammate.name,
      type: "message",
      content: hookResult.stdout,
      createdAt: new Date().toISOString(),
    });
    return "continue";
  }
  return "idle";
}
```

### 6.2 TaskCompleted Hook

Fires when a task is being marked complete. Exit code 2 prevents completion and sends feedback.

```typescript
async function onTaskCompleted(task: Task, result: string): Promise<boolean> {
  const hookResult = await runHook("TaskCompleted", {
    taskId: task.id,
    title: task.title,
    assignee: task.assignee,
    result: result,
  });
  if (hookResult.exitCode === 2) return false;  // Task stays in_progress
  return true;
}
```

---

## Component 7: TUI — Reuse Existing Grid Dashboard

Reuse and extend the proven TUI from `agent-team.ts`. No need to build new display modes — the existing grid widget, detail overlay, and select dialogs already work well.

### 7.1 What Already Exists (from `agent-team.ts`)

| Component | How it works |
|-----------|-------------|
| **Grid widget** | `ctx.ui.setWidget("agent-team", factory)` — renders agent cards in columns, auto-calculates `colWidth`, normalizes card heights across rows |
| **Agent cards** | `renderCard()` — header (name + status badge with icon/elapsed), progress bar (`━`/`─` for context%), current tool indicator (`▸ read src/foo.ts`), last 6 lines of streaming output, colored borders (accent for running, dim for idle) |
| **Detail overlay** | `ctx.ui.custom()` — full-screen scrollable view of agent output. Keyboard: `↑/↓/j/k` scroll, `g/G` jump top/bottom, `Esc/q` close |
| **Select dialogs** | `ctx.ui.select()` — pick agents by name with status icons for `/agents-view`, pick teams for `/agents-team` |
| **Footer** | `ctx.ui.setFooter()` — model + team name + `/perm-mode` (left), context bar `[####------] 42%` (right) |
| **Status bar** | `ctx.ui.setStatus()` — `Team: name (count) · approval:mode` |
| **Stream parsing** | JSON events from `--mode json` stdout: `message_update` → text delta, `tool_execution_start/end` → tool indicator, `message_end` → context%, `agent_end` → final context% |

### 7.2 What to Add for Team Orchestration

Extend the existing TUI with team-specific information. The grid cards and overlay patterns stay the same — just add new data fields.

#### Enhanced Agent Cards

Add task and mailbox info to the existing `renderCard()`:

```
┌━━ security-reviewer ━━━━━━━━━━━━ ● Working 2m34s ━┐
│ ▓▓▓▓▓▓░░░░ 62%  tools: 8                           │
│ Task: Security review (#task-001)                   │
│ ▸ read src/auth/jwt.ts                              │
│ > Checking token validation logic...                │
│ > Found potential timing attack in                  │
│ > compareTokens() — uses === instead                │
│ > of constant-time comparison.                      │
│ > Sending finding to lead...                        │
│ > ✉ 2 messages sent, 1 received                     │
└─────────────────────────────────────────────────────┘
```

New fields in existing `AgentState`:
```typescript
// Add to existing AgentState interface
currentTaskId: string | null;    // Active task ID
currentTaskTitle: string | null; // Active task title
messagesSent: number;            // Outbound message count
messagesReceived: number;        // Inbound message count
```

#### Task List Overlay

New overlay via `ctx.ui.custom()` — triggered by `/team-tasks` or `Ctrl+T`:

```
┌─ Tasks: code-review ──────────────────────────────────────┐
│                                                            │
│  ✓ task-001  Security review          security-reviewer    │
│  ✓ task-002  Performance review       perf-reviewer        │
│  ● task-003  Test coverage review     test-reviewer        │
│  ○ task-004  Synthesize findings      (unassigned)         │
│              ↳ blocked by: task-003                        │
│                                                            │
│  ✓ = completed  ● = in progress  ○ = pending              │
│                                                            │
│  3/4 tasks complete │ 1 blocked                            │
│  ↑/↓ navigate  Enter: view details  Esc: close            │
└────────────────────────────────────────────────────────────┘
```

#### Message Log Overlay

New overlay via `/team-messages` — scrollable chronological message log:

```
┌─ Messages: code-review ───────────────────────────────────┐
│                                                            │
│  14:32  security-reviewer → lead                           │
│         Found timing attack vulnerability in JWT compare   │
│                                                            │
│  14:33  lead → security-reviewer                           │
│         Good find. Check session management too.           │
│                                                            │
│  14:35  perf-reviewer → lead                               │
│         DB queries are N+1, recommending batch loading     │
│                                                            │
│  ↑/↓/j/k scroll  Esc/q close                              │
└────────────────────────────────────────────────────────────┘
```

#### Enhanced Footer

Extend the existing footer with team-specific counters:

```
sonnet-4 · Team: code-review · 3 agents · Tasks: 2/4 · ✉ 8     [####------] 42%
```

#### Enhanced Detail Overlay

When viewing a specific teammate via `/agents-view`, add a header section showing their current task, messages, and task history before the streaming output.

### 7.3 Commands (extend existing)

Keep existing commands and add team-specific ones:

| Command | Description | TUI |
|---------|-------------|-----|
| `/agents-view [name]` | **Existing** — view agent detail overlay | `ctx.ui.custom()` overlay |
| `/agents-grid` | **Existing** — toggle grid widget visibility | `ctx.ui.setWidget()` |
| `/agents-team [name]` | **Existing** — switch active team from `teams.yaml` | `ctx.ui.select()` |
| `/agents-list` | **Existing** — list available agents | Text output |
| `/team-tasks` | **New** — task list overlay | `ctx.ui.custom()` overlay |
| `/team-messages` | **New** — message log overlay | `ctx.ui.custom()` overlay |
| `/team-status` | **New** — summary of team health | Text output |
| `/team-cleanup` | **New** — shut down teammates, archive state, and clean up | Confirm dialog |

### 7.4 No New Display Modes Needed

The existing in-process grid dashboard handles everything. Split pane (tmux/iTerm2) is **out of scope** for MVP. If needed later, it can be added as a Phase 3 enhancement without changing the core orchestration.

---

## Implementation Contract (State, Concurrency, Recovery)

This section is normative for implementation. If any component text conflicts with this contract, this contract wins.

### A. State transition rules

#### Task state machine

| From | To | Allowed | Who can trigger | Notes |
|------|----|---------|-----------------|-------|
| `pending` | `in_progress` | Yes | Lead (assign) or teammate (claim) | Requires unblocked dependencies |
| `in_progress` | `completed` | Yes | Assignee or lead override | Must set `completedAt` and `result` |
| `in_progress` | `failed` | Yes | Assignee or lead override | Must include failure note |
| `failed` | `pending` | Yes | **Lead only** | Requeue path for retries |
| `completed` | any | No (default) | N/A | Reopen only with explicit lead override command |

#### Team member state machine

| From | To | Allowed | Trigger |
|------|----|---------|---------|
| `starting` | `idle` | Yes | Teammate initialized, no active task |
| `starting` | `working` | Yes | Teammate initialized and immediately claims/assigned task |
| `idle` | `working` | Yes | Claims or receives task |
| `working` | `idle` | Yes | Task completed/failed and no next claim |
| `idle`/`working` | `shutting_down` | Yes | Shutdown request accepted |
| `shutting_down` | `stopped` | Yes | Process exits cleanly |
| `any` | `stopped` | Yes | Crash detection or hard kill |

#### Invariants (must always hold)

| Invariant | Enforcement |
|-----------|-------------|
| Member with `status="working"` must have non-null `currentTaskId` | Transition guard + reconciliation |
| Task with `status="in_progress"` must have non-null `assignee` | Transition guard + schema validator |
| Task with `status="completed"` must have non-null `completedAt` and `result` | `completeTask()` guard |

### B. Shared module API contract (`team-shared.ts`)

Minimal API surface (TypeScript-style):

```typescript
// Config
function readTeamConfig(teamDir: string): TeamConfig;
function writeTeamConfig(teamDir: string, config: TeamConfig): void;
function updateTeamConfig(
  teamDir: string,
  mutator: (draft: TeamConfig) => void,
  options?: { expectedVersion?: number }
): TeamConfig;

// Tasks
function createTask(teamDir: string, input: CreateTaskInput): Task;
function listTasks(teamDir: string, filter?: TaskFilter): Task[];
function getTask(teamDir: string, taskId: string): Task | null;
function claimTaskAtomic(teamDir: string, taskId: string, claimant: string): boolean;
function updateTask(
  teamDir: string,
  taskId: string,
  patch: Partial<Task>,
  options?: { expectedVersion?: number }
): Task;
function completeTask(teamDir: string, taskId: string, result: string, actor: string): Task;
function requeueTask(teamDir: string, taskId: string, note: string, actor: "lead"): Task;

// Mailbox
function sendMessage(teamDir: string, message: TeamMessage): void;
function listMessages(teamDir: string, opts?: { to?: string; from?: string; limit?: number }): TeamMessage[];
function listUnreadMessages(teamDir: string, recipient: string, limit?: number): TeamMessage[];
function ackMessage(teamDir: string, recipient: string, msgId: string): void;

// IO + locking primitives
function writeAtomicJson(path: string, data: unknown): void;
function readJsonSafe<T>(path: string): T | null;
function withFileLock<T>(
  targetPath: string,
  options: { timeoutMs: number; staleMs?: number; owner?: string },
  fn: () => T
): T;
```

### C. Concurrency and atomicity policy

| Policy | Requirement |
|--------|-------------|
| Atomic writes | All mutable JSON writes use tmp file + `rename()` |
| Locking | Use lock files for task claim/update and config writes |
| Optimistic concurrency | `version` field on Task + TeamConfig; update requires expected version or last-write rejection |
| Lock payload | Store `{ ownerPid, ownerName, createdAt }` in lock file |
| Lock timeout | Acquire timeout: 5s default |
| Stale lock cleanup | Lock older than 30s may be reclaimed after liveness check of `ownerPid` |

### D. Mailbox delivery semantics

| Aspect | Contract |
|--------|----------|
| Message mutability | Message files are immutable after creation |
| Ack model | Per-recipient ack files at `mailbox/acks/{recipient}/{msgId}.ack.json` |
| Delivery guarantee | **At-least-once** |
| Consumer behavior | Must dedupe by `msg.id` in runtime and tolerate duplicates |
| Unread computation | `all messages addressed to me or *` minus `my ack files` |
| Retention | Keep 7 days or max 10k messages; then prune/archive oldest |

### E. Crash/restart reconciliation algorithm

Deterministic lead startup sequence:

1. Load and validate config/tasks/messages schema versions.
2. Rebuild runtime state from disk (members, tasks, message indexes, acks).
3. Run liveness checks for members (PID + heartbeat timestamp).
4. Mark dead members as `stopped` in config.
5. Requeue stale `in_progress` tasks owned by dead members (append recovery note).
6. Recover UI cards/state and resume mailbox watcher.
7. Emit reconciliation summary to status/output.

#### Teammate heartbeat design

| File | Update interval | Dead threshold |
|------|------------------|----------------|
| `members/{name}.heartbeat.json` | Every 2s | Stale > 10s => dead member |

Heartbeat payload example:

```json
{
  "schemaVersion": 1,
  "teammate": "security-reviewer",
  "pid": 91234,
  "status": "working",
  "timestamp": "2026-03-01T17:15:02.123Z"
}
```

---

## MVP Scope and Non-Goals

### In Scope (Phase 1A + 1B)

- Team creation + versioned config persistence
- Teammate spawn and long-lived worker loop
- Task create/list/claim/complete flows with dependency checks
- Direct messaging + broadcast using immutable mailbox and ack files
- Graceful shutdown request/response flow
- Cleanup command with active-member safety checks
- Reconciliation on lead restart (dead member detection + stale task requeue)
- Existing grid TUI extensions (task/message counters, task overlay, message overlay)

### Out of Scope (Phase 1)

- Split pane execution modes (tmux/iTerm2)
- Nested teams / sub-teams
- Cross-host or distributed coordination
- Auth/signatures/encryption for mailbox files
- Advanced custom hook ecosystems beyond baseline integration

---

## Implementation Phases

### Phase 1A: Core Runtime (MVP Foundation)

**Goal:** Reliable on-disk runtime, lifecycle, and coordination semantics.

| # | Task | Details | Builds On |
|---|------|---------|-----------|
| 1A.1 | Team config module | `TeamConfig` read/write/update, schema/version checks, directory creation | New shared module |
| 1A.2 | Task list module | CRUD + state guards + file locking + version checks + dependency resolver | New shared module |
| 1A.3 | Mailbox module | Immutable message writes, ack files, unread derivation, retention prune | Borrows from `permission-ipc.ts` |
| 1A.4 | `team-worker.ts` | Teammate tools, mailbox watcher, heartbeat, auto-claim on idle | New extension |
| 1A.5 | `team-lead.ts` runtime | Lead tools, system prompt injection, mailbox watcher, reconciliation startup | Evolves from `agent-team.ts` |
| 1A.6 | Long-lived spawning | Teammates persist, receive messages, work on multiple tasks | Extends `dispatchAgent()` |
| 1A.7 | Shutdown + cleanup | Graceful shutdown protocol; cleanup rejects if active teammates remain | Phase 1A lifecycle |

**Deliverable:** Stable core orchestration runtime without advanced UI changes.

### Phase 1A Acceptance Criteria

1. Team creation writes `config.json` with `schemaVersion` and `version`.
2. Under 3-way concurrent claim attempts, exactly one claimant wins.
3. Dependency-blocked task cannot be claimed by any teammate.
4. Completing a task without `result` is rejected by guard.
5. Message files are never mutated after creation.
6. Duplicate message delivery does not duplicate side effects (dedupe by `msg.id`).
7. Lead restart marks dead teammates `stopped` and requeues their stale `in_progress` tasks.
8. Cleanup fails when any teammate is not `stopped`.
9. Stale lock (>30s with dead owner PID) is reclaimed successfully.

### Phase 1B: TUI Integration (MVP UX)

**Goal:** Extend the existing `agent-team.ts` dashboard patterns with team orchestration visibility.

| # | Task | Details | Builds On |
|---|------|---------|-----------|
| 1B.1 | Extend grid dashboard | Add task info + message counters to cards | Existing `agent-team.ts` TUI |
| 1B.2 | Task list overlay | `/team-tasks` with status + blocked indicators | Existing `ctx.ui.custom()` patterns |
| 1B.3 | Message log overlay | `/team-messages` scrollable chronological log | Existing overlay renderer |
| 1B.4 | Footer/status counters | Tasks complete ratio + message counts + health hints | Existing footer/status code |
| 1B.5 | Detail header enrichment | Task + messaging summary before stream output | Existing `/agents-view` detail overlay |

**Deliverable:** Familiar, consistent team UX built on existing TUI primitives.

### Phase 1B Acceptance Criteria

1. `/agents-grid` still renders with no regression in card layout.
2. Cards show current task ID/title when member is `working`.
3. Cards show sent/received message counters updated in near real time.
4. `/team-tasks` overlay displays blocked tasks and dependency references.
5. `/team-messages` overlay scrolls and renders latest 500 messages without UI freeze.
6. Footer includes `Tasks: x/y` and `✉ n` counters.
7. `/agents-view [name]` shows task/message header above stream output.
8. All new overlays close via `Esc/q` and preserve prior screen state.

### Phase 2: Coordination & Safety

**Goal:** Plan approval, hooks hardening, safety gates.

| # | Task | Details | Builds On |
|---|------|---------|-----------|
| 2.1 | Plan mode | Read-only tools → submit_plan → lead approval → full tools | Phase 1A spawning |
| 2.2 | TeammateIdle hook | Run user scripts on idle, exit code 2 = keep working | Phase 1A idle detection |
| 2.3 | TaskCompleted hook | Run user scripts on completion, exit code 2 = reject | Phase 1A task completion |
| 2.4 | Permission inheritance | Teammates inherit lead permission mode; IPC relay | Existing `permission-ipc.ts` |
| 2.5 | Dependency auto-unblock notify | Notify assignees when blocked task becomes claimable | Phase 1A task list |
| 2.6 | Lead override commands | Explicit commands for reopen/reassign/requeue with audit notes | Phase 1A state machine |

**Deliverable:** Production-ready orchestration with clear control gates and override paths.

### Phase 2 Acceptance Criteria

1. Plan-mode teammate cannot call write/edit/bash tools before approval.
2. `submit_plan` creates approval request message visible to lead.
3. Approval response toggles teammate out of plan mode within one turn.
4. Hook exit code 2 blocks transition and surfaces feedback to actor.
5. Dependency completion emits claimable notification for newly unblocked tasks.
6. Lead override commands require explicit reason and are audit-logged.
7. Transition guard blocks invalid state jumps (`completed -> in_progress` without override).
8. Permission mode changes on lead propagate to all active teammates.

### Phase 3: Polish & Scale

**Goal:** Advanced UX and operational scalability.

| # | Task | Details | Builds On |
|---|------|---------|-----------|
| 3.1 | Split pane mode (optional) | If needed, spawn teammates in tmux/iTerm2 panes | Phase 1A spawning |
| 3.2 | Enhanced dashboard | Token usage per teammate, task progress, message log stats | Phase 1B TUI |
| 3.3 | Team templates | Predefined compositions from `teams.yaml` | Existing `teams.yaml` |
| 3.4 | Broadcast rate limiting | Prevent token explosion from excessive broadcasts | Phase 1A mailbox |
| 3.5 | Crash cleanup automation | Detect orphaned teammates via PID checks, auto-cleanup helpers | Phase 1A config |
| 3.6 | Session persistence polish | Resume team state seamlessly after lead restart | Phase 1A reconciliation |

**Deliverable:** Polished, scalable orchestration for long-running multi-agent workflows.

### Phase 3 Acceptance Criteria

1. Optional split pane launcher works in tmux and degrades gracefully elsewhere.
2. Dashboard shows per-teammate token estimates and refreshes every ≤2s.
3. Team templates create expected teammate sets from `teams.yaml` deterministically.
4. Broadcast limiter enforces configured cap without dropping direct messages.
5. Orphan detection reports stale PIDs and offers one-step cleanup.
6. Restart resume restores cards, tasks, and mailbox views within 3s on typical team sizes.
7. Message retention pruning runs without corrupting ack-derived unread state.

---

## File Structure (New & Modified)

```
extensions/
├── team-lead.ts           # NEW — Team lead orchestrator extension
├── team-worker.ts         # NEW — Teammate worker extension
├── team-shared.ts         # NEW — Shared modules (config, tasks, mailbox, locks)
├── agent-team.ts          # EXISTING — Keep as simpler dispatcher (backward compat)
├── permission-ipc.ts      # EXISTING — Reuse for permission relay
└── ...

~/.pi/teams/               # NEW — Runtime team data (created dynamically)
└── {team-id}/
    ├── config.json
    ├── tasks/
    │   └── task-{uuid}.json
    ├── mailbox/
    │   ├── msg-{uuid}.json
    │   └── acks/{recipient}/{msgId}.ack.json
    └── members/
        └── {name}.heartbeat.json
```

---

## Key Design Decisions

### 1. File-based coordination (not sockets/IPC pipes)

Consistent with existing `permission-ipc.ts` pattern. Works cross-platform. Agents can read team state independently without a running server. Simple to debug (JSON files on disk). Trade-off: polling latency, acceptable for agent coordination.

### 2. Teammates are long-lived processes

Unlike the current dispatcher model (fire-and-forget), teammates receive messages, claim new tasks, and maintain conversation context across multiple tasks. They run in a loop: work → complete → check mailbox → claim next → repeat.

### 3. Lead keeps dispatch_agent too

Quick one-off dispatches (existing pattern) and persistent team management coexist.

### 4. Separate extensions (team-lead.ts + team-worker.ts)

Clean separation of concerns. Shared data layer in `team-shared.ts`.

### 5. Reuse existing TUI patterns

The grid dashboard, detail overlay, and select dialogs from `agent-team.ts` are proven and familiar. Rather than inventing new display modes, extend the existing TUI with task and message information. This keeps UX consistent and reduces implementation effort.

### 6. Delivery semantics are at-least-once

At-least-once delivery is robust with simple file-based persistence and crash recovery. Exact-once would require heavier coordination/state coupling. We accept possible duplicates and require consumers to dedupe by message ID.

---

## Integration Points

| Existing System | Integration |
|----------------|-------------|
| **agent-team.ts** | Backward compatible — `team-lead.ts` is the evolution |
| **teams.yaml** | Seeds team creation (e.g., `/team-create pi-pi`) |
| **agent-chain.ts** | Orthogonal — a teammate could use `run_chain` internally |
| **permission-ipc.ts** | Reused directly for permission relay |
| **damage-control.ts** | Stackable as extension on teammates |
| **pi-pi.ts** | Could be reimplemented as a team for richer coordination |
| **TUI grid dashboard** | Reused and extended, not replaced |
| **Session files** | Per-teammate sessions enable context continuity |

---

## Example Walkthrough: PR Review Team

```
User: Create an agent team to review PR #142 with three reviewers —
      one for security, one for performance, one for test coverage.

Lead (internally):
  1. create_team("pr-142-review")
  2. create_task("Security review", "Review PR #142 for security...", priority=1)
  3. create_task("Performance review", "Review PR #142 for perf...", priority=1)
  4. create_task("Test coverage review", "Review PR #142 for tests...", priority=1)
  5. create_task("Synthesize findings", "Combine all reviews...", dependencies=[1,2,3])
  6. spawn_teammate("security-reviewer", agentId="reviewer", prompt="Focus on security...")
  7. spawn_teammate("perf-reviewer", agentId="reviewer", prompt="Focus on performance...")
  8. spawn_teammate("test-reviewer", agentId="reviewer", prompt="Focus on test coverage...")

Teammates (automatically):
  - security-reviewer claims "Security review"
  - perf-reviewer claims "Performance review"
  - test-reviewer claims "Test coverage review"
  - Each works independently, messages lead with findings
  - When all three complete, "Synthesize findings" unblocks
  - Lead claims synthesis task and produces final report
```

---

## Testing Strategy

### Unit Tests

- Schema validation for `TeamConfig`, `Task`, `TeamMessage`, `MessageAck`, heartbeat payloads
- Transition guard tests for allowed/disallowed task and member state transitions
- Lock contention tests for `claimTaskAtomic`, `updateTeamConfig`, and stale lock reclaim
- Dependency resolver tests (`blocked` detection and unblock propagation)
- Version conflict tests (optimistic concurrency mismatch paths)

### Integration Tests

- End-to-end: create team → spawn teammates → claim tasks → complete tasks → cleanup
- Mailbox flow: send direct + broadcast messages, ack creation, unread computation
- Shutdown flow: request/approve/reject shutdown and status transitions
- Reconciliation flow: restart lead, reload disk state, resume watchers/UI
- TUI command flow: `/team-tasks`, `/team-messages`, `/team-status` produce expected outputs

### Failure Tests

- Process kill during `working` state leads to dead-member detection and task requeue
- Stale lock files are recovered according to timeout + PID liveness policy
- Partial write recovery (`.tmp` leftovers, malformed JSON) handled by safe readers
- Duplicate message deliveries do not duplicate effects due to message ID dedupe
- Cleanup with active teammates fails deterministically with actionable reason

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Token explosion | Teams use N× tokens | Default 3-5 teammates; warn on larger; show token counter |
| File conflicts | Two teammates edit same file | Task descriptions specify file ownership; damage-control enforces |
| Orphaned processes | Teammates survive lead crash | PID + heartbeat tracking; reconciliation requeues stale tasks; cleanup checks liveness |
| Mailbox flooding | Excessive broadcasts fill context | Rate limit broadcasts; cap message delivery per turn; retention pruning |
| Stale task state | Teammate fails to mark complete | Timeout detection; lead can force-complete or requeue |
| Polling latency | Message delivery delay | Acceptable for agent workflows; tune poll interval if needed |
