/**
 * agent-loader.ts — Shared agent definition loader with validation
 *
 * SEC-001: All extensions that load agent .md files and pass their content
 * to subprocess spawn() calls MUST use this module instead of raw file reads.
 *
 * Validates:
 *   - Agent name: alphanumeric, dashes, underscores only
 *   - Tools: must be from a known allowlist
 *   - System prompt: scanned for suspicious patterns (shell injection vectors)
 *   - Length: system prompt capped at MAX_SYSTEM_PROMPT_LENGTH
 *
 * Usage:
 *   import { loadAgentFile, scanAgentDirectory, type AgentDef } from "./utils/agent-loader.ts";
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, relative } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

export interface ValidationWarning {
	field: string;
	message: string;
	severity: "error" | "warning";
}

export interface LoadResult {
	agent: AgentDef | null;
	warnings: ValidationWarning[];
}

export interface CollisionWarning {
	name: string;
	duplicatePath: string;
	originalPath: string;
}

export interface ScanResult {
	agents: Map<string, AgentDef>;
	collisions: CollisionWarning[];
}

// ── Constants ──────────────────────────────────────────────────────────

/** Maximum system prompt length in characters. */
export const MAX_SYSTEM_PROMPT_LENGTH = 50_000;

/** Maximum agent name length. */
const MAX_NAME_LENGTH = 64;

/** Pattern for valid agent names: alphanumeric, dashes, underscores, dots. */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Known safe tool names. Extensions can extend this set. */
export const KNOWN_TOOLS = new Set([
	"read", "write", "edit", "bash", "grep", "find", "ls",
	"fetch", "firecrawl", "dispatch_agent", "run_chain",
	"query_experts", "tilldone", "subagent_create",
	"subagent_continue", "subagent_remove", "subagent_list",
]);

/**
 * Patterns that indicate possible shell injection or prompt manipulation
 * in a system prompt body. Each entry has a regex and a human-readable reason.
 */
const SUSPICIOUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\$\(.*\)/, reason: "contains shell command substitution $(…)" },
	{ pattern: /(?:^|[^`])`(rm|dd|mkfs|chmod|chown|kill|curl|wget|sh|bash|eval)\s[^`\n]*`/m, reason: "contains backtick expression with shell command" },
	{ pattern: /\x00/, reason: "contains null byte" },
	{ pattern: /\\\x27/, reason: "contains escaped single quote" },
	{ pattern: /;\s*(rm|dd|mkfs|kill|chmod|chown)\s/, reason: "contains chained destructive shell command" },
	{ pattern: /\|\s*(sh|bash|zsh|dash)\b/, reason: "contains pipe to shell" },
	{ pattern: />\s*\/dev\//, reason: "contains redirect to /dev/" },
	{ pattern: /\beval\s*\(/, reason: "contains eval() call" },
];

// ── Frontmatter Parser ─────────────────────────────────────────────────

interface ParsedFile {
	fields: Record<string, string>;
	body: string;
}

function parseFrontmatter(raw: string): ParsedFile | null {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return null;

	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}

	return { fields, body: match[2] };
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validate an agent name.
 * Returns warnings if the name is invalid.
 */
export function validateName(name: string): ValidationWarning[] {
	const warnings: ValidationWarning[] = [];

	if (!name) {
		warnings.push({ field: "name", message: "agent name is empty", severity: "error" });
		return warnings;
	}

	if (name.length > MAX_NAME_LENGTH) {
		warnings.push({
			field: "name",
			message: `agent name exceeds ${MAX_NAME_LENGTH} characters (got ${name.length})`,
			severity: "error",
		});
	}

	if (!VALID_NAME_PATTERN.test(name)) {
		warnings.push({
			field: "name",
			message: `agent name "${name}" contains invalid characters (allowed: a-z, 0-9, dash, underscore, dot)`,
			severity: "error",
		});
	}

	return warnings;
}

/**
 * Validate a comma-separated tools string.
 * Returns warnings for unknown tools.
 */
export function validateTools(tools: string, knownTools: Set<string> = KNOWN_TOOLS): ValidationWarning[] {
	const warnings: ValidationWarning[] = [];
	if (!tools) return warnings;

	const toolList = tools.split(",").map((t) => t.trim()).filter(Boolean);

	for (const tool of toolList) {
		if (!knownTools.has(tool)) {
			warnings.push({
				field: "tools",
				message: `unknown tool "${tool}" — not in the known tools allowlist`,
				severity: "warning",
			});
		}
	}

	return warnings;
}

/**
 * Validate a system prompt body for suspicious patterns.
 * Returns warnings for each suspicious pattern found.
 */
export function validateSystemPrompt(body: string): ValidationWarning[] {
	const warnings: ValidationWarning[] = [];

	if (body.length > MAX_SYSTEM_PROMPT_LENGTH) {
		warnings.push({
			field: "systemPrompt",
			message: `system prompt exceeds ${MAX_SYSTEM_PROMPT_LENGTH} characters (got ${body.length})`,
			severity: "error",
		});
	}

	for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
		if (pattern.test(body)) {
			warnings.push({
				field: "systemPrompt",
				message: `suspicious content in system prompt: ${reason}`,
				severity: "warning",
			});
		}
	}

	return warnings;
}

/**
 * Run all validations on a parsed agent definition.
 */
export function validateAgent(agent: AgentDef): ValidationWarning[] {
	return [
		...validateName(agent.name),
		...validateTools(agent.tools),
		...validateSystemPrompt(agent.systemPrompt),
	];
}

// ── Loading ────────────────────────────────────────────────────────────

/**
 * Load and validate a single agent .md file.
 *
 * Returns the agent definition and any validation warnings.
 * If there are any "error" severity warnings, agent will be null.
 */
export function loadAgentFile(filePath: string): LoadResult {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		return {
			agent: null,
			warnings: [{
				field: "file",
				message: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
				severity: "error",
			}],
		};
	}

	const parsed = parseFrontmatter(raw);
	if (!parsed) {
		return {
			agent: null,
			warnings: [{
				field: "file",
				message: "file does not have valid frontmatter (---\\n...\\n---)",
				severity: "error",
			}],
		};
	}

	const { fields, body } = parsed;
	const name = fields.name || basename(filePath, ".md");
	const description = fields.description || "";
	const tools = fields.tools || "read,grep,find,ls";
	const systemPrompt = body.trim();

	const agent: AgentDef = {
		name,
		description,
		tools,
		systemPrompt,
		file: filePath,
	};

	const warnings = validateAgent(agent);

	const hasErrors = warnings.some((w) => w.severity === "error");

	return {
		agent: hasErrors ? null : agent,
		warnings,
	};
}

/**
 * Scan a directory recursively for agent .md files, validate each, and return valid agents.
 *
 * Walks nested subdirectories so agents can be organized:
 *   agents/
 *   ├── review_agents/
 *   │   ├── code_reviewer.md
 *   │   └── security_reviewer.md
 *   └── build_agents/
 *       └── ts_builder.md
 *
 * When duplicate agent names are found (case-insensitive), the first one wins
 * and a CollisionWarning is recorded.
 *
 * @param dir        Directory to scan (recursively)
 * @param onWarning  Optional callback for each validation warning
 * @returns          ScanResult with agents map and collision warnings
 */
export function scanAgentDirectory(
	dir: string,
	onWarning?: (file: string, warning: ValidationWarning) => void,
): ScanResult {
	const agents = new Map<string, AgentDef>();
	const collisions: CollisionWarning[] = [];

	if (!existsSync(dir)) return { agents, collisions };

	let files: (string | Buffer)[];
	try {
		files = readdirSync(dir, { recursive: true });
	} catch {
		return { agents, collisions };
	}

	for (const file of files) {
		const rel = typeof file === "string" ? file : file.toString();
		if (!rel.endsWith(".md")) continue;
		const fullPath = resolve(dir, rel);

		// Skip directories that happen to end in .md
		try { if (!statSync(fullPath).isFile()) continue; } catch { continue; }

		const result = loadAgentFile(fullPath);

		if (onWarning) {
			for (const w of result.warnings) {
				onWarning(fullPath, w);
			}
		}

		if (result.agent) {
			const key = result.agent.name.toLowerCase();
			if (agents.has(key)) {
				collisions.push({
					name: result.agent.name,
					duplicatePath: fullPath,
					originalPath: agents.get(key)!.file,
				});
			} else {
				agents.set(key, result.agent);
			}
		}
	}

	return { agents, collisions };
}
