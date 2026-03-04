import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const TEAM_SCHEMA_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TeamConfig {
	schemaVersion: number;
	version: number;
	id: string;
	name: string;
	createdAt: string;
	leadSessionId: string;
	status: "active" | "shutting_down" | "cleaned_up";
	lastReconciledAt?: string;
	members: TeamMember[];
}

export interface TeamMember {
	name: string;
	agentId: string;
	agentType: string;
	sessionFile: string;
	pid: number | null;
	status: "starting" | "idle" | "working" | "shutting_down" | "stopped";
	currentTaskId: string | null;
	spawnedAt: string;
	planMode: boolean;
}

export interface Task {
	schemaVersion: number;
	version: number;
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	assignee: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	dependencies: string[];
	result: string | null;
	priority: number;
	tags: string[];
}

export interface TeamMessage {
	schemaVersion: number;
	id: string;
	from: string;
	to: string | "*";
	type:
		| "message"
		| "shutdown_request"
		| "shutdown_response"
		| "plan_approval_request"
		| "plan_approval_response"
		| "idle_notification"
		| "task_update";
	content: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

export interface MessageAck {
	schemaVersion: number;
	msgId: string;
	recipient: string;
	ackedAt: string;
}

export interface CreateTaskInput {
	title: string;
	description: string;
	createdBy: string;
	dependencies?: string[];
	priority?: number;
	tags?: string[];
	assignee?: string | null;
}

export interface TaskFilter {
	status?: TaskStatus;
	assignee?: string | null;
}

function sleepMs(ms: number): void {
	const start = Date.now();
	while (Date.now() - start < ms) {
		// intentional small blocking sleep for sync lock loop
	}
}

function ensureTeamDirs(teamDir: string): void {
	for (const dir of [teamDir, join(teamDir, "tasks"), join(teamDir, "mailbox"), join(teamDir, "members")]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
	const ackRoot = join(teamDir, "mailbox", "acks");
	if (!existsSync(ackRoot)) mkdirSync(ackRoot, { recursive: true });
}

export function readJsonSafe<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

export function writeAtomicJson(path: string, data: unknown): void {
	const parent = dirname(path);
	if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmp, path);
}

function tryUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function configPath(teamDir: string): string {
	return join(teamDir, "config.json");
}

function taskPath(teamDir: string, taskId: string): string {
	return join(teamDir, "tasks", `task-${taskId}.json`);
}

function mailboxDir(teamDir: string): string {
	return join(teamDir, "mailbox");
}

function messagePath(teamDir: string, messageId: string): string {
	return join(mailboxDir(teamDir), `msg-${messageId}.json`);
}

function ackPath(teamDir: string, recipient: string, msgId: string): string {
	return join(mailboxDir(teamDir), "acks", recipient, `${msgId}.ack.json`);
}

function listTaskFiles(teamDir: string): string[] {
	const tasksDir = join(teamDir, "tasks");
	if (!existsSync(tasksDir)) return [];
	return readdirSync(tasksDir)
		.filter(name => name.startsWith("task-") && name.endsWith(".json"))
		.map(name => join(tasksDir, name));
}

function listMessageFiles(teamDir: string): string[] {
	const dir = mailboxDir(teamDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.startsWith("msg-") && name.endsWith(".json"))
		.map(name => join(dir, name));
}

function dependenciesComplete(teamDir: string, task: Task): boolean {
	for (const depId of task.dependencies) {
		const dep = getTask(teamDir, depId);
		if (!dep || dep.status !== "completed") return false;
	}
	return true;
}

export function withFileLock<T>(
	targetPath: string,
	options: { timeoutMs?: number; staleMs?: number; owner?: string },
	fn: () => T,
): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
	const lockPath = `${targetPath}.lock`;
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const payload = {
			ownerPid: process.pid,
			ownerName: options.owner ?? "team-shared",
			createdAt: new Date().toISOString(),
		};

