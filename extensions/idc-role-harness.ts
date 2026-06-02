import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";

export type IdcRole =
	| "think"
	| "plan"
	| "sequence"
	| "ripple"
	| "build-impl"
	| "build-review"
	| "build-finish";

type GuardMode = "off" | "warn" | "block";

export interface GuardOptions {
	rippleAllowCanonical?: boolean;
}

export interface GuardEvaluation {
	allowed: boolean;
	reason: string;
	allowedRoots: string[];
	blockedSurfaces: string[];
	attemptedPaths?: string[];
}

interface PathPolicy {
	allowedRoots: string[];
	blockedSurfaces: string[];
	allowRepoImplementation?: boolean;
	readOnly?: boolean;
}

interface BashMutation {
	kind: string;
	paths: string[];
	unscoped?: boolean;
}

const IDC_ROLES = new Set<IdcRole>([
	"think",
	"plan",
	"sequence",
	"ripple",
	"build-impl",
	"build-review",
	"build-finish",
]);

const THINK_ALLOWED = [
	"docs/considerations/**",
	"/tmp/pi-idc/think/**",
	"/tmp/ke-idc-think/**",
];

const PLAN_ALLOWED = [
	"docs/prd/**",
	"docs/specs/**",
	"docs/plans/**",
	"docs/workflow/pillar-conflicts/**",
	"docs/workflow/pillar-matrices/**",
	"docs/workflow/phase-planning/**",
	"docs/workflow/audits/**",
	"docs/workflow/handoffs/**",
	"/tmp/pi-idc/plan/**",
	"/tmp/ke-idc-plan/**",
];

const SEQUENCE_ALLOWED = [
	"TRACKER.md",
	"TRACKER-archive.md",
	"docs/workflow/pillar-matrices/**",
	"docs/workflow/audits/**",
	"docs/workflow/code-reviews/**",
	"docs/workflow/handoffs/waves/**",
	"/tmp/pi-idc/sequence/**",
	"/tmp/ke-idc-sequence/**",
];

const RIPPLE_ALLOWED_BASE = [
	"docs/workflow/ripple/**",
	"docs/workflow/audits/**",
	"docs/workflow/handoffs/ripples/**",
	"/tmp/pi-idc/ripple/**",
	"/tmp/ke-idc-ripple/**",
];

const RIPPLE_CANONICAL_ALLOWED = [
	"docs/prd/**",
	"docs/specs/**",
	"docs/plans/**",
	"CLAUDE.md",
	"AGENTS.md",
	"**/CLAUDE.md",
];

const BUILD_ALLOWED_EXPLICIT = [
	"docs/workflow/operator-todos/**",
	"docs/workflow/code-reviews/**",
	"docs/workflow/handoffs/builds/**",
];

const BUILD_IMPL_ALLOWED = [
	"repo source/tests/implementation files except blocked governance surfaces",
	...BUILD_ALLOWED_EXPLICIT,
	"/tmp/pi-idc/build-impl/**",
	"/tmp/ke-idc-build/**",
];

const BUILD_FINISH_ALLOWED = [
	"repo source/tests/implementation files except blocked governance surfaces",
	...BUILD_ALLOWED_EXPLICIT,
	"/tmp/pi-idc/build-finish/**",
	"/tmp/ke-idc-build/**",
];

const BUILD_BLOCKED = [
	"docs/prd/**",
	"docs/specs/**",
	"docs/plans/**",
	"docs/workflow/ripple/**",
	"docs/workflow/pillar-matrices/**",
	"docs/workflow/pillar-conflicts/**",
	"TRACKER.md",
	"TRACKER-archive.md",
	".pi/agents/**",
	"WORKFLOW.md",
	"WORKFLOW-config.yaml",
	"CLAUDE.md",
	"AGENTS.md",
	"**/CLAUDE.md",
];

const SEPARATORS = new Set([";", "&&", "||", "|", "&"]);

// git global options that consume the following token, so the subcommand finder
// must skip both the flag and its value before reading the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

export function isIdcRole(role: string): role is IdcRole {
	return IDC_ROLES.has(role as IdcRole);
}

export function normalizeToolPath(rawPath: string, cwd: string): string {
	let cleaned = String(rawPath || "").trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (cleaned === "~") cleaned = os.homedir();
	else if (cleaned.startsWith("~/")) cleaned = path.join(os.homedir(), cleaned.slice(2));
	return path.normalize(path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned));
}

