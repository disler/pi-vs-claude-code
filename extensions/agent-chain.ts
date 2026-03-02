/**
 * Agent Chain — Sequential pipeline orchestrator
 *
 * Runs opinionated, repeatable agent workflows. Chains are defined in
 * .pi/agents/agent-chain.yaml — each chain is a sequence of agent steps
 * with prompt templates. The user's original prompt flows into step 1,
 * the output becomes $INPUT for step 2's prompt template, and so on.
 * $ORIGINAL is always the user's original prompt.
 *
 * The primary Pi agent has NO codebase tools — it can ONLY kick off the
 * pipeline via the `run_chain` tool. On boot you select a chain; the
 * agent decides when to run it based on the user's prompt.
 *
 * Agents maintain session context within a Pi session — re-running the
 * chain lets each agent resume where it left off.
 *
 * Commands:
 *   /chain             — switch active chain
 *   /chain-list        — list all available chains
 *
 * Usage: pi -e extensions/agent-chain.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
	cleanupIpcDir,
	IPC_ENV_AGENT,
	IPC_ENV_DIR,
	showPermissionDialog,
	startIpcWatcher,
	type IpcPermissionRequest,
	type IpcPermissionResponse,
} from "./permission-ipc.ts";

// ── Types ────────────────────────────────────────

interface ChainStep {
	agent: string;
	prompt: string;
}

interface ChainDef {
	name: string;
	description: string;
	steps: ChainStep[];
}

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

interface StepState {
	agent: string;
	status: "pending" | "running" | "done" | "error";
	elapsed: number;
	lastWork: string;
	/** Rolling buffer of recent output lines for expanded card view */
	recentLines: string[];
}

const CARD_OUTPUT_LINES = 7;

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Strip matching single or double quotes from a string. */
function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

// ── Chain YAML Parser ────────────────────────────

