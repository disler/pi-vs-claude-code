# Agents Flow Proposal Plan (Parent-Session Approval)

## Goal

Enable a two-phase subagent workflow where the user can **review and approve proposals from the parent session** without manually attaching to tmux or blindly trusting subagent writes.

## Scope

- Add a new orchestration flow mode in `agent-team`:
  - `direct` (current behavior — subagent executes immediately)
  - `propose` (new two-phase flow — subagent proposes, user approves, then executes)
- Keep existing transport modes (`json`, `tmux`) intact — proposal flow applies on top.
- Add parent-session review/approval commands.
- Enforce proposal safety: read-only tools in proposal phase.

## Non-Goals

- Full real-time per-tool-call UI proxy from subagent to parent.
- Advanced partial/hunk-level approvals in MVP.
- Replacing existing `dispatch_agent` semantics — flow mode is orthogonal.

## UX Commands

| Command | Description |
|---------|-------------|
| `/agents-flow [direct\|propose\|status]` | Set or view the orchestration flow mode |
| `/agents-review` | List all pending proposals with summary |
| `/agents-approve <id>` | Approve a proposal for execution |
| `/agents-reject <id> [reason]` | Reject a proposal (never executes) |

## Two-Phase Flow

### Phase 1: Proposal

1. `dispatch_agent` is called by the orchestrator.
2. If flow mode is `propose`, subagent launches with **read-only tools** (write/edit stripped).
3. Subagent's system prompt is augmented with proposal instructions + JSON schema.
4. Subagent analyzes the task, explores the codebase, and returns a structured proposal as its final text output.
5. Extension parses the JSON proposal from the output (fenced `\`\`\`json ... \`\`\`` block).
6. Proposal is stored in the proposal queue with status `awaiting_approval`.
7. `dispatch_agent` returns immediately with a summary asking the user to review.

### Phase 2: Approval

1. User runs `/agents-review` to see pending proposals.
2. User runs `/agents-approve <id>` to approve, or `/agents-reject <id> [reason]` to reject.
3. Approval can also be done via a `ui.confirm` dialog shown inline.

### Phase 3: Execution

1. On approval, the same subagent relaunches with **full tools** (including write/edit).
2. The approved proposal is injected into the execution prompt so the subagent knows exactly what to do.
3. Subagent executes only the approved scope.
4. Result is returned to the orchestrator.

## Proposal Schema (MVP)

```typescript
interface Proposal {
  proposalId: string;         // Auto-generated UUID
  agent: string;              // Agent name
  task: string;               // Original task description
  summary: string;            // Human-readable summary of what will happen
  risk: "low" | "medium" | "high";
  edits: Array<{
    path: string;
    operation: "create" | "modify" | "delete" | "rename";
    description: string;      // What changes in this file
  }>;
  commands: Array<{
    command: string;
    cwd?: string;
    risk: "safe" | "dangerous";
    rationale?: string;
  }>;
  notes?: string;             // Any caveats or open questions
  status: ProposalStatus;
  createdAt: number;          // Timestamp
  resolvedAt?: number;        // When approved/rejected/failed
  rejectionReason?: string;
}
```

## State Machine

```
  proposal_running ──► proposal_ready ──► awaiting_approval
         │                                     │
         ▼                               ┌─────┴─────┐
       failed                        approved    rejected
                                        │
                                        ▼
                                  execute_running
                                     │       │
                                     ▼       ▼
                                  executed  failed
```

Statuses: `proposal_running` | `proposal_ready` | `awaiting_approval` | `approved` | `rejected` | `execute_running` | `executed` | `failed`

## Proposal-Phase Safety Policy

During proposal phase, the subagent runs with a restricted tool set:
- **Allowed:** `read`, `grep`, `find`, `ls`, `bash` (read-only commands only)
- **Stripped:** `write`, `edit`
- The system prompt explicitly instructs the agent NOT to modify files.
- If the agent somehow produces write/edit calls, they are blocked by the tool restriction.

## Parent-Session Approval Behavior

