/**
 * Subagent Widget — /sub, /subclear, /subrm, /subcont commands with stacking live widgets
 *
 * Each /sub spawns a background Pi subagent with its own persistent session,
 * enabling conversation continuations via /subcont.
 *
 * Usage: pi -e extensions/subagent-widget.ts
 * Then:
 *   /sub list files and summarize          — spawn a new subagent
 *   /subcont 1 now write tests for it      — continue subagent #1's conversation
 *   /subrm 2                               — remove subagent #2 widget
 *   /subclear                              — clear all subagent widgets
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { realpathSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

interface SubState {
	id: number;
	status: "running" | "done" | "error";
	task: string;
	textChunks: string[];
	toolCount: number;
	elapsed: number;
	sessionFile: string;   // persistent JSONL session path — used by /subcont to resume
	turnCount: number;     // increments each time /subcont continues this agent
	proc?: any;            // active ChildProcess ref (for kill on /subrm)
}

export default function (pi: ExtensionAPI) {
	const agents: Map<number, SubState> = new Map();
	let nextId = 1;
	let widgetCtx: any;

	// ── Session file helpers ──────────────────────────────────────────────────

	function makeSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
	}

	// ── Widget rendering ──────────────────────────────────────────────────────

	function updateWidgets() {
		if (!widgetCtx) return;

		for (const [id, state] of Array.from(agents.entries())) {
			const key = `sub-${id}`;
			widgetCtx.ui.setWidget(key, (_tui: any, theme: any) => {
				const container = new Container();
				const borderFn = (s: string) => theme.fg("dim", s);

				container.addChild(new Text("", 0, 0)); // top margin
				container.addChild(new DynamicBorder(borderFn));
				const content = new Text("", 1, 0);
				container.addChild(content);
				container.addChild(new DynamicBorder(borderFn));

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						const statusColor = state.status === "running" ? "accent"
							: state.status === "done" ? "success" : "error";
						const statusIcon = state.status === "running" ? "●"
							: state.status === "done" ? "✓" : "✗";

						const taskPreview = state.task.length > 40
							? state.task.slice(0, 37) + "..."
							: state.task;

						const turnLabel = state.turnCount > 1
							? theme.fg("dim", ` · Turn ${state.turnCount}`)
							: "";

						lines.push(
							theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) +
							turnLabel +
							theme.fg("dim", `  ${taskPreview}`) +
							theme.fg("dim", `  (${Math.round(state.elapsed / 1000)}s)`) +
							theme.fg("dim", ` | Tools: ${state.toolCount}`)
						);

						const fullText = state.textChunks.join("");
						const lastLine = fullText.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (lastLine) {
							const trimmed = lastLine.length > width - 10
								? lastLine.slice(0, width - 13) + "..."
								: lastLine;
							lines.push(theme.fg("muted", `  ${trimmed}`));
						}

						content.setText(lines.join("\n"));
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
				};
			});
		}
	}

	// ── Streaming helpers ─────────────────────────────────────────────────────

	function processLine(state: SubState, line: string) {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			const type = event.type;

			if (type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					state.textChunks.push(delta.delta || "");
					updateWidgets();
				}
			} else if (type === "tool_execution_start") {
				state.toolCount++;
				updateWidgets();
			}
		} catch {}
	}

	function spawnAgent(
		state: SubState,
		prompt: string,
		ctx: any,
	): Promise<void> {
		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		return new Promise<void>((resolve) => {
			// Use process.execPath (real node binary, not snap wrapper) + resolved pi script
		// to bypass snap AppArmor confinement that breaks pipes on snap-to-snap spawns.
		const nodeBin = process.execPath;
		const piScript = (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
		const proc = spawn(nodeBin, [
				piScript,
				"--mode", "json",
				"-p",
				"--session", state.sessionFile,   // persistent session for /subcont resumption
				"--no-extensions",
				"--model", model,
				"--tools", "read,bash,grep,find,ls",
				"--thinking", "off",
				prompt,
			], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			state.proc = proc;

			const startTime = Date.now();
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidgets();
			}, 1000);

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(state, line);
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				if (chunk.trim()) {
					state.textChunks.push(chunk);
					updateWidgets();
				}
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(state, buffer);
				clearInterval(timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";
				state.proc = undefined;
				updateWidgets();

				const result = state.textChunks.join("");
				ctx.ui.notify(
					`Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				pi.sendMessage({
					customType: "subagent-result",
					content: `Subagent #${state.id}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
					display: true,
				}, { deliverAs: "followUp", triggerTurn: true });

				resolve();
			});

			proc.on("error", (err) => {
				clearInterval(timer);
				state.status = "error";
				state.proc = undefined;
				state.textChunks.push(`Error: ${err.message}`);
				updateWidgets();
				resolve();
			});
		});
	}

		// ── Tools for the Main Agent ──────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_create",
		description: "Spawn a background subagent to perform a task. Returns the subagent ID immediately while it runs in the background. Results will be delivered as a follow-up message when finished.",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task: args.task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget
			spawnAgent(state, args.task, ctx);

			return {
				content: [{ type: "text", text: `Subagent #${id} spawned and running in background.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_continue",
		description: "Continue an existing subagent's conversation. Use this to give further instructions to a finished subagent. Returns immediately while it runs in the background.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to continue" }),
			prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}
			if (state.status === "running") {
				return { content: [{ type: "text", text: `Error: Subagent #${args.id} is still running.` }] };
			}

			state.status = "running";
			state.task = args.prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			ctx.ui.notify(`Continuing Subagent #${args.id} (Turn ${state.turnCount})…`, "info");
			spawnAgent(state, args.prompt, ctx);

			return {
				content: [{ type: "text", text: `Subagent #${args.id} continuing conversation in background.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_remove",
		description: "Remove a specific subagent. Kills it if it's currently running.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to remove" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}

			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${args.id}`, undefined);
			agents.delete(args.id);

			return {
				content: [{ type: "text", text: `Subagent #${args.id} removed successfully.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		description: "List all active and finished subagents, showing their IDs, tasks, and status.",
		parameters: Type.Object({}),
		execute: async () => {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No active subagents." }] };
			}

			const list = Array.from(agents.values()).map(s => 
				`#${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}) - ${s.task}`
			).join("\n");

			return {
				content: [{ type: "text", text: `Subagents:\n${list}` }],
			};
		},
	});



	// ── /sub <task> ───────────────────────────────────────────────────────────

	pi.registerCommand("sub", {
		description: "Spawn a subagent with live widget: /sub <task>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const task = args?.trim();
			if (!task) {
				ctx.ui.notify("Usage: /sub <task>", "error");
				return;
			}

			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget
			spawnAgent(state, task, ctx);
		},
	});

	// ── /subcont <number> <prompt> ────────────────────────────────────────────

	pi.registerCommand("subcont", {
		description: "Continue an existing subagent's conversation: /subcont <number> <prompt>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const num = parseInt(trimmed.slice(0, spaceIdx), 10);
			const prompt = trimmed.slice(spaceIdx + 1).trim();

			if (isNaN(num) || !prompt) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found. Use /sub to create one.`, "error");
				return;
			}

			if (state.status === "running") {
				ctx.ui.notify(`Subagent #${num} is still running — wait for it to finish first.`, "warning");
				return;
			}

			// Resume: update state for a new turn
			state.status = "running";
			state.task = prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			ctx.ui.notify(`Continuing Subagent #${num} (Turn ${state.turnCount})…`, "info");

			// Fire-and-forget — reuses the same sessionFile for conversation history
			spawnAgent(state, prompt, ctx);
		},
	});

	// ── /subrm <number> ───────────────────────────────────────────────────────

	pi.registerCommand("subrm", {
		description: "Remove a specific subagent widget: /subrm <number>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const num = parseInt(args?.trim() ?? "", 10);
			if (isNaN(num)) {
				ctx.ui.notify("Usage: /subrm <number>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found.`, "error");
				return;
			}

			// Kill the process if still running
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
				ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
			} else {
				ctx.ui.notify(`Subagent #${num} removed.`, "info");
			}

			ctx.ui.setWidget(`sub-${num}`, undefined);
			agents.delete(num);
		},
	});

	// ── /subclear ─────────────────────────────────────────────────────────────

	pi.registerCommand("subclear", {
		description: "Clear all subagent widgets",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;

			let killed = 0;
			for (const [id, state] of Array.from(agents.entries())) {
				if (state.proc && state.status === "running") {
					state.proc.kill("SIGTERM");
					killed++;
				}
				ctx.ui.setWidget(`sub-${id}`, undefined);
			}

			const total = agents.size;
			agents.clear();
			nextId = 1;

			const msg = total === 0
				? "No subagents to clear."
				: `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			ctx.ui.notify(msg, total === 0 ? "info" : "success");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${id}`, undefined);
		}
		agents.clear();
		nextId = 1;
		widgetCtx = ctx;
	});
}
