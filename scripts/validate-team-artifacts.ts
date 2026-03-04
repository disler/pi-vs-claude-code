#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type AnyObj = Record<string, unknown>;

const errors: string[] = [];
const warnings: string[] = [];

function err(msg: string): void { errors.push(msg); }
function warn(msg: string): void { warnings.push(msg); }

function isObj(v: unknown): v is AnyObj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readJson(path: string): AnyObj | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e: any) {
    err(`[parse] ${path}: ${e?.message || e}`);
    return null;
  }
}

function reqString(obj: AnyObj, key: string, path: string): string | null {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    err(`[field] ${path}: missing/invalid string '${key}'`);
    return null;
  }
  return v;
}

function reqNumber(obj: AnyObj, key: string, path: string): number | null {
  const v = obj[key];
  if (typeof v !== "number" || Number.isNaN(v)) {
    err(`[field] ${path}: missing/invalid number '${key}'`);
    return null;
  }
  return v;
}

function reqArray(obj: AnyObj, key: string, path: string): unknown[] | null {
  const v = obj[key];
  if (!Array.isArray(v)) {
    err(`[field] ${path}: missing/invalid array '${key}'`);
    return null;
  }
  return v;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => join(dir, f));
}

const teamDirArg = process.argv[2];
if (!teamDirArg) {
  console.error("Usage: bun scripts/validate-team-artifacts.ts <team-dir>");
  process.exit(2);
}

const teamDir = resolve(process.cwd(), teamDirArg);
const configPath = join(teamDir, "config.json");
const tasksDir = join(teamDir, "tasks");
const mailboxDir = join(teamDir, "mailbox");
const membersDir = join(teamDir, "members");
const acksDir = join(mailboxDir, "acks");

if (!existsSync(teamDir)) err(`[structure] missing team dir: ${teamDir}`);
if (!existsSync(configPath)) err(`[structure] missing config.json: ${configPath}`);
if (!existsSync(tasksDir)) err(`[structure] missing tasks dir: ${tasksDir}`);
if (!existsSync(mailboxDir)) err(`[structure] missing mailbox dir: ${mailboxDir}`);
if (!existsSync(membersDir)) err(`[structure] missing members dir: ${membersDir}`);

const memberNames = new Set<string>();
const taskIds = new Set<string>();
const messageIds = new Set<string>();

if (existsSync(configPath)) {
  const cfg = readJson(configPath);
  if (cfg && isObj(cfg)) {
    reqNumber(cfg, "schemaVersion", configPath);
    reqNumber(cfg, "version", configPath);
    reqString(cfg, "id", configPath);
    reqString(cfg, "name", configPath);
    reqString(cfg, "createdAt", configPath);
    reqString(cfg, "leadSessionId", configPath);
    reqString(cfg, "status", configPath);
    const members = reqArray(cfg, "members", configPath);
    if (members) {
      for (let i = 0; i < members.length; i++) {
        const mPath = `${configPath}#members[${i}]`;
        const m = members[i];
        if (!isObj(m)) {
          err(`[field] ${mPath}: member must be object`);
          continue;
        }
        const name = reqString(m, "name", mPath);
        reqString(m, "agentId", mPath);
        reqString(m, "agentType", mPath);
        reqString(m, "sessionFile", mPath);
        reqString(m, "status", mPath);
        reqString(m, "spawnedAt", mPath);
        if (typeof m["planMode"] !== "boolean") err(`[field] ${mPath}: missing/invalid boolean 'planMode'`);
        if (!(typeof m["pid"] === "number" || m["pid"] === null)) err(`[field] ${mPath}: pid must be number|null`);
        if (!(typeof m["currentTaskId"] === "string" || m["currentTaskId"] === null)) err(`[field] ${mPath}: currentTaskId must be string|null`);
        if (name) memberNames.add(name);
      }
    }
  }
}

