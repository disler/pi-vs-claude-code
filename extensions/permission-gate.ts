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
 * - Ctrl+Shift+E toggles EDIT auto-approve mode for this session
 * - /perm-mode command to view/set mode
 * - Footer status shows current permission mode
 */

import path from "node:path";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

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
	let mode: PermissionMode = "guarded";

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
		description: "Toggle permission-gate edit auto-approve mode",
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
		if (isToolCallEventType("bash", event)) {
			return handleBashToolCall(event.input.command ?? "", ctx);
		}

		if (isToolCallEventType("write", event)) {
			return handleModifyToolCall("write", event.input.path, ctx, allowedModifyPaths, mode);
		}

		if (isToolCallEventType("edit", event)) {
			return handleModifyToolCall("edit", event.input.path, ctx, allowedModifyPaths, mode);
		}

		return undefined;
	});

	function resetSessionState(): void {
		allowedModifyPaths.clear();
		mode = "guarded";
	}

	function setMode(nextMode: PermissionMode, ctx: ExtensionContext): void {
		mode = nextMode;
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
): Promise<BlockResult | undefined> {
	const isDangerous = DANGEROUS_BASH_PATTERNS.some(function matchesPattern(pattern) {
		return pattern.test(command);
	});
	if (!isDangerous) {
		return undefined;
	}

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "Dangerous command blocked (no UI for confirmation)",
		};
	}

	const approved = await confirmYesNo(ctx, `⚠️ Dangerous bash command:\n\n  ${command}\n\nAllow?`);
	if (!approved) {
		return { block: true, reason: "Blocked by user" };
	}

	return undefined;
}

async function handleModifyToolCall(
	toolName: ModifyToolName,
	rawPath: string,
	ctx: ExtensionContext,
	allowedModifyPaths: Set<string>,
	mode: PermissionMode,
): Promise<BlockResult | undefined> {
	if (toolName === "edit" && mode === "auto-edit") {
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
		return {
			block: true,
			reason: `${toolName} blocked (no UI for confirmation)`,
		};
	}

	const choice = await requestModifyPermission(ctx, toolName, targetPath);
	if (choice === "Allow once") {
		return undefined;
	}

	if (choice === "Always allow this file (session)") {
		allowedModifyPaths.add(targetPath);
		ctx.ui.notify(`permission-gate: auto-allow enabled for ${targetPath}`, "info");
		return undefined;
	}

	return { block: true, reason: "Blocked by user" };
}

async function confirmYesNo(ctx: ExtensionContext, prompt: string): Promise<boolean> {
	const choice = await ctx.ui.select(prompt, ["Yes", "No"]);
	return choice === "Yes";
}

async function requestModifyPermission(
	ctx: ExtensionContext,
	toolName: ModifyToolName,
	targetPath: string,
): Promise<ModifyPermissionChoice> {
	const prompt = `🔐 ${toolName} permission request\n\nPath: ${targetPath}`;
	const choice = await ctx.ui.select(prompt, [...MODIFY_PERMISSION_OPTIONS]);
	return (choice as ModifyPermissionChoice | undefined) ?? "Deny";
}

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
	if (mode === "auto-edit") {
		return "AUTO-EDIT";
	}

	return "GUARDED";
}

function getModeDetail(mode: PermissionMode): string {
	if (mode === "auto-edit") {
		return "edit is pre-approved";
	}

	return "write/edit require confirmation";
}

function getModeNotification(mode: PermissionMode): string {
	if (mode === "auto-edit") {
		return "permission-gate: AUTO-EDIT enabled (edit tool calls are pre-approved)";
	}

	return "permission-gate: GUARDED mode enabled";
}

function toggleMode(mode: PermissionMode): PermissionMode {
	if (mode === "guarded") {
		return "auto-edit";
	}

	return "guarded";
}

function normalizePath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || rawPath.trim().length === 0) {
		return undefined;
	}

	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return path.resolve(cwd, withoutAt);
}
