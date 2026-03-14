/**
 * Permission Gate Extension (standalone)
 *
 * Prompts for confirmation before:
 * - running potentially dangerous bash commands
 * - write/edit operations
 *
 * Write/edit approvals support:
 * - Allow once
 * - Always allow this file (session)
 * - Deny
 *
 * Extra controls:
 * - Ctrl+Shift+E toggles AUTO-EDIT mode for this session
 * - /perm-mode command to view/set mode and status style
 * - Footer status is compact by default; /perm-mode style [compact|medium|verbose]
 *
 * IPC support:
 * When PI_IPC_DIR is set (by a parent orchestrator), headless subagents
 * relay permission prompts to the parent via file-based IPC instead of
 * blocking on a missing UI.
 */

import { randomUUID } from "crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { join, resolve } from "path";
import {
	DynamicBorder,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
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

// ── IPC Constants ────────────────────────────────

const IPC_ENV_DIR = "PI_IPC_DIR";
const IPC_ENV_AGENT = "PI_IPC_AGENT";
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes

// ── IPC Types ────────────────────────────────────

type IpcRequestType = "bash_dangerous" | "write" | "edit";

interface IpcPermissionRequest {
	id: string;
	agent: string;
	type: IpcRequestType;
	path?: string;
	command?: string;
	content?: string;
	oldText?: string;
	timestamp: number;
}

interface IpcPermissionResponse {
	id: string;
	approved: boolean;
	choice?: "allow_once" | "allow_always" | "deny";
	message?: string;
	timestamp: number;
}

// ── IPC Helpers (child / subagent side) ──────────

function tryUnlink(filePath: string): void {
	try { unlinkSync(filePath); } catch {}
}

function reqFile(id: string): string {
	return `req-${id}.json`;
}

function resFile(id: string): string {
	return `res-${id}.json`;
}

function truncateForIpc(text: string, maxLen = 4096): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + `\n... [truncated, ${text.length} chars total]`;
}