function parseChainYaml(raw: string): ChainDef[] {
	const chains: ChainDef[] = [];
	let current: ChainDef | null = null;
	let currentStep: ChainStep | null = null;

	for (const line of raw.split("\n")) {
		// Chain name: top-level key
		const chainMatch = line.match(/^(\S[^:]*):$/);
		if (chainMatch) {
			if (current && currentStep) {
				current.steps.push(currentStep);
				currentStep = null;
			}
			current = { name: chainMatch[1].trim(), description: "", steps: [] };
			chains.push(current);
			continue;
		}

		// Chain description
		const descMatch = line.match(/^\s+description:\s+(.+)$/);
		if (descMatch && current && !currentStep) {
			current.description = stripQuotes(descMatch[1].trim());
			continue;
		}

		// "steps:" label — skip
		if (line.match(/^\s+steps:\s*$/) && current) {
			continue;
		}

		// Step agent line
		const agentMatch = line.match(/^\s+-\s+agent:\s+(.+)$/);
		if (agentMatch && current) {
			if (currentStep) {
				current.steps.push(currentStep);
			}
			currentStep = { agent: agentMatch[1].trim(), prompt: "" };
			continue;
		}

		// Step prompt line
		const promptMatch = line.match(/^\s+prompt:\s+(.+)$/);
		if (promptMatch && currentStep) {
			currentStep.prompt = stripQuotes(promptMatch[1].trim()).replace(/\\n/g, "\n");
			continue;
		}
	}

	if (current && currentStep) {
		current.steps.push(currentStep);
	}

	return chains;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): Map<string, AgentDef> {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents = new Map<string, AgentDef>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !agents.has(def.name.toLowerCase())) {
					agents.set(def.name.toLowerCase(), def);
				}
			}
		} catch {}
	}

	return agents;
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let allAgents: Map<string, AgentDef> = new Map();
	let chains: ChainDef[] = [];
	let activeChain: ChainDef | null = null;
	let widgetCtx: any;
	let sessionDir = "";
	let ipcDir = "";
	let activeIpcWatcher: (() => void) | null = null;
	let ipcWatcherRefCount = 0;
	const agentSessions: Map<string, string | null> = new Map();

	// Per-step state for the active chain
	let stepStates: StepState[] = [];
	let pendingReset = false;

	function makeStepStates(steps: ChainStep[]): StepState[] {
		return steps.map(s => ({
			agent: s.agent,
			status: "pending" as const,
			elapsed: 0,
			lastWork: "",
			recentLines: [],
		}));
	}

	// ── IPC Watcher (parent side) ───────────────

	function makeIpcResponse(
		id: string,
		approved: boolean,
		choice: string,
		message?: string,
	): IpcPermissionResponse {
		return { id, approved, choice, message, timestamp: Date.now() };
	}

	function acquireIpcWatcher(ctx: any): void {
		ipcWatcherRefCount++;
		if (activeIpcWatcher || !ctx.hasUI || !ipcDir) return;

		activeIpcWatcher = startIpcWatcher(ipcDir, async (req: IpcPermissionRequest): Promise<IpcPermissionResponse> => {
			const agentLabel = displayName(req.agent);

			if (req.type === "bash_dangerous") {
				const result = await showPermissionDialog(
					ctx,
					`⚠️ ${agentLabel}: Dangerous command\n\nCommand: ${req.command}\n\nAllow?`,
					["Yes", "No"] as const,
				);
				const approved = result.choice === "Yes";
				return makeIpcResponse(req.id, approved, approved ? "allow_once" : "deny", result.message);
			}

			// write or edit
			let detail = `File: ${req.path || "unknown"}\n`;
			if (req.type === "edit" && req.oldText) {
				detail += `\n── Replacing ──\n${req.oldText}\n\n── With ──\n${req.content || "(empty)"}`;
			} else if (req.content) {
				detail += `\n── Content ──\n${req.content}`;
			}

			const result = await showPermissionDialog(
				ctx,
				`🔐 ${agentLabel}: ${req.type} — ${req.path || "unknown"}\n\n${detail}`,
				["Allow once", "Always allow this file", "Deny"] as const,
			);

			const choiceMap: Record<string, { approved: boolean; choice: string }> = {
				"Allow once": { approved: true, choice: "allow_once" },
				"Always allow this file": { approved: true, choice: "allow_always" },
			};
			const mapped = choiceMap[result.choice] || { approved: false, choice: "deny" };
			return makeIpcResponse(req.id, mapped.approved, mapped.choice, result.message);
		});
	}

	function releaseIpcWatcher(): void {
		ipcWatcherRefCount--;
		if (ipcWatcherRefCount <= 0) {
			ipcWatcherRefCount = 0;
			if (activeIpcWatcher) {
				activeIpcWatcher();
				activeIpcWatcher = null;
			}
		}
	}

	function loadChains(cwd: string) {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		ipcDir = join(cwd, ".pi", "agent-ipc");
		for (const dir of [sessionDir, ipcDir]) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}

		allAgents = scanAgentDirs(cwd);

		agentSessions.clear();
		for (const [key] of allAgents) {
			const sessionFile = join(sessionDir, `chain-${key}.json`);
			agentSessions.set(key, existsSync(sessionFile) ? sessionFile : null);
		}

		const chainPath = join(cwd, ".pi", "agents", "agent-chain.yaml");
		try {
			chains = existsSync(chainPath)
				? parseChainYaml(readFileSync(chainPath, "utf-8"))
				: [];
		} catch {
			chains = [];
		}
	}

	function activateChain(chain: ChainDef) {
		activeChain = chain;
		stepStates = makeStepStates(chain.steps);
		// Skip widget re-registration if reset is pending — let before_agent_start handle it
		if (!pendingReset) {
			updateWidget();
		}
	}

	// ── Card Rendering ──────────────────────────

	function renderCard(state: StepState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		let statusColor: string;
		let statusIcon: string;
		switch (state.status) {
			case "pending":  statusColor = "dim";     statusIcon = "○"; break;
			case "running":  statusColor = "accent";  statusIcon = "●"; break;
			case "done":     statusColor = "success"; statusIcon = "✓"; break;
			case "error":    statusColor = "error";   statusIcon = "✗"; break;
		}

		const name = displayName(state.agent);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "pending" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const sep = "├" + "─".repeat(w) + "┤";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		const lines: string[] = [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			theme.fg("dim", sep),
		];

		const recent = state.recentLines.slice(-CARD_OUTPUT_LINES);
		for (let i = 0; i < CARD_OUTPUT_LINES; i++) {
			if (i < recent.length) {
				const lineText = truncate(recent[i], w - 1);
				lines.push(border(" " + theme.fg("muted", lineText), 1 + lineText.length));
			} else if (i === 0 && recent.length === 0) {
				lines.push(border(" " + theme.fg("dim", "—"), 2));
			} else {
				lines.push(border("", 0));
			}
		}

		lines.push(theme.fg("dim", bot));
		return lines;
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-chain", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (!activeChain || stepStates.length === 0) {
						text.setText(theme.fg("dim", "No chain active. Use /chain to select one."));
						return text.render(width);
					}

					const arrowWidth = 5; // " ──▶ "
					const cols = stepStates.length;
					const totalArrowWidth = arrowWidth * (cols - 1);
					const colWidth = Math.max(12, Math.floor((width - totalArrowWidth) / cols));
					const arrowRow = 5; // middle of expanded card (0-indexed)

					const cards = stepStates.map(s => renderCard(s, colWidth, theme));
					const cardHeight = cards[0].length;
					const outputLines: string[] = [];

					for (let line = 0; line < cardHeight; line++) {
						let row = cards[0][line];
						for (let c = 1; c < cols; c++) {
							if (line === arrowRow) {
								row += theme.fg("dim", " ──▶ ");
							} else {
								row += " ".repeat(arrowWidth);
							}
							row += cards[c][line];
						}
						outputLines.push(row);
					}

					text.setText(outputLines.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	/** Try to extract a text_delta from a JSON-mode event line. Returns the delta string or null. */
	function extractTextDelta(json: string): string | null {
		try {
			const event = JSON.parse(json);
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") return delta.delta || "";
			}
		} catch {}
		return null;
	}

	/** Update step state from accumulated text chunks. */
	function updateStepFromChunks(state: StepState, textChunks: string[]): void {
		const full = textChunks.join("");
		const allLines = full.split("\n").filter((l: string) => l.trim());
		state.recentLines = allLines.slice(-CARD_OUTPUT_LINES);
		state.lastWork = allLines[allLines.length - 1] || "";
	}

	// ── Run Agent (subprocess) ──────────────────

	function runAgent(
		agentDef: AgentDef,
		task: string,
		stepIndex: number,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `chain-${agentKey}.json`);
		const hasSession = agentSessions.get(agentKey);

		// Resolve permission-gate extension for subagent
		const projectPermissionGateExt = resolve(ctx.cwd, "extensions", "permission-gate.ts");
		const bundledPermissionGateExt = resolve(dirname(fileURLToPath(import.meta.url)), "permission-gate.ts");
		const permissionGateExt = existsSync(projectPermissionGateExt)
			? projectPermissionGateExt
			: bundledPermissionGateExt;

		if (!existsSync(permissionGateExt)) {
			return Promise.resolve({
				output: `Error: permission-gate.ts not found for subagent. Checked: ${projectPermissionGateExt} and ${bundledPermissionGateExt}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		const subagentPermMode = process.env.PI_PERM_MODE || "guarded";

		const subagentEnv: Record<string, string> = {
			...process.env as Record<string, string>,
			PI_PERM_MODE: subagentPermMode,
			[IPC_ENV_DIR]: ipcDir,
			[IPC_ENV_AGENT]: agentDef.name,
		};

		const args = [
			"--mode", "json",
			"-p",
			"-e", permissionGateExt,
			"--model", model,
			"--tools", agentDef.tools,
			"--thinking", "off",
			"--append-system-prompt", agentDef.systemPrompt,
			"--session", agentSessionFile,
		];

		if (hasSession) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		const startTime = Date.now();
		const state = stepStates[stepIndex];

		acquireIpcWatcher(ctx);

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: subagentEnv,
			});

			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidget();
			}, 1000);

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const delta = extractTextDelta(line);
					if (delta !== null) {
						textChunks.push(delta);
						updateStepFromChunks(state, textChunks);
						updateWidget();
					}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				// Process any remaining buffered data
				if (buffer.trim()) {
					const delta = extractTextDelta(buffer);
					if (delta !== null) textChunks.push(delta);
				}

				clearInterval(timer);
				const elapsed = Date.now() - startTime;
				state.elapsed = elapsed;
				const output = textChunks.join("");
				updateStepFromChunks(state, textChunks);

				if (code === 0) {
					agentSessions.set(agentKey, agentSessionFile);
				}

				releaseIpcWatcher();
				resolve({ output, exitCode: code ?? 1, elapsed });
			});

			proc.on("error", (err) => {
				clearInterval(timer);
				releaseIpcWatcher();
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── Run Chain (sequential pipeline) ─────────

	async function runChain(
		task: string,
		ctx: any,
	): Promise<{ output: string; success: boolean; elapsed: number }> {
		if (!activeChain) {
			return { output: "No chain active", success: false, elapsed: 0 };
		}

		const chainStart = Date.now();

		stepStates = makeStepStates(activeChain.steps);
		updateWidget();

		let input = task;
		const originalPrompt = task;

		for (let i = 0; i < activeChain.steps.length; i++) {
			const step = activeChain.steps[i];
			stepStates[i].status = "running";
			updateWidget();

			const resolvedPrompt = step.prompt
				.replace(/\$INPUT/g, input)
				.replace(/\$ORIGINAL/g, originalPrompt);

			const agentDef = allAgents.get(step.agent.toLowerCase());
			if (!agentDef) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = `Agent "${step.agent}" not found`;
				updateWidget();
				return {
					output: `Error at step ${i + 1}: Agent "${step.agent}" not found. Available: ${Array.from(allAgents.keys()).join(", ")}`,
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			const result = await runAgent(agentDef, resolvedPrompt, i, ctx);

			if (result.exitCode !== 0) {
				stepStates[i].status = "error";
				updateWidget();
				return {
					output: `Error at step ${i + 1} (${step.agent}): ${result.output}`,
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			stepStates[i].status = "done";
			updateWidget();

			input = result.output;
		}

		return { output: input, success: true, elapsed: Date.now() - chainStart };
	}

	// ── run_chain Tool ──────────────────────────

	pi.registerTool({
		name: "run_chain",
		label: "Run Chain",
		description: "Execute the active agent chain pipeline. Each step runs sequentially — output from one step feeds into the next. Agents maintain session context across runs.",
		parameters: Type.Object({
			task: Type.String({ description: "The task/prompt for the chain to process" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { task } = params as { task: string };

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting chain: ${activeChain?.name}...` }],
					details: { chain: activeChain?.name, task, status: "running" },
				});
			}

			const result = await runChain(task, ctx);

			const truncated = result.output.length > 8000
				? result.output.slice(0, 8000) + "\n\n... [truncated]"
				: result.output;

			const status = result.success ? "done" : "error";
			const summary = `[chain:${activeChain?.name}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

			return {
				content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
				details: {
					chain: activeChain?.name,
					task,
					status,
					elapsed: result.elapsed,
					fullOutput: result.output,
				},
			};
		},

		renderCall(args, theme) {
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("run_chain ")) +
				theme.fg("accent", activeChain?.name || "?") +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "running") {
				return new Text(
					theme.fg("accent", `● ${details.chain || "chain"}`) +
					theme.fg("dim", " running..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.chain}`) +
				theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("chain", {
		description: "Switch active chain",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const options = chains.map(c => {
				const steps = c.steps.map(s => displayName(s.agent)).join(" → ");
				const desc = c.description ? ` — ${c.description}` : "";
				return `${c.name}${desc} (${steps})`;
			});

			const choice = await ctx.ui.select("Select Chain", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			activateChain(chains[idx]);
			const flow = chains[idx].steps.map(s => displayName(s.agent)).join(" → ");
			ctx.ui.setStatus("agent-chain", `Chain: ${chains[idx].name} (${chains[idx].steps.length} steps)`);
			ctx.ui.notify(
				`Chain: ${chains[idx].name}\n${chains[idx].description}\n${flow}`,
				"info",
			);
		},
	});

	pi.registerCommand("chain-list", {
		description: "List all available chains",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const list = chains.map(c => {
				const desc = c.description ? `  ${c.description}` : "";
				const steps = c.steps.map((s, i) =>
					`  ${i + 1}. ${displayName(s.agent)}`
				).join("\n");
				return `${c.name}:${desc ? "\n" + desc : ""}\n${steps}`;
			}).join("\n\n");

			ctx.ui.notify(list, "info");
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		// Force widget reset on first turn after /new
		if (pendingReset && activeChain) {
			pendingReset = false;
			widgetCtx = ctx;
			stepStates = makeStepStates(activeChain.steps);
			updateWidget();
		}

		if (!activeChain) return {};

		const flow = activeChain.steps.map(s => displayName(s.agent)).join(" → ");
		const desc = activeChain.description ? `\n${activeChain.description}` : "";

		// Build pipeline steps summary
		const steps = activeChain.steps.map((s, i) => {
			const agentDef = allAgents.get(s.agent.toLowerCase());
			const agentDesc = agentDef?.description || "";
			return `${i + 1}. **${displayName(s.agent)}** — ${agentDesc}`;
		}).join("\n");

		// Build full agent catalog (like agent-team.ts)
		const seen = new Set<string>();
		const agentCatalog = activeChain.steps
			.filter(s => {
				const key = s.agent.toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map(s => {
				const agentDef = allAgents.get(s.agent.toLowerCase());
				if (!agentDef) return `### ${displayName(s.agent)}\nAgent not found.`;
				return `### ${displayName(agentDef.name)}\n${agentDef.description}\n**Tools:** ${agentDef.tools}\n**Role:** ${agentDef.systemPrompt}`;
			})
			.join("\n\n");

		return {
			systemPrompt: `You are an agent with a sequential pipeline called "${activeChain.name}" at your disposal.${desc}
You have full access to your own tools AND the run_chain tool to delegate to your team.

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agent Details

${agentCatalog}

## When to Use run_chain
- Significant work: new features, refactors, multi-file changes, anything non-trivial
- Tasks that benefit from the full pipeline: planning, building, reviewing
- When you want structured, multi-agent collaboration on a problem

## When to Work Directly
- Simple one-off commands: reading a file, checking status, listing contents
- Quick lookups, small edits, answering questions about the codebase
- Anything you can handle in a single step without needing the pipeline

## How run_chain Works
- Pass a clear task description to run_chain
- Each step's output feeds into the next step as $INPUT
- Agents maintain session context — they remember previous work within this session
- You can run the chain multiple times with different tasks if needed
- After the chain completes, review the result and summarize for the user

## Guidelines
- Use your judgment — if it's quick, just do it; if it's real work, run the chain
- Keep chain tasks focused and clearly described
- You can mix direct work and chain runs in the same conversation`,
		};
	});

	// ── Session Start ───────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Clear widget with both old and new ctx — one of them will be valid
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-chain", undefined);
		}
		ctx.ui.setWidget("agent-chain", undefined);
		widgetCtx = ctx;

		// Reset execution state — widget re-registration deferred to before_agent_start
		stepStates = [];
		activeChain = null;
		pendingReset = true;

		// Wipe chain session files — reset agent context on /new and launch
		const sessDir = join(ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.startsWith("chain-") && f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// Stop any active IPC watcher from previous session
		if (activeIpcWatcher) {
			activeIpcWatcher();
			activeIpcWatcher = null;
		}
		ipcWatcherRefCount = 0;

		// Reload chains + clear agentSessions map (all agents start fresh)
		loadChains(ctx.cwd);

		// Clean up IPC files from previous session
		cleanupIpcDir(join(ctx.cwd, ".pi", "agent-ipc"));

		if (chains.length === 0) {
			ctx.ui.notify("No chains found in .pi/agents/agent-chain.yaml", "warning");
			return;
		}

		// Default to first chain — use /chain to switch
		activateChain(chains[0]);

		const flow = activeChain!.steps.map(s => displayName(s.agent)).join(" → ");
		ctx.ui.setStatus("agent-chain", `Chain: ${activeChain!.name} (${activeChain!.steps.length} steps)`);
		ctx.ui.notify(
			`Chain: ${activeChain!.name}\n${activeChain!.description}\n${flow}\n\n` +
			`/chain             Switch chain\n` +
			`/chain-list        List all chains`,
			"info",
		);
	});
}