export function evaluatePathForRole(
	role: IdcRole,
	attemptedPath: string,
	cwd: string,
	options: GuardOptions = {},
): GuardEvaluation {
	const absPath = path.normalize(path.isAbsolute(attemptedPath) ? attemptedPath : normalizeToolPath(attemptedPath, cwd));
	const policy = pathPolicyFor(role, options);

	if (policy.readOnly) {
		return {
			allowed: false,
			reason: `${role} is read-only; file writes are not allowed`,
			allowedRoots: policy.allowedRoots,
			blockedSurfaces: policy.blockedSurfaces,
			attemptedPaths: [absPath],
		};
	}

	if (policy.allowRepoImplementation) {
		if (matchesAny(absPath, cwd, policy.blockedSurfaces)) {
			return {
				allowed: false,
				reason: `path is on a blocked governance/canonical surface for ${role}`,
				allowedRoots: policy.allowedRoots,
				blockedSurfaces: policy.blockedSurfaces,
				attemptedPaths: [absPath],
			};
		}

		const explicitAllowed = policy.allowedRoots.filter((rule) => rule !== "repo source/tests/implementation files except blocked governance surfaces");
		if (matchesAny(absPath, cwd, explicitAllowed) || isInsideOrEqual(path.resolve(cwd), absPath)) {
			return {
				allowed: true,
				reason: "path is inside role implementation authority",
				allowedRoots: policy.allowedRoots,
				blockedSurfaces: policy.blockedSurfaces,
				attemptedPaths: [absPath],
			};
		}

		return {
			allowed: false,
			reason: `path is outside ${role} repo/scratch authority`,
			allowedRoots: policy.allowedRoots,
			blockedSurfaces: policy.blockedSurfaces,
			attemptedPaths: [absPath],
		};
	}

	if (matchesAny(absPath, cwd, policy.allowedRoots)) {
		return {
			allowed: true,
			reason: "path is inside role write authority",
			allowedRoots: policy.allowedRoots,
			blockedSurfaces: policy.blockedSurfaces,
			attemptedPaths: [absPath],
		};
	}

	return {
		allowed: false,
		reason: `path is outside ${role} write authority`,
		allowedRoots: policy.allowedRoots,
		blockedSurfaces: policy.blockedSurfaces,
		attemptedPaths: [absPath],
	};
}

export function evaluateBashForRole(
	role: IdcRole,
	command: string,
	cwd: string,
	options: GuardOptions = {},
): GuardEvaluation {
	const policy = pathPolicyFor(role, options);
	const mutations = analyzeBashCommand(command);
	if (mutations.length === 0) {
		return {
			allowed: true,
			reason: "no obvious mutating bash detected",
			allowedRoots: policy.allowedRoots,
			blockedSurfaces: policy.blockedSurfaces,
		};
	}

	if (role === "build-review") {
		return {
			allowed: false,
			reason: `build-review is read-only; mutating bash blocked (${mutations.map((m) => m.kind).join(", ")})`,
			allowedRoots: policy.allowedRoots,
			blockedSurfaces: policy.blockedSurfaces,
			attemptedPaths: collectMutationPaths(mutations, cwd),
		};
	}

	for (const mutation of mutations) {
		if (isGitFinalizationMutation(mutation)) {
			if (role === "build-finish" && mutation.kind !== "git reset") continue;
			return {
				allowed: false,
				reason: `${mutation.kind} is outside ${role} authority`,
				allowedRoots: policy.allowedRoots,
				blockedSurfaces: policy.blockedSurfaces,
				attemptedPaths: collectMutationPaths([mutation], cwd),
			};
		}

		if (mutation.unscoped || mutation.paths.length === 0) {
			return {
				allowed: false,
				reason: `${mutation.kind} has no safely extractable path`,
				allowedRoots: policy.allowedRoots,
				blockedSurfaces: policy.blockedSurfaces,
			};
		}

		for (const rawPath of mutation.paths) {
			if (isAlwaysAllowedDevice(rawPath)) continue;
			const normalized = normalizeToolPath(rawPath, cwd);
			const pathEval = evaluatePathForRole(role, normalized, cwd, options);
			if (!pathEval.allowed) {
				return {
					allowed: false,
					reason: `${mutation.kind} targets ${normalized}: ${pathEval.reason}`,
					allowedRoots: policy.allowedRoots,
					blockedSurfaces: policy.blockedSurfaces,
					attemptedPaths: [normalized],
				};
			}
		}
	}

	return {
		allowed: true,
		reason: "mutating bash targets are inside role authority",
		allowedRoots: policy.allowedRoots,
		blockedSurfaces: policy.blockedSurfaces,
		attemptedPaths: collectMutationPaths(mutations, cwd),
	};
}