function createPermissionRequest(
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

async function sendPermissionRequest(
	ipcDir: string,
	request: IpcPermissionRequest,
): Promise<IpcPermissionResponse> {
	if (!existsSync(ipcDir)) {
		mkdirSync(ipcDir, { recursive: true });
	}

	const reqPath = join(ipcDir, reqFile(request.id));
	const tmpReq = reqPath + ".tmp";
	writeFileSync(tmpReq, JSON.stringify(request), "utf-8");
	renameSync(tmpReq, reqPath);

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

// ── Permission Dialog ────────────────────────────

interface PermissionDialogResult<T extends string> {
	choice: T;
	message?: string;
}

async function showPermissionDialog<T extends string>(
	ctx: ExtensionContext,
	prompt: string,
	options: readonly T[],
): Promise<PermissionDialogResult<T>> {
	const defaultChoice = options[options.length - 1] as T;

	const result = await ctx.ui.custom<PermissionDialogResult<T>>((tui, theme, _kb, done) => {
		const container = new Container();
		let messageInputVisible = false;
		let focusOnInput = false;

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
			done({ choice, message: getMessageText() });
		};

		const helpText = new Text("", 1, 0);
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

		function getMessageText(): string | undefined {
			const val = messageInput.getText().trim();
			return val.length > 0 ? val : undefined;
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

// ── Extension Constants ──────────────────────────

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
];

const TOGGLE_EDIT_MODE_SHORTCUT = "ctrl+shift+e";
const SHORTCUT_HINT = "C-S-E";
const STATUS_VERBOSITY_ENV = "PI_PERM_STATUS_VERBOSITY";
const MODE_OPTIONS = ["guarded", "auto-edit", "cancel"] as const;
const STATUS_VERBOSITY_OPTIONS = ["compact", "medium", "verbose"] as const;
const MODIFY_PERMISSION_OPTIONS = [
	"Allow once",
	"Always allow this file (session)",
	"Deny",
] as const;

type BlockResult = { block: true; reason: string };
type PermissionMode = "guarded" | "auto-edit";
type StatusVerbosity = (typeof STATUS_VERBOSITY_OPTIONS)[number];
type ModifyToolName = "write" | "edit";
type ModifyPermissionChoice = (typeof MODIFY_PERMISSION_OPTIONS)[number];

// ── Main Extension ───────────────────────────────

export default function permissionGateExtension(pi: ExtensionAPI): void {
	const allowedModifyPaths = new Set<string>();
	const pendingFeedback = new Map<string, string>();
	const defaultMode = parsePermissionModeFromEnv(process.env.PI_PERM_MODE);
	const defaultVerbosity = parseStatusVerbosityFromEnv(process.env[STATUS_VERBOSITY_ENV]);
	const ipcDir = process.env[IPC_ENV_DIR] || "";
	const ipcAgent = process.env[IPC_ENV_AGENT] || "subagent";
	let mode: PermissionMode = defaultMode;
	let statusVerbosity: StatusVerbosity = defaultVerbosity;
	process.env.PI_PERM_MODE = mode;
	process.env[STATUS_VERBOSITY_ENV] = statusVerbosity;

	function refreshUI(ctx: ExtensionContext): void {
		updateModeUI(ctx, mode, statusVerbosity);
		updateModeWidget(ctx, mode, statusVerbosity);
	}

	pi.on("session_start", async function onSessionStart(_event, ctx) {
		refreshUI(ctx);
	});

	pi.on("session_switch", async function onSessionSwitch(_event, ctx) {
		resetSessionState();
		refreshUI(ctx);
	});

	pi.registerShortcut(TOGGLE_EDIT_MODE_SHORTCUT, {
		description: "Toggle permission-gate auto-edit mode",
		handler: async function onToggleShortcut(ctx) {
			setMode(toggleMode(mode), ctx);
		},
	});

	pi.registerCommand("perm-mode", {
		description: "Permission mode: /perm-mode [guarded|auto-edit|toggle|status|compact|medium|verbose|style <...>]",
		handler: async function onPermModeCommand(args, ctx) {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const arg = tokens[0] ?? "";
			const styleArg = arg === "style" ? (tokens[1] ?? "") : arg;

			if (arg.length === 0 || arg === "status") {
				refreshUI(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(getModeStatusSummary(mode, statusVerbosity), "info");
				}
				return;
			}

			if (arg === "toggle") {
				setMode(toggleMode(mode), ctx);
				return;
			}

			if (arg === "guarded" || arg === "auto-edit") {
				setMode(arg, ctx);
				return;
			}

			if (isStatusVerbosity(styleArg)) {
				setStatusVerbosity(styleArg, ctx);
				return;
			}

			if (!ctx.hasUI) {
				return;
			}

			if (arg === "style") {
				const stylePick = await ctx.ui.select("Set permission status style", [...STATUS_VERBOSITY_OPTIONS, "cancel"]);
				if (isStatusVerbosity(stylePick)) {
					setStatusVerbosity(stylePick, ctx);
				}
				return;
			}

			const pick = await ctx.ui.select("Set permission mode", [...MODE_OPTIONS]);
			if (pick === "guarded" || pick === "auto-edit") {
				setMode(pick, ctx);
			}
		},
	});

	pi.registerCommand("perm-clear", {
		description: "Clear write/edit file approvals saved by permission-gate",
		handler: async function onPermClear(_args, ctx) {
			allowedModifyPaths.clear();
			if (ctx.hasUI) {
				ctx.ui.notify("permission-gate: cleared saved file approvals", "info");
			}
		},
	});

	pi.on("tool_call", async function onToolCall(event, ctx) {
		console.error(`[perm-gate DEBUG] tool_call: toolCallId=${event.toolCallId}, toolName=${event.toolName}`);
		const feedbackFn = (message: string) => queueFeedback(event.toolCallId, message);

		if (isToolCallEventType("bash", event)) {
			return handleBashToolCall(event.input.command ?? "", ctx, ipcDir, ipcAgent, feedbackFn);
		}

		if (isToolCallEventType("write", event)) {
			return handleModifyToolCall("write", event.input.path, ctx, allowedModifyPaths, mode, ipcDir, ipcAgent, {
				content: event.input.content,
			}, feedbackFn);
		}

		if (isToolCallEventType("edit", event)) {
			return handleModifyToolCall("edit", event.input.path, ctx, allowedModifyPaths, mode, ipcDir, ipcAgent, {
				content: event.input.newText,
				oldText: event.input.oldText,
			}, feedbackFn);
		}

		return undefined;
	});

	function queueFeedback(toolCallId: string, message: string): void {
		console.error(`[perm-gate DEBUG] queueFeedback: toolCallId=${toolCallId}, message="${message}"`);
		pendingFeedback.set(toolCallId, message);
	}

	pi.on("tool_result", async function onToolResult(event: ToolResultEvent) {
		console.error(`[perm-gate DEBUG] tool_result: toolCallId=${event.toolCallId}, hasPending=${pendingFeedback.has(event.toolCallId)}, pendingSize=${pendingFeedback.size}`);
		const message = pendingFeedback.get(event.toolCallId);
		if (!message) {
			return undefined;
		}
		pendingFeedback.delete(event.toolCallId);

		console.error(`[perm-gate DEBUG] appending feedback: "${message}"`);
		const feedbackBlock = {
			type: "text" as const,
			text: `\n\n[User feedback]: ${message}`,
		};
		return {
			content: [...event.content, feedbackBlock],
		};
	});

	function resetSessionState(): void {
		allowedModifyPaths.clear();
		pendingFeedback.clear();
		mode = defaultMode;
		statusVerbosity = defaultVerbosity;
		process.env.PI_PERM_MODE = mode;
		process.env[STATUS_VERBOSITY_ENV] = statusVerbosity;
	}

	function setMode(nextMode: PermissionMode, ctx: ExtensionContext): void {
		mode = nextMode;
		process.env.PI_PERM_MODE = mode;
		refreshUI(ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(getModeNotification(mode), "info");
		}
	}

	function setStatusVerbosity(nextVerbosity: StatusVerbosity, ctx: ExtensionContext): void {
		statusVerbosity = nextVerbosity;
		process.env[STATUS_VERBOSITY_ENV] = statusVerbosity;
		refreshUI(ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(`permission-gate style: ${statusVerbosity}`, "info");
		}
	}
}

// ── Shared Helpers ───────────────────────────────

function deliverFeedback(
	message: string | undefined,
	onFeedback?: (message: string) => void,
): void {
	console.error(`[perm-gate DEBUG] deliverFeedback: message="${message}", hasOnFeedback=${!!onFeedback}`);
	if (message && onFeedback) {
		onFeedback(message);
	}
}

function blockWithReason(baseReason: string, message?: string): BlockResult {
	const reason = message
		? `${baseReason}. Feedback: ${message}`
		: baseReason;
	return { block: true, reason };
}

// ── Tool Call Handlers ───────────────────────────

async function handleBashToolCall(
	command: string,
	ctx: ExtensionContext,
	ipcDir: string,
	ipcAgent: string,
	onFeedback?: (message: string) => void,
): Promise<BlockResult | undefined> {
	const isDangerous = DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
	if (!isDangerous) {
		return undefined;
	}

	if (!ctx.hasUI) {
		if (ipcDir) {
			const req = createPermissionRequest(ipcAgent, "bash_dangerous", { command });
			const res = await sendPermissionRequest(ipcDir, req);
			if (res.approved) {
				deliverFeedback(res.message, onFeedback);
				return undefined;
			}
			return blockWithReason("Dangerous command blocked by parent session", res.message);
		}
		return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
	}

	const result = await showPermissionDialog(ctx, `⚠️ Dangerous bash command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"] as const);
	if (result.choice !== "Yes") {
		return blockWithReason("Blocked by user", result.message);
	}

	deliverFeedback(result.message, onFeedback);
	return undefined;
}

async function handleModifyToolCall(
	toolName: ModifyToolName,
	rawPath: string,
	ctx: ExtensionContext,
	allowedModifyPaths: Set<string>,
	mode: PermissionMode,
	ipcDir: string,
	ipcAgent: string,
	changeDetails?: { content?: string; oldText?: string },
	onFeedback?: (message: string) => void,
): Promise<BlockResult | undefined> {
	if (mode === "auto-edit") {
		return undefined;
	}

	const targetPath = normalizePath(rawPath, ctx.cwd);
	if (!targetPath) {
		return { block: true, reason: `${toolName} blocked (missing path)` };
	}

	if (allowedModifyPaths.has(targetPath)) {
		return undefined;
	}

	if (!ctx.hasUI) {
		if (ipcDir) {
			const req = createPermissionRequest(ipcAgent, toolName, {
				path: targetPath,
				content: changeDetails?.content,
				oldText: changeDetails?.oldText,
			});
			const res = await sendPermissionRequest(ipcDir, req);
			if (res.approved) {
				if (res.choice === "allow_always") {
					allowedModifyPaths.add(targetPath);
				}
				deliverFeedback(res.message, onFeedback);
				return undefined;
			}
			return blockWithReason(`${toolName} blocked by parent session`, res.message);
		}
		return { block: true, reason: `${toolName} blocked (no UI for confirmation)` };
	}

	const prompt = `🔐 ${toolName} permission request\n\nPath: ${targetPath}`;
	const result = await showPermissionDialog(ctx, prompt, [...MODIFY_PERMISSION_OPTIONS]);
	const choice: ModifyPermissionChoice = result.choice ?? "Deny";

	if (choice === "Allow once") {
		deliverFeedback(result.message, onFeedback);
		return undefined;
	}

	if (choice === "Always allow this file (session)") {
		allowedModifyPaths.add(targetPath);
		ctx.ui.notify(`permission-gate: auto-allow enabled for ${targetPath}`, "info");
		deliverFeedback(result.message, onFeedback);
		return undefined;
	}

	return blockWithReason("Blocked by user", result.message);
}

// ── UI Helpers ───────────────────────────────────

function updateModeUI(ctx: ExtensionContext, mode: PermissionMode, verbosity: StatusVerbosity): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.setStatus("perm-gate", getModeStatusText(mode, verbosity));
}

function updateModeWidget(ctx: ExtensionContext, mode: PermissionMode, verbosity: StatusVerbosity): void {
	if (!ctx.hasUI) {
		return;
	}

	if (!isOrchestratorLoadedFromArgv()) {
		ctx.ui.setWidget("perm-gate-mode", undefined);
		return;
	}

	const modeBadge = getModeBadge(mode);
	const detail = getModeDetail(mode);
	ctx.ui.setWidget("perm-gate-mode", (_tui, theme) => {
		return new Text(
			theme.fg("accent", "Permission: ") +
			theme.fg("success", modeBadge) +
			theme.fg("dim", ` · ${detail} · ${TOGGLE_EDIT_MODE_SHORTCUT} · style:${verbosity}`),
			0,
			0,
		);
	}, { placement: "belowEditor" });
}

function isOrchestratorLoadedFromArgv(): boolean {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] !== "-e" && argv[i] !== "--extension") {
			continue;
		}

		const source = (argv[i + 1] || "").toLowerCase();
		if (source.includes("agent-team") || source.includes("agent-chain")) {
			return true;
		}
	}

	return false;
}

function getModeIcon(mode: PermissionMode): string {
	return mode === "auto-edit" ? "🔓" : "🔐";
}

function getModeLabel(mode: PermissionMode): string {
	return mode === "auto-edit" ? "AUTO-EDIT" : "GUARDED";
}

function getModeBadge(mode: PermissionMode): string {
	return `${getModeIcon(mode)} ${getModeLabel(mode)}`;
}

function getModeStatusText(mode: PermissionMode, verbosity: StatusVerbosity): string {
	const modeBadge = getModeBadge(mode);
	if (verbosity === "compact") {
		return modeBadge;
	}
	if (verbosity === "medium") {
		return `${modeBadge} · ${SHORTCUT_HINT}`;
	}
	return `${modeBadge} · ${getModeDetail(mode)} · ${SHORTCUT_HINT}`;
}

function getModeDetail(mode: PermissionMode): string {
	return mode === "auto-edit" ? "write/edit are pre-approved" : "write/edit require confirmation";
}

function getModeStatusSummary(mode: PermissionMode, verbosity: StatusVerbosity): string {
	return `permission-gate: ${getModeBadge(mode)} · ${getModeDetail(mode)} · style=${verbosity} · toggle=${TOGGLE_EDIT_MODE_SHORTCUT}`;
}

function getModeNotification(mode: PermissionMode): string {
	return mode === "auto-edit"
		? `permission-gate: 🔓 AUTO-EDIT enabled · write/edit are pre-approved · toggle: ${TOGGLE_EDIT_MODE_SHORTCUT}`
		: `permission-gate: 🔐 GUARDED enabled · write/edit require confirmation · toggle: ${TOGGLE_EDIT_MODE_SHORTCUT}`;
}

function isStatusVerbosity(value: string): value is StatusVerbosity {
	return STATUS_VERBOSITY_OPTIONS.includes(value as StatusVerbosity);
}

function toggleMode(mode: PermissionMode): PermissionMode {
	return mode === "guarded" ? "auto-edit" : "guarded";
}

function normalizePath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || rawPath.trim().length === 0) {
		return undefined;
	}

	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return resolve(cwd, withoutAt);
}

function parsePermissionModeFromEnv(raw: string | undefined): PermissionMode {
	return raw === "auto-edit" ? "auto-edit" : "guarded";
}

function parseStatusVerbosityFromEnv(raw: string | undefined): StatusVerbosity {
	return isStatusVerbosity(raw ?? "") ? raw as StatusVerbosity : "compact";
}
