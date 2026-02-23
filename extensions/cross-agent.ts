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
import { wrapTextWithAnsi, visibleWidth } from "@mariozechner/pi-tui";

// --- Synthwave palette ---
function bg(s: string): string {
	return `\x1b[48;2;52;20;58m${s}\x1b[49m`;
}
function pink(s: string): string {
	return `\x1b[38;2;255;126;219m${s}\x1b[39m`;
}
function cyan(s: string): string {
	return `\x1b[38;2;54;249;246m${s}\x1b[39m`;
}
function green(s: string): string {
	return `\x1b[38;2;114;241;184m${s}\x1b[39m`;
}
function yellow(s: string): string {
	return `\x1b[38;2;254;222;93m${s}\x1b[39m`;
}
function dim(s: string): string {
	return `\x1b[38;2;120;100;140m${s}\x1b[39m`;
}
function bold(s: string): string {
	return `\x1b[1m${s}\x1b[22m`;
}

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
			const raw = readFileSync(join(dir, file), "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
			const raw = readFileSync(join(dir, file), "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
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

		// Register commands
		const seenCmds = new Set<string>();
		let totalCommands = 0;
		let totalSkills = 0;
		let totalAgents = 0;

		for (const g of groups) {
			totalSkills += g.skills.length;
			totalAgents += g.agents.length;
			
			for (const cmd of g.commands) {
				if (seenCmds.has(cmd.name)) continue;
				seenCmds.add(cmd.name);
				totalCommands++;
				pi.registerCommand(cmd.name, {
					description: `[${g.source}] ${cmd.description}`.slice(0, 120),
					handler: async (args) => {
						pi.sendUserMessage(expandArgs(cmd.content, args || ""));
					},
				});
			}
		}

		if (groups.length === 0) return;

				// We delay slightly so it doesn't get instantly overwritten by system-select's default startup notify
						setTimeout(() => {
			if (!ctx.hasUI) return;
			// Reduce max width slightly to ensure it never overflows and breaks the next line
			const width = Math.min((process.stdout.columns || 80) - 4, 100); 
			const pad = bg(" ".repeat(width));
			const lines: string[] = [];

			lines.push(""); // space from prev
			
			for (let i = 0; i < groups.length; i++) {
				const g = groups[i];

				// Title with counts
				const counts: string[] = [];
				if (g.skills.length) counts.push(yellow("(") + green(`${g.skills.length}`) + dim(` skill${g.skills.length > 1 ? "s" : ""}`) + yellow(")"));
				if (g.commands.length) counts.push(yellow("(") + green(`${g.commands.length}`) + dim(` command${g.commands.length > 1 ? "s" : ""}`) + yellow(")"));
				if (g.agents.length) counts.push(yellow("(") + green(`${g.agents.length}`) + dim(` agent${g.agents.length > 1 ? "s" : ""}`) + yellow(")"));
				const countStr = counts.length ? "  " + counts.join(" ") : "";
				lines.push(pink(bold(`  ${g.source}`)) + countStr);

				// Build body content
				const items: string[] = [];
				if (g.commands.length) {
					items.push(
						yellow("/") +
						g.commands.map((c) => cyan(c.name)).join(yellow(", /"))
					);
				}
				if (g.skills.length) {
					items.push(
						yellow("/skill:") +
						g.skills.map((s) => cyan(s)).join(yellow(", /skill:"))
					);
				}
				if (g.agents.length) {
					items.push(
						yellow("@") +
						g.agents.map((a) => green(a.name)).join(yellow(", @"))
					);
				}

				const body = items.join("\n");
				
				// Top padding
				lines.push(pad);

				// Wrap body text, cap at 3 rows
				const maxRows = 3;
				const innerWidth = width - 4;
				const wrapped = wrapTextWithAnsi(body, innerWidth);
				const totalItems = g.commands.length + g.skills.length + g.agents.length;
				const shown = wrapped.slice(0, maxRows);

				for (const wline of shown) {
					const vis = visibleWidth(wline);
					const fill = Math.max(0, width - vis - 4);
					lines.push(bg("  " + wline + " ".repeat(fill) + "  "));
				}

				if (wrapped.length > maxRows) {
					const overflow = dim(`  ... ${totalItems - 15 > 0 ? totalItems - 15 : "more"} more`);
					const oVis = visibleWidth(overflow);
					const oFill = Math.max(0, width - oVis - 2);
					lines.push(bg(overflow + " ".repeat(oFill) + "  "));
				}

				// Bottom padding
				lines.push(pad);

				// Spacing between groups
				if (i < groups.length - 1) lines.push("");
			}
			
			// We send it as "info" which forces it to be a raw text element in the chat 
			// without the widget container, but preserving all our ANSI colors!
			ctx.ui.notify(lines.join("\n"), "info");
		}, 100);
	});
}
