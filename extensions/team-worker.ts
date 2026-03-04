import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ackMessage,
  claimTaskAtomic,
  completeTask,
  listMessages,
  listTasks,
  readTeamConfig,
  sendMessage,
  updateTask,
  updateTeamConfig,
  writeAtomicJson,
  TEAM_SCHEMA_VERSION,
} from "./team-shared.ts";

export default function teamWorkerExtension(pi: ExtensionAPI): void {
  const teamDir = process.env.PI_TEAM_DIR || "";
  const teammateName = process.env.PI_TEAMMATE_NAME || "teammate";
  const isLead = (process.env.PI_TEAM_LEAD || "false") === "true";
  const planMode = (process.env.PI_TEAM_PLAN_MODE || "false") === "true";
  const autoClaim = (process.env.PI_TEAM_AUTO_CLAIM || "false") === "true";

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let mailboxTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  const seenMsgIds = new Set<string>();
  let planApproved = !planMode;
  const PLAN_APPROVAL_ERROR = "Plan not approved. Call submit_plan with your plan, then wait for plan_approval_response from lead.";

  function ensureEnabled(): void {
    if (!teamDir || isLead) throw new Error("team-worker is disabled (missing PI_TEAM_DIR or running as lead)");
  }

  function writeHeartbeat(status: string = "idle"): void {
    if (!teamDir) return;
    const path = join(teamDir, "members", `${teammateName}.heartbeat.json`);
    writeAtomicJson(path, {
      schemaVersion: TEAM_SCHEMA_VERSION,
      teammate: teammateName,
      pid: process.pid,
      status,
      timestamp: new Date().toISOString(),
      planMode,
    });
  }

  function pollMailbox(ctx: any): void {
    if (!teamDir) return;
    const mine = listMessages(teamDir, { to: teammateName, limit: 200 });
    const broadcasts = listMessages(teamDir, { to: "*", limit: 200 });
    for (const msg of [...mine, ...broadcasts]) {
      if (seenMsgIds.has(msg.id)) continue;
      seenMsgIds.add(msg.id);
      ackMessage(teamDir, teammateName, msg.id);
      if (msg.type === "shutdown_request") {
        pi.sendMessage({
          content: `[TEAM] Shutdown requested by ${msg.from}: ${msg.content}`,
          deliverAs: "followUp",
          triggerTurn: true,
        });
      } else if (msg.type === "plan_approval_response") {
        const approved = !!msg.metadata?.approved;
        planApproved = approved;
        const feedback = msg.metadata?.feedback ? ` Feedback: ${msg.metadata.feedback}` : "";
        pi.sendMessage({
          content: `[TEAM] Plan approval ${approved ? "approved" : "rejected"} by ${msg.from}.${feedback}`,
          deliverAs: "followUp",
          triggerTurn: true,
        });
      } else {
        pi.sendMessage({
          content: `[TEAM] Message from ${msg.from}: ${msg.content}`,
          deliverAs: "followUp",
          triggerTurn: false,
        });
      }
      if (ctx?.ui) ctx.ui.notify(`[team] ${msg.from} -> ${msg.to}: ${msg.type}`, "info");
    }
  }

  pi.registerTool({
    name: "submit_plan",
    description: "Submit implementation plan to lead for approval",
    parameters: Type.Object({ plan: Type.String() }),
    async execute(_id, params) {
      ensureEnabled();
      const p = params as any;
      sendMessage(teamDir, {
        schemaVersion: TEAM_SCHEMA_VERSION,
        id: randomUUID(),
        from: teammateName,
        to: "lead",
        type: "plan_approval_request",
        content: p.plan,
        createdAt: new Date().toISOString(),
      });
      const wasApproved = planApproved;
      if (planMode) planApproved = false;
      const text = planMode
        ? (wasApproved
          ? "revised plan submitted; re-approval is now required before claim_task/update_task/complete_task"
          : "plan submitted; waiting for approval")
        : "plan submitted";
      return { content: [{ type: "text", text }], details: { planMode, planApproved, wasApproved } };
    },
  });

  pi.registerTool({
    name: "claim_task",
    description: "Claim a pending task for this teammate",
    parameters: Type.Object({ taskId: Type.String() }),
    async execute(_id, params) {
      ensureEnabled();
      if (planMode && !planApproved) throw new Error(PLAN_APPROVAL_ERROR);
      const taskId = (params as any).taskId;
      const ok = claimTaskAtomic(teamDir, taskId, teammateName);
      if (ok) {
        writeHeartbeat("working");
        try {
          updateTeamConfig(teamDir, draft => {
            const me = draft.members.find(m => m.name === teammateName);
            if (me) {
              me.status = "working";
              me.currentTaskId = taskId;
            }
          });
        } catch {}
      }
      return { content: [{ type: "text", text: ok ? "claimed" : "not-claimable" }], details: { ok } };
    },
  });

  pi.registerTool({
    name: "complete_task",
    description: "Complete an in-progress task",
    parameters: Type.Object({ taskId: Type.String(), result: Type.String() }),
    async execute(_id, params) {
      ensureEnabled();
      if (planMode && !planApproved) throw new Error(PLAN_APPROVAL_ERROR);
      const p = params as any;
      const task = completeTask(teamDir, p.taskId, p.result, teammateName);
      writeHeartbeat("idle");
      try {
        updateTeamConfig(teamDir, draft => {
          const me = draft.members.find(m => m.name === teammateName);
          if (me) {
            me.status = "idle";
            me.currentTaskId = null;
          }
        });
      } catch {}
      return { content: [{ type: "text", text: `completed ${task.id}` }], details: task };
    },
  });

  pi.registerTool({
    name: "update_task",
    description: "Update task description/notes",
    parameters: Type.Object({ taskId: Type.String(), notes: Type.String() }),
    async execute(_id, params) {
      ensureEnabled();
      if (planMode && !planApproved) throw new Error(PLAN_APPROVAL_ERROR);
      const p = params as any;
      const task = updateTask(teamDir, p.taskId, { description: p.notes });
      return { content: [{ type: "text", text: `updated ${task.id}` }], details: task };
    },
  });

  pi.registerTool({
    name: "list_tasks",
    description: "List team tasks",
    parameters: Type.Object({ status: Type.Optional(Type.String()), assignee: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      ensureEnabled();
      const p = params as any;
      const tasks = listTasks(teamDir, { status: p.status, assignee: p.assignee });
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }], details: { count: tasks.length } };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    description: "List teammates from team config",
    parameters: Type.Object({}),
    async execute() {
      ensureEnabled();
      const cfg = readTeamConfig(teamDir);
      return { content: [{ type: "text", text: JSON.stringify(cfg.members, null, 2) }], details: { count: cfg.members.length } };
    },
  });

  pi.registerTool({
    name: "send_message",
    description: "Send a direct team message",
    parameters: Type.Object({ to: Type.String(), content: Type.String() }),
    async execute(_id, params) {
      ensureEnabled();
      const p = params as any;
      sendMessage(teamDir, {
        schemaVersion: TEAM_SCHEMA_VERSION,
        id: randomUUID(),
        from: teammateName,
        to: p.to,
        type: "message",
        content: p.content,
        createdAt: new Date().toISOString(),
      });
      return { content: [{ type: "text", text: "sent" }] };
    },
  });

  pi.registerTool({
    name: "broadcast",
    description: "Broadcast message to all",
    parameters: Type.Object({ content: Type.String() }),
    async execute(_id, params) {
      ensureEnabled();
      const p = params as any;
      sendMessage(teamDir, {
        schemaVersion: TEAM_SCHEMA_VERSION,
        id: randomUUID(),
        from: teammateName,
        to: "*",
        type: "message",
        content: p.content,
        createdAt: new Date().toISOString(),
      });
      return { content: [{ type: "text", text: "broadcast" }] };
    },
  });

  pi.registerTool({
    name: "request_shutdown",
    description: "Respond to shutdown request",
    parameters: Type.Object({ approved: Type.Boolean(), reason: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      ensureEnabled();
      const p = params as any;
      sendMessage(teamDir, {
        schemaVersion: TEAM_SCHEMA_VERSION,
        id: randomUUID(),
        from: teammateName,
        to: "lead",
        type: "shutdown_response",
        content: p.approved ? "approved" : "rejected",
        metadata: { reason: p.reason || "" },
        createdAt: new Date().toISOString(),
      });
      try {
        updateTeamConfig(teamDir, draft => {
          const me = draft.members.find(m => m.name === teammateName);
          if (me) me.status = "stopping" as any;
        });
      } catch {}
      if (p.approved) {
        writeHeartbeat("shutting_down");
        setTimeout(() => process.exit(0), 50);
      }
      return { content: [{ type: "text", text: p.approved ? "shutting-down" : "staying-online" }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!teamDir || isLead) return;
    writeHeartbeat("idle");
    heartbeatTimer = setInterval(() => writeHeartbeat("idle"), 2000);
    mailboxTimer = setInterval(() => pollMailbox(ctx), 1000);
    if (autoClaim) {
      idleTimer = setInterval(() => {
        try {
          const pending = listTasks(teamDir, { status: "pending" });
          const mine = pending.find(t => !t.assignee || t.assignee === teammateName);
          if (mine && claimTaskAtomic(teamDir, mine.id, teammateName)) {
            writeHeartbeat("working");
            pi.sendMessage({ content: `[TEAM] Auto-claimed task ${mine.id}: ${mine.title}`, deliverAs: "followUp", triggerTurn: true });
          }
        } catch {}
      }, 3000);
    }
  });

  pi.on("session_end", async () => {
    try {
      if (teamDir && !isLead) {
        updateTeamConfig(teamDir, draft => {
          const me = draft.members.find(m => m.name === teammateName);
          if (me) {
            me.status = "stopped";
            me.currentTaskId = null;
            me.pid = null;
          }
        });
      }
    } catch {}
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (mailboxTimer) clearInterval(mailboxTimer);
    if (idleTimer) clearInterval(idleTimer);
  });
}
