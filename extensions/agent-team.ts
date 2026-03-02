/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md.
 * Teams are defined in ~/.pi/agents/teams.yaml and/or .pi/agents/teams.yaml —
 * on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
 *
 * Commands:
 *   /agents-team          — switch active team
 *   /agents-list          — list loaded agents
 *   /agents-view [name]   — view full streaming output from an agent
 *   /agents-grid N        — set column count (default 2)
 *   /agents-approval MODE — dispatch approval mode: off|writes|always
 *
 * Usage: pi -e extensions/agent-team.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { applyExtensionDefaults } from "./themeMap.ts";
import {
	IPC_ENV_DIR,
	IPC_ENV_AGENT,
	startIpcWatcher,
	cleanupIpcDir,
	showPermissionDialog,
	type IpcPermissionRequest,
	type IpcPermissionResponse,
} from "./permission-ipc.ts";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
	/** Accumulated streaming text from subagent stdout */
	streamBuffer: string[];
	/** Current tool being executed */
	currentTool: string;
}

type DispatchApprovalMode = "off" | "writes" | "always";
type AgentsMode = "team" | "single";

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name
		.split("-")
		.map(function toDisplayWord(word) {
			return word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join(" ");
}

const STATUS_COLORS: Record<string, string> = { idle: "dim", running: "accent", done: "success" };
const STATUS_ICONS: Record<string, string> = { idle: "○", running: "●", done: "✓" };

function getStatusColor(status: AgentState["status"]): string {
	return STATUS_COLORS[status] || "error";
}

function getStatusIcon(status: AgentState["status"]): string {
	return STATUS_ICONS[status] || "✗";
}

function getDefaultGridColumns(teamSize: number): number {
	return teamSize <= 3 ? teamSize : teamSize === 4 ? 2 : 3;
}

function parseToolsList(tools: string): Set<string> {
	return new Set(tools.split(",").map(t => t.trim().toLowerCase()).filter(Boolean));
}

function requiresDispatchApproval(def: AgentDef, task: string, mode: DispatchApprovalMode): boolean {
	if (mode === "off") return false;
	if (mode === "always") return true;
	const tools = parseToolsList(def.tools);
	return tools.has("write") || tools.has("edit") || /\b(edit|modify|change|write|update|delete|remove|refactor|patch|rewrite)\b/i.test(task);
}

// ── Teams YAML Parser ────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		const lines = match[1].split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const idx = line.indexOf(":");
			if (idx <= 0) continue;

			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (!key) continue;

			// Support YAML block scalars like `description: |` and `description: >`.
			if (/^[|>][+-]?$/.test(value)) {
				const blockLines: string[] = [];
				for (let j = i + 1; j < lines.length; j++) {
					const next = lines[j];
					if (next.startsWith(" ") || next.startsWith("\t") || next === "") {
						if (next.startsWith("  ")) blockLines.push(next.slice(2));
						else if (next.startsWith("\t")) blockLines.push(next.slice(1));
						else blockLines.push(next);
						i = j;
						continue;
					}
					break;
				}
				frontmatter[key] = value.startsWith(">") ? blockLines.join(" ").trim() : blockLines.join("\n").trim();
				continue;
			}

			frontmatter[key] = value;
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): AgentDef[] {
	const home = homedir();
	const dirs = [
		// Project-local (higher precedence)
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		// Global fallbacks (available everywhere)
		join(home, ".pi", "agents"),
		join(home, ".claude", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}

// ── Extension ────────────────────────────────────

export default function agentTeamExtension(pi: ExtensionAPI): void {
	const agentStates: Map<string, AgentState> = new Map();
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let widgetCtx: any;
	let sessionDir = "";
	let ipcDir = "";
	let activeIpcWatcher: (() => void) | null = null;
	let ipcWatcherRefCount = 0;
	let contextWindow = 0;
	let dispatchApprovalMode: DispatchApprovalMode = process.env.PI_PERM_MODE === "auto-edit" ? "off" : "writes";
	let agentsMode: AgentsMode = "team";

	function getEffectiveDispatchApprovalMode(): DispatchApprovalMode {
		return process.env.PI_PERM_MODE === "auto-edit" ? "off" : dispatchApprovalMode;
	}

	function getStatusText(): string {
		if (agentsMode !== "team") {
			return "Mode: single";
		}
		const approval = getEffectiveDispatchApprovalMode();
		return `approval:${approval} · agents:${agentStates.size} · Team: ${activeTeamName} · Mode: ${agentsMode}`;
	}

	function getStatusLine2(): string {
		return `Team: ${activeTeamName} · Mode: ${agentsMode}`;
	}

	function applyModeTools(): void {
		if (agentsMode === "team") {
			pi.setActiveTools(["dispatch_agent"]);
			return;
		}
		pi.setActiveTools([]);
	}

	function updateStatus(ctx: any) {
		ctx.ui.setStatus("agent-team", getStatusText());
		if (agentsMode !== "team") {
			ctx.ui.setStatus("agent-team-mode", undefined);
			return;
		}
		ctx.ui.setStatus("agent-team-mode", getStatusLine2());
	}

	function updateFooter(ctx: any): void {
		ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model?.id || "no-model";
				const usage = ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				let left: string;
				if (agentsMode === "team") {
					left = theme.fg("dim", ` ${model}`) +
						theme.fg("muted", " · ") +
						theme.fg("accent", activeTeamName) +
						theme.fg("muted", " · ") +
						theme.fg("warning", `mode:${agentsMode}`) +
						theme.fg("dim", " · /perm-mode");
				} else {
					left = theme.fg("dim", ` ${model}`) +
						theme.fg("muted", " · ") +
						theme.fg("warning", `mode:${agentsMode}`) +
						theme.fg("dim", " · /perm-mode");
				}
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	}

	function refreshTeamChrome(ctx: any): void {
		updateStatus(ctx);
		updateWidget();
		updateFooter(ctx);
	}

	pi.registerCommand("agents-auto-edit", {
		description: "Toggle AUTO-EDIT bridge for dispatch approvals",
		handler: async (_args, ctx) => {
			const next = process.env.PI_PERM_MODE === "auto-edit" ? "guarded" : "auto-edit";
			process.env.PI_PERM_MODE = next;
			updateStatus(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`agent-team: PI_PERM_MODE=${next} (dispatch approval ${next === "auto-edit" ? "off" : dispatchApprovalMode})`, "info");
			}
		},
	});

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
				return {
					id: req.id,
					approved,
					choice: approved ? "allow_once" : "deny",
					message: result.message,
					timestamp: Date.now(),
				};
			}

			// write or edit — build a detailed preview
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

			if (result.choice === "Allow once") {
				return { id: req.id, approved: true, choice: "allow_once", message: result.message, timestamp: Date.now() };
			}
			if (result.choice === "Always allow this file") {
				return { id: req.id, approved: true, choice: "allow_always", message: result.message, timestamp: Date.now() };
			}
			return { id: req.id, approved: false, choice: "deny", message: result.message, timestamp: Date.now() };
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

	function loadAgents(cwd: string) {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		ipcDir = join(cwd, ".pi", "agent-ipc");
		for (const dir of [sessionDir, ipcDir]) {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}

		allAgentDefs = scanAgentDirs(cwd);

		const nextTeams: Record<string, string[]> = {};
		for (const teamsPath of [join(homedir(), ".pi", "agents", "teams.yaml"), join(cwd, ".pi", "agents", "teams.yaml")]) {
			if (!existsSync(teamsPath)) continue;
			try { Object.assign(nextTeams, parseTeamsYaml(readFileSync(teamsPath, "utf-8"))); } catch {}
		}
		teams = Object.keys(nextTeams).length > 0 ? nextTeams : { all: allAgentDefs.map(d => d.name) };
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));
		agentStates.clear();
		for (const member of (teams[teamName] || [])) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			const key = def.name.toLowerCase().replace(/\s+/g, "-");
			const sf = join(sessionDir, `${key}.json`);
			agentStates.set(def.name.toLowerCase(), {
				def, status: "idle", task: "", toolCount: 0, elapsed: 0,
				lastWork: "", contextPct: 0, sessionFile: existsSync(sf) ? sf : null, runCount: 0,
				streamBuffer: [], currentTool: "",
			});
		}
		gridCols = getDefaultGridColumns(agentStates.size);
	}

	// ── Card & Grid Rendering ────────────────────

	/** How many lines of streaming output to show per card */
	const STREAM_LINES_PER_CARD = 6;

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2; // inner width (minus │ borders)
		const pad = (content: string, vLen: number) =>
			theme.fg("border", "│") + " " + content + " ".repeat(Math.max(0, w - 1 - vLen)) + theme.fg("border", "│");

		const name = displayName(state.def.name);
		const nameStr = truncateToWidth(name, w - 1);

		// ── Header: Name + status badge ──
		const statusIcon = getStatusIcon(state.status);
		const statusColor = getStatusColor(state.status);
		const elapsed = state.status !== "idle" ? `${Math.round(state.elapsed / 1000)}s` : "";
		const badge = `${statusIcon} ${state.status}${elapsed ? " " + elapsed : ""}`;
		const badgeVis = badge.length;
		const nameMaxW = w - 2 - badgeVis;
		const truncName = truncateToWidth(name, Math.max(4, nameMaxW));
		const headerGap = Math.max(1, w - 1 - visibleWidth(truncName) - badgeVis);
		const headerLine = theme.fg("accent", theme.bold(truncName)) + " ".repeat(headerGap) + theme.fg(statusColor, badge);

		// ── Progress bar ──
		const barW = Math.min(20, w - 10);
		const filled = Math.round((state.contextPct / 100) * barW);
		const barFilled = theme.fg("accent", "━".repeat(filled));
		const barEmpty = theme.fg("dim", "─".repeat(Math.max(0, barW - filled)));
		const pctStr = `${Math.ceil(state.contextPct)}%`;
		const toolStr = state.toolCount > 0 ? ` · ${state.toolCount} tools` : "";
		const progressLine = barFilled + barEmpty + theme.fg("dim", ` ${pctStr}${toolStr}`);
		const progressVis = barW + 1 + pctStr.length + toolStr.length;

		// ── Current tool indicator ──
		const toolLine = state.currentTool
			? theme.fg("warning", "▸ ") + theme.fg("muted", truncateToWidth(state.currentTool, w - 4))
			: "";
		const toolLineVis = state.currentTool ? 2 + Math.min(state.currentTool.length, w - 4) : 0;

		// ── Streaming output (last N lines) ──
		const streamLines: string[] = [];
		if (state.streamBuffer.length > 0) {
			const fullText = state.streamBuffer.join("");
			const allLines = fullText.split("\n").filter(l => l.trim());
			const tail = allLines.slice(-STREAM_LINES_PER_CARD);
			for (const line of tail) {
				streamLines.push(theme.fg("muted", truncateToWidth(line, w - 1)));
			}
		} else if (state.task) {
			// Show task description when no stream yet
			const taskStr = truncateToWidth(state.task, w - 1);
			streamLines.push(theme.fg("dim", taskStr));
		} else {
			// Idle — show agent description
			const descStr = truncateToWidth(state.def.description, w - 1);
			streamLines.push(theme.fg("dim", descStr));
		}

		// Pad stream lines to fixed height for stable layout
		while (streamLines.length < STREAM_LINES_PER_CARD) {
			streamLines.push("");
		}

		// ── Assemble card ──
		const topBorder = state.status === "running"
			? theme.fg("accent", "┌" + "━".repeat(w) + "┐")
			: theme.fg("border", "┌" + "─".repeat(w) + "┐");
		const botBorder = state.status === "running"
			? theme.fg("accent", "└" + "━".repeat(w) + "┘")
			: theme.fg("border", "└" + "─".repeat(w) + "┘");
		const divider = theme.fg("dim", "├" + "┄".repeat(w) + "┤");

		const lines: string[] = [topBorder];
		lines.push(pad(headerLine, visibleWidth(truncName) + headerGap + badgeVis));
		lines.push(pad(progressLine, progressVis));
		if (toolLine) {
			lines.push(pad(toolLine, toolLineVis));
		}
		lines.push(divider);
		for (const sl of streamLines) {
			const slVis = visibleWidth(sl);
			lines.push(pad(sl, slVis));
		}
		lines.push(botBorder);

		return lines;
	}

	function updateWidget() {
		if (!widgetCtx) return;
		if (agentsMode !== "team") {
			widgetCtx.ui.setWidget("agent-team", undefined);
			return;
		}

		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (agentStates.size === 0) {
						text.setText(theme.fg("dim", "  No agents loaded. Add .md files to .pi/agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const colWidth = Math.max(30, Math.floor((width - gap * (cols - 1)) / cols));
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						// Normalize card heights (they may differ if currentTool shown)
						const maxH = Math.max(...cards.map(c => c.length));
						for (const card of cards) {
							while (card.length < maxH) {
								card.splice(card.length - 1, 0, theme.fg("border", "│") + " ".repeat(colWidth - 2) + theme.fg("border", "│"));
							}
						}

						while (cards.length < cols) {
							cards.push(Array(maxH).fill(" ".repeat(colWidth)));
						}

						for (let line = 0; line < maxH; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Detail Overlay (full streaming output) ──

	function showAgentDetail(agentName: string, ctx: any): void {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			ctx.ui.notify(`Agent "${agentName}" not found.`, "error");
			return;
		}

		const fullText = state.streamBuffer.join("");
		const name = displayName(state.def.name);
		const statusIcon = getStatusIcon(state.status);
		const statusColor = getStatusColor(state.status);

		ctx.ui.custom((_tui: any, theme: any, _kb: any, done: (v: any) => void) => {
			let scrollOffset = 0;
			let cachedLines: string[] | null = null;
			let cachedWidth: number | null = null;

			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;

					const maxH = Math.max(10, (process.stdout.rows || 40) - 6);
					const innerW = width - 4;
					const lines: string[] = [];

					// Header
					const header = theme.fg("accent", theme.bold(` ◆ ${name} `)) +
						theme.fg(statusColor, `${statusIcon} ${state.status}`) +
						(state.elapsed > 0 ? theme.fg("dim", ` · ${Math.round(state.elapsed / 1000)}s`) : "") +
						(state.toolCount > 0 ? theme.fg("dim", ` · ${state.toolCount} tools`) : "") +
						theme.fg("dim", ` · ctx ${Math.ceil(state.contextPct)}%`);
					lines.push(theme.fg("accent", "━".repeat(width)));
					lines.push(header);
					if (state.task) {
						lines.push(theme.fg("dim", " Task: ") + theme.fg("muted", truncateToWidth(state.task, innerW)));
					}
					lines.push(theme.fg("accent", "━".repeat(width)));

					// Streaming content
					const contentLines = fullText.split("\n");
					const visibleCount = maxH - lines.length - 2;
					const maxScroll = Math.max(0, contentLines.length - visibleCount);
					scrollOffset = Math.min(scrollOffset, maxScroll);

					const slice = contentLines.slice(scrollOffset, scrollOffset + visibleCount);
					for (const cl of slice) {
						lines.push(theme.fg("text", " " + truncateToWidth(cl, innerW)));
					}

					// Pad to fill
					while (lines.length < maxH - 1) {
						lines.push("");
					}

					// Footer
					const scrollInfo = contentLines.length > visibleCount
						? theme.fg("dim", ` Lines ${scrollOffset + 1}-${Math.min(scrollOffset + visibleCount, contentLines.length)} of ${contentLines.length}`)
						: "";
					lines.push(theme.fg("dim", " ↑↓ scroll · esc close") + scrollInfo);

					cachedLines = lines;
					cachedWidth = width;
					return lines;
				},
				handleInput(data: string) {
					cachedLines = null;
					if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
						done(null);
					} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
						scrollOffset = Math.max(0, scrollOffset - 1);
					} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
						scrollOffset++;
					} else if (data === "g") {
						scrollOffset = 0;
					} else if (data === "G") {
						scrollOffset = 999999;
					}
					_tui.requestRender();
				},
				invalidate() {
					cachedLines = null;
					cachedWidth = null;
				},
			};
		});
	}

	// ── Subagent Helpers ─────────────────────────

	function prepareSubagentRun(state: AgentState, task: string, ctx: any): {
		model: string;
		agentSessionFile: string;
		permissionGateExt: string;
		subagentPermMode: string;
		env: Record<string, string>;
		baseArgs: string[];
	} | { error: string } {
		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);

		const projectPermissionGateExt = resolve(ctx.cwd, "extensions", "permission-gate.ts");
		const bundledPermissionGateExt = resolve(dirname(fileURLToPath(import.meta.url)), "permission-gate.ts");
		const permissionGateExt = existsSync(projectPermissionGateExt)
			? projectPermissionGateExt
			: bundledPermissionGateExt;

		if (!existsSync(permissionGateExt)) {
			return { error: `Subagent launch aborted: permission-gate.ts not found. Checked: ${projectPermissionGateExt} and ${bundledPermissionGateExt}` };
		}

		const subagentPermMode = process.env.PI_PERM_MODE || "guarded";

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			PI_PERM_MODE: subagentPermMode,
			[IPC_ENV_DIR]: ipcDir,
			[IPC_ENV_AGENT]: state.def.name,
		};

		const baseArgs = [
			"-e", permissionGateExt,
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			"--session", agentSessionFile,
		];

		if (state.sessionFile) {
			baseArgs.push("-c");
		}

		return { model, agentSessionFile, permissionGateExt, subagentPermMode, env, baseArgs };
	}

	function finalizeSubagentRun(
		state: AgentState,
		startTime: number,
		exitCode: number | null,
		agentSessionFile: string,
		lastWork: string,
	): void {
		clearInterval(state.timer);
		state.elapsed = Date.now() - startTime;
		state.status = exitCode === 0 ? "done" : "error";
		if (exitCode === 0) state.sessionFile = agentSessionFile;
		state.lastWork = lastWork;
		state.currentTool = "";
		updateWidget();
	}

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({ output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, exitCode: 1, elapsed: 0 });
		}
		if (state.status === "running") {
			return Promise.resolve({ output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`, exitCode: 1, elapsed: 0 });
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.streamBuffer = [];
		state.currentTool = "";
		state.runCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const prep = prepareSubagentRun(state, task, ctx);
		if ("error" in prep) {
			clearInterval(state.timer);
			state.elapsed = Date.now() - startTime;
			state.status = "error";
			state.lastWork = "Error: permission-gate.ts not found for subagent run";
			updateWidget();
			if (ctx.hasUI) {
				ctx.ui.notify("agent-team: subagent blocked (permission-gate.ts not found)", "error");
			}
			return Promise.resolve({ output: prep.error, exitCode: 1, elapsed: state.elapsed });
		}

		const { agentSessionFile, subagentPermMode, env, baseArgs } = prep;

		const args = ["--mode", "json", "-p", ...baseArgs, task];
		const textChunks: string[] = [];

		acquireIpcWatcher(ctx);

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env,
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
								const text = delta.delta || "";
								textChunks.push(text);
								state.streamBuffer.push(text);
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastWork = last;
								updateWidget();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							const toolName = event.tool || event.name || "";
							const toolArgs = event.args || event.input || {};
							// Build a short description of the tool call
							let toolDesc = toolName;
							if (toolName === "read" && toolArgs.path) toolDesc = `read ${toolArgs.path}`;
							else if (toolName === "write" && toolArgs.path) toolDesc = `write ${toolArgs.path}`;
							else if (toolName === "edit" && toolArgs.path) toolDesc = `edit ${toolArgs.path}`;
							else if (toolName === "bash" && toolArgs.command) toolDesc = `bash: ${toolArgs.command.slice(0, 60)}`;
							else if (toolName === "grep" || toolName === "find") toolDesc = `${toolName} ${toolArgs.pattern || toolArgs.path || ""}`;
							state.currentTool = toolDesc;
							state.streamBuffer.push(`\n▸ ${toolDesc}\n`);
							updateWidget();
						} else if (event.type === "tool_execution_end" || event.type === "tool_result") {
							state.currentTool = "";
							updateWidget();
						} else if (event.type === "message_end") {
							state.currentTool = "";
							const msg = event.message;
							if (msg?.usage && contextWindow > 0) {
								state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						} else if (event.type === "agent_end") {
							state.currentTool = "";
							const msgs = event.messages || [];
							const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
							if (last?.usage && contextWindow > 0) {
								state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				releaseIpcWatcher();
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				const full = textChunks.join("");
				finalizeSubagentRun(state, startTime, code ?? 1, agentSessionFile,
					full.split("\n").filter((l: string) => l.trim()).pop() || "");

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				resolve({ output: full, exitCode: code ?? 1, elapsed: state.elapsed });
			});

			proc.on("error", (err) => {
				releaseIpcWatcher();
				finalizeSubagentRun(state, startTime, 1, agentSessionFile, `Error: ${err.message}`);
				resolve({ output: `Error spawning agent: ${err.message}`, exitCode: 1, elapsed: Date.now() - startTime });
			});
		});
	}

	// ── Dispatch Result Formatting ───────────────

	function formatDispatchResult(agent: string, result: { output: string; exitCode: number; elapsed: number }, extra?: Record<string, any>, statusOverride?: string) {
		let truncated = result.output;
		if (result.output.length > 8000) {
			truncated = result.output.slice(0, 8000) + "\n\n... [truncated]";
		}
		const status = statusOverride || (result.exitCode === 0 ? "done" : "error");
		const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;
		return {
			content: [{ type: "text" as const, text: `${summary}\n\n${truncated}` }],
			details: { agent, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output, ...extra },
		};
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			let taskForDispatch = task;

			try {
				const state = agentStates.get(agent.toLowerCase());
				const approvalMode = getEffectiveDispatchApprovalMode();
				if (state && requiresDispatchApproval(state.def, task, approvalMode)) {
					if (!ctx.hasUI) {
						return { content: [{ type: "text", text: `Dispatch blocked: approval mode is '${approvalMode}' but no interactive UI is available.` }], details: { agent, task, status: "blocked", elapsed: 0, exitCode: 1, fullOutput: "" } };
					}
					const decision = await showPermissionDialog(
						ctx,
						`Approve dispatch to ${displayName(state.def.name)}?\n\nTask: ${task}\n\nTools: ${state.def.tools || "(default)"}\n\nMode: ${approvalMode}`,
						["Yes", "No"] as const,
					);
					if (decision.choice !== "Yes") {
						const suffix = decision.message ? ` Feedback: ${decision.message}` : "";
						return { content: [{ type: "text", text: `Dispatch denied by user for ${agent}.${suffix}` }], details: { agent, task, status: "denied", elapsed: 0, exitCode: 1, fullOutput: "" } };
					}
					if (decision.message) {
						taskForDispatch = `${task}\n\n[User feedback]: ${decision.message}`;
					}
				}

				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task: taskForDispatch, status: "dispatching" },
					});
				}

				const result = await dispatchAgent(agent, taskForDispatch, ctx);
				return formatDispatchResult(agent, result, { task: taskForDispatch });
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }], details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } };
			}
		},

		renderCall(args, theme) {
			const { agent = "?", task = "" } = args as any;
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(theme.fg("toolTitle", theme.bold("dispatch_agent ")) + theme.fg("accent", agent) + theme.fg("dim", " — ") + theme.fg("muted", preview), 0, 0);
		},

		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (options.isPartial || d.status === "dispatching") {
				return new Text(theme.fg("accent", `● ${d.agent || "?"}`) + theme.fg("dim", " working..."), 0, 0);
			}
			const icon = d.status === "done" ? "✓" : "✗";
			const color = d.status === "done" ? "success" : "error";
			const elapsed = typeof d.elapsed === "number" ? Math.round(d.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${d.agent}`) + theme.fg("dim", ` ${elapsed}s`);
			if (options.expanded && d.fullOutput) {
				const output = d.fullOutput.length > 4000 ? d.fullOutput.slice(0, 4000) + "\n... [truncated]" : d.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}
			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("agents-team", {
		description: "Select a team to work with",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				ctx.ui.notify("No teams defined in ~/.pi/agents/teams.yaml or .pi/agents/teams.yaml", "warning");
				return;
			}

			const options = teamNames.map(name => {
				const members = teams[name].map(m => displayName(m));
				return `${name} — ${members.join(", ")}`;
			});

			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			const name = teamNames[idx];
			activateTeam(name);
			if (agentsMode !== "team") {
				agentsMode = "team";
				applyModeTools();
			}
			refreshTeamChrome(ctx);
			ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List all loaded agents",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const names = Array.from(agentStates.values())
				.map(s => {
					const session = s.sessionFile ? "resumed" : "new";
					return `${displayName(s.def.name)} (${s.status}, ${session}, runs: ${s.runCount}): ${s.def.description}`;
				})
				.join("\n");
			ctx.ui.notify(names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-view", {
		description: "View full streaming output from an agent: /agents-view <name>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = Array.from(agentStates.values()).map(s => ({
				value: s.def.name,
				label: `${displayName(s.def.name)} (${s.status})`,
			}));
			const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const name = (args || "").trim();
			if (!name) {
				// Show selection dialog if no name given
				const items = Array.from(agentStates.values());
				if (items.length === 0) {
					ctx.ui.notify("No agents loaded.", "warning");
					return;
				}
				const options = items.map(s => {
					const icon = getStatusIcon(s.status);
					const bufLen = s.streamBuffer.join("").length;
					return `${icon} ${displayName(s.def.name)} — ${s.status} · ${bufLen > 0 ? `${bufLen} chars` : "no output"}`;
				});
				const choice = await ctx.ui.select("View Agent Output", options);
				if (choice !== undefined) {
					const idx = options.indexOf(choice);
					showAgentDetail(items[idx].def.name, ctx);
				}
				return;
			}
			showAgentDetail(name, ctx);
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({
				value: n,
				label: `${n} columns`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	// ── Setting Toggle Factory ───────────────────

	function registerSettingToggle<T extends string>(
		name: string,
		description: string,
		validValues: T[],
		getCurrent: () => T,
		setCurrent: (val: T, ctx: any) => void,
	) {
		pi.registerCommand(name, {
			description,
			getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
				const items = [...validValues, "status"].map(v => ({ value: v, label: v }));
				const filtered = items.filter(i => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : items;
			},
			handler: async (args, ctx) => {
				const arg = (args || "").trim().toLowerCase() as T;
				if (!arg || arg === ("status" as any)) {
					ctx.ui.notify(`${name}: ${getCurrent()}`, "info");
					return;
				}
				if (validValues.includes(arg)) {
					setCurrent(arg, ctx);
					ctx.ui.notify(`${name} set to: ${arg}`, "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`Usage: /${name} [${validValues.join("|")}|status]`, "error");
					return;
				}
				const choice = await ctx.ui.select(`Set ${name}`, [...validValues]);
				if (choice && validValues.includes(choice as T)) {
					setCurrent(choice as T, ctx);
					ctx.ui.notify(`${name} set to: ${choice}`, "info");
				}
			},
		});
	}

	registerSettingToggle("agents-approval", "Dispatch approval mode", ["off", "writes", "always"],
		() => getEffectiveDispatchApprovalMode(),
		(val, ctx) => { dispatchApprovalMode = val; updateStatus(ctx); },
	);

	registerSettingToggle<AgentsMode>("agents-mode", "Agent mode toggle", ["team", "single"],
		() => agentsMode,
		(val, ctx) => { agentsMode = val; applyModeTools(); refreshTeamChrome(ctx); },
	);

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (agentsMode !== "team") return;
		// Build dynamic agent catalog from active team only
		const agentCatalog = Array.from(agentStates.values())
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
			.join("\n\n");

		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

		return {
			systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents outside this team.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Choose the right agent(s) for each sub-task
- Dispatch tasks using the dispatch_agent tool
- Review results and dispatch follow-up agents if needed
- If a task fails, try a different agent or adjust the task description
- Summarize the outcome for the user

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`,
		};
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		// Clear widgets from previous session
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
		}
		widgetCtx = ctx;
		contextWindow = ctx.model?.contextWindow || 0;

		// Wipe old agent session files so subagents start fresh
		const sessDir = join(ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// Clean up IPC files from previous session
		cleanupIpcDir(join(ctx.cwd, ".pi", "agent-ipc"));

		loadAgents(ctx.cwd);

		// Default to first team — use /agents-team to switch
		const teamNames = Object.keys(teams);
		if (teamNames.length > 0) {
			activateTeam(teamNames[0]);
		}

		// Apply active mode tool restrictions
		applyModeTools();

		updateStatus(ctx);
		const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
		ctx.ui.notify(
			`Mode: ${agentsMode} (toggle: /agents-mode team|single)\n` +
			`Team: ${activeTeamName} (${members})\n` +
			`Team sets loaded from: ~/.pi/agents/teams.yaml and/or .pi/agents/teams.yaml\n\n` +
			`/agents-team          Select a team\n` +
			`/agents-list          List active agents and status\n` +
			`/agents-view [name]   View full streaming output from agent\n` +
			`/agents-grid <1-6>    Set grid column count\n` +
			`/agents-approval      Dispatch approval mode (off|writes|always)\n` +
			`/agents-mode          Switch mode (team|single)\n` +
			`/agents-auto-edit     Toggle PI_PERM_MODE auto-edit/guarded bridge\n` +
			`Subagent permissions are relayed to this session via IPC`,
			"info",
		);
		refreshTeamChrome(ctx);
	});
}
