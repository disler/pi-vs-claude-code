/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before:
 * - running potentially dangerous bash commands
 * - requiring confirmation for edit
 * - requiring confirmation for write
 *
 * Bash patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
];

export default function permissionGateExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async function onToolCall(event, ctx) {
		const toolName = event.toolName;

		if (toolName === "bash") {
			return handleBashToolCall(event.input as Record<string, unknown>, ctx);
		}

		if (toolName === "read") {
			return undefined;
		}

		if (toolName === "write") {
			return handleWriteToolCall(event.input as Record<string, unknown>, ctx);
		}

		if (toolName === "edit") {
			return handleEditToolCall(event.input as Record<string, unknown>, ctx);
		}

		return undefined;
	});
}

async function handleBashToolCall(
	input: Record<string, unknown>,
	ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
	const command = String(input.command ?? "");
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

	const approved = await requestApproval(
		ctx,
		`⚠️ Dangerous bash command:\n\n  ${command}\n\nAllow?`,
	);

	if (!approved) {
		return { block: true, reason: "Blocked by user" };
	}

	return undefined;
}

async function handleWriteToolCall(
	input: Record<string, unknown>,
	ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
	const targetPath = getTargetPath(input);
	if (!targetPath) {
		return {
			block: true,
			reason: "write blocked (missing path)",
		};
	}

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "write blocked (no UI for confirmation)",
		};
	}

	const summary = formatToolInput("write", input);
	const approved = await requestApproval(ctx, `🔐 Tool permission request\n\n${summary}\n\nAllow?`);
	if (!approved) {
		return { block: true, reason: "Blocked by user" };
	}

	return undefined;
}

async function handleEditToolCall(
	input: Record<string, unknown>,
	ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
	const targetPath = getTargetPath(input);
	if (!targetPath) {
		return {
			block: true,
			reason: "edit blocked (missing path)",
		};
	}

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "edit blocked (no UI for confirmation)",
		};
	}

	const summary = formatToolInput("edit", input);
	const approved = await requestApproval(ctx, `🔐 Tool permission request\n\n${summary}\n\nAllow?`);
	if (!approved) {
		return { block: true, reason: "Blocked by user" };
	}

	return undefined;
}

async function requestApproval(ctx: any, prompt: string): Promise<boolean> {
	const choice = await ctx.ui.select(prompt, ["Yes", "No"]);
	return choice === "Yes";
}

function getTargetPath(input: Record<string, unknown>): string | undefined {
	const raw = input.path;
	return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
			return `Tool: read\nPath: ${String(input.path ?? "(unknown)")}`;
		case "write":
			return `Tool: write\nPath: ${String(input.path ?? "(unknown)")}`;
		case "edit":
			return `Tool: edit\nPath: ${String(input.path ?? "(unknown)")}`;
		default:
			return `Tool: ${toolName}`;
	}
}