for (const path of listJsonFiles(tasksDir)) {
  const task = readJson(path);
  if (!task || !isObj(task)) continue;
  reqNumber(task, "schemaVersion", path);
  reqNumber(task, "version", path);
  const id = reqString(task, "id", path);
  reqString(task, "title", path);
  reqString(task, "description", path);
  const status = reqString(task, "status", path);
  const assignee = task["assignee"];
  reqString(task, "createdBy", path);
  reqString(task, "createdAt", path);
  reqString(task, "updatedAt", path);
  if (!(typeof task["completedAt"] === "string" || task["completedAt"] === null)) err(`[field] ${path}: completedAt must be string|null`);
  if (!(typeof task["result"] === "string" || task["result"] === null)) err(`[field] ${path}: result must be string|null`);
  if (!Array.isArray(task["dependencies"])) err(`[field] ${path}: dependencies must be array`);
  reqNumber(task, "priority", path);
  if (!Array.isArray(task["tags"])) err(`[field] ${path}: tags must be array`);

  if (status === "in_progress" && (typeof assignee !== "string" || !assignee)) {
    err(`[invariant] ${path}: in_progress task requires non-empty assignee`);
  }
  if (status === "completed") {
    if (typeof task["completedAt"] !== "string" || !String(task["completedAt"]).trim()) {
      err(`[invariant] ${path}: completed task requires completedAt`);
    }
    if (typeof task["result"] !== "string" || !String(task["result"]).trim()) {
      err(`[invariant] ${path}: completed task requires result`);
    }
  }
  if (typeof assignee === "string" && assignee && memberNames.size > 0 && !memberNames.has(assignee)) {
    err(`[coherence] ${path}: assignee '${assignee}' not found in config members`);
  }
  if (id) taskIds.add(id);
}

for (const path of listJsonFiles(mailboxDir)) {
  const base = basename(path);
  if (!base.startsWith("msg-")) continue;
  const msg = readJson(path);
  if (!msg || !isObj(msg)) continue;
  reqNumber(msg, "schemaVersion", path);
  const id = reqString(msg, "id", path);
  reqString(msg, "from", path);
  reqString(msg, "to", path);
  reqString(msg, "type", path);
  reqString(msg, "content", path);
  reqString(msg, "createdAt", path);
  if (id) {
    if (messageIds.has(id)) err(`[invariant] ${path}: duplicate message id '${id}'`);
    messageIds.add(id);
  }
}

if (existsSync(acksDir)) {
  const recipients = readdirSync(acksDir).map(n => join(acksDir, n));
  for (const rPath of recipients) {
    if (!existsSync(rPath)) continue;
    for (const ackFile of listJsonFiles(rPath)) {
      const ack = readJson(ackFile);
      if (!ack || !isObj(ack)) continue;
      reqNumber(ack, "schemaVersion", ackFile);
      const msgId = reqString(ack, "msgId", ackFile);
      reqString(ack, "recipient", ackFile);
      reqString(ack, "ackedAt", ackFile);
      if (msgId && !messageIds.has(msgId)) {
        warn(`[coherence] ${ackFile}: ack references unknown msgId '${msgId}'`);
      }
    }
  }
}

for (const hbPath of listJsonFiles(membersDir)) {
  const base = basename(hbPath);
  if (!base.endsWith(".heartbeat.json")) continue;
  const hb = readJson(hbPath);
  if (!hb || !isObj(hb)) continue;
  reqNumber(hb, "schemaVersion", hbPath);
  reqString(hb, "teammate", hbPath);
  reqString(hb, "status", hbPath);
  reqString(hb, "timestamp", hbPath);
  if (!(typeof hb["pid"] === "number" || hb["pid"] === null)) err(`[field] ${hbPath}: pid must be number|null`);
  if (typeof hb["planMode"] !== "boolean") warn(`[field] ${hbPath}: planMode must be boolean`);
}

if (existsSync(configPath)) {
  const cfg = readJson(configPath);
  if (cfg && isObj(cfg) && Array.isArray(cfg.members)) {
    for (let i = 0; i < cfg.members.length; i++) {
      const m = cfg.members[i];
      if (!isObj(m)) continue;
      const currentTaskId = m["currentTaskId"];
      const name = typeof m["name"] === "string" ? m["name"] : `members[${i}]`;
      if (typeof currentTaskId === "string" && currentTaskId && !taskIds.has(currentTaskId)) {
        err(`[coherence] config members '${name}' currentTaskId '${currentTaskId}' does not exist`);
      }
    }
  }
}

if (listJsonFiles(tasksDir).length === 0) warn(`[warn] no task files found in ${tasksDir}`);
if (messageIds.size === 0) warn(`[warn] no mailbox messages found in ${mailboxDir}`);

console.log(`Validation target: ${teamDir}`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);

if (errors.length > 0) {
  console.log(`\nResult: FAILED (${errors.length} error(s), ${warnings.length} warning(s))`);
  process.exit(1);
}

console.log(`\nResult: OK (${warnings.length} warning(s))`);
process.exit(0);
