/**
 * Tool Counter Widget — Tool call counts in a widget above the editor
 *
 * Shows a persistent, live-updating widget with per-tool themed badges.
 * Format: Tools (N): [Bash 3] [Read 7] [Write 2]
 *
 * Usage: pi -e extensions/tool-counter-widget.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { applyExtensionDefaults } from "./themeMap.ts";

const badgeTokens = [
  "accent",
  "success",
  "warning",
  "error",
  "muted",
  "toolTitle",
] as const;

type BadgeToken = (typeof badgeTokens)[number];

export default function (pi: ExtensionAPI) {
	const counts: Record<string, number> = {};
	const toolBadgeTokens: Record<string, BadgeToken> = {};
	let total = 0;
	let colorIdx = 0;

	pi.on("tool_execution_end", async (event) => {
		if (!(event.toolName in toolBadgeTokens)) {
			toolBadgeTokens[event.toolName] = badgeTokens[colorIdx % badgeTokens.length];
			colorIdx++;
		}
		counts[event.toolName] = (counts[event.toolName] || 0) + 1;
		total++;
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.setWidget("tool-counter", (_tui, theme) => {
			const text = new Text("", 1, 1);

			return {
				render(width: number): string[] {
					const entries = Object.entries(counts);
					const parts = entries.map(([name, count]) => {
						const token = toolBadgeTokens[name] ?? "accent";
						return theme.bg("selectedBg", theme.fg(token, ` ${name} ${count} `));
					});
					text.setText(
						theme.fg("accent", `Tools (${total}):`) +
						(entries.length > 0 ? " " + parts.join(" ") : "")
					);
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	});
}
