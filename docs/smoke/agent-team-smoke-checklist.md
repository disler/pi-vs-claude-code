# Agent Team Smoke Checklist

Manual smoke flow for `extensions/team-lead.ts` + `extensions/team-worker.ts`.

Helper script: `scripts/smoke/agent-team-smoke.sh`

## Preconditions

- Run from repo root.
- Use `bun` tooling already configured in this project.
- Use a writable team dir (example: `.pi/teams/smoke-team`).
- Optional helper: `bash scripts/smoke/agent-team-smoke.sh` (prints steps + filesystem checks).

---

## A) Normal mode (no plan approval required)

1. Start lead with extension loaded.
2. Create a team via `create_team`.
3. Spawn teammate `worker-a` with `planMode: false`.
4. Create a task assigned to `worker-a`.
5. In teammate session:
   - call `claim_task` (should succeed)
   - call `update_task` (should succeed)
   - call `complete_task` (should succeed)
6. Verify lead `list_tasks` shows completed state and result.
7. Verify no plan approval messages were required.

Expected: worker can execute task tools directly.

---

## B) Plan mode approval flow

1. Spawn teammate `worker-plan` with `planMode: true`.
2. Create a task for `worker-plan`.
3. In teammate session, attempt `claim_task` before submitting plan.

Expected: blocked with error indicating plan approval is required.

4. In teammate session, call `submit_plan` with concise plan text.
5. In lead session, confirm mailbox poll shows a clear **PLAN APPROVAL REQUEST** notification.
6. In lead session, call `approve_plan`:
   - case 1: `approved: false`, include feedback
   - case 2: `approved: true`
7. In teammate session, verify receipt of `plan_approval_response` follow-up message each time.
8. While rejected, verify `claim_task` / `update_task` / `complete_task` remain blocked.
9. After approval, verify those tools succeed.

Expected: plan mode strictly gates task mutation tools until approval response is approved.

---

## C) Quick regression checks

- `send_message` and `broadcast` still work for lead and worker.
- `shutdown_teammate` + worker `request_shutdown` behavior unchanged.
- Mailbox polling still acknowledges messages (no duplicate spam after first handling).

## D) Run non-interactive artifact validator

After the smoke flow, validate on-disk artifacts:

- Direct bun run: `bun scripts/validate-team-artifacts.ts .pi/teams/smoke-team`
- Just target: `just validate-team .pi/teams/smoke-team`

Expected:
- Exit code `0` when no errors are found (warnings allowed)
- Exit code `1` when validation errors are present