export function analyzeBashCommand(command: string): BashMutation[] {
	const mutations: BashMutation[] = [];
	const tokens = shellWords(command);

	for (let i = 0; i < tokens.length; i++) {
		const token = commandName(tokens[i]);
		if (!token) continue;

		if (["rm", "mkdir", "touch"].includes(token)) {
			mutations.push({ kind: token, paths: extractCommandArgs(tokens, i).filter(isPathLikeArg) });
			continue;
		}

		if (token === "mv") {
			// mv removes every source and writes the destination, so all path
			// operands must be in role authority (not just the destination).
			const args = extractCommandArgs(tokens, i).filter(isPathLikeArg);
			mutations.push({ kind: token, paths: args, unscoped: args.length === 0 });
			continue;
		}

		if (token === "cp") {
			// cp only writes the destination; sources are reads, which roles may do.
			const args = extractCommandArgs(tokens, i).filter(isPathLikeArg);
			mutations.push({ kind: token, paths: args.length > 0 ? [args[args.length - 1]] : [], unscoped: args.length === 0 });
			continue;
		}

		if (token === "ln") {
			// ln creates the link name and (for -s) may point outside authority;
			// treat every path operand as a mutation target.
			const args = extractCommandArgs(tokens, i).filter(isPathLikeArg);
			mutations.push({ kind: token, paths: args, unscoped: args.length === 0 });
			continue;
		}

		if (token === "dd") {
			// dd's write target is a key=value operand (of=<path>), which
			// isPathLikeArg rejects, so read it from the raw args instead.
			const ofArg = extractCommandArgs(tokens, i).find((arg) => arg.startsWith("of="));
			const target = ofArg ? ofArg.slice(3) : undefined;
			mutations.push({ kind: token, paths: target ? [target] : [], unscoped: !target });
			continue;
		}

		if (token === "tee") {
			const paths = extractCommandArgs(tokens, i).filter(isPathLikeArg);
			mutations.push({ kind: "tee", paths, unscoped: paths.length === 0 });
			continue;
		}

		if (token === "sed" && extractCommandArgs(tokens, i).some((arg) => arg === "-i" || arg.startsWith("-i"))) {
			const pathGuess = lastPathLikeArg(extractCommandArgs(tokens, i));
			mutations.push({ kind: "sed -i", paths: pathGuess ? [pathGuess] : [], unscoped: !pathGuess });
			continue;
		}

		if (token === "perl" && extractCommandArgs(tokens, i).some((arg) => /^-[A-Za-z]*p[A-Za-z]*i|^-[A-Za-z]*i[A-Za-z]*p/.test(arg))) {
			const pathGuess = lastPathLikeArg(extractCommandArgs(tokens, i));
			mutations.push({ kind: "perl -pi", paths: pathGuess ? [pathGuess] : [], unscoped: !pathGuess });
			continue;
		}

		if (token === "git") {
			const subcommand = gitSubcommand(extractCommandArgs(tokens, i));
			if (subcommand && ["commit", "merge", "reset"].includes(subcommand)) {
				mutations.push({ kind: `git ${subcommand}`, paths: [], unscoped: true });
			}
			continue;
		}

		if (token === "gh") {
			const args = extractCommandArgs(tokens, i);
			if (args[0] === "pr" && args[1] === "merge") mutations.push({ kind: "gh pr merge", paths: [], unscoped: true });
			continue;
		}
	}

	mutations.push(...extractRedirections(command));

	if (hasUnscopedOneLinerWriter(command)) {
		mutations.push({ kind: "one-liner file writer", paths: [], unscoped: true });
	}

	return mutations;
}

