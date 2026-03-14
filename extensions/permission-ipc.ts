/**
 * Permission IPC — File-based IPC for relaying permission prompts
 * from headless subagents back to the parent session.
 *
 * Also exports a shared permission dialog component used by both
 * permission-gate.ts (standalone) and agent-team.ts (IPC parent).
 *
 * Protocol:
 *   1. Parent sets PI_IPC_DIR env var when spawning subagent
 *   2. Subagent's permission-gate writes req-<id>.json when it needs approval
 *   3. Parent detects the file, shows UI prompt, writes res-<id>.json
 *   4. Subagent polls for res-<id>.json and reads the decision
 */

import { randomUUID } from "crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { DynamicBorder, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Editor,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────

export type IpcRequestType = "bash_dangerous" | "write" | "edit";

export interface IpcPermissionRequest {
	id: string;
	agent: string;
	type: IpcRequestType;
	path?: string;
	command?: string;
	/** For write: the full file content (truncated). For edit: the new text. */
	content?: string;
	/** For edit: the text being replaced. */
	oldText?: string;
	timestamp: number;
}

export interface IpcPermissionResponse {
	id: string;
	approved: boolean;
	choice?: "allow_once" | "allow_always" | "deny";
	/** Optional feedback message from the user to the agent. */
	message?: string;
	timestamp: number;
}

// ── Helpers ──────────────────────────────────────

function tryUnlink(filePath: string): void {
	try { unlinkSync(filePath); } catch {}
}

// ── Constants ────────────────────────────────────

export const IPC_ENV_DIR = "PI_IPC_DIR";
export const IPC_ENV_AGENT = "PI_IPC_AGENT";
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes

// ── File Name Helpers ────────────────────────────

function reqFile(id: string): string {
	return `req-${id}.json`;
}

function resFile(id: string): string {
	return `res-${id}.json`;
}

// ── Child Side (subagent) ────────────────────────

export function createPermissionRequest(
	agent: string,
	type: IpcRequestType,
	details: { path?: string; command?: string; content?: string; oldText?: string },
): IpcPermissionRequest {
	return {
		id: randomUUID(),
		agent,
		type,
		path: details.path,
		command: details.command,
		content: details.content ? truncateForIpc(details.content) : undefined,
		oldText: details.oldText ? truncateForIpc(details.oldText) : undefined,
		timestamp: Date.now(),
	};
}

/** Truncate content to keep IPC files small (max 4KB preview). */
function truncateForIpc(text: string, maxLen = 4096): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + `\n... [truncated, ${text.length} chars total]`;
}

/**
 * Write a permission request file and poll until the parent responds.
 * Blocks (async) until response arrives or 5-minute timeout.
 */
export async function sendPermissionRequest(
	ipcDir: string,
	request: IpcPermissionRequest,
): Promise<IpcPermissionResponse> {
	if (!existsSync(ipcDir)) {
		mkdirSync(ipcDir, { recursive: true });
	}

	// Write request atomically (tmp + rename)
	const reqPath = join(ipcDir, reqFile(request.id));
	const tmpReq = reqPath + ".tmp";
	writeFileSync(tmpReq, JSON.stringify(request), "utf-8");
	renameSync(tmpReq, reqPath);

	// Poll for response
	const resPath = join(ipcDir, resFile(request.id));
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	const denied: IpcPermissionResponse = {
		id: request.id,
		approved: false,
		choice: "deny",
		timestamp: Date.now(),
	};

	return new Promise<IpcPermissionResponse>((resolve) => {
		const timer = setInterval(() => {
			if (existsSync(resPath)) {
				clearInterval(timer);
				try {
					const raw = readFileSync(resPath, "utf-8");
					const response: IpcPermissionResponse = JSON.parse(raw);
					tryUnlink(reqPath);
					tryUnlink(resPath);
					resolve(response);
				} catch {
					tryUnlink(reqPath);
					tryUnlink(resPath);
					resolve(denied);
				}
				return;
			}
			if (Date.now() > deadline) {
				clearInterval(timer);
				tryUnlink(reqPath);
				resolve(denied);
			}
		}, POLL_INTERVAL_MS);
	});
}

// ── Parent Side ──────────────────────────────────

/**
 * Scan IPC directory for pending request files.
 */
export function scanForRequests(ipcDir: string): IpcPermissionRequest[] {
	if (!existsSync(ipcDir)) return [];
	const out: IpcPermissionRequest[] = [];
	try {
		for (const f of readdirSync(ipcDir)) {
			if (!f.startsWith("req-") || !f.endsWith(".json") || f.endsWith(".tmp")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(ipcDir, f), "utf-8")));
			} catch {}
		}
	} catch {}
	return out;
}

/**
 * Write a response file for a request.
 */
export function writePermissionResponse(
	ipcDir: string,
	response: IpcPermissionResponse,
): void {
	const p = join(ipcDir, resFile(response.id));
	const tmp = p + ".tmp";
	writeFileSync(tmp, JSON.stringify(response), "utf-8");
	renameSync(tmp, p);
}

/**
 * Remove all IPC request/response files.
 */
