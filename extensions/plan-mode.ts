/**
 * Plan Mode Extension
 *
 * Claude Code-style plan mode: read-only exploration → plan creation →
 * execute, save to .plans/, or revise.
 *
 * Usage: pi -e extensions/plan-mode.ts
 *   or:  pi -e extensions/plan-mode.ts --plan
 *
 * Commands:
 *   /plan  — Toggle plan mode (read-only exploration)
 *   /todos — Interactive plan progress viewer
 *   /plans — Browse and preview saved plans from .plans/
 *
 * Shortcut: Ctrl+Alt+P — Toggle plan mode
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Box, Container, Key, matchesKey, type SelectItem, SelectList, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const WIDGET_PLACEMENT = "belowEditor" as const;

// ────────────────────────────────────────────────────────────────
// Bash command filtering
// ────────────────────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
	/\bchmod\b/i, /\bchown\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i, /\bdd\b/i,
	/(^|[^<])>(?!>)/, />>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bbun\s+(add|remove|install|publish|link|update|patch)\b/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
	/^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/, /^\s*file\b/,
	/^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/, /^\s*which\b/,
	/^\s*env\b/, /^\s*printenv\b/, /^\s*uname\b/, /^\s*whoami\b/,
	/^\s*date\b/, /^\s*uptime\b/, /^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*bun\s+(pm\s+(ls|cache)|outdated|run\s+--)/i,
	/^\s*node\s+--version/i, /^\s*python\s+--version/i,
	/^\s*curl\s/i, /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/,
	/^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/,
];

function isSafeCommand(command: string): boolean {
	// Split on pipes and check each segment independently
	const segments = command.split(/\|/).map((s) => s.trim());
	for (const segment of segments) {
		if (DESTRUCTIVE_PATTERNS.some((p) => p.test(segment))) return false;
	}
	// At least the first segment must match a safe pattern
	return SAFE_PATTERNS.some((p) => p.test(segments[0]));
}

// ────────────────────────────────────────────────────────────────
// Plan extraction utilities
// ────────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			let cleaned = text
				.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
				.replace(/`([^`]+)`/g, "$1")
				.replace(/\s+/g, " ")
				.trim();
			if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
			if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 77)}...`;
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
	let count = 0;

	const completeStep = (raw: string | undefined): void => {
		const step = Number(raw);
		if (!Number.isFinite(step)) return;
		const item = items.find((t) => t.step === step && !t.completed);
		if (item) {
			item.completed = true;
			count++;
		}
	};

	// Primary: explicit [DONE:n] tags (allow whitespace variants)
	for (const match of text.matchAll(/\[\s*DONE\s*:\s*(\d+)\s*\]/gi)) {
		completeStep(match[1]);
	}

	// Accept plain DONE markers too (e.g. "DONE 2", "DONE #2")
	for (const match of text.matchAll(/\bDONE\s*#?\s*(\d+)\b/gi)) {
		completeStep(match[1]);
	}

	// Markdown checklist style lines, e.g. "1. ✅ Build thing" or "2. [x] Do task"
	for (const match of text.matchAll(/^\s*(\d+)\.\s*(?:\[x\]|✅|✓|☑|✔)\s+/gim)) {
		completeStep(match[1]);
	}

	// Fallback: natural language patterns like "completed step 3", "step 3 ✓", "step 3 done"
	const nlPatterns = [
		/(?:completed|finished|done with|✓|✅)\s*(?:step\s*)?#?(\d+)/gi,
		/step\s*#?(\d+)\s*(?:is\s+)?(?:completed|finished|done|✓|✅|complete)/gi,
		/\*\*step\s*(\d+)[^*]*\*\*\s*[—–-]\s*(?:completed|done|✓)/gi,
	];
	for (const pattern of nlPatterns) {
		for (const match of text.matchAll(pattern)) {
			completeStep(match[1]);
		}
	}

	return count;
}

function extractRawPlan(messages: AgentMessage[]): string | null {
	const lastAssistant = [...messages].reverse().find(isAssistantMessage);
	if (!lastAssistant) return null;
	const text = getTextContent(lastAssistant);
	const headerMatch = text.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return null;
	return text.slice(text.indexOf(headerMatch[0]));
}

// ────────────────────────────────────────────────────────────────
// File I/O for .plans/
// ────────────────────────────────────────────────────────────────

function savePlan(cwd: string, planContent: string, todoItems: TodoItem[]): string {
	const plansDir = path.join(cwd, ".plans");
	if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	let slug = "plan";
	if (todoItems.length > 0) {
		slug = todoItems[0].text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40);
	}

	const filepath = path.join(plansDir, `${timestamp}-${slug}.md`);
	const checklist = todoItems.map((t) => `- [${t.completed ? "x" : " "}] ${t.text}`).join("\n");
	fs.writeFileSync(filepath, `# Plan\n\n${checklist}\n\n---\n\n## Full Plan\n\n${planContent}\n`, "utf-8");
	return filepath;
}

function listSavedPlans(cwd: string): { name: string; path: string; mtime: Date }[] {
	const plansDir = path.join(cwd, ".plans");
	if (!fs.existsSync(plansDir)) return [];
	return fs.readdirSync(plansDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const fullPath = path.join(plansDir, f);
			const stat = fs.statSync(fullPath);
			return { name: f, path: fullPath, mtime: stat.mtime };
		})
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function planSlugFromFilename(name: string): string {
	return name.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
}

function parseChecklistTodos(content: string): TodoItem[] {
	const loaded: TodoItem[] = [];
	for (const line of content.split("\n")) {
		const match = line.match(/^- \[([ x])\] (.+)/);
		if (!match) continue;
		loaded.push({ step: loaded.length + 1, text: match[2], completed: match[1] === "x" });
	}
	return loaded;
}

// ────────────────────────────────────────────────────────────────
// TUI: Progress bar renderer
// ────────────────────────────────────────────────────────────────

function renderProgressBar(completed: number, total: number, width: number, theme: Theme): string {
	const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
	const label = `${completed}/${total}`;
	const pctLabel = `${pct}%`;
	// bar gutter: ▕...▏ label pct
	const overhead = 2 + 1 + label.length + 1 + pctLabel.length; // ▕▏ + space + label + space + pct
	const barWidth = Math.max(4, width - overhead);
	const filled = Math.round((completed / Math.max(total, 1)) * barWidth);
	const empty = barWidth - filled;

	const filledStr = theme.fg("success", "█".repeat(filled));
	const emptyStr = theme.fg("dim", "░".repeat(empty));
	const bar = `▕${filledStr}${emptyStr}▏`;
	return `${bar} ${theme.fg("accent", label)} ${theme.fg("muted", pctLabel)}`;
}

// ────────────────────────────────────────────────────────────────
// TUI: Interactive /todos overlay component
// ────────────────────────────────────────────────────────────────

class TodoOverlay {
	private todos: TodoItem[];
	private theme: Theme;
	private tui: InstanceType<typeof import("@mariozechner/pi-tui").TUI>;
	private onClose: () => void;
	private onUpdate: () => void;
	private cursor = 0;
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoItem[], theme: Theme, tui: any, onClose: () => void, onUpdate: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.tui = tui;
		this.onClose = onClose;
		this.onUpdate = onUpdate;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
			this.onClose();
			return;
		} else if (matchesKey(data, Key.up) && this.cursor > 0) {
			this.cursor--;
		} else if (matchesKey(data, Key.down) && this.cursor < this.todos.length - 1) {
			this.cursor++;
		} else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
			if (this.todos.length > 0) {
				const item = this.todos[this.cursor];
				item.completed = !item.completed;
				this.onUpdate();
			}
		} else {
			return;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];
		const completed = this.todos.filter((t) => t.completed).length;
		const total = this.todos.length;

		// Top border
		const titleText = " Plan Progress ";
		const borderChar = "─";
		const leftBorder = borderChar.repeat(3);
		const rightBorder = borderChar.repeat(Math.max(0, width - 3 - visibleWidth(titleText)));
		lines.push(truncateToWidth(
			th.fg("accent", leftBorder) + th.fg("accent", th.bold(titleText)) + th.fg("accent", rightBorder),
			width
		));

		// Progress bar
		lines.push("");
		lines.push(truncateToWidth(`  ${renderProgressBar(completed, total, width - 4, th)}`, width));
		lines.push("");

		// Separator
		lines.push(truncateToWidth(th.fg("dim", "  " + "╌".repeat(Math.max(0, width - 4))), width));
		lines.push("");

		// Todo items (scrollable) — adapt to terminal height
		// Chrome: top border + progress bar + separator + blank lines + footer + bottom border ≈ 10 lines
		const termHeight = this.tui.height ?? 24;
		const maxVisible = Math.max(3, termHeight - 10);
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		if (this.cursor >= this.scroll + maxVisible) this.scroll = this.cursor - maxVisible + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - maxVisible)));
		
		const visible = this.todos.slice(this.scroll, this.scroll + maxVisible);

		for (let i = 0; i < visible.length; i++) {
			const todo = visible[i];
			const isSelected = this.scroll + i === this.cursor;
			const stepNum = th.fg("dim", `${String(todo.step).padStart(2)}.`);
			
			let prefix = isSelected ? th.fg("accent", "❯ ") : "  ";
			
			if (todo.completed) {
				const check = th.fg("success", " ✓ ");
				const text = th.fg("muted", th.strikethrough(todo.text));
				let line = `${prefix}${stepNum}${check}${text}`;
				if (isSelected) line = th.bg("selectedBg", line);
				lines.push(truncateToWidth(line, width));
			} else {
				const check = th.fg("warning", " ○ ");
				const text = th.fg("text", todo.text);
				let line = `${prefix}${stepNum}${check}${text}`;
				if (isSelected) line = th.bg("selectedBg", line);
				lines.push(truncateToWidth(line, width));
			}
		}

		if (total > maxVisible) {
			lines.push("");
			lines.push(truncateToWidth(
				`  ${th.fg("dim", `↑↓ scroll (${this.scroll + 1}–${Math.min(this.scroll + maxVisible, total)} of ${total})`)}`,
				width
			));
		}

		// Footer
		lines.push("");
		lines.push(truncateToWidth(th.fg("dim", "  esc/q close  ↑↓ navigate  space/enter toggle"), width));

		// Bottom border
		lines.push(truncateToWidth(th.fg("accent", borderChar.repeat(width)), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ────────────────────────────────────────────────────────────────
// Extension
// ────────────────────────────────────────────────────────────────

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ── Shared helpers ──────────────────────────────────────────

	function completedCount(): number {
		return todoItems.filter((t) => t.completed).length;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
		});
	}

	/** Transition from plan mode into execution mode and send the kickoff message. */
	function startExecution(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = todoItems.length > 0;
		pi.setActiveTools(NORMAL_MODE_TOOLS);
		if (todoItems.length > 0) {
			const slug = todoItems[0].text.slice(0, 50);
			pi.setSessionName(`Plan: ${slug}`);
		}
		updateStatus(ctx);

		const execMessage = todoItems.length > 0
			? `Execute the plan. Start with step 1: ${todoItems[0].text}`
			: "Execute the plan you just created.";
		pi.sendMessage(
			{ customType: "plan-mode-execute", content: execMessage, display: true },
			{ triggerTurn: true },
		);
	}

	function readSessionMessages(ctx: ExtensionContext): AgentMessage[] {
		return ctx.sessionManager.getEntries()
			.filter((entry: any) => entry.type === "message" && entry.message)
			.map((entry: any) => entry.message as AgentMessage);
	}

	function applyLoadedPlan(
		ctx: ExtensionContext,
		loaded: TodoItem[],
		sourceLabel: string,
		emptyMessage: string = "No steps found in saved plan.",
		successMessage?: (steps: number, label: string) => string,
	): boolean {
		if (loaded.length === 0) {
			ctx.ui.notify(emptyMessage, "warning");
			return false;
		}

		todoItems = loaded;
		planModeEnabled = true;
		pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
		persistState();
		const message = successMessage
			? successMessage(loaded.length, sourceLabel)
			: `Loaded plan: ${sourceLabel} (${loaded.length} steps)`;
		ctx.ui.notify(message, "success");
		return true;
	}

	/** Save plan and notify the user. Returns the filepath. */
	function saveAndNotify(ctx: ExtensionContext, messages: AgentMessage[]): string {
		const todoListText = todoItems.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
		const rawPlan = extractRawPlan(messages) ?? todoListText;
		const filepath = savePlan(ctx.cwd, rawPlan, todoItems);
		ctx.ui.notify(`Plan saved → ${path.relative(ctx.cwd, filepath)}`, "success");
		return filepath;
	}

	async function showPlanPreview(ctx: ExtensionContext, selectedPath: string): Promise<void> {
		const content = fs.readFileSync(selectedPath, "utf-8");
		const contentLines = content.split("\n");
		const title = path.basename(selectedPath);

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let scroll = 0;
			return {
				render(width: number): string[] {
					const w = Math.max(20, width);
					const maxLines = Math.max(5, (tui.height ?? 24) - 6);
					const lines: string[] = [];
					const border = (s: string) => theme.fg("accent", s);
					const header = ` ${title} `;

					lines.push(border("─".repeat(2)) + theme.fg("accent", theme.bold(header)) + border("─".repeat(Math.max(0, w - 2 - visibleWidth(header)))));
					lines.push("");

					const visible = contentLines.slice(scroll, scroll + maxLines);
					for (const line of visible) {
						lines.push(truncateToWidth(`  ${theme.fg("text", line)}`, w));
					}

					if (contentLines.length > maxLines) {
						lines.push("");
						lines.push(truncateToWidth(`  ${theme.fg("dim", `↑↓ scroll (${scroll + 1}–${Math.min(scroll + maxLines, contentLines.length)} of ${contentLines.length})`)}`, w));
					}
					lines.push("");
					lines.push(truncateToWidth(theme.fg("dim", "  esc/q close  ↑↓ scroll"), w));
					lines.push(border("─".repeat(w)));
					return lines;
				},
				invalidate() {},
				handleInput(data: string) {
					const maxLines = Math.max(5, (tui.height ?? 24) - 6);
					if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
						done();
					} else if (matchesKey(data, Key.up) && scroll > 0) {
						scroll--;
						tui.requestRender();
					} else if (matchesKey(data, Key.down) && scroll < contentLines.length - maxLines) {
						scroll++;
						tui.requestRender();
					}
				},
			};
		});
	}

	async function promptPlanRevision(ctx: ExtensionContext): Promise<void> {
		const refinement = await ctx.ui.editor("Revise the plan:", "");
		if (refinement?.trim()) {
			pi.sendUserMessage(refinement.trim());
		}
	}

	async function handlePostPlanChoice(
		choice: string,
		ctx: ExtensionContext,
		messages: AgentMessage[],
	): Promise<void> {
		switch (choice) {
			case "execute": {
				startExecution(ctx);
				return;
			}
			case "save-exec": {
				saveAndNotify(ctx, messages);
				startExecution(ctx);
				return;
			}
			case "save": {
				saveAndNotify(ctx, messages);
				const next = await ctx.ui.select("Plan saved. What next?", [
					"▶ Execute it now",
					"✏️  Revise the plan",
					"⏸ Stay in plan mode",
				]);
				if (next?.startsWith("▶")) {
					startExecution(ctx);
				} else if (next?.startsWith("✏️")) {
					await promptPlanRevision(ctx);
				}
				return;
			}
			case "revise": {
				await promptPlanRevision(ctx);
				return;
			}
			default:
				return;
		}
	}

	// ── Status & widget ─────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status badge
		if (executionMode && todoItems.length > 0) {
			const done = completedCount();
			const total = todoItems.length;
			const pct = Math.round((done / total) * 100);
			ctx.ui.setStatus("plan-mode",
				ctx.ui.theme.fg("accent", `📋 ${done}/${total}`) +
				ctx.ui.theme.fg("dim", ` (${pct}%)`)
			);
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "🔍 plan mode"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Execution progress widget — reads live from todoItems (not a snapshot)
		if (executionMode && todoItems.length > 0) {
			ctx.ui.setWidget("plan-todos", (_tui, theme) => {
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				return {
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						const w = Math.max(20, width);
						const th = theme;
						const done = todoItems.filter((t) => t.completed).length;
						const total = todoItems.length;
						const lines: string[] = [];

						lines.push(th.fg("accent", th.bold("▸ Plan Execution")));
						lines.push(renderProgressBar(done, total, w, th));
						lines.push(th.fg("dim", "╌".repeat(Math.min(w, 80))));

						for (const item of todoItems) {
							const num = th.fg("dim", `${String(item.step).padStart(2)}.`);
							if (item.completed) {
								lines.push(truncateToWidth(`${num} ${th.fg("success", "✓")} ${th.fg("muted", th.strikethrough(item.text))}`, w));
							} else {
								lines.push(truncateToWidth(`${num} ${th.fg("warning", "○")} ${item.text}`, w));
							}
						}
						cachedWidth = width;
						cachedLines = lines;
						return lines;
					},
					invalidate() { cachedWidth = undefined; cachedLines = undefined; },
				};
			}, { placement: WIDGET_PLACEMENT });
		} else {
			ctx.ui.setWidget("plan-todos", undefined, { placement: WIDGET_PLACEMENT });
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			pi.setSessionName("Plan: exploring…");
			ctx.ui.notify("Plan mode ON — read-only tools only", "info");
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode OFF — full access restored", "info");
		}
		updateStatus(ctx);
	}

	// ── Custom message renderers ────────────────────────────────

	pi.registerMessageRenderer("plan-todo-list", (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const stepLines = content.split("\n").filter((l: string) => /^\d+\.\s+☐/.test(l.trim()));

		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild({
			render(width: number): string[] {
				const w = Math.max(20, width - 2);
				const lines: string[] = [];
				const borderColor = (s: string) => theme.fg("accent", s);

				const label = " Plan ";
				const leftB = "─".repeat(2);
				lines.push(truncateToWidth(borderColor(leftB) + theme.fg("accent", theme.bold(label)) + borderColor("─".repeat(Math.max(0, w - 2 - visibleWidth(label)))), w));
				lines.push("");

				const display = expanded ? stepLines : stepLines.slice(0, 8);
				for (const line of display) {
					const match = line.match(/^(\d+)\.\s+☐\s+(.*)/);
					if (match) {
						const num = theme.fg("dim", `${match[1].padStart(2)}.`);
						const bullet = theme.fg("warning", " ○ ");
						lines.push(truncateToWidth(`  ${num}${bullet}${theme.fg("text", match[2])}`, w));
					}
				}

				if (!expanded && stepLines.length > 8) {
					lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${stepLines.length - 8} more steps (Ctrl+O to expand)`)}`, w));
				}

				if (stepLines.length === 0) {
					lines.push(truncateToWidth(`  ${theme.fg("text", content)}`, w));
				}

				lines.push("");
				lines.push(borderColor("─".repeat(w)));
				return lines;
			},
			invalidate() {},
		});
		return box;
	});

	pi.registerMessageRenderer("plan-complete", (_message, _opts, theme) => {
		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild({
			render(width: number): string[] {
				const w = Math.max(20, width - 2);
				const border = (s: string) => theme.fg("success", s);
				return [
					border("━".repeat(w)),
					"",
					`  ${theme.fg("success", theme.bold("✓  Plan Complete"))}`,
					"",
					border("━".repeat(w)),
				];
			},
			invalidate() {},
		});
		return box;
	});

	pi.registerMessageRenderer("plan-mode-execute", (_message, _opts, theme) => {
		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild({
			render(width: number): string[] {
				const w = Math.max(20, width - 2);
				return [
					theme.fg("accent", "─".repeat(w)),
					`  ${theme.fg("accent", theme.bold("▶  Executing plan…"))}`,
					theme.fg("accent", "─".repeat(w)),
				];
			},
			invalidate() {},
		});
		return box;
	});

	// ── Commands ────────────────────────────────────────────────

	pi.registerCommand("cancel", {
		description: "Cancel current plan execution",
		handler: async (_args, ctx) => {
			if (!executionMode) {
				ctx.ui.notify("No plan is currently executing.", "warning");
				return;
			}
			executionMode = false;
			todoItems = [];
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persistState();
			ctx.ui.notify("Plan execution cancelled. Normal mode restored.", "info");
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or: /plan save | /plan load <name>",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["save", "load"];
			if (!prefix || subcommands.some((subcommand) => subcommand.startsWith(prefix))) {
				const items = subcommands
					.filter((subcommand) => subcommand.startsWith(prefix || ""))
					.map((subcommand) => ({ value: subcommand, label: subcommand }));
				if (prefix?.startsWith("load ")) {
					const namePrefix = prefix.slice(5);
					const plans = listSavedPlans(process.cwd());
					return plans
						.map((plan) => {
							const slug = planSlugFromFilename(plan.name);
							return { value: `load ${slug || plan.name}`, label: slug || plan.name, description: timeSince(plan.mtime) };
						})
						.filter((item) => !namePrefix || item.label.startsWith(namePrefix));
				}
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (!trimmed) {
				togglePlanMode(ctx);
				return;
			}
			if (trimmed === "save") {
				if (todoItems.length === 0) {
					ctx.ui.notify("No plan to save.", "warning");
					return;
				}
				saveAndNotify(ctx, readSessionMessages(ctx));
				return;
			}
			if (trimmed.startsWith("load")) {
				const name = trimmed.slice(5).trim();
				const plans = listSavedPlans(ctx.cwd);
				const match = plans.find((plan) => {
					const slug = planSlugFromFilename(plan.name);
					return slug === name || plan.name === name;
				});
				if (!match) {
					ctx.ui.notify(`Plan not found: ${name}`, "error");
					return;
				}
				try {
					const content = fs.readFileSync(match.path, "utf-8");
					const loaded = parseChecklistTodos(content);
					applyLoadedPlan(ctx, loaded, path.basename(match.path));
				} catch {
					ctx.ui.notify(`Failed to read: ${match.path}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /plan | /plan save | /plan load <name>", "info");
		},
	});

	pi.registerCommand("todos", {
		description: "Interactive plan progress viewer",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No plan yet. Enable plan mode with /plan first.", "info");
				return;
			}
			if (!ctx.hasUI) {
				const list = todoItems.map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`).join("\n");
				ctx.ui.notify(`Plan Progress:\n${list}`, "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new TodoOverlay(todoItems, theme, tui, () => done(), () => {
					updateStatus(ctx);
					persistState();
				});
			});
		},
	});

	pi.registerCommand("plans", {
		description: "Browse saved plans from .plans/",
		handler: async (_args, ctx) => {
			const plans = listSavedPlans(ctx.cwd);
			if (plans.length === 0) {
				ctx.ui.notify("No saved plans in .plans/", "info");
				return;
			}
			if (!ctx.hasUI) {
				const list = plans.map((p) => `  ${p.name}`).join("\n");
				ctx.ui.notify(`Saved plans:\n${list}`, "info");
				return;
			}

			const items: SelectItem[] = plans.map((plan) => {
				const age = timeSince(plan.mtime);
				const slug = planSlugFromFilename(plan.name);
				return {
					value: plan.path,
					label: slug || plan.name,
					description: age,
				};
			});

			const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(" 📂 Saved Plans")), 1, 0));

				const selectList = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • enter open • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
				};
			});

			if (selected) {
				const action = await ctx.ui.select(`${path.basename(selected)}`, [
					"👁  Preview",
					"📋  Load into plan mode",
					"🗑  Delete",
				]);

				if (action?.startsWith("👁")) {
					try {
						await showPlanPreview(ctx, selected);
					} catch {
						ctx.ui.notify(`Failed to read ${selected}`, "error");
					}
				} else if (action?.startsWith("📋")) {
					try {
						const content = fs.readFileSync(selected, "utf-8");
						const loaded = parseChecklistTodos(content);
						applyLoadedPlan(
							ctx,
							loaded,
							path.basename(selected),
							"No steps found in plan.",
							(steps, label) => `Loaded ${steps} steps from ${label}`,
						);
					} catch {
						ctx.ui.notify(`Failed to read ${selected}`, "error");
					}
				} else if (action?.startsWith("🗑")) {
					const confirm = await ctx.ui.confirm("Delete plan?", `Delete ${path.basename(selected)}?`);
					if (confirm) {
						try {
							fs.unlinkSync(selected);
							ctx.ui.notify(`Deleted ${path.basename(selected)}`, "success");
						} catch {
							ctx.ui.notify(`Failed to delete ${selected}`, "error");
						}
					}
				}
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ── Event: Streaming indicator for plan mode ───────────────

	pi.on("agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			ctx.ui.setWorkingMessage("Analyzing codebase…");
		} else if (executionMode && todoItems.length > 0) {
			const current = todoItems.find((t) => !t.completed);
			if (current) {
				ctx.ui.setWorkingMessage(`Executing step ${current.step}…`);
			}
		}
	});

	// ── Event: Block destructive bash in plan mode ──────────────

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked. Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// ── Event: Filter stale plan-mode context ───────────────────

	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
				}
				return true;
			}),
		};
	});

	// ── Event: Preserve plan state across compaction ────────────

	pi.on("session_before_compact", async (event) => {
		if (!executionMode || todoItems.length === 0) return;

		const completed = todoItems.filter((t) => t.completed);
		const remaining = todoItems.filter((t) => !t.completed);
		const planSummary = [
			"[PLAN STATE — preserved across compaction]",
			`Completed steps (${completed.length}/${todoItems.length}):`,
			...completed.map((t) => `  ✓ ${t.step}. ${t.text}`),
			`Remaining steps:`,
			...remaining.map((t) => `  ○ ${t.step}. ${t.text}`),
		].join("\n");

		return {
			compaction: {
				summary: `${event.preparation.summary ?? ""}\n\n${planSummary}`,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	// ── Event: Inject plan/execution context ────────────────────

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to read-only commands only

Your job:
1. Explore the codebase to understand the task
2. Ask clarifying questions if needed
3. Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes — just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const currentStep = remaining[0];
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN — Full tool access enabled]

Current step: ${currentStep.step}. ${currentStep.text}

Remaining steps:
${todoList}

CRITICAL — PROGRESS TRACKING REQUIREMENT:
After completing EACH step, you MUST write "[DONE:N]" where N is the step number.
Example: After finishing step ${currentStep.step}, write: [DONE:${currentStep.step}]
This tag MUST appear in your text response (not inside a tool call). Without it, progress cannot be tracked.
Write the tag on its own line for clarity.`,
					display: false,
				},
			};
		}
	});

	// ── Event: Track [DONE:n] progress ──────────────────────────

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		// Also scan tool results — [DONE:n] might appear in bash output
		const toolText = event.toolResults
			?.map((tr: any) => {
				if (typeof tr.content === "string") return tr.content;
				if (Array.isArray(tr.content)) return tr.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
				return "";
			})
			.join("\n") ?? "";

		const combined = `${text}\n${toolText}`;
		if (markCompletedSteps(combined, todoItems) > 0) {
			updateStatus(ctx);
			// Update working message for next step
			const next = todoItems.find((t) => !t.completed);
			if (next) {
				ctx.ui.setWorkingMessage(`Executing step ${next.step}…`);
			}
		}
		persistState();
	});

	// ── Event: Post-plan menu ───────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		// Clear working message
		if (planModeEnabled || executionMode) {
			ctx.ui.setWorkingMessage();
		}

		// Final sweep: scan ALL messages for step completion (catches what turn_end missed)
		if (executionMode && todoItems.length > 0) {
			const allText = event.messages
				.filter(isAssistantMessage)
				.map(getTextContent)
				.join("\n");
			const newlyCompleted = markCompletedSteps(allText, todoItems);
			if (newlyCompleted > 0) {
				updateStatus(ctx);
				persistState();
			}
		}

		// Execution complete?
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				pi.sendMessage(
					{ customType: "plan-complete", content: "**Plan Complete!** ✓", display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract plan from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) todoItems = extracted;
		}
		if (todoItems.length === 0) return;

		// Display extracted plan
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		pi.sendMessage(
			{ customType: "plan-todo-list", content: todoListText, display: true },
			{ triggerTurn: false },
		);

		// Custom SelectList post-plan menu
		const menuItems: SelectItem[] = [
			{ value: "execute", label: "▶  Execute the plan", description: "Restore full tools & run steps in order" },
			{ value: "save", label: "💾  Save to .plans/", description: "Write plan as markdown checklist" },
			{ value: "save-exec", label: "💾▶ Save & execute", description: "Save then immediately start execution" },
			{ value: "revise", label: "✏️   Revise the plan", description: "Open editor to refine instructions" },
			{ value: "stay", label: "⏸  Stay in plan mode", description: "Continue read-only exploration" },
		];

		const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(
				theme.fg("accent", theme.bold(` Plan ready — ${todoItems.length} steps`)),
				1, 0
			));

			const selectList = new SelectList(menuItems, menuItems.length, {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc dismiss"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
			};
		});

		if (!choice || choice === "stay") return;
		await handlePostPlanChoice(choice, ctx, event.messages);
	});

	// ── Event: Auto-save on shutdown ────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		if (todoItems.length > 0 && todoItems.some((t) => t.completed)) {
			try {
				const messages = readSessionMessages(ctx);
				savePlan(ctx.cwd, extractRawPlan(messages) ?? "", todoItems);
				persistState();
			} catch {
				// Best-effort save, don't crash on exit
			}
		}
	});

	// ── Event: Session restore ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planModeEnabled = true;

		const entries = ctx.sessionManager.getEntries();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
		}

		// On resume: re-scan for completed steps
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") { executeIndex = i; break; }
			}
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
		}

		if (planModeEnabled) pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
	});
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function timeSince(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
