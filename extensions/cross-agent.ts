/**
 * Cross-Agent — Load commands, skills, and agents from other AI coding agents
 *
 * Scans .claude/, .gemini/, .codex/ directories (project + global) for:
 *   commands/*.md  → registered as /name
 *   skills/        → listed as /skill:name (discovery only)
 *   agents/*.md    → listed as @name (discovery only)
 *
 * Usage: pi -e extensions/cross-agent.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { applyExtensionDefaults } from "./themeMap.ts";
import { truncateToWidth, wrapTextWithAnsi, visibleWidth } from "@mariozechner/pi-tui";


interface Discovered {
	name: string;
	description: string;
	content: string;
}

interface SourceGroup {
	source: string;
	commands: Discovered[];
	skills: string[];
	agents: Discovered[];
}

function parseFrontmatter(raw: string): { description: string; body: string; fields: Record<string, string> } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { description: "", body: raw, fields: {} };

	const front = match[1];
	const body = match[2];
	const fields: Record<string, string> = {};
	for (const line of front.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { description: fields.description || "", body, fields };
}

function expandArgs(template: string, args: string): string {
	const parts = args.split(/\s+/).filter(Boolean);
	let result = template;
	result = result.replace(/\$ARGUMENTS|\$@/g, args);
	for (let i = 0; i < parts.length; i++) {
		result = result.replaceAll(`$${i + 1}`, parts[i]);
	}
	return result;
}

function scanCommands(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { description, body } = parseFrontmatter(raw);
			items.push({
				name: basename(file, ".md"),
				description: description || body.split("\n").find((l) => l.trim())?.trim() || "",
				content: body,
			});
		}
	} catch {}
	return items;
}

function scanSkills(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const names: string[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const skillFile = join(dir, entry, "SKILL.md");
			const flatFile = join(dir, entry);
			if (existsSync(skillFile) && statSync(skillFile).isFile()) {
				names.push(entry);
			} else if (entry.endsWith(".md") && statSync(flatFile).isFile()) {
				names.push(basename(entry, ".md"));
			}
		}
	} catch {}
	return names;
}

function scanAgents(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { fields } = parseFrontmatter(raw);
			items.push({
				name: fields.name || basename(file, ".md"),
				description: fields.description || "",
				content: raw,
			});
		}
	} catch {}
	return items;
}

export default function (pi: ExtensionAPI) {
	const SUMMARY_WIDGET_KEY = "cross-agent-summary";
	let summaryClearTimer: ReturnType<typeof setTimeout> | undefined;
	let summarySetupTimer: ReturnType<typeof setTimeout> | undefined;
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		if (summaryClearTimer) {
			clearTimeout(summaryClearTimer);
			summaryClearTimer = undefined;
		}
		if (summarySetupTimer) {
			clearTimeout(summarySetupTimer);
			summarySetupTimer = undefined;
		}
		if (ctx.hasUI) {
			ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined);
		}
		const home = homedir();
		const cwd = ctx.cwd;
		const providers = ["claude", "gemini", "codex"];
		const groups: SourceGroup[] = [];

		for (const p of providers) {
			for (const [dir, label] of [
				[join(cwd, `.${p}`), `.${p}`],
				[join(home, `.${p}`), `~/.${p}`],
			] as const) {
				const commands = scanCommands(join(dir, "commands"));
				const skills = scanSkills(join(dir, "skills"));
				const agents = scanAgents(join(dir, "agents"));

				if (commands.length || skills.length || agents.length) {
					groups.push({ source: label, commands, skills, agents });
				}
			}
		}

		// Also scan .pi/agents/ (pi-vs-cc pattern)
		const localAgents = scanAgents(join(cwd, ".pi", "agents"));
		if (localAgents.length) {
			groups.push({ source: ".pi/agents", commands: [], skills: [], agents: localAgents });
		}

		// Register commands (first definition wins across providers)
		const seenCmds = new Set<string>();

		for (const g of groups) {
			for (const cmd of g.commands) {
				if (seenCmds.has(cmd.name)) continue;
				seenCmds.add(cmd.name);
				pi.registerCommand(cmd.name, {
					description: `[${g.source}] ${cmd.description}`.slice(0, 120),
					handler: async (args) => {
						pi.sendUserMessage(expandArgs(cmd.content, args || ""));
					},
				});
			}
		}

		if (groups.length === 0) return;

		if (!ctx.hasUI) return;
		// Delay slightly so startup summaries aren't immediately overwritten by other notices
		summarySetupTimer = setTimeout(() => {
			summarySetupTimer = undefined;


			ctx.ui.setWidget(SUMMARY_WIDGET_KEY, (_tui, theme) => {
				return {
					render(width: number): string[] {
						const maxWidth = Math.max(1, Math.min(Math.max(width - 4, 1), 100));
						const horizontalPadding = maxWidth >= 6 ? 2 : 0;
						const sidePad = " ".repeat(horizontalPadding);
						const pad = theme.bg("selectedBg", " ".repeat(maxWidth));
						const lines: string[] = [""];

						for (let i = 0; i < groups.length; i++) {
							const g = groups[i];

							const counts: string[] = [];
							if (g.skills.length) {
								counts.push(
									theme.fg("warning", "(") +
									theme.fg("success", `${g.skills.length}`) +
									theme.fg("dim", ` skill${g.skills.length > 1 ? "s" : ""}`) +
									theme.fg("warning", ")"),
								);
							}
							if (g.commands.length) {
								counts.push(
									theme.fg("warning", "(") +
									theme.fg("success", `${g.commands.length}`) +
									theme.fg("dim", ` command${g.commands.length > 1 ? "s" : ""}`) +
									theme.fg("warning", ")"),
								);
							}
							if (g.agents.length) {
								counts.push(
									theme.fg("warning", "(") +
									theme.fg("success", `${g.agents.length}`) +
									theme.fg("dim", ` agent${g.agents.length > 1 ? "s" : ""}`) +
									theme.fg("warning", ")"),
								);
							}

							const countStr = counts.length ? "  " + counts.join(" ") : "";
							const headerLine = truncateToWidth(
								theme.fg("accent", theme.bold(`  ${g.source}`)) + countStr,
								maxWidth,
								"",
							);
							lines.push(headerLine);

							const items: string[] = [];
							if (g.commands.length) {
								items.push(
									theme.fg("warning", "/") +
									g.commands.map((c) => theme.fg("muted", c.name)).join(theme.fg("warning", ", /")),
								);
							}
							if (g.skills.length) {
								items.push(
									theme.fg("warning", "/skill:") +
									g.skills.map((s) => theme.fg("muted", s)).join(theme.fg("warning", ", /skill:")),
								);
							}
							if (g.agents.length) {
								items.push(
									theme.fg("warning", "@") +
									g.agents.map((a) => theme.fg("success", a.name)).join(theme.fg("warning", ", @")),
								);
							}

							const body = items.join("\n");
							lines.push(pad);

							const maxRows = 3;
							const innerWidth = Math.max(1, maxWidth - horizontalPadding * 2);
							const wrapped = wrapTextWithAnsi(body, innerWidth);
							const shown = wrapped.slice(0, maxRows);

							for (const wrappedLine of shown) {
								const vis = visibleWidth(wrappedLine);
								const fill = Math.max(0, maxWidth - vis - horizontalPadding * 2);
								lines.push(theme.bg("selectedBg", sidePad + wrappedLine + " ".repeat(fill) + sidePad));
							}

							if (wrapped.length > maxRows) {
								const hiddenLineCount = wrapped.length - maxRows;
								const overflowCore = truncateToWidth(
									theme.fg("dim", `... ${hiddenLineCount} more line${hiddenLineCount > 1 ? "s" : ""}`),
									Math.max(1, maxWidth - horizontalPadding * 2),
									"",
								);
								const overflowVisible = visibleWidth(overflowCore);
								const overflowFill = Math.max(0, maxWidth - overflowVisible - horizontalPadding * 2);
								lines.push(theme.bg("selectedBg", sidePad + overflowCore + " ".repeat(overflowFill) + sidePad));
							}

							lines.push(pad);
							if (i < groups.length - 1) lines.push("");
						}

						return lines;
					},
					invalidate() {},
				};
			});

			summaryClearTimer = setTimeout(() => {
				summaryClearTimer = undefined;
				if (!ctx.hasUI) return;
				ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined);
			}, 12000);
		}, 100);
	});
}
