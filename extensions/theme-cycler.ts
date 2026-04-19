/**
 * Theme Cycler — Keyboard shortcuts to cycle through available themes
 *
 * Shortcuts:
 *   Ctrl+X          — Cycle theme forward
 *   Ctrl+Q          — Cycle theme backward
 *
 * Commands:
 *   /theme          — Open select picker to choose a theme
 *   /theme <name>   — Switch directly by name
 *
 * Features:
 *   - Status line shows current theme name with accent color
 *   - Color swatch widget flashes briefly after each switch
 *   - Auto-dismisses swatch after 3 seconds
 *
 * Usage: pi -e extensions/theme-cycler.ts -e extensions/minimal.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

export default function (pi: ExtensionAPI) {
	function persistTheme(themeName: string): void {
		try {
			const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
			const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : "{}";
			const settings = JSON.parse(raw);
			settings.theme = themeName;
			fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		} catch {
			// best-effort
		}
	}

	let currentCtx: ExtensionContext | undefined;
	let swatchTimer: ReturnType<typeof setTimeout> | null = null;

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const name = ctx.ui.theme.name;
		ctx.ui.setStatus("theme", `🎨 ${name}`);
	}

	function showSwatch(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (swatchTimer) {
			clearTimeout(swatchTimer);
			swatchTimer = null;
		}

		ctx.ui.setWidget(
			"theme-swatch",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const block = "\u2588\u2588\u2588";
					const swatch =
						theme.fg("success", block) +
						" " +
						theme.fg("accent", block) +
						" " +
						theme.fg("warning", block) +
						" " +
						theme.fg("dim", block) +
						" " +
						theme.fg("muted", block);
					const label = theme.fg("accent", " 🎨 ") + theme.fg("muted", ctx.ui.theme.name) + "  " + swatch;
					const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
					return [border, truncateToWidth("  " + label, width), border];
				},
			}),
			{ placement: "belowEditor" },
		);

		swatchTimer = setTimeout(() => {
			ctx.ui.setWidget("theme-swatch", undefined);
			swatchTimer = null;
		}, 3000);
	}

	function getThemeList(ctx: ExtensionContext) {
		return ctx.ui.getAllThemes();
	}

	function findCurrentIndex(ctx: ExtensionContext): number {
		const themes = getThemeList(ctx);
		const current = ctx.ui.theme.name;
		return themes.findIndex((t) => t.name === current);
	}

	function cycleTheme(ctx: ExtensionContext, direction: 1 | -1) {
		if (!ctx.hasUI) return;

		const themes = getThemeList(ctx);
		if (themes.length === 0) {
			ctx.ui.notify("No themes available", "warning");
			return;
		}

		let index = findCurrentIndex(ctx);
		if (index === -1) index = 0;

		index = (index + direction + themes.length) % themes.length;
		const theme = themes[index];
		const result = ctx.ui.setTheme(theme.name);
		persistTheme(theme.name);

		if (result.success) {
			updateStatus(ctx);
			showSwatch(ctx);
			ctx.ui.notify(`${theme.name} (${index + 1}/${themes.length})`, "info");
		} else {
			ctx.ui.notify(`Failed to set theme: ${result.error}`, "error");
		}
	}

	// --- Shortcuts ---

	pi.registerShortcut("ctrl+x", {
		description: "Cycle theme forward",
		handler: async (ctx) => {
			currentCtx = ctx;
			cycleTheme(ctx, 1);
		},
	});

	pi.registerShortcut("ctrl+q", {
		description: "Cycle theme backward",
		handler: async (ctx) => {
			currentCtx = ctx;
			cycleTheme(ctx, -1);
		},
	});

	// --- Command: /theme ---

	pi.registerCommand("theme", {
		description: "Select a theme: /theme or /theme <name>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			if (!ctx.hasUI) return;

			const themes = getThemeList(ctx);
			const arg = args.trim();

			if (arg) {
				const result = ctx.ui.setTheme(arg);
				persistTheme(arg);
				if (result.success) {
					updateStatus(ctx);
					showSwatch(ctx);
					ctx.ui.notify(`Theme: ${arg}`, "info");
				} else {
					ctx.ui.notify(`Theme not found: ${arg}. Use /theme to see available themes.`, "error");
				}
				return;
			}

			const items = themes.map((t) => {
				const desc = t.path ? t.path : "built-in";
				const active = t.name === ctx.ui.theme.name ? " (active)" : "";
				return `${t.name}${active} — ${desc}`;
			});

			const selected = await ctx.ui.select("Select Theme", items);
			if (!selected) return;

			const selectedName = selected.split(/\s/)[0];
			const result = ctx.ui.setTheme(selectedName);
			persistTheme(selectedName);
			if (result.success) {
				updateStatus(ctx);
				showSwatch(ctx);
				ctx.ui.notify(`Theme: ${selectedName}`, "info");
			}
		},
	});

	// --- Session init ---

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		applyExtensionDefaults(import.meta.url, ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (swatchTimer) {
			clearTimeout(swatchTimer);
			swatchTimer = null;
		}
	});
}