export default async function (pi: ExtensionAPI) {
	const { isToolCallEventType } = await import("@earendil-works/pi-coding-agent");

	pi.registerFlag("idc-role", {
		description: "IDC role name for hard path/bash guardrails",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("idc-guard-mode", {
		description: "IDC guard mode: off, warn, or block",
		type: "string",
		default: process.env.PI_IDC_GUARD_MODE || "block",
	});

	let warnedMissingRole = false;
	let warnedInvalidRole = false;

	pi.on("session_start", async (_event, ctx) => {
		const rawRole = readRawRole(pi);
		if (!rawRole) {
			if (!warnedMissingRole && ctx.hasUI) {
				warnedMissingRole = true;
				ctx.ui.notify("IDC guard loaded without --idc-role; no role path guard active.", "warning");
			}
			return;
		}
		if (!isIdcRole(rawRole)) {
			if (!warnedInvalidRole && ctx.hasUI) {
				warnedInvalidRole = true;
				ctx.ui.notify(`IDC guard role '${rawRole}' is unknown; no role path guard active.`, "error");
			}
			return;
		}

		const mode = readGuardMode(pi);
		const policy = pathPolicyFor(rawRole, readGuardOptions());
		if (ctx.hasUI) {
			ctx.ui.setStatus("idc-role", `IDC: ${rawRole} guard:${mode}`);
			ctx.ui.setTitle(`pi idc:${rawRole}`);
			ctx.ui.notify(`IDC ${rawRole} guard:${mode}. Writes: ${compactRoots(policy.allowedRoots)}`, "info");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const rawRole = readRawRole(pi);
		if (!rawRole || !isIdcRole(rawRole)) return undefined;

		const mode = readGuardMode(pi);
		if (mode === "off") return undefined;

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const attempted = normalizeToolPath(event.input.path, ctx.cwd);
			const evaluation = evaluatePathForRole(rawRole, attempted, ctx.cwd, readGuardOptions());
			return enforceEvaluation({ role: rawRole, mode, tool: event.toolName, attempted, evaluation, ctx });
		}

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			const evaluation = evaluateBashForRole(rawRole, command, ctx.cwd, readGuardOptions());
			return enforceEvaluation({ role: rawRole, mode, tool: "bash", attempted: command, evaluation, ctx });
		}

		return undefined;
	});
}

function pathPolicyFor(role: IdcRole, options: GuardOptions): PathPolicy {
	switch (role) {
		case "think":
			return {
				allowedRoots: THINK_ALLOWED,
				blockedSurfaces: ["canonical docs", "TRACKER.md", "source/tests", "release/merge artifacts"],
			};
		case "plan":
			return {
				allowedRoots: PLAN_ALLOWED,
				blockedSurfaces: ["source/tests", "TRACKER ordering/status", "Build runtime state"],
			};
		case "sequence":
			return {
				allowedRoots: SEQUENCE_ALLOWED,
				blockedSurfaces: ["PRD/spec/master/subphase/pillar plans", "source/tests", "new product scope"],
			};
		case "ripple":
			return {
				allowedRoots: options.rippleAllowCanonical ? [...RIPPLE_ALLOWED_BASE, ...RIPPLE_CANONICAL_ALLOWED] : RIPPLE_ALLOWED_BASE,
				blockedSurfaces: ["source/tests", "tracker scope/order", "ungated canonical edits"],
			};
		case "build-impl":
			return {
				allowedRoots: BUILD_IMPL_ALLOWED,
				blockedSurfaces: BUILD_BLOCKED,
				allowRepoImplementation: true,
			};
		case "build-finish":
			return {
				allowedRoots: BUILD_FINISH_ALLOWED,
				blockedSurfaces: BUILD_BLOCKED,
				allowRepoImplementation: true,
			};
		case "build-review":
			return {
				allowedRoots: ["none (read-only role)"],
				blockedSurfaces: ["all file writes", "all mutating bash"],
				readOnly: true,
			};
	}
}

function readRawRole(pi: ExtensionAPI): string | undefined {
	const role = pi.getFlag("idc-role") as string | undefined;
	return role && role.trim().length > 0 ? role.trim() : undefined;
}

function readGuardMode(pi: ExtensionAPI): GuardMode {
	const mode = String(pi.getFlag("idc-guard-mode") || process.env.PI_IDC_GUARD_MODE || "block").trim();
	return mode === "off" || mode === "warn" || mode === "block" ? mode : "block";
}

function readGuardOptions(): GuardOptions {
	return { rippleAllowCanonical: process.env.PI_IDC_RIPPLE_ALLOW_CANONICAL === "1" };
}

function enforceEvaluation(args: {
	role: IdcRole;
	mode: Exclude<GuardMode, "off">;
	tool: string;
	attempted: string;
	evaluation: GuardEvaluation;
	ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };
}) {
	if (args.evaluation.allowed) return undefined;
	const message = formatGuardMessage(args.role, args.mode, args.tool, args.attempted, args.evaluation);
	if (args.mode === "warn") {
		if (args.ctx.hasUI) args.ctx.ui.notify(message, "warning");
		return undefined;
	}
	if (args.ctx.hasUI) args.ctx.ui.notify(message, "error");
	return { block: true, reason: message };
}

function formatGuardMessage(role: IdcRole, mode: GuardMode, tool: string, attempted: string, evaluation: GuardEvaluation): string {
	return [
		`IDC guard blocked ${tool} for role ${role}.`,
		`Attempted path/command: ${attempted}`,
		`Guard mode: ${mode}`,
		`Reason: ${evaluation.reason}`,
		`Allowed roots: ${evaluation.allowedRoots.join(", ")}`,
		`Blocked surfaces: ${evaluation.blockedSurfaces.join(", ")}`,
	].join("\n");
}

