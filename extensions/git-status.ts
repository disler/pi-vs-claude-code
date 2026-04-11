/**
 * Git Status Footer — Live git status in the footer bar
 *
 * Shows the current branch plus a colour-coded change summary:
 *   ⎇ main  ✚ 3 staged  ✎ 2 unstaged  ? 1 untracked  ✗ 1 conflict
 *   (or just  ⎇ main  ✓ clean  when the working tree is pristine)
 *
 * Features:
 *  • Polls `git status --porcelain=v1 -b` every 5 s in the background
 *  • Re-polls immediately after every tool call (bash, write, etc.)
 *  • Subscribes to Pi's own branch-change event for instant re-renders
 *  • /gitstatus command — force refresh + show a full summary notification
 *  • Stacks cleanly with theme-cycler (apply your own theme via themeMap)
 *
 * Usage:
 *   pi -e extensions/git-status.ts
 *   pi -e extensions/git-status.ts -e extensions/theme-cycler.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { applyExtensionDefaults } from "./themeMap.ts";

const execAsync = promisify(exec);

// ── Git status shape ───────────────────────────────────────────────────────

interface GitStatus {
	branch: string;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
	ahead: number;
	behind: number;
}

// ── Parse git status --porcelain=v1 -b ────────────────────────────────────

async function fetchGitStatus(cwd: string): Promise<GitStatus | null> {
	try {
		const { stdout } = await execAsync("git status --porcelain=v1 -b", {
			cwd,
			timeout: 3_000,
		});

		let branch = "HEAD";
		let staged = 0;
		let unstaged = 0;
		let untracked = 0;
		let conflicted = 0;
		let ahead = 0;
		let behind = 0;

		for (const line of stdout.split("\n")) {
			// Branch header: ## main...origin/main [ahead 2, behind 1]
			if (line.startsWith("## ")) {
				const header = line.slice(3);
				const branchMatch = header.match(/^([^\s.]+)/);
				if (branchMatch) branch = branchMatch[1];
				const aheadMatch = header.match(/ahead (\d+)/);
				const behindMatch = header.match(/behind (\d+)/);
				if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
				if (behindMatch) behind = parseInt(behindMatch[1], 10);
				continue;
			}

			if (line.length < 2) continue;
			const X = line[0]; // index  (staged)
			const Y = line[1]; // w-tree (unstaged)

			if (X === "?" && Y === "?") {
				untracked++;
			} else if (X === "U" || Y === "U" || (X === "A" && Y === "A") || (X === "D" && Y === "D")) {
				conflicted++;
			} else {
				if (X !== " ") staged++;
				if (Y !== " ") unstaged++;
			}
		}

		return { branch, staged, unstaged, untracked, conflicted, ahead, behind };
	} catch {
		// Not a git repo, git not installed, etc. → hide widget silently.
		return null;
	}
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let status: GitStatus | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	// Reference to the active TUI instance so background polls can trigger renders.
	let activeTui: { requestRender(): void } | null = null;

	// ── Refresh helper ─────────────────────────────────────────────────────

	async function refresh(cwd: string) {
		status = await fetchGitStatus(cwd);
		activeTui?.requestRender();
	}

	// ── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);

		// Initial fetch
		await refresh(ctx.cwd);

		// Background poll every 5 s
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => refresh(ctx.cwd), 5_000);

		// ── Register footer ────────────────────────────────────────────────
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;

			// Re-render whenever Pi detects a branch switch
			const unsubBranch = footerData.onBranchChange(async () => {
				await refresh(ctx.cwd);
				tui.requestRender();
			});

			return {
				dispose() {
					unsubBranch();
					activeTui = null;
				},

				invalidate() {
					// Theme changed — nothing to cache here, render() rebuilds strings each call.
				},

				render(width: number): string[] {
					const dir = basename(ctx.cwd);

					// ── Left side: branch + change counts ──────────────────
					let left: string;

					if (!status) {
						// Not a git repo
						left = theme.fg("dim", ` ${dir}  `) + theme.fg("muted", "no git");
					} else {
						const branchSrc = status.branch || footerData.getGitBranch() || "HEAD";
						left = theme.fg("dim", ` ${dir}  `) + theme.fg("accent", `⎇ ${branchSrc}`);

						// Upstream divergence
						if (status.ahead > 0)  left += theme.fg("success", `  ↑${status.ahead}`);
						if (status.behind > 0) left += theme.fg("warning", `  ↓${status.behind}`);

						const dirty = status.staged + status.unstaged + status.untracked + status.conflicted > 0;

						if (!dirty) {
							left += "  " + theme.fg("success", "✓ clean");
						} else {
							if (status.staged     > 0) left += "  " + theme.fg("success", `✚ ${status.staged}`);
							if (status.unstaged   > 0) left += "  " + theme.fg("warning", `✎ ${status.unstaged}`);
							if (status.untracked  > 0) left += "  " + theme.fg("dim",     `? ${status.untracked}`);
							if (status.conflicted > 0) left += "  " + theme.fg("error",   `✗ ${status.conflicted}`);
						}
					}

					// ── Right side: context usage bar ──────────────────────
					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? 0;
					const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
					const bar = "#".repeat(filled) + "-".repeat(10 - filled);
					const right =
						theme.fg("warning", "[") +
						theme.fg("success", "#".repeat(filled)) +
						theme.fg("dim",     "-".repeat(10 - filled)) +
						theme.fg("warning", "]") +
						theme.fg("dim", ` ${Math.round(pct)}% `);

					// ── Combine with padding ────────────────────────────────
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	});

	// ── Refresh after every tool call (file writes, bash, etc.) ───────────

	pi.on("tool_execution_end", async (_event, ctx) => {
		await refresh(ctx.cwd);
	});

	// ── /gitstatus command ─────────────────────────────────────────────────

	pi.registerCommand("gitstatus", {
		description: "Refresh git status and show a summary notification",
		handler: async (_args, ctx) => {
			await refresh(ctx.cwd);

			if (!status) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			const dirty = status.staged + status.unstaged + status.untracked + status.conflicted;
			const parts: string[] = [`⎇  ${status.branch}`];
			if (status.ahead  > 0)  parts.push(`↑ ${status.ahead} ahead`);
			if (status.behind > 0)  parts.push(`↓ ${status.behind} behind`);
			if (dirty === 0) {
				parts.push("✓ clean");
			} else {
				if (status.staged     > 0) parts.push(`✚ ${status.staged} staged`);
				if (status.unstaged   > 0) parts.push(`✎ ${status.unstaged} unstaged`);
				if (status.untracked  > 0) parts.push(`? ${status.untracked} untracked`);
				if (status.conflicted > 0) parts.push(`✗ ${status.conflicted} conflicted`);
			}

			ctx.ui.notify(parts.join("   "), "info");
		},
	});
}
