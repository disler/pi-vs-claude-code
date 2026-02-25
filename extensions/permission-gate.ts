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

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
];

const TOGGLE_EDIT_MODE_SHORTCUT = "ctrl+shift+e";

type BlockResult = { block: true; reason: string };
type PermissionMode = "guarded" | "auto-edit";

type ModifyPermissionChoice =
	| "Allow once"
	| "Always allow this file (session)"
	| "Deny";

export default function permissionGateExtension(pi: ExtensionAPI): void {
	const allowedModifyPaths = new Set<string>();
	let mode: PermissionMode = "guarded";

	const resetSessionState = () => {
		allowedModifyPaths.clear();
		mode = "guarded";
	};

	const updateModeUI = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const modeLabel = mode === "auto-edit" ? "AUTO-EDIT" : "GUARDED";
		const detail =
			mode === "auto-edit"
				? "edit is pre-approved"
				: "write/edit require confirmation";
		ctx.ui.setStatus("perm-gate", `🔐 ${modeLabel} · ${detail} · ${TOGGLE_EDIT_MODE_SHORTCUT}`);
	};

	const setMode = (next: PermissionMode, ctx: ExtensionContext) => {
		mode = next;
		updateModeUI(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				mode === "auto-edit"
					? "permission-gate: AUTO-EDIT enabled (edit tool calls are pre-approved)"
					: "permission-gate: GUARDED mode enabled",
				"info",
			);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		updateModeUI(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetSessionState();
		updateModeUI(ctx);
	});

	pi.registerShortcut(TOGGLE_EDIT_MODE_SHORTCUT, {
		description: "Toggle permission-gate edit auto-approve mode",
		handler: async (ctx) => {
			setMode(mode === "guarded" ? "auto-edit" : "guarded", ctx);
		},
	});

	pi.registerCommand("perm-mode", {
		description: "Permission mode: /perm-mode [guarded|auto-edit|toggle|status]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (!arg || arg === "status") {
				updateModeUI(ctx);
				if (ctx.hasUI) ctx.ui.notify(`permission-gate mode: ${mode}`, "info");
				return;
			}

			if (arg === "toggle") {
				setMode(mode === "guarded" ? "auto-edit" : "guarded", ctx);
				return;
			}

			if (arg === "guarded" || arg === "auto-edit") {
				setMode(arg, ctx);
				return;
			}

			if (ctx.hasUI) {
				const pick = await ctx.ui.select("Set permission mode", ["guarded", "auto-edit", "cancel"]);
				if (pick === "guarded" || pick === "auto-edit") setMode(pick, ctx);
			}
		},
	});

	pi.registerCommand("perm-clear", {
		description: "Clear write/edit file approvals saved by permission-gate",
		handler: async (_args, ctx) => {
			allowedModifyPaths.clear();
			if (ctx.hasUI) {
				ctx.ui.notify("permission-gate: cleared saved file approvals", "info");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
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
}

async function handleBashToolCall(
	command: string,
	ctx: ExtensionContext,
): Promise<BlockResult | undefined> {
	const isDangerous = DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
	if (!isDangerous) return undefined;

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "Dangerous command blocked (no UI for confirmation)",
		};
	}

	const approved = await confirmYesNo(ctx, `⚠️ Dangerous bash command:\n\n  ${command}\n\nAllow?`);
	if (!approved) return { block: true, reason: "Blocked by user" };

	return undefined;
}

async function handleModifyToolCall(
	toolName: "write" | "edit",
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
	if (choice === "Allow once") return undefined;
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
	toolName: "write" | "edit",
	targetPath: string,
): Promise<ModifyPermissionChoice> {
	const prompt = `🔐 ${toolName} permission request\n\nPath: ${targetPath}`;
	const options: ModifyPermissionChoice[] = [
		"Allow once",
		"Always allow this file (session)",
		"Deny",
	];

	const choice = await ctx.ui.select(prompt, options);
	return (choice as ModifyPermissionChoice | undefined) ?? "Deny";
}

function normalizePath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || rawPath.trim().length === 0) return undefined;
	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return path.resolve(cwd, withoutAt);
}
