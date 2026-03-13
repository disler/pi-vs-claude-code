/**
 * Pi Pi — Meta-agent that builds Pi agents
 *
 * A team of domain-specific research experts (extensions, themes, skills,
 * settings, TUI) operate in PARALLEL to gather documentation and patterns.
 * The primary agent synthesizes their findings and WRITES the actual files.
 *
 * Each expert fetches fresh Pi documentation via firecrawl on first query.
 * Experts are read-only researchers. The primary agent is the only writer.
 *
 * Commands:
 *   /experts          — list available experts and their status
 *   /experts-grid N   — set dashboard column count (default 3)
 *
 * Usage: pi -e extensions/pi-pi.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { applyExtensionDefaults } from "./themeMap.ts";
import { scanAgentDirectory, type AgentDef, type ValidationWarning, type CollisionWarning } from "./utils/agent-loader.ts";

// ── Types ────────────────────────────────────────

type ExpertDef = AgentDef;

interface ExpertState {
	def: ExpertDef;
	status: "idle" | "researching" | "done" | "error";
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	timer?: ReturnType<typeof setInterval>;
}

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Expert card colors ────────────────────────────
// Each expert gets a unique hue: bg fills the card interior,
// br is the matching border foreground (brighter shade of same hue).
const EXPERT_COLORS: Record<string, { bg: string; br: string }> = {
	"agent-expert":      { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m"  }, // navy
	"config-expert":     { bg: "\x1b[48;2;18;65;30m",  br: "\x1b[38;2;55;175;90m"   }, // forest
	"ext-expert":        { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m"   }, // crimson
	"keybinding-expert": { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  }, // violet
	"prompt-expert":     { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  }, // amber
	"skill-expert":      { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m"  }, // teal
	"theme-expert":      { bg: "\x1b[48;2;80;18;62m",  br: "\x1b[38;2;210;55;160m"  }, // rose
	"tui-expert":        { bg: "\x1b[48;2;28;42;80m",  br: "\x1b[38;2;85;120;210m"  }, // slate
	"cli-expert":        { bg: "\x1b[48;2;60;80;20m",  br: "\x1b[38;2;160;210;55m"  }, // olive/lime
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const experts: Map<string, ExpertState> = new Map();
	let gridCols = 3;
	let widgetCtx: any;
	let lastCollisions: CollisionWarning[] = [];

	function loadExperts(cwd: string) {
		// Pi Pi experts live in their own dedicated directory
		const piPiDir = join(cwd, ".pi", "agents", "pi-pi");

		experts.clear();
		lastCollisions = [];

		if (!existsSync(piPiDir)) return;

		const { agents: validAgents, collisions } = scanAgentDirectory(piPiDir, (_file, warning) => {
			if (warning.severity === "error") {
				console.error(`[pi-pi] ${_file}: ${warning.message}`);
			}
		});
		lastCollisions = collisions;

		// Exclude the orchestrator itself from the expert list
		validAgents.delete("pi-orchestrator");

		for (const [key, def] of validAgents) {
			if (!experts.has(key)) {
				experts.set(key, {
					def,
					status: "idle",
					question: "",
					elapsed: 0,
					lastLine: "",
					queryCount: 0,
				});
			}
		}
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: ExpertState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "researching" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "researching" ? "◉"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const queriesStr = state.queryCount > 0 ? ` (${state.queryCount})` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr + queriesStr);
		const statusVisible = statusStr.length + timeStr.length + queriesStr.length;

		const workRaw = state.question || state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const lastRaw = state.lastLine || "";
		const lastText = truncate(lastRaw, Math.min(50, w - 1));
		const lastLineRendered = lastText ? theme.fg("dim", lastText) : theme.fg("dim", "—");
		const lastVisible = lastText ? lastText.length : 1;

		const colors = EXPERT_COLORS[state.def.name];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";

		// br colors the box-drawing characters; bg fills behind them so the
		// full card — top line, side bars, bottom line — is one solid block.
		const bord = (s: string) => bg + br + s + bgr + fgr;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";

		// bg fills the inner content area; re-applied before padding to ensure
		// the full row is colored even if theme.fg uses a full ANSI reset inside.
		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine, 1 + workVisible),
			border(" " + lastLineRendered, 1 + lastVisible),
			bord(bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("pi-pi-grid", (_tui: any, theme: any) => {

			return {
				render(width: number): string[] {
					if (experts.size === 0) {
						return ["", theme.fg("dim", "  No experts found. Add agent .md files to .pi/agents/pi-pi/")];
					}

					const cols = Math.min(gridCols, experts.size);
					const gap = 1;
					// avoid Text component's ANSI-width miscounting by returning raw lines
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols) - 1;
					const allExperts = Array.from(experts.values());

					const lines: string[] = [""]; // top margin

					for (let i = 0; i < allExperts.length; i += cols) {
						const rowExperts = allExperts.slice(i, i + cols);
						const cards = rowExperts.map(e => renderCard(e, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							lines.push(cards.map(card => card[line] || "").join(" ".repeat(gap)));
						}
					}

					return lines;
				},
				invalidate() {},
			};
		});
	}

	// ── Query Expert ─────────────────────────────

	function queryExpert(
		expertName: string,
		question: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = expertName.toLowerCase();
		const state = experts.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Expert "${expertName}" not found. Available: ${Array.from(experts.values()).map(s => s.def.name).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "researching") {
			return Promise.resolve({
				output: `Expert "${displayName(state.def.name)}" is already researching. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			question,
		];

		const textChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastLine = last;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				const full = textChunks.join("");
				state.lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastLine = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning expert: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── query_experts Tool (parallel) ───────────

	pi.registerTool({
		name: "query_experts",
		label: "Query Experts",
		description: `Query one or more Pi domain experts IN PARALLEL. All experts run simultaneously as concurrent subprocesses.

Pass an array of queries — each with an expert name and a specific question. All experts start at the same time and their results are returned together.

Available experts:
- ext-expert: Extensions — tools, events, commands, rendering, state management
- theme-expert: Themes — JSON format, 51 color tokens, vars, color values
- skill-expert: Skills — SKILL.md multi-file packages, scripts, references, frontmatter
- config-expert: Settings — settings.json, providers, models, packages, keybindings
- tui-expert: TUI — components, keyboard input, overlays, widgets, footers, editors
- prompt-expert: Prompt templates — single-file .md commands, arguments ($1, $@)
- agent-expert: Agent definitions — .md personas, tools, teams.yaml, orchestration
- keybinding-expert: Keyboard shortcuts — registerShortcut(), Key IDs, reserved keys, macOS terminal compatibility

Ask specific questions about what you need to BUILD. Each expert will return documentation excerpts, code patterns, and implementation guidance.`,

		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					expert: Type.String({
						description: "Expert name: ext-expert, theme-expert, skill-expert, config-expert, tui-expert, prompt-expert, or agent-expert",
					}),
					question: Type.String({
						description: "Specific question about what you need to build. Include context about the target component.",
					}),
				}),
				{ description: "Array of expert queries to run in parallel" },
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { queries } = params as { queries: { expert: string; question: string }[] };

			if (!queries || queries.length === 0) {
				return {
					content: [{ type: "text", text: "No queries provided." }],
					details: { results: [], status: "error" },
				};
			}

			const names = queries.map(q => displayName(q.expert)).join(", ");
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Querying ${queries.length} experts in parallel: ${names}` }],
					details: { queries, status: "researching", results: [] },
				});
			}

			// Launch ALL experts concurrently — allSettled so one failure
			// never discards results from the others
			const settled = await Promise.allSettled(
				queries.map(async ({ expert, question }) => {
					const result = await queryExpert(expert, question, ctx);
					const truncated = result.output.length > 12000
						? result.output.slice(0, 12000) + "\n\n... [truncated — ask follow-up for more]"
						: result.output;
					const status = result.exitCode === 0 ? "done" : "error";
					return {
						expert,
						question,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: truncated,
						fullOutput: result.output,
					};
				}),
			);

			const results = settled.map((s, i) =>
				s.status === "fulfilled"
					? s.value
					: {
						expert: queries[i].expert,
						question: queries[i].question,
						status: "error" as const,
						elapsed: 0,
						exitCode: 1,
						output: `Error: ${(s.reason as any)?.message || s.reason}`,
						fullOutput: "",
					},
			);

			// Build combined response
			const sections = results.map(r => {
				const icon = r.status === "done" ? "✓" : "✗";
				return `## [${icon}] ${displayName(r.expert)} (${Math.round(r.elapsed / 1000)}s)\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: {
					results,
					status: results.every(r => r.status === "done") ? "done" : "partial",
				},
			};
		},

		renderCall(args, theme) {
			const queries = (args as any).queries || [];
			const names = queries.map((q: any) => displayName(q.expert || "?")).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("query_experts ")) +
				theme.fg("accent", `${queries.length} parallel`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", names),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "researching") {
				const count = details.queries?.length || "?";
				return new Text(
					theme.fg("accent", `◉ ${count} experts`) +
					theme.fg("dim", " researching in parallel..."),
					0, 0,
				);
			}

			const lines = (details.results as any[]).map((r: any) => {
				const icon = r.status === "done" ? "✓" : "✗";
				const color = r.status === "done" ? "success" : "error";
				const elapsed = typeof r.elapsed === "number" ? Math.round(r.elapsed / 1000) : 0;
				return theme.fg(color, `${icon} ${displayName(r.expert)}`) +
					theme.fg("dim", ` ${elapsed}s`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = (details.results as any[]).map((r: any) => {
					const output = r.fullOutput
						? (r.fullOutput.length > 4000 ? r.fullOutput.slice(0, 4000) + "\n... [truncated]" : r.fullOutput)
						: r.output || "";
					return theme.fg("accent", `── ${displayName(r.expert)} ──`) + "\n" + theme.fg("muted", output);
				});
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("experts", {
		description: "List available Pi Pi experts and their status",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const lines = Array.from(experts.values())
				.map(s => `${displayName(s.def.name)} (${s.status}, queries: ${s.queryCount}): ${s.def.description}`)
				.join("\n");
			_ctx.ui.notify(lines || "No experts loaded", "info");
		},
	});

	pi.registerCommand("experts-grid", {
		description: "Set expert grid columns: /experts-grid <1-5>",
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 5) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("Usage: /experts-grid <1-5>", "error");
			}
		},
	});

	// ── System Prompt ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const expertCatalog = Array.from(experts.values())
			.map(s => `### ${displayName(s.def.name)}\n**Query as:** \`${s.def.name}\`\n${s.def.description}`)
			.join("\n\n");

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");

		const orchestratorPath = join(_ctx.cwd, ".pi", "agents", "pi-pi", "pi-orchestrator.md");
		let systemPrompt = "";
		try {
			const raw = readFileSync(orchestratorPath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			const template = match ? match[2].trim() : raw;
			
			systemPrompt = template
				.replace("{{EXPERT_COUNT}}", experts.size.toString())
				.replace("{{EXPERT_NAMES}}", expertNames)
				.replace("{{EXPERT_CATALOG}}", expertCatalog);
		} catch (err) {
			systemPrompt = "Error: Could not load pi-orchestrator.md. Make sure it exists in .pi/agents/pi-pi/.";
		}

		return { systemPrompt };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyExtensionDefaults(import.meta.url, _ctx);
		if (widgetCtx) {
			widgetCtx.ui.setWidget("pi-pi-grid", undefined);
		}
		widgetCtx = _ctx;

		loadExperts(_ctx.cwd);

		for (const c of lastCollisions) {
			_ctx.ui.notify(`⚠️ Expert collision: "${c.name}" in ${c.duplicatePath} — already loaded from ${c.originalPath}`, "warning");
		}

		updateWidget();

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");
		_ctx.ui.setStatus("pi-pi", `Pi Pi (${experts.size} experts)`);
		_ctx.ui.notify(
			`Pi Pi loaded — ${experts.size} experts: ${expertNames}\n\n` +
			`/experts          List experts and status\n` +
			`/experts-grid N   Set grid columns (1-5)\n\n` +
			`Ask me to build any Pi agent component!`,
			"info",
		);

		// Custom footer
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const active = Array.from(experts.values()).filter(e => e.status === "researching").length;
				const done = Array.from(experts.values()).filter(e => e.status === "done").length;

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", "Pi Pi");
				const mid = active > 0
					? theme.fg("accent", ` ◉ ${active} researching`)
					: done > 0
					? theme.fg("success", ` ✓ ${done} done`)
					: "";
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});
}
