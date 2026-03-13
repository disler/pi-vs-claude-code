/**
 * Pushover Notify — sends a Pushover notification whenever Pi finishes
 * responding and is waiting for your input.
 *
 * Fires on `agent_end` and uses heuristics to detect if Pi is asking
 * a question or needs something from you before notifying.
 *
 * Credentials (checked in order):
 *   1. Sidecar config: .pi/extensions/pushover.json  (project)
 *   2. Sidecar config: ~/.pi/agent/extensions/pushover.json  (global)
 *   3. Environment variables: PUSHOVER_API_TOKEN, PUSHOVER_USER_KEY
 *
 * Sidecar JSON format:
 *   { "apiToken": "your_token", "userKey": "your_user_key" }
 *   Both values support "!shell command" syntax for secrets managers.
 *
 * Usage: pi -e extensions/pushover-notify.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface PushoverConfig {
	apiToken?: string;
	userKey?: string;
	/** Only notify when Pi is asking a question / needs input. Default: true */
	onlyWhenAsking?: boolean;
	/** Max characters of the Pi response to include in notification body. Default: 200 */
	summaryLength?: number;
}

function readJson(path: string): PushoverConfig {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function resolveValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("!")) {
		try {
			return execSync(value.slice(1), { encoding: "utf-8" }).trim();
		} catch {
			return undefined;
		}
	}
	return value;
}

function loadConfig(cwd: string): PushoverConfig {
	const globalCfg = readJson(
		join(homedir(), ".pi", "agent", "extensions", "pushover.json")
	);
	const projectCfg = readJson(join(cwd, ".pi", "extensions", "pushover.json"));

	// Project overrides global
	const merged: PushoverConfig = { ...globalCfg, ...projectCfg };

	// Resolve credential values (supports !command syntax)
	return {
		...merged,
		apiToken:
			resolveValue(merged.apiToken) ?? process.env.PUSHOVER_API_TOKEN,
		userKey:
			resolveValue(merged.userKey) ?? process.env.PUSHOVER_USER_KEY,
		onlyWhenAsking: merged.onlyWhenAsking ?? true,
		summaryLength: merged.summaryLength ?? 200,
	};
}

// ---------------------------------------------------------------------------
// Heuristics — does Pi need something from the user?
// ---------------------------------------------------------------------------

function isWaitingForInput(text: string): boolean {
	const trimmed = text.trimEnd();

	// Ends with a question mark
	if (trimmed.endsWith("?")) return true;

	const lastLine = trimmed.split("\n").at(-1)?.toLowerCase() ?? "";

	const actionPhrases = [
		"would you like",
		"do you want",
		"should i",
		"shall i",
		"can you",
		"could you",
		"what would you",
		"which ",
		"how would you",
		"is that ok",
		"is that correct",
		"are you sure",
		"let me know",
		"please let me know",
		"please confirm",
		"please provide",
		"please share",
		"please review",
		"awaiting your",
		"waiting for your",
		"your input",
		"your feedback",
		"your choice",
		"your decision",
		"your confirmation",
	];

	return actionPhrases.some((phrase) => lastLine.includes(phrase));
}

// ---------------------------------------------------------------------------
// Summarise a long response into a compact notification body
// ---------------------------------------------------------------------------

function buildNotificationBody(text: string, maxLength: number): string {
	// Strip markdown fences and leading whitespace
	const cleaned = text
		.replace(/```[\s\S]*?```/g, "[code block]")
		.replace(/`[^`]+`/g, (m) => m.slice(1, -1))
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	if (cleaned.length <= maxLength) return cleaned;

	// Try to cut at a sentence boundary
	const cutoff = cleaned.lastIndexOf(". ", maxLength);
	if (cutoff > maxLength * 0.5) {
		return cleaned.slice(0, cutoff + 1) + " …";
	}

	return cleaned.slice(0, maxLength) + " …";
}

// ---------------------------------------------------------------------------
// Pushover API call
// ---------------------------------------------------------------------------

async function sendPushover(
	token: string,
	userKey: string,
	title: string,
	message: string
): Promise<void> {
	const body = JSON.stringify({
		token,
		user: userKey,
		title,
		message: message || "(no message)",
		// Use high priority so it breaks through quiet hours if Pi is waiting on you
		priority: 0,
	});

	const res = await fetch("https://api.pushover.net/1/messages.json", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});

	if (!res.ok) {
		const err = await res.text().catch(() => res.statusText);
		throw new Error(`Pushover API error ${res.status}: ${err}`);
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());

	const { apiToken, userKey, onlyWhenAsking, summaryLength = 200 } = config;

	if (!apiToken || !userKey) {
		console.warn(
			"[pushover-notify] Missing credentials. " +
				"Set PUSHOVER_API_TOKEN + PUSHOVER_USER_KEY env vars, " +
				"or create .pi/extensions/pushover.json with apiToken + userKey."
		);
		return;
	}

	pi.on("agent_end", async (event: any, _ctx: any) => {
		try {
			const messages: any[] = event.messages ?? [];

			// Get the last assistant message
			const lastAssistant = [...messages]
				.reverse()
				.find((m: any) => m.role === "assistant");

			if (!lastAssistant) return;

			// Extract plain text from the content blocks
			const fullText: string = (lastAssistant.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text as string)
				.join("\n")
				.trim();

			if (!fullText) return;

			const waiting = isWaitingForInput(fullText);

			// If onlyWhenAsking is true, skip silent completions
			if (onlyWhenAsking && !waiting) return;

			const title = waiting
				? "⏳ Pi needs your input"
				: "✅ Pi finished";

			const body = buildNotificationBody(fullText, summaryLength);

			await sendPushover(apiToken, userKey, title, body);
		} catch (err: any) {
			// Non-fatal — don't crash Pi over a failed notification
			console.error("[pushover-notify] Failed to send notification:", err?.message ?? err);
		}
	});
}
