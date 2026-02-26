/**
 * ghostty-import — Convert Ghostty terminal themes to Pi themes.
 *
 * Adds a `/ghostty <name>` command that fetches a Ghostty theme from
 * iTerm2-Color-Schemes and converts it to Pi's theme format, then
 * applies it live. Also adds `/ghostty-list` to browse available themes.
 *
 * Usage:
 *   /ghostty dracula       — fetch, convert, and apply the Dracula theme
 *   /ghostty-list          — show all 463 available Ghostty themes
 *   /ghostty-list nord     — filter themes matching "nord"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

// Ghostty theme format: `key = value` per line
interface GhosttyColors {
	bg: string;
	fg: string;
	cursor?: string;
	selectionBg?: string;
	selectionFg?: string;
	palette: Record<number, string>;
}

// ANSI palette index → Pi color mapping
const PALETTE_MAP: Record<number, string> = {
	0: "bgDeep",   // black
	1: "red",
	2: "green",
	3: "yellow",
	4: "blue",
	5: "purple",
	6: "cyan",
	7: "fgSoft",   // white → soft foreground
};

function parseGhosttyTheme(raw: string): GhosttyColors {
	const c: GhosttyColors = { bg: "#1e1e2e", fg: "#cdd6f4", palette: {} };
	for (const line of raw.split("\n")) {
		const l = line.trim();
		if (!l || l.startsWith("#")) continue;
		const eq = l.indexOf("=");
		if (eq === -1) continue;
		const k = l.slice(0, eq).trim();
		const v = l.slice(eq + 1).trim();
		const hex = v.startsWith("#") ? v : `#${v}`;
		switch (k) {
			case "background": c.bg = hex; break;
			case "foreground": c.fg = hex; break;
			case "cursor-color": c.cursor = hex; break;
			case "selection-background": c.selectionBg = hex; break;
			case "selection-foreground": c.selectionFg = hex; break;
			case "palette": {
				const peq = v.indexOf("=");
				if (peq !== -1) {
					const idx = parseInt(v.slice(0, peq), 10);
					const color = v.slice(peq + 1).trim();
					c.palette[idx] = color.startsWith("#") ? color : `#${color}`;
				}
				break;
			}
		}
	}
	return c;
}

/** Simple hex color mixing. Returns hex midpoint at `ratio` between two colors. */
function mix(h1: string, h2: string, r: number): string {
	const p = (h: string, o: number) => parseInt(h.slice(o, o + 2), 16) || 0;
	const c = (a: number, b: number) => Math.round(a + (b - a) * r).toString(16).padStart(2, "0");
	return `#${c(p(h1, 1), p(h2, 1))}${c(p(h1, 3), p(h2, 3))}${c(p(h1, 5), p(h2, 5))}`;
}

/** Convert parsed Ghostty colors to Pi theme JSON. */
function toPiTheme(name: string, g: GhosttyColors): object {
	const red = g.palette[1] || "#ff5555";
	const green = g.palette[2] || "#50fa7b";
	const yellow = g.palette[3] || "#f1fa8c";
	const blue = g.palette[4] || "#bd93f9";
	const purple = g.palette[5] || "#ff79c6";
	const cyan = g.palette[6] || "#8be9fd";
	const orange = mix(red, yellow, 0.5);
	const pink = mix(red, purple, 0.4);
	const comment = g.palette[8] || mix(g.fg, g.bg, 0.5);
	const surface = mix(g.bg, g.fg, 0.08);
	const selection = g.selectionBg || mix(g.bg, g.fg, 0.15);

	return {
		$schema: "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		name,
		vars: {
			bg: g.bg,
			bgDark: mix(g.bg, "#000000", 0.3),
			bgDeep: mix(g.bg, "#000000", 0.5),
			surface,
			selection,
			bgRed: mix(g.bg, red, 0.15),
			bgOrange: mix(g.bg, orange, 0.15),
			bgGreen: mix(g.bg, green, 0.15),
			bgCyan: mix(g.bg, cyan, 0.15),
			bgPurple: mix(g.bg, purple, 0.15),
			bgPink: mix(g.bg, pink, 0.15),
			fg: g.fg,
			fgSoft: mix(g.fg, g.bg, 0.25),
			comment,
			cyan,
			green,
			orange,
			pink,
			purple,
			red,
			yellow,
			blue,
		},
		colors: {
			accent: "purple",
			border: "cyan",
			borderAccent: "purple",
			borderMuted: "surface",
			success: "green",
			error: "red",
			warning: "orange",
			muted: "comment",
			dim: "comment",
			text: "fg",
			thinkingText: "cyan",
			selectedBg: "bgPurple",
			userMessageBg: "bgCyan",
			userMessageText: "fg",
			customMessageBg: "bgCyan",
			customMessageText: "fg",
			customMessageLabel: "cyan",
			toolPendingBg: "bgOrange",
			toolSuccessBg: "bgGreen",
			toolErrorBg: "bgRed",
			toolTitle: "cyan",
			toolOutput: "fgSoft",
			mdHeading: "cyan",
			mdLink: "blue",
			mdLinkUrl: "comment",
			mdCode: "green",
			mdCodeBlock: "fgSoft",
			mdCodeBlockBorder: "surface",
			mdQuote: "purple",
			mdQuoteBorder: "surface",
			mdHr: "surface",
			mdListBullet: "cyan",
			toolDiffAdded: "green",
			toolDiffRemoved: "red",
			toolDiffContext: "comment",
			syntaxComment: "comment",
			syntaxKeyword: "pink",
			syntaxFunction: "green",
			syntaxVariable: "fg",
			syntaxString: "yellow",
			syntaxNumber: "purple",
			syntaxType: "cyan",
			syntaxOperator: "pink",
			syntaxPunctuation: "fgSoft",
			thinkingOff: "surface",
			thinkingMinimal: "comment",
			thinkingLow: "blue",
			thinkingMedium: "purple",
			thinkingHigh: "cyan",
			thinkingXhigh: "pink",
			bashMode: "orange",
		},
	};
}

