/**
 * Permission Gate Extension
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
 * - /perm-mode command to view/set mode
 * - Footer status shows current permission mode
 */

import path from "node:path";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	IPC_ENV_DIR,
	IPC_ENV_AGENT,
	createPermissionRequest,
	sendPermissionRequest,
	showPermissionDialog,
	type PermissionDialogResult,
} from "./permission-ipc.ts";

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
];

const TOGGLE_EDIT_MODE_SHORTCUT = "ctrl+shift+e";
const MODE_OPTIONS = ["guarded", "auto-edit", "cancel"] as const;
const MODIFY_PERMISSION_OPTIONS = [
	"Allow once",
	"Always allow this file (session)",
	"Deny",
] as const;

type BlockResult = { block: true; reason: string };
type PermissionMode = "guarded" | "auto-edit";
type ModifyToolName = "write" | "edit";

type ModifyPermissionChoice = (typeof MODIFY_PERMISSION_OPTIONS)[number];



export default function permissionGateExtension(pi: ExtensionAPI): void {
	const allowedModifyPaths = new Set<string>();
	const pendingFeedback = new Map<string, string>();
	const defaultMode = parsePermissionModeFromEnv(process.env.PI_PERM_MODE);
	const ipcDir = process.env[IPC_ENV_DIR] || "";
	const ipcAgent = process.env[IPC_ENV_AGENT] || "subagent";
	let mode: PermissionMode = defaultMode;
	process.env.PI_PERM_MODE = mode;

	pi.on("session_start", async function onSessionStart(_event, ctx) {
		updateModeUI(ctx, mode);
		updateModeWidget(ctx, mode);
	});

	pi.on("session_switch", async function onSessionSwitch(_event, ctx) {
		resetSessionState();
		updateModeUI(ctx, mode);
		updateModeWidget(ctx, mode);
	});

	pi.registerShortcut(TOGGLE_EDIT_MODE_SHORTCUT, {
		description: "Toggle permission-gate auto-edit mode",
		handler: async function onToggleShortcut(ctx) {
			setMode(toggleMode(mode), ctx);
		},
	});

	pi.registerCommand("perm-mode", {
		description: "Permission mode: /perm-mode [guarded|auto-edit|toggle|status]",
		handler: async function onPermModeCommand(args, ctx) {
			const arg = args.trim().toLowerCase();

			if (arg.length === 0 || arg === "status") {
				updateModeUI(ctx, mode);
				if (ctx.hasUI) {
					ctx.ui.notify(`permission-gate mode: ${mode}`, "info");
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

			if (!ctx.hasUI) {
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

	/** Queue a user feedback message to be appended to the tool result the LLM sees. */
	function queueFeedback(toolCallId: string, message: string): void {
		pendingFeedback.set(toolCallId, message);
	}

	/**
	 * Append queued user feedback to tool results so the LLM sees it in the current turn.
	 * tool_result fires after the tool executes and can modify the result content.
	 */
	pi.on("tool_result", async function onToolResult(event: ToolResultEvent) {
		const message = pendingFeedback.get(event.toolCallId);
		if (!message) {
			return undefined;
		}
		pendingFeedback.delete(event.toolCallId);

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
		process.env.PI_PERM_MODE = mode;
	}

	function setMode(nextMode: PermissionMode, ctx: ExtensionContext): void {
		mode = nextMode;
		// Keep process-wide mode in sync so other extensions (e.g. agent-team)
		// can react to runtime toggles from /perm-mode or Ctrl+Shift+E.
		process.env.PI_PERM_MODE = mode;
		updateModeUI(ctx, mode);
		updateModeWidget(ctx, mode);

		if (!ctx.hasUI) {
			return;
		}

		ctx.ui.notify(getModeNotification(mode), "info");
	}
}

async function handleBashToolCall(
	command: string,
	ctx: ExtensionContext,
	ipcDir: string,
	ipcAgent: string,
	onFeedback?: (message: string) => void,
): Promise<BlockResult | undefined> {
	const isDangerous = DANGEROUS_BASH_PATTERNS.some(function matchesPattern(pattern) {
		return pattern.test(command);
	});
	if (!isDangerous) {
		return undefined;
	}

	if (!ctx.hasUI) {
		if (ipcDir) {
			const req = createPermissionRequest(ipcAgent, "bash_dangerous", { command });
			const res = await sendPermissionRequest(ipcDir, req);
			if (res.approved) {
				if (res.message && onFeedback) {
					onFeedback(res.message);
				}
				return undefined;
			}
			const reason = res.message
				? `Dangerous command blocked by parent session. Feedback: ${res.message}`
				: "Dangerous command blocked by parent session";
			return { block: true, reason };
		}
		return {
			block: true,
			reason: "Dangerous command blocked (no UI for confirmation)",
		};
	}

	const result = await showPermissionDialog(ctx, `⚠️ Dangerous bash command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"] as const);
	if (result.choice !== "Yes") {
		const reason = result.message
			? `Blocked by user. Feedback: ${result.message}`
			: "Blocked by user";
		return { block: true, reason };
	}

	if (result.message && onFeedback) {
		onFeedback(result.message);
	}

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
	if (mode === "auto-edit" && (toolName === "edit" || toolName === "write")) {
		return undefined;
	}

	const targetPath = normalizePath(rawPath, ctx.cwd);
	if (!targetPath) {
		return {
			block: true,
			reason: `${toolName} blocked (missing path)`,
		};
	}

	if (allowedModifyPaths.has(targetPath)) {
		return undefined;
	}

	if (!ctx.hasUI) {
		if (ipcDir) {
			const req = createPermissionRequest(ipcAgent, toolName as "write" | "edit", {
				path: targetPath,
				content: changeDetails?.content,
				oldText: changeDetails?.oldText,
			});
			const res = await sendPermissionRequest(ipcDir, req);
			if (res.approved) {
				if (res.choice === "allow_always") {
					allowedModifyPaths.add(targetPath);
				}
				if (res.message && onFeedback) {
					onFeedback(res.message);
				}
				return undefined;
			}
			const reason = res.message
				? `${toolName} blocked by parent session. Feedback: ${res.message}`
				: `${toolName} blocked by parent session`;
			return { block: true, reason };
		}

		return {
			block: true,
			reason: `${toolName} blocked (no UI for confirmation)`,
		};
	}

	const result = await requestModifyPermission(ctx, toolName, targetPath);
	if (result.choice === "Allow once") {
		if (result.message && onFeedback) {
			onFeedback(result.message);
		}
		return undefined;
	}

	if (result.choice === "Always allow this file (session)") {
		allowedModifyPaths.add(targetPath);
		ctx.ui.notify(`permission-gate: auto-allow enabled for ${targetPath}`, "info");
		if (result.message && onFeedback) {
			onFeedback(result.message);
		}
		return undefined;
	}

	const reason = result.message
		? `Blocked by user. Feedback: ${result.message}`
		: "Blocked by user";
	return { block: true, reason };
}

async function requestModifyPermission(
	ctx: ExtensionContext,
	toolName: ModifyToolName,
	targetPath: string,
): Promise<PermissionDialogResult<ModifyPermissionChoice>> {
	const prompt = `🔐 ${toolName} permission request\n\nPath: ${targetPath}`;
	const result = await showPermissionDialog(ctx, prompt, [...MODIFY_PERMISSION_OPTIONS]);
	const choice = (result.choice as ModifyPermissionChoice | undefined) ?? "Deny";
	return { choice, message: result.message };
}

/**
 * Show a permission dialog with selectable options and an optional message input (Tab to toggle).
 * Returns the chosen option and an optional user-provided message.
 */
function updateModeUI(ctx: ExtensionContext, mode: PermissionMode): void {
	if (!ctx.hasUI) {
		return;
	}

	const modeLabel = getModeLabel(mode);
	const detail = getModeDetail(mode);
	ctx.ui.setStatus("perm-gate", `🔐 ${modeLabel} · ${detail} · ${TOGGLE_EDIT_MODE_SHORTCUT}`);
}

function updateModeWidget(ctx: ExtensionContext, mode: PermissionMode): void {
	if (!ctx.hasUI) {
		return;
	}

	// Avoid duplicate status surfaces in normal mode.
	// Only show the extra widget when agent-team is loaded (it overrides footer/status visibility).
	if (!isAgentTeamLoadedFromArgv()) {
		ctx.ui.setWidget("perm-gate-mode", undefined);
		return;
	}

	const modeLabel = getModeLabel(mode);
	ctx.ui.setWidget("perm-gate-mode", (_tui, theme) => {
		return new Text(
			theme.fg("accent", "🔐 Permission: ") +
			theme.fg("success", modeLabel) +
			theme.fg("dim", ` · ${TOGGLE_EDIT_MODE_SHORTCUT}`),
			0,
			0,
		);
	}, { placement: "belowEditor" });
}

function isAgentTeamLoadedFromArgv(): boolean {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] !== "-e" && argv[i] !== "--extension") {
			continue;
		}

		const source = (argv[i + 1] || "").toLowerCase();
		if (source.includes("agent-team.ts") || source.includes("agent-team")) {
			return true;
		}
	}

	return false;
}

function getModeLabel(mode: PermissionMode): string {
	return mode === "auto-edit" ? "AUTO-EDIT" : "GUARDED";
}

function getModeDetail(mode: PermissionMode): string {
	return mode === "auto-edit" ? "write/edit are pre-approved" : "write/edit require confirmation";
}

function getModeNotification(mode: PermissionMode): string {
	return mode === "auto-edit"
		? "permission-gate: AUTO-EDIT enabled (write/edit tool calls are pre-approved)"
		: "permission-gate: GUARDED mode enabled";
}

function toggleMode(mode: PermissionMode): PermissionMode {
	return mode === "guarded" ? "auto-edit" : "guarded";
}

function normalizePath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || rawPath.trim().length === 0) {
		return undefined;
	}

	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return path.resolve(cwd, withoutAt);
}

function parsePermissionModeFromEnv(raw: string | undefined): PermissionMode {
	return raw === "auto-edit" ? "auto-edit" : "guarded";
}
