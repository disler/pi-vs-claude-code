/**
 * Claude Code Bridge — expose Samuel's authenticated Claude Code CLI to Pi.
 *
 * Pi cannot consume a Claude Code subscription as a normal model provider, but
 * it can delegate bounded work to the local `claude` CLI. This tool keeps that
 * delegation explicit and auditable.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLAUDE_BIN = process.env.OPENCLAW_CLAUDE_BIN || "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_CLAUDE_BRIDGE_TIMEOUT_MS || 20 * 60 * 1000);
const MAX_OUTPUT_CHARS = Number(process.env.OPENCLAW_CLAUDE_BRIDGE_MAX_OUTPUT_CHARS || 20000);
const DEFAULT_PERMISSION_MODE = process.env.OPENCLAW_CLAUDE_BRIDGE_PERMISSION_MODE || "bypassPermissions";
const DEFAULT_MODEL = process.env.OPENCLAW_CLAUDE_BRIDGE_MODEL || "claude-opus-4-8";
const DEFAULT_EFFORT = process.env.OPENCLAW_CLAUDE_BRIDGE_EFFORT || "max";
const ALLOW_CALL_MODEL_OVERRIDE = process.env.OPENCLAW_CLAUDE_BRIDGE_ALLOW_CALL_MODEL_OVERRIDE === "1";
const EXTERNAL_CALL_LOG = process.env.OPENCLAW_PI_EXTERNAL_CALL_LOG
	|| path.join(process.cwd(), ".pi/openclaw-teams/logs/external-agent-calls.jsonl");

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function allowedRoots(): string[] {
	const raw = process.env.OPENCLAW_CLAUDE_BRIDGE_ALLOW_ROOTS
		|| `${os.homedir()}/Development:${os.homedir()}/.openclaw/workspace`;
	return raw
		.split(":")
		.map((root) => path.resolve(expandHome(root)))
		.filter(Boolean);
}

function assertAllowedCwd(cwd: string): string {
	const resolved = path.resolve(expandHome(cwd));
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
		throw new Error(`cwd is not a directory: ${resolved}`);
	}

	const ok = allowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
	if (!ok) {
		throw new Error(`cwd is outside allowed Claude bridge roots: ${resolved}`);
	}

	return resolved;
}

function truncate(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
	return {
		text: text.slice(0, MAX_OUTPUT_CHARS) + `\n\n... [truncated at ${MAX_OUTPUT_CHARS} chars]`,
		truncated: true,
	};
}

function compact(text: string, maxChars: number): string {
	return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function classifyClaudeCall(prompt: string, agent?: string): string[] {
	const source = `${agent || ""} ${prompt}`.toLowerCase();
	const categories = new Set<string>(["claude_code", "external_agent"]);
	if (source.includes("/pre-pr") || source.includes("pre-pr")) categories.add("pre_pr");
	if (source.includes("/no-mistakes") || source.includes("no-mistakes")) categories.add("no_mistakes");
	if (source.includes("review") || source.includes("reviewer")) categories.add("review");
	if (source.includes("security") || source.includes("secret")) categories.add("security");
	if (source.includes("plan") || source.includes("architecture")) categories.add("planning");
	if (source.includes("test") || source.includes("verification")) categories.add("verification");
	if (source.includes("pr comment") || source.includes("review-auto-resolve")) categories.add("pr_comments");
	return [...categories].sort();
}

function appendExternalCallLog(entry: Record<string, unknown>) {
	try {
		fs.mkdirSync(path.dirname(EXTERNAL_CALL_LOG), { recursive: true });
		fs.appendFileSync(EXTERNAL_CALL_LOG, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// Logging must not break the Claude bridge itself.
	}
}

function runClaude(args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{
	exitCode: number | null;
	elapsedMs: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const proc = spawn(CLAUDE_BIN, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
		}, timeoutMs);

		const onAbort = () => {
			timedOut = true;
			proc.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		proc.on("close", (exitCode) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode,
				elapsedMs: Date.now() - started,
				stdout,
				stderr,
				timedOut,
			});
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "claude_code_run",
		label: "Claude Code",
		description: `Delegate a bounded task to the local Claude Code CLI using Samuel's existing Claude Code auth, commands, agents, skills, settings, and hooks.

Use this when you specifically need Claude-native setup, such as /pre-pr, /create-pr, /review-auto-resolve, security swarm, Claude agents, or cross-checking a failed Pi result. Prefer Pi/OpenAI for ordinary work. Always pass the target repo/work folder as cwd.`,
		parameters: Type.Object({
			prompt: Type.String({
				description: "Prompt or Claude slash-command text to run, for example `/pre-pr` or `Review this diff and return findings only.`",
			}),
			cwd: Type.Optional(Type.String({
				description: "Repo/work folder to run Claude in. Must be under /Users/samuelimini/Development or ~/.openclaw/workspace. Defaults to current Pi cwd.",
			})),
			model: Type.Optional(Type.String({
				description: "Compatibility field. Ignored by default because Samuel's rule enforces claude-opus-4-8; set OPENCLAW_CLAUDE_BRIDGE_ALLOW_CALL_MODEL_OVERRIDE=1 only when Samuel explicitly asks.",
			})),
			effort: Type.Optional(Type.String({
				description: "Compatibility field. Ignored by default because Samuel's rule enforces max effort; set OPENCLAW_CLAUDE_BRIDGE_ALLOW_CALL_MODEL_OVERRIDE=1 only when Samuel explicitly asks.",
			})),
			agent: Type.Optional(Type.String({
				description: "Optional Claude Code agent name, for example code-reviewer or tenant-checker.",
			})),
			permissionMode: Type.Optional(Type.String({
				description: "Optional Claude Code permission mode. Defaults to bypassPermissions per Samuel's approval; override only for a stricter run.",
			})),
			timeoutMs: Type.Optional(Type.Number({
				description: "Timeout in milliseconds. Default 20 minutes.",
			})),
		}),

		async execute(callId, params, signal, onUpdate, ctx) {
			const p = params as {
				prompt: string;
				cwd?: string;
				model?: string;
				effort?: string;
				agent?: string;
				permissionMode?: string;
				timeoutMs?: number;
			};

			try {
				if (!p.prompt || !p.prompt.trim()) {
					return {
						content: [{ type: "text", text: "claude_code_run requires a prompt." }],
						details: { status: "error", exitCode: 2 },
					};
				}

				const cwd = assertAllowedCwd(p.cwd || ctx.cwd || process.cwd());
				const model = ALLOW_CALL_MODEL_OVERRIDE && p.model ? p.model : DEFAULT_MODEL;
				const effort = ALLOW_CALL_MODEL_OVERRIDE && p.effort ? p.effort : DEFAULT_EFFORT;
				const permissionMode = p.permissionMode || DEFAULT_PERMISSION_MODE;

				const args = [
					"--print",
					"--output-format", "text",
					"--model", model,
					"--effort", effort,
					"--permission-mode", permissionMode,
					"--append-system-prompt",
					"You are being invoked by Pi through OpenClaw's Claude Code bridge. Use Samuel's existing Claude Code setup. Keep output concise, evidence-based, and suitable for a Pi agent to act on. Do not ask the user for confirmation unless blocked by missing product/repo/branch/safety information.",
				];
				if (p.agent) args.push("--agent", p.agent);
				args.push(p.prompt);

				onUpdate?.({
					content: [{ type: "text", text: `Starting Claude Code in ${cwd}` }],
					details: { status: "running", cwd, model, effort, agent: p.agent || null, permissionMode },
				});

				const result = await runClaude(args, cwd, p.timeoutMs || DEFAULT_TIMEOUT_MS, signal);
				const combined = [
					result.stdout.trim(),
					result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim()}` : "",
				].filter(Boolean).join("\n");
				const clipped = truncate(combined || "(Claude Code produced no output.)");
				const status = result.exitCode === 0 && !result.timedOut ? "done" : "error";

				appendExternalCallLog({
					kind: "external_agent_call",
					tool: "claude_code_run",
					callId,
					timestamp: new Date().toISOString(),
					categories: classifyClaudeCall(p.prompt, p.agent),
					cwd,
					model,
					effort,
					agent: p.agent || null,
					permissionMode,
					status,
					exitCode: result.exitCode,
					elapsedMs: result.elapsedMs,
					timedOut: result.timedOut,
					truncated: clipped.truncated,
					promptHash: sha256(p.prompt),
					outputHash: sha256(combined),
					promptPreview: compact(p.prompt, 300),
					outputPreview: compact(combined, 1000),
				});

				return {
					content: [{
						type: "text",
						text: `claude_code_run ${status} in ${Math.round(result.elapsedMs / 1000)}s (exit ${result.exitCode ?? "null"})\n\n${clipped.text}`,
					}],
					details: {
						status,
						cwd,
						exitCode: result.exitCode,
						elapsedMs: result.elapsedMs,
						timedOut: result.timedOut,
						truncated: clipped.truncated,
						fullOutput: combined,
					},
				};
			} catch (err: any) {
				appendExternalCallLog({
					kind: "external_agent_call",
					tool: "claude_code_run",
					callId,
					timestamp: new Date().toISOString(),
					status: "error",
					exitCode: 1,
					error: err?.message || String(err),
					model: ALLOW_CALL_MODEL_OVERRIDE && p?.model ? p.model : DEFAULT_MODEL,
					effort: ALLOW_CALL_MODEL_OVERRIDE && p?.effort ? p.effort : DEFAULT_EFFORT,
					promptHash: p?.prompt ? sha256(p.prompt) : null,
					promptPreview: p?.prompt ? compact(p.prompt, 300) : "",
					categories: p?.prompt ? classifyClaudeCall(p.prompt, p.agent) : ["claude_code", "external_agent"],
				});
				return {
					content: [{ type: "text", text: `claude_code_run error: ${err?.message || String(err)}` }],
					details: { status: "error", exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const cwd = (args as any).cwd || "current cwd";
			const prompt = String((args as any).prompt || "");
			const preview = prompt.length > 70 ? prompt.slice(0, 67) + "..." : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("claude_code_run ")) +
				theme.fg("accent", cwd) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0,
				0,
			);
		},
	});
}
