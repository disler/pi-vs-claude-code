import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  TEAM_SCHEMA_VERSION,
  createTask,
  getTask,
  listMessages,
  listTasks,
  readTeamConfig,
  sendMessage,
  updateTask,
  updateTeamConfig,
  writeTeamConfig,
  ackMessage,
  readJsonSafe,
} from "./team-shared.ts";

export default function teamLeadExtension(pi: ExtensionAPI): void {
  let teamDir = process.env.PI_TEAM_DIR || "";
  const procs = new Map<string, ReturnType<typeof spawn>>();
  const seenLeadMsgs = new Set<string>();
  let mailboxTimer: ReturnType<typeof setInterval> | null = null;

  function ensureTeamDir(input?: string): string {
    const dir = input || teamDir;
    if (!dir) throw new Error("No team dir. Call create_team first.");
    for (const p of [dir, join(dir, "tasks"), join(dir, "mailbox"), join(dir, "members")]) {
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
    return dir;
  }

  function reconcile(dir: string): { stopped: string[]; requeued: string[] } {
    const stopped: string[] = [];
    const requeued: string[] = [];

    const heartbeats = new Map<string, { timestamp?: string }>();
    const membersDir = join(dir, "members");
    if (existsSync(membersDir)) {
      for (const f of readdirSync(membersDir)) {
        if (!f.endsWith(".heartbeat.json")) continue;
        const name = f.replace(/\.heartbeat\.json$/, "");
        const hb = readJsonSafe<{ timestamp?: string }>(join(membersDir, f));
        if (hb) heartbeats.set(name, hb);
      }
    }

    updateTeamConfig(dir, draft => {
      for (const m of draft.members) {
        const pidAlive = typeof m.pid === "number" && m.pid > 0 ? (() => { try { process.kill(m.pid!, 0); return true; } catch { return false; } })() : false;
        const hb = heartbeats.get(m.name);
        const stale = !hb?.timestamp || (Date.now() - Date.parse(hb.timestamp)) > 10_000;
        if (!pidAlive || stale) {
          if (m.status !== "stopped") stopped.push(m.name);
          m.status = "stopped";
          m.pid = null;
          m.currentTaskId = null;
        }
      }
      draft.lastReconciledAt = new Date().toISOString();
    });

    const cfgAfter = readTeamConfig(dir);
    const tasks = listTasks(dir, { status: "in_progress" });
    for (const t of tasks) {
      if (!t.assignee) continue;
      const member = cfgAfter.members.find(m => m.name === t.assignee);
      if (!member || member.status === "stopped") {
        updateTask(dir, t.id, { status: "pending", assignee: null, result: t.result ? `${t.result}\n[requeue] recovered on lead startup` : "[requeue] recovered on lead startup" });
        requeued.push(t.id);
      }
    }

    return { stopped, requeued };
  }

  function pollLeadMailbox(ctx: any): void {
    if (!teamDir) return;
    const mine = listMessages(teamDir, { to: "lead", limit: 200 });
    const broadcasts = listMessages(teamDir, { to: "*", limit: 200 });
    for (const msg of [...mine, ...broadcasts]) {
      if (seenLeadMsgs.has(msg.id)) continue;
      seenLeadMsgs.add(msg.id);
      ackMessage(teamDir, "lead", msg.id);
      if (msg.type === "plan_approval_request") {
        ctx.ui.notify(`[team] PLAN APPROVAL REQUEST from ${msg.from}: ${msg.content}`, "warning");
      } else {
        ctx.ui.notify(`[team] ${msg.from} -> ${msg.to}: ${msg.type}`, "info");
      }
    }
  }

  pi.registerTool({
    name: "create_team",
    description: "Create a team directory and config",
    parameters: Type.Object({ name: Type.String(), teamDir: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as any;
      const rootCwd = ctx?.cwd || process.cwd();
      teamDir = ensureTeamDir(p.teamDir || teamDir || join(rootCwd, ".pi", "teams", p.name.replace(/\s+/g, "-")));
      const now = new Date().toISOString();
      writeTeamConfig(teamDir, {
        schemaVersion: TEAM_SCHEMA_VERSION,
        version: 1,
        id: randomUUID(),
        name: p.name,
        createdAt: now,
        leadSessionId: "lead",
        status: "active",
        members: [],
      });
      return { content: [{ type: "text", text: `team created at ${teamDir}` }] };
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    description: "Spawn long-lived teammate pi process",
    parameters: Type.Object({ name: Type.String(), prompt: Type.String(), planMode: Type.Optional(Type.Boolean()), tools: Type.Optional(Type.String()), model: Type.Optional(Type.String()), profile: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as any;
      const dir = ensureTeamDir();
      const sessionFile = join(ctx.cwd, ".pi", "agent-sessions", `team-${p.name}.json`);
      const workerExt = resolve(ctx.cwd, "extensions", "team-worker.ts");
      const projectPermGateExt = resolve(ctx.cwd, "extensions", "permission-gate.ts");
      const args = ["--mode", "json", "-p", p.prompt, "--session", sessionFile];
      if (p.tools) args.push("--tools", p.tools);
      if (p.model) args.push("--model", p.model);
      if (p.profile) args.push("--profile", p.profile);
      if (existsSync(projectPermGateExt)) args.push("-e", projectPermGateExt);
      args.push("-e", workerExt);
      const proc = spawn("pi", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_TEAM_DIR: dir,
          PI_TEAMMATE_NAME: p.name,
          PI_TEAM_LEAD: "false",
          PI_TEAM_PLAN_MODE: p.planMode ? "true" : "false",
        },
      });

      procs.set(p.name, proc);
      updateTeamConfig(dir, draft => {
        const existing = draft.members.find(m => m.name === p.name);
        const startedAt = new Date().toISOString();
        if (existing) {
          existing.pid = proc.pid || null;
          existing.status = "starting";
          existing.currentTaskId = null;
          existing.sessionFile = sessionFile;
          existing.spawnedAt = startedAt;
          existing.planMode = !!p.planMode;
        } else {
          draft.members.push({
            name: p.name,
            agentId: p.name,
            agentType: "teammate",
            sessionFile,
            pid: proc.pid || null,
            status: "starting",
            currentTaskId: null,
            spawnedAt: startedAt,
            planMode: !!p.planMode,
          });
        }
      });

      proc.on("close", () => {
        try {
          updateTeamConfig(dir, draft => {
            const m = draft.members.find(x => x.name === p.name);
            if (m) {
              m.status = "stopped";
              m.pid = null;
              m.currentTaskId = null;
            }
          });
        } catch {}
      });

      return { content: [{ type: "text", text: `spawned ${p.name} pid=${proc.pid || "?"}` }] };
    },
  });

  pi.registerTool({
    name: "shutdown_teammate",
    description: "Request teammate shutdown",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      const p = params as any;
      const dir = ensureTeamDir();
      sendMessage(dir, { schemaVersion: TEAM_SCHEMA_VERSION, id: randomUUID(), from: "lead", to: p.name, type: "shutdown_request", content: "please shutdown", createdAt: new Date().toISOString() });
      updateTeamConfig(dir, draft => {
        const m = draft.members.find(x => x.name === p.name);
        if (m) m.status = "shutting_down";
      });
      return { content: [{ type: "text", text: `shutdown requested for ${p.name}` }] };
    },
  });

  pi.registerTool({
    name: "cleanup_team",
    description: "Cleanup team if all members are stopped",
    parameters: Type.Object({}),
    async execute() {
      const dir = ensureTeamDir();
      const cfg = readTeamConfig(dir);
      const active = cfg.members.filter(m => m.status !== "stopped");
      if (active.length > 0) {
        return { content: [{ type: "text", text: `cannot cleanup; active members: ${active.map(a => a.name).join(", ")}` }] };
      }
      updateTeamConfig(dir, draft => { draft.status = "cleaned_up"; });
      return { content: [{ type: "text", text: "team marked cleaned_up" }] };
    },
  });

  pi.registerTool({
    name: "create_task",
    description: "Create a team task",
    parameters: Type.Object({ title: Type.String(), description: Type.String(), dependencies: Type.Optional(Type.Array(Type.String())), priority: Type.Optional(Type.Number()), assignee: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const p = params as any;
      const dir = ensureTeamDir();
      const task = createTask(dir, { title: p.title, description: p.description, dependencies: p.dependencies, priority: p.priority, assignee: p.assignee || null, createdBy: "lead" });
      return { content: [{ type: "text", text: `created task ${task.id}` }], details: task };
    },
  });

  pi.registerTool({
    name: "assign_task",
    description: "Assign task to teammate",
    parameters: Type.Object({ taskId: Type.String(), assignee: Type.String(), startNow: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      const p = params as any;
      const dir = ensureTeamDir();
      const task = getTask(dir, p.taskId);
      if (!task) throw new Error("task not found");
      const depsBlocked = (task.dependencies || []).filter(depId => getTask(dir, depId)?.status !== "completed");
      const canStart = !!p.startNow && depsBlocked.length === 0;
      const next = updateTask(dir, p.taskId, { assignee: p.assignee, status: canStart ? "in_progress" : task.status === "completed" ? "completed" : "pending" });
      updateTeamConfig(dir, draft => {
        const m = draft.members.find(x => x.name === p.assignee);
        if (m && canStart) {
          m.status = "working";
          m.currentTaskId = p.taskId;
        }
      });
      const msg = canStart
        ? `assigned ${p.taskId} -> ${p.assignee} (started)`
        : (p.startNow ? `assigned ${p.taskId} -> ${p.assignee} (pending: blocked by ${depsBlocked.join(", ") || "state"})` : `assigned ${p.taskId} -> ${p.assignee}`);
      return { content: [{ type: "text", text: msg }], details: { ...next, blockedBy: depsBlocked } };
    },
  });

  pi.registerTool({
    name: "list_tasks",
    description: "List tasks",
    parameters: Type.Object({ status: Type.Optional(Type.String()), assignee: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const p = params as any;
      const tasks = listTasks(ensureTeamDir(), { status: p.status, assignee: p.assignee });
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }], details: { count: tasks.length } };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    description: "List teammates",
    parameters: Type.Object({}),
    async execute() {
      const cfg = readTeamConfig(ensureTeamDir());
      return { content: [{ type: "text", text: JSON.stringify(cfg.members, null, 2) }], details: { count: cfg.members.length } };
    },
  });

  pi.registerTool({
    name: "approve_plan",
    description: "Approve or reject teammate plan",
    parameters: Type.Object({ teammate: Type.String(), approved: Type.Boolean(), feedback: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const p = params as any;
      sendMessage(ensureTeamDir(), {
        schemaVersion: TEAM_SCHEMA_VERSION,
        id: randomUUID(),
        from: "lead",
        to: p.teammate,
        type: "plan_approval_response",
        content: p.approved ? "approved" : "rejected",
        metadata: { approved: p.approved, feedback: p.feedback || "" },
        createdAt: new Date().toISOString(),
      });
      return { content: [{ type: "text", text: `plan ${p.approved ? "approved" : "rejected"} for ${p.teammate}` }] };
    },
  });

  pi.registerTool({
    name: "send_message",
    description: "Send direct message",
    parameters: Type.Object({ to: Type.String(), content: Type.String() }),
    async execute(_id, params) {
      const p = params as any;
      sendMessage(ensureTeamDir(), { schemaVersion: TEAM_SCHEMA_VERSION, id: randomUUID(), from: "lead", to: p.to, type: "message", content: p.content, createdAt: new Date().toISOString() });
      return { content: [{ type: "text", text: "sent" }] };
    },
  });

  pi.registerTool({
    name: "broadcast",
    description: "Broadcast message",
    parameters: Type.Object({ content: Type.String() }),
    async execute(_id, params) {
      const p = params as any;
      sendMessage(ensureTeamDir(), { schemaVersion: TEAM_SCHEMA_VERSION, id: randomUUID(), from: "lead", to: "*", type: "message", content: p.content, createdAt: new Date().toISOString() });
      return { content: [{ type: "text", text: "broadcast" }] };
    },
  });

  pi.registerCommand("team-status", {
    description: "Show team status",
    handler: async (_args, ctx) => {
      if (!teamDir) return ctx.ui.notify("no team", "warning");
      const cfg = readTeamConfig(teamDir);
      ctx.ui.notify(`team=${cfg.name} status=${cfg.status} members=${cfg.members.length}`, "info");
    },
  });

  pi.registerCommand("team-tasks", {
    description: "Show task summary",
    handler: async (_args, ctx) => {
      if (!teamDir) return ctx.ui.notify("no team", "warning");
      const tasks = listTasks(teamDir);
      ctx.ui.notify(tasks.map(t => `${t.id.slice(0, 8)} ${t.status} ${t.title}`).join("\n") || "no tasks", "info");
    },
  });

  pi.registerCommand("team-messages", {
    description: "Show recent messages",
    handler: async (_args, ctx) => {
      if (!teamDir) return ctx.ui.notify("no team", "warning");
      const msgs = listMessages(teamDir, { limit: 30 });
      ctx.ui.notify(msgs.map(m => `${m.createdAt} ${m.from}->${m.to} ${m.type}: ${m.content}`).join("\n") || "no messages", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!teamDir) return;
    try {
      const r = reconcile(teamDir);
      ctx.ui.notify(`team reconcile: stopped=${r.stopped.length} requeued=${r.requeued.length}`, "info");
    } catch (e: any) {
      ctx.ui.notify(`team reconcile failed: ${e?.message || e}`, "warning");
    }
    mailboxTimer = setInterval(() => pollLeadMailbox(ctx), 1000);
  });

  pi.on("session_end", async () => {
    if (mailboxTimer) clearInterval(mailboxTimer);
  });
}