function matchesAny(absPath: string, cwd: string, rules: string[]): boolean {
	return rules.some((rule) => matchesRule(absPath, cwd, rule));
}

function matchesRule(absPath: string, cwd: string, rule: string): boolean {
	if (!rule || rule.includes("source/tests/implementation")) return false;
	if (rule.startsWith("**/")) {
		const suffix = rule.slice(3);
		const rel = normalizeRelative(cwd, absPath);
		return rel === suffix || rel.endsWith(`/${suffix}`);
	}

	if (rule.endsWith("/**")) {
		const baseRule = rule.slice(0, -3);
		const base = path.isAbsolute(baseRule) ? path.normalize(baseRule) : path.resolve(cwd, baseRule);
		return isInsideOrEqual(base, absPath);
	}

	const exact = path.isAbsolute(rule) ? path.normalize(rule) : path.resolve(cwd, rule);
	return path.normalize(absPath) === exact;
}

function normalizeRelative(cwd: string, absPath: string): string {
	return path.relative(path.resolve(cwd), absPath).split(path.sep).join("/");
}

function isInsideOrEqual(base: string, candidate: string): boolean {
	const rel = path.relative(path.normalize(base), path.normalize(candidate));
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;

	const flush = () => {
		if (current.length > 0) words.push(current);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}

		if (/\s/.test(ch)) {
			flush();
			continue;
		}

		if (ch === ";" || ch === "|") {
			flush();
			if ((ch === "|" && next === "|")) {
				words.push("||");
				i++;
			} else {
				words.push(ch);
			}
			continue;
		}

		if (ch === "&") {
			flush();
			if (next === "&") {
				words.push("&&");
				i++;
			} else {
				// A lone & backgrounds the preceding command and separates it
				// from the next, so subsequent tokens are a new command.
				words.push("&");
			}
			continue;
		}

		current += ch;
	}
	flush();
	return words;
}

function commandName(token: string): string | null {
	if (!token || SEPARATORS.has(token)) return null;
	const base = token.split("/").pop() || token;
	return base;
}

function extractCommandArgs(tokens: string[], commandIndex: number): string[] {
	const args: string[] = [];
	for (let i = commandIndex + 1; i < tokens.length; i++) {
		if (SEPARATORS.has(tokens[i])) break;
		args.push(tokens[i]);
	}
	return args;
}

function isPathLikeArg(arg: string): boolean {
	if (!arg || arg.startsWith("-")) return false;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) return false;
	return true;
}

// Resolve a git subcommand, skipping global options (and any value they consume)
// such as `-C <path>` or `-c <name=value>` so they cannot mask `commit`/`reset`.
function gitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (GIT_VALUE_OPTIONS.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

function lastPathLikeArg(args: string[]): string | undefined {
	const candidates = args.filter((arg) => isPathLikeArg(arg) && !arg.startsWith("s/"));
	return candidates[candidates.length - 1];
}

function extractRedirections(command: string): BashMutation[] {
	const mutations: BashMutation[] = [];
	const re = /(?:^|[\s;|&])(?:\d*|&)(>>?|&>)\s*([^\s;&|]+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command)) !== null) {
		let target = match[2].trim();
		target = target.replace(/^['"]|['"]$/g, "");
		mutations.push({ kind: match[1] === ">>" ? "append redirection" : "redirection", paths: target ? [target] : [], unscoped: !target });
	}
	return mutations;
}

function hasUnscopedOneLinerWriter(command: string): boolean {
	if (!/\b(?:python3?|node|bun)\s+-(?:e|c)\b/.test(command)) return false;
	return /(writeFileSync|writeFile|\.write_text\s*\(|open\s*\([^)]*,\s*['"](?:w|a|x)|fs\.(?:write|append|createWriteStream))/.test(command);
}

function isGitFinalizationMutation(mutation: BashMutation): boolean {
	return mutation.kind.startsWith("git ") || mutation.kind === "gh pr merge";
}

function collectMutationPaths(mutations: BashMutation[], cwd: string): string[] {
	return mutations.flatMap((mutation) => mutation.paths.map((raw) => isAlwaysAllowedDevice(raw) ? raw : normalizeToolPath(raw, cwd)));
}

function isAlwaysAllowedDevice(rawPath: string): boolean {
	return rawPath === "/dev/null";
}

function compactRoots(roots: string[]): string {
	if (roots.length <= 4) return roots.join(", ");
	return `${roots.slice(0, 4).join(", ")}, +${roots.length - 4} more`;
}
