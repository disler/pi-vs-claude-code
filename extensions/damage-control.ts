import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { applyExtensionDefaults } from "./themeMap.ts";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
}

export default function (pi: ExtensionAPI) {
	let rules: Rules = {
		bashToolPatterns: [],
		zeroAccessPaths: [],
		readOnlyPaths: [],
		noDeletePaths: [],
	};

	function resolvePath(p: string, cwd: string): string {
		if (p.startsWith("~")) {
			p = path.join(os.homedir(), p.slice(1));
		}
		return path.resolve(cwd, p);
	}

	function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
		// Simple glob-to-regex or substring match
		// Expand tilde in pattern if present
		const resolvedPattern = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : pattern;

		// If pattern ends with /, it's a directory match
		if (resolvedPattern.endsWith("/")) {
			const absolutePattern = path.isAbsolute(resolvedPattern) ? resolvedPattern : path.resolve(cwd, resolvedPattern);
			return targetPath.startsWith(absolutePattern);
		}

		// Handle basic wildcards *
		const regexPattern = resolvedPattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
			.replace(/\*/g, ".*"); // convert * to .*

		const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);

		// Match against absolute path and relative-to-cwd path
		const relativePath = path.relative(cwd, targetPath);

		return regex.test(targetPath) || regex.test(relativePath) || targetPath.includes(resolvedPattern) || relativePath.includes(resolvedPattern);
	}

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		const rulesPath = path.join(ctx.cwd, ".pi", "damage-control-rules.yaml");
		try {
			if (fs.existsSync(rulesPath)) {
				const content = fs.readFileSync(rulesPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
				const loaded = yamlParse(content) as Partial<Rules>;
				rules = {
					bashToolPatterns: loaded.bashToolPatterns || [],
					zeroAccessPaths: loaded.zeroAccessPaths || [],
					readOnlyPaths: loaded.readOnlyPaths || [],
					noDeletePaths: loaded.noDeletePaths || [],
				};
				ctx.ui.notify(`🛡️ Damage-Control: Loaded ${rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length} rules.`);
			} else {
				ctx.ui.notify("🛡️ Damage-Control: No rules found at .pi/damage-control-rules.yaml");
			}
		} catch (err) {
			ctx.ui.notify(`🛡️ Damage-Control: Failed to load rules: ${err instanceof Error ? err.message : String(err)}`);
		}

		ctx.ui.setStatus(`🛡️ Damage-Control Active: ${rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length} Rules`);
	});

	pi.on("tool_call", async (event, ctx) => {
		let violationReason: string | null = null;
		let shouldAsk = false;

		// 1. Check Zero Access Paths for all tools that use path or glob
		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						return `Access to zero-access path restricted: ${zap}`;
					}
				}
			}
			return null;
		};

		// Extract paths from tool input
		const inputPaths: string[] = [];
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			inputPaths.push(event.input.path);
		} else if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("grep", event) && event.input.glob) {
			// Check glob field as well
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.glob.includes(zap) || isPathMatch(event.input.glob, zap, ctx.cwd)) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					break;
				}
			}
		}

		if (!violationReason) {
			violationReason = checkPaths(inputPaths);
		}

		// 2. Tool-specific logic
		if (!violationReason) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;

				// Check bashToolPatterns
				for (const rule of rules.bashToolPatterns) {
					const regex = new RegExp(rule.pattern);
					if (regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						break;
					}
				}

				// Check if bash command interacts with restricted paths
				if (!violationReason) {
					for (const zap of rules.zeroAccessPaths) {
						if (command.includes(zap)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const rop of rules.readOnlyPaths) {
						// Heuristic: check if command might modify a read-only path
						// Redirects, sed -i, rm, mv to, etc.
						if (command.includes(rop) && (/[\s>|]/.test(command) || command.includes("rm") || command.includes("mv") || command.includes("sed"))) {
							violationReason = `Bash command may modify read-only path: ${rop}`;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const ndp of rules.noDeletePaths) {
						if (command.includes(ndp) && (command.includes("rm") || command.includes("mv"))) {
							violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
							break;
						}
					}
				}
			} else if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				// Check Read-Only paths
				for (const p of inputPaths) {
					const resolved = resolvePath(p, ctx.cwd);
					for (const rop of rules.readOnlyPaths) {
						if (isPathMatch(resolved, rop, ctx.cwd)) {
							violationReason = `Modification of read-only path restricted: ${rop}`;
							break;
						}
					}
				}
			}
		}

		if (violationReason) {
			if (shouldAsk) {
				const confirmed = await ctx.ui.confirm("🛡️ Damage-Control Confirmation", `Dangerous command detected: ${violationReason}\n\nCommand: ${isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input)}\n\nDo you want to proceed?`, { timeout: 30000 });

				if (!confirmed) {
					ctx.ui.setStatus(`⚠️ Last Violation Blocked: ${violationReason.slice(0, 30)}...`);
					pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked_by_user" });
					ctx.abort();
					return { block: true, reason: `🛑 BLOCKED by Damage-Control: ${violationReason} (User denied)\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.` };
				} else {
					pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "confirmed_by_user" });
					return { block: false };
				}
			} else {
				ctx.ui.notify(`🛑 Damage-Control: Blocked ${event.toolName} due to ${violationReason}`);
				ctx.ui.setStatus(`⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked" });
				ctx.abort();
				return { block: true, reason: `🛑 BLOCKED by Damage-Control: ${violationReason}\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.` };
			}
		}

		return { block: false };
	});
}
