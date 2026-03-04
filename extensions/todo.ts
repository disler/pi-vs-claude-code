/**
 * Todo Extension — Lightweight task tracking
 *
 * A clean, non-intrusive todo tracker. The agent can voluntarily use it to
 * organize work without being forced into a rigid workflow. State is stored
 * in tool result details for proper branching support.
 *
 * UI surfaces:
 * - Footer:  compact progress bar + task snapshot
 * - Status:  "📋 3/7 done"
 * - /todos:  interactive overlay with full task list
 *
 * Usage: pi -e extensions/todo.ts
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ──────────────────────────────────────────────────────────────

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "remove" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle/remove)" })),
});

// ── /todos overlay component ───────────────────────────────────────────

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		lines.push(truncateToWidth(
			th.fg("borderMuted", "─".repeat(3)) + title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
			width,
		));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			const total = this.todos.length;
			lines.push(truncateToWidth(
				"  " +
				th.fg("success", `${done} done`) + th.fg("dim", "  ") +
				th.fg("muted", `${total - done} remaining`),
				width,
			));
			lines.push("");

			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;

	// ── Snapshot for details ───────────────────────────────────────────

	const makeDetails = (action: TodoDetails["action"], error?: string): TodoDetails => ({
		action,
		todos: [...todos],
		nextId,
		...(error ? { error } : {}),
	});

	// ── UI refresh ─────────────────────────────────────────────────────

	const refreshUI = (ctx: ExtensionContext) => {
		// Status line
		if (todos.length === 0) {
			ctx.ui.setStatus("📋 no todos", "todo");
		} else {
			const done = todos.filter((t) => t.done).length;
			ctx.ui.setStatus(`📋 ${done}/${todos.length} done`, "todo");
		}

		// Footer
		ctx.ui.setFooter((_tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {});

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					if (todos.length === 0) {
						return [truncateToWidth(theme.fg("dim", " 📋 no todos"), width)];
					}

					const done = todos.filter((t) => t.done).length;
					const total = todos.length;

					// Line 1: progress
					const label = theme.fg("accent", " 📋 Todos ");
					const progress =
						theme.fg("warning", "[") +
						theme.fg("success", `${done}`) +
						theme.fg("dim", "/") +
						theme.fg("success", `${total}`) +
						theme.fg("warning", "]");

					const remaining = total - done;
					const right = remaining > 0
						? theme.fg("muted", `${remaining} remaining `)
						: theme.fg("success", "all done! ");

					const pad = " ".repeat(Math.max(1, width - visibleWidth(label) - visibleWidth(progress) - 1 - visibleWidth(right)));
					const line1 = truncateToWidth(label + progress + pad + right, width, "");

					// Lines 2+: show up to 4 pending tasks, then recent done
					const pending = todos.filter((t) => !t.done);
					const doneTasks = todos.filter((t) => t.done).reverse();
					const visible = [...pending, ...doneTasks].slice(0, 4);
					const extra = total - visible.length;

					const rows = visible.map((t) => {
						const icon = t.done
							? theme.fg("success", "✓")
							: theme.fg("dim", "○");
						const text = t.done
							? theme.fg("dim", t.text)
							: theme.fg("muted", t.text);
						return truncateToWidth(` ${icon} ${text}`, width, "");
					});

					if (extra > 0) {
						rows.push(truncateToWidth(
							` ${theme.fg("dim", `  +${extra} more`)}`,
							width, "",
						));
					}

					return [line1, ...rows];
				},
			};
		});
	};

	// ── State reconstruction from session ──────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}

		refreshUI(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		reconstructState(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ── Register todo tool ─────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list, add (text), toggle (id), remove (id), clear. " +
			"Use this to track tasks, mark progress, and stay organized.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list": {
					const result = {
						content: [{
							type: "text" as const,
							text: todos.length
								? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
								: "No todos",
						}],
						details: makeDetails("list"),
					};
					refreshUI(ctx);
					return result;
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text required for add" }],
							details: makeDetails("add", "text required"),
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					const result = {
						content: [{ type: "text" as const, text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: makeDetails("add"),
					};
					refreshUI(ctx);
					return result;
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for toggle" }],
							details: makeDetails("toggle", "id required"),
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text" as const, text: `Todo #${params.id} not found` }],
							details: makeDetails("toggle", `#${params.id} not found`),
						};
					}
					todo.done = !todo.done;
					const result = {
						content: [{
							type: "text" as const,
							text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`,
						}],
						details: makeDetails("toggle"),
					};
					refreshUI(ctx);
					return result;
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for remove" }],
							details: makeDetails("remove", "id required"),
						};
					}
					const idx = todos.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text" as const, text: `Todo #${params.id} not found` }],
							details: makeDetails("remove", `#${params.id} not found`),
						};
					}
					const removed = todos.splice(idx, 1)[0];
					const result = {
						content: [{ type: "text" as const, text: `Removed todo #${removed.id}: ${removed.text}` }],
						details: makeDetails("remove"),
					};
					refreshUI(ctx);
					return result;
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					const result = {
						content: [{ type: "text" as const, text: `Cleared ${count} todos` }],
						details: makeDetails("clear"),
					};
					refreshUI(ctx);
					return result;
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: makeDetails("list", `unknown action: ${params.action}`),
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);

					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
						theme.fg("accent", `#${added.id}`) + " " +
						theme.fg("muted", added.text),
						0, 0,
					);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("accent", "⟳ ") + theme.fg("muted", msg), 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("warning", "✕ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);

				default:
					return new Text(theme.fg("dim", "done"), 0, 0);
			}
		},
	});

	// ── /todos command ─────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