export function cleanupIpcDir(ipcDir: string): void {
	if (!existsSync(ipcDir)) return;
	try {
		for (const f of readdirSync(ipcDir)) {
			if (f.startsWith("req-") || f.startsWith("res-")) {
				tryUnlink(join(ipcDir, f));
			}
		}
	} catch {}
}

/**
 * Start polling for permission requests. Calls handler for each new request.
 * Returns a stop function.
 */
export function startIpcWatcher(
	ipcDir: string,
	handler: (req: IpcPermissionRequest) => Promise<IpcPermissionResponse>,
): () => void {
	const handled = new Set<string>();
	let running = true;

	const poll = async () => {
		while (running) {
			for (const req of scanForRequests(ipcDir)) {
				if (handled.has(req.id)) continue;
				handled.add(req.id);
				handler(req)
					.then((res) => writePermissionResponse(ipcDir, res))
					.catch(() => {
						writePermissionResponse(ipcDir, {
							id: req.id,
							approved: false,
							choice: "deny",
							timestamp: Date.now(),
						});
					});
			}
			await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
	};

	poll();
	return () => { running = false; };
}

// ── Shared Permission Dialog ─────────────────────

/** Result from the permission dialog: the chosen option and optional feedback message. */
export interface PermissionDialogResult<T extends string> {
	choice: T;
	message?: string;
}

/**
 * Show a permission dialog with selectable options and a Tab-toggleable message input.
 *
 * Works in any extension context with UI (standalone permission-gate, agent-team IPC, etc.).
 * Returns the chosen option and an optional user-provided feedback message.
 *
 * Usage:
 *   const result = await showPermissionDialog(ctx, "Allow this?", ["Yes", "No"] as const);
 *   // result.choice  — "Yes" | "No"
 *   // result.message — user feedback or undefined
 */
export async function showPermissionDialog<T extends string>(
	ctx: ExtensionContext,
	prompt: string,
	options: readonly T[],
): Promise<PermissionDialogResult<T>> {
	const defaultChoice = options[options.length - 1] as T;

	const result = await ctx.ui.custom<PermissionDialogResult<T>>((tui, theme, _kb, done) => {
		const container = new Container();
		let messageInputVisible = false;
		let focusOnInput = false;
		// Editor clears its text before calling onSubmit, so we snapshot it
		// before each handleInput call to preserve the message for submission.
		let lastEditorSnapshot = "";

		// ── Select list ──
		const items: SelectItem[] = options.map((opt) => ({ value: opt, label: opt }));
		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		selectList.onSelect = (item) => {
			done({ choice: item.value as T, message: getMessageText() });
		};
		selectList.onCancel = () => {
			done({ choice: defaultChoice, message: getMessageText() });
		};

		// ── Message editor (initially hidden) ──
		const messageLabel = new Text("", 1, 0);
		const messageInput = new Editor(tui, {
			borderColor: (s: string) => theme.fg("dim", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		}, { paddingX: 1 });
		messageInput.onSubmit = () => {
			const selected = selectList.getSelectedItem();
			const choice = selected ? (selected.value as T) : defaultChoice;
			// Use snapshot taken before handleInput cleared the editor
			const msg = lastEditorSnapshot.trim();
			const message = msg.length > 0 ? msg : undefined;
			done({ choice, message });
		};

		const helpText = new Text("", 1, 0);
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

		function getMessageText(): string | undefined {
			// For selectList paths (Tab back then Enter), read live editor text
			const val = messageInput.getText().trim();
			// Also check snapshot in case editor was cleared
			const effective = val.length > 0 ? val : lastEditorSnapshot.trim();
			return effective.length > 0 ? effective : undefined;
		}

		function rebuildContainer(): void {
			container.clear();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", prompt), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(selectList);

			if (messageInputVisible) {
				messageLabel.setText(theme.fg("warning", "  Message to agent:"));
				container.addChild(messageLabel);
				container.addChild(messageInput);
				helpText.setText(theme.fg("dim", "↑↓ navigate • enter confirm • shift+enter new line • tab hide message • esc cancel"));
			} else {
				helpText.setText(theme.fg("dim", "↑↓ navigate • enter confirm • tab add message • esc cancel"));
			}

			container.addChild(helpText);
			container.addChild(bottomBorder);
		}

		rebuildContainer();

		return {
			render(width: number): string[] {
				return container.render(width);
			},
			invalidate(): void {
				container.invalidate();
				rebuildContainer();
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.tab)) {
					messageInputVisible = !messageInputVisible;
					focusOnInput = messageInputVisible;
					rebuildContainer();
					tui.requestRender();
					return;
				}

				if (focusOnInput && messageInputVisible) {
					if (matchesKey(data, Key.escape)) {
						messageInputVisible = false;
						focusOnInput = false;
						rebuildContainer();
						tui.requestRender();
						return;
					}
					// Snapshot editor text BEFORE handleInput processes it
					// (Editor clears text on submit before calling onSubmit)
					lastEditorSnapshot = messageInput.getText();
					messageInput.handleInput(data);
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});

	return result ?? { choice: defaultChoice };
}