		try {
			writeFileSync(lockPath, JSON.stringify(payload), { encoding: "utf-8", flag: "wx" });
			break;
		} catch {
			const existing = readJsonSafe<{ ownerPid?: number; createdAt?: string }>(lockPath);
			const createdAtMs = existing?.createdAt ? Date.parse(existing.createdAt) : NaN;
			const stale = Number.isFinite(createdAtMs) && Date.now() - createdAtMs > staleMs;
			const alive = typeof existing?.ownerPid === "number" ? isPidAlive(existing.ownerPid) : false;
			if (stale && !alive) {
				tryUnlink(lockPath);
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timeout acquiring lock for ${targetPath}`);
			}
			sleepMs(25);
		}
	}

	try {
		return fn();
	} finally {
		tryUnlink(lockPath);
	}
}

export function readTeamConfig(teamDir: string): TeamConfig {
	const cfg = readJsonSafe<TeamConfig>(configPath(teamDir));
	if (!cfg) throw new Error(`Team config not found: ${configPath(teamDir)}`);
	return cfg;
}

export function writeTeamConfig(teamDir: string, config: TeamConfig): void {
	ensureTeamDirs(teamDir);
	writeAtomicJson(configPath(teamDir), config);
}

export function updateTeamConfig(
	teamDir: string,
	mutator: (draft: TeamConfig) => void,
	options?: { expectedVersion?: number },
): TeamConfig {
	const path = configPath(teamDir);
	return withFileLock(path, { owner: "updateTeamConfig" }, () => {
		const current = readJsonSafe<TeamConfig>(path);
		if (!current) throw new Error(`Team config not found: ${path}`);
		if (typeof options?.expectedVersion === "number" && current.version !== options.expectedVersion) {
			throw new Error(`Team config version mismatch: expected ${options.expectedVersion}, got ${current.version}`);
		}
		const draft: TeamConfig = { ...current, members: [...current.members] };
		mutator(draft);
		draft.version = (current.version || 0) + 1;
		writeAtomicJson(path, draft);
		return draft;
	});
}

export function createTask(teamDir: string, input: CreateTaskInput): Task {
	ensureTeamDirs(teamDir);
	const now = new Date().toISOString();
	const task: Task = {
		schemaVersion: TEAM_SCHEMA_VERSION,
		version: 1,
		id: randomUUID(),
		title: input.title,
		description: input.description,
		status: "pending",
		assignee: input.assignee ?? null,
		createdBy: input.createdBy,
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		dependencies: input.dependencies ?? [],
		result: null,
		priority: Math.min(5, Math.max(1, input.priority ?? 3)),
		tags: input.tags ?? [],
	};
	writeAtomicJson(taskPath(teamDir, task.id), task);
	return task;
}

export function getTask(teamDir: string, taskId: string): Task | null {
	return readJsonSafe<Task>(taskPath(teamDir, taskId));
}

export function listTasks(teamDir: string, filter?: TaskFilter): Task[] {
	const out: Task[] = [];
	for (const file of listTaskFiles(teamDir)) {
		const task = readJsonSafe<Task>(file);
		if (!task) continue;
		if (filter?.status && task.status !== filter.status) continue;
		if (Object.prototype.hasOwnProperty.call(filter ?? {}, "assignee") && task.assignee !== filter?.assignee) continue;
		out.push(task);
	}
	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return out;
}

export function claimTaskAtomic(teamDir: string, taskId: string, claimant: string): boolean {
	const path = taskPath(teamDir, taskId);
	if (!existsSync(path)) return false;
	return withFileLock(path, { owner: `claim:${claimant}` }, () => {
		const task = readJsonSafe<Task>(path);
		if (!task) return false;
		if (task.status !== "pending" || task.assignee !== null) return false;
		if (!dependenciesComplete(teamDir, task)) return false;
		task.assignee = claimant;
		task.status = "in_progress";
		task.version += 1;
		task.updatedAt = new Date().toISOString();
		writeAtomicJson(path, task);
		return true;
	});
}

export function updateTask(
	teamDir: string,
	taskId: string,
	patch: Partial<Task>,
	options?: { expectedVersion?: number },
): Task {
	const path = taskPath(teamDir, taskId);
	return withFileLock(path, { owner: "updateTask" }, () => {
		const current = readJsonSafe<Task>(path);
		if (!current) throw new Error(`Task not found: ${taskId}`);
		if (typeof options?.expectedVersion === "number" && current.version !== options.expectedVersion) {
			throw new Error(`Task version mismatch: expected ${options.expectedVersion}, got ${current.version}`);
		}
		const next: Task = {
			...current,
			...patch,
			id: current.id,
			schemaVersion: current.schemaVersion,
			createdAt: current.createdAt,
			createdBy: current.createdBy,
			version: current.version + 1,
			updatedAt: new Date().toISOString(),
		};
		writeAtomicJson(path, next);
		return next;
	});
}

export function completeTask(teamDir: string, taskId: string, result: string, actor: string): Task {
	if (!result || !result.trim()) throw new Error("Task result is required");
	const path = taskPath(teamDir, taskId);
	return withFileLock(path, { owner: `complete:${actor}` }, () => {
		const task = readJsonSafe<Task>(path);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (task.status !== "in_progress") throw new Error(`Task is not in_progress: ${taskId}`);
		if (task.assignee && task.assignee !== actor) throw new Error(`Only assignee can complete task: ${taskId}`);
		const now = new Date().toISOString();
		const next: Task = {
			...task,
			status: "completed",
			result: result.trim(),
			completedAt: now,
			updatedAt: now,
			version: task.version + 1,
		};
		writeAtomicJson(path, next);
		return next;
	});
}

export function requeueTask(teamDir: string, taskId: string, note: string, actor: "lead"): Task {
	void actor;
	const path = taskPath(teamDir, taskId);
	return withFileLock(path, { owner: "requeue:lead" }, () => {
		const task = readJsonSafe<Task>(path);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (task.status !== "failed") throw new Error(`Only failed tasks can be requeued: ${taskId}`);
		const stampedNote = note?.trim() ? `\n\n[requeue] ${note.trim()}` : "";
		const next: Task = {
			...task,
			status: "pending",
			assignee: null,
			completedAt: null,
			result: task.result ? `${task.result}${stampedNote}` : stampedNote.trim() || null,
			updatedAt: new Date().toISOString(),
			version: task.version + 1,
		};
		writeAtomicJson(path, next);
		return next;
	});
}

export function sendMessage(teamDir: string, message: TeamMessage): void {
	ensureTeamDirs(teamDir);
	writeAtomicJson(messagePath(teamDir, message.id), message);
}

export function listMessages(teamDir: string, opts?: { to?: string; from?: string; limit?: number }): TeamMessage[] {
	const out: TeamMessage[] = [];
	for (const file of listMessageFiles(teamDir)) {
		const msg = readJsonSafe<TeamMessage>(file);
		if (!msg) continue;
		if (opts?.from && msg.from !== opts.from) continue;
		if (opts?.to && msg.to !== opts.to && msg.to !== "*") continue;
		out.push(msg);
	}
	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	if (opts?.limit && opts.limit > 0 && out.length > opts.limit) {
		return out.slice(out.length - opts.limit);
	}
	return out;
}

export function ackMessage(teamDir: string, recipient: string, msgId: string): void {
	const now = new Date().toISOString();
	const ack: MessageAck = {
		schemaVersion: TEAM_SCHEMA_VERSION,
		msgId,
		recipient,
		ackedAt: now,
	};
	writeAtomicJson(ackPath(teamDir, recipient, msgId), ack);
}

export function listUnreadMessages(teamDir: string, recipient: string, limit?: number): TeamMessage[] {
	const unread = listMessages(teamDir, { to: recipient }).filter(msg => !existsSync(ackPath(teamDir, recipient, msg.id)));
	if (limit && limit > 0 && unread.length > limit) return unread.slice(unread.length - limit);
	return unread;
}