const THEMES_BASE_URL = "https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/ghostty";
const THEMES_API_URL = "https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/contents/ghostty";

let themeListCache: string[] | null = null;

async function fetchThemeList(): Promise<string[]> {
	if (themeListCache) return themeListCache;
	const res = await fetch(THEMES_API_URL);
	if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
	const files = (await res.json()) as Array<{ name: string }>;
	themeListCache = files.map((f) => f.name);
	return themeListCache;
}

async function fetchTheme(name: string): Promise<string> {
	const url = `${THEMES_BASE_URL}/${encodeURIComponent(name)}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Theme "${name}" not found (${res.status})`);
	return res.text();
}

export default function (pi: ExtensionAPI) {
	// /ghostty <name> — fetch, convert, apply
	pi.registerCommand({
		name: "ghostty",
		description: "Import a Ghostty theme: /ghostty <name>",
		handler: async (args) => {
			const name = args.trim();
			if (!name) {
				pi.addSystemMessage("Usage: `/ghostty <theme-name>` — e.g. `/ghostty Dracula`\nUse `/ghostty-list` to see all available themes.");
				return;
			}

			try {
				pi.addSystemMessage(`⏳ Fetching Ghostty theme: ${name}...`);

				const raw = await fetchTheme(name);
				const parsed = parseGhosttyTheme(raw);
				const piTheme = toPiTheme(name.toLowerCase().replace(/\s+/g, "-"), parsed);

				// Save to .pi/themes/
				const themesDir = path.join(process.cwd(), ".pi", "themes");
				if (!fs.existsSync(themesDir)) {
					fs.mkdirSync(themesDir, { recursive: true });
				}

				const slug = name.toLowerCase().replace(/\s+/g, "-");
				const themePath = path.join(themesDir, `${slug}.json`);
				fs.writeFileSync(themePath, JSON.stringify(piTheme, null, 2));

				pi.addSystemMessage(
					`👻 Ghostty theme "${name}" converted and saved to:\n` +
					`\`.pi/themes/${slug}.json\`\n\n` +
					`Palette: bg=${parsed.bg} fg=${parsed.fg}\n` +
					`Use \`/theme ${slug}\` or restart with \`-t ${slug}\` to apply.`
				);
			} catch (err) {
				pi.addSystemMessage(`❌ Failed to fetch theme: ${(err as Error).message}`);
			}
		},
	});

	// /ghostty-list [filter] — browse available themes
	pi.registerCommand({
		name: "ghostty-list",
		description: "List available Ghostty themes: /ghostty-list [filter]",
		handler: async (args) => {
			try {
				pi.addSystemMessage("⏳ Fetching theme list from GitHub...");

				const themes = await fetchThemeList();
				const filter = args.trim().toLowerCase();
				const filtered = filter
					? themes.filter((t) => t.toLowerCase().includes(filter))
					: themes;

				if (filtered.length === 0) {
					pi.addSystemMessage(`No themes matching "${filter}". ${themes.length} total available.`);
					return;
				}

				// Show in columns
				const cols = 3;
				const rows: string[] = [];
				for (let i = 0; i < filtered.length; i += cols) {
					rows.push(filtered.slice(i, i + cols).map((t) => t.padEnd(30)).join(""));
				}

				pi.addSystemMessage(
					`👻 Ghostty Themes (${filtered.length}${filter ? ` matching "${filter}"` : ""} of ${themes.length}):\n\n` +
					"```\n" + rows.join("\n") + "\n```\n\n" +
					"Use `/ghostty <name>` to import any theme."
				);
			} catch (err) {
				pi.addSystemMessage(`❌ Failed to fetch theme list: ${(err as Error).message}`);
			}
		},
	});
}