- `/agents-review` shows a formatted table of pending proposals: id, agent, risk, summary.
- `/agents-approve <id>` triggers execution phase for that proposal.
- `/agents-reject <id> [reason]` marks proposal as rejected with optional reason.
- When a proposal arrives, a `ui.notify` alerts the user in the parent session.
- Optionally, a `ui.confirm` dialog can be shown inline for simple approve/reject.

## Execution Constraints

- Execute only when proposal status is `approved`.
- The execution prompt includes the full approved proposal as context.
- Subagent is instructed to implement exactly what was proposed, nothing more.
- If the subagent output diverges significantly, it is the user's responsibility to review (MVP).

## Error Handling

| Scenario | Result |
|----------|--------|
| Malformed proposal JSON (no valid fenced block) | Status → `failed`, reason surfaced |
| Subagent process crash during proposal | Status → `failed` |
| Subagent process crash during execution | Status → `failed` |
| User never approves (session ends) | Proposal stays `awaiting_approval` (ephemeral) |
| Invalid proposal ID in approve/reject | User-facing error notification |

## Phased Rollout

### MVP (Phase 1) — This Implementation
- Global flow toggle (`direct`/`propose`) via `/agents-flow`
- Proposal queue stored in memory (Map)
- Full-proposal approval only (no partial file selection)
- Inline `ui.confirm` for quick approve/reject after proposal arrives
- `/agents-review`, `/agents-approve`, `/agents-reject` commands

### Phase 2
- File-level partial approvals (approve subset of edits)
- Richer proposal preview formatting with risk badges in widget
- Proposal diff preview (show what files will change)

### Phase 3
- Execution scope verification (detect drift from proposal)
- Proposal audit history persisted via `appendEntry`
- Multi-agent proposal coordination (dependent proposals)

## Permission IPC Proxy

In addition to the proposal flow, a **file-based IPC system** relays subagent permission prompts to the parent session in real time.

### Files
| File | Role |
|------|------|
| `extensions/permission-ipc.ts` | Shared IPC protocol — types, request/response helpers, watcher |
| `extensions/permission-gate.ts` | Child side — detects `PI_IPC_DIR`, relays prompts via IPC |
| `extensions/agent-team.ts` | Parent side — starts ref-counted IPC watcher, shows prompts |

### How It Works
1. Parent sets `PI_IPC_DIR`, `PI_IPC_AGENT`, `PI_PERM_MODE=guarded` in subagent env
2. Subagent's permission-gate detects IPC mode, writes `req-<uuid>.json` on permission need
3. Parent's IPC watcher detects request, shows custom permission dialog to user
4. User can select an option and optionally press `Tab` to add a feedback message for the agent
5. Parent writes `res-<uuid>.json` with decision and optional `message` field
6. Subagent reads response, allows or blocks the tool call (feedback included in block reason)

### Design
- Atomic file writes (`.tmp` + `rename`) prevent partial reads
- Single ref-counted watcher handles all concurrent subagents
- 5-minute timeout on child side (denied if no response)
- `allow_always` choice is cached in subagent's session

## Acceptance Checklist

### Proposal Flow
- [ ] User can enable `/agents-flow propose`
- [ ] Dispatch creates proposal instead of immediate edits
- [ ] Proposal phase uses read-only tools (write/edit stripped)
- [ ] User can review pending proposals via `/agents-review`
- [ ] User can approve/reject from parent session without tmux
- [ ] Approved proposal executes with full tools and reports result
- [ ] Rejected proposal never executes
- [ ] Malformed proposals are marked failed with actionable messages
- [ ] Flow mode persists across dispatches in the same session
- [ ] Status bar shows current flow mode

### Permission IPC Proxy
- [ ] Subagent write/edit prompts appear in parent session
- [ ] Subagent dangerous bash prompts appear in parent session
- [ ] "Always allow this file" choice persists in subagent session
- [ ] Timeout (5 min) denies the request
- [ ] Concurrent subagents don't cause duplicate prompts
- [ ] IPC files are cleaned up on session start
- [ ] User can Tab to add feedback message when denying a permission
- [ ] Feedback message propagates to subagent via IPC `message` field
