/**
 * coms-net — HTTP/SSE Pi Agent Communication Network (client)
 *
 * Drop-in successor to `extensions/coms.ts` whose substrate is a dedicated
 * Bun HTTP/SSE hub instead of per-agent Unix sockets / named pipes. The
 * user-facing tool surface is renamed for total separation from v1:
 *
 *   tools         coms_net_list / coms_net_send / coms_net_get / coms_net_await
 *   slash command /coms-net
 *   widget key    "coms-net-pool"   (placement: belowEditor only)
 *   audit channel "coms-net-log"
 *   customType    "coms-net-inbound"
 *   status key    "coms-net"
 *   registry root ~/.pi/coms-net/
 *
 * Both `coms.ts` and `coms-net.ts` may be loaded together without identifier
 * collision. v1 stays untouched.
 *
 * Usage:
 *   bun scripts/coms-net-server.ts                                 # start hub
 *   pi -e extensions/coms-net.ts                                   # auto-discover local server.json
 *   pi -e extensions/coms-net.ts --server-url http://host:port \
 *      --auth-token <tok> --cname planner --project default
 *
 * Note: the agent name flag is `--cname` (not `--name`). pi's own harness owns
 * `--name` and resumes it across sessions, so coms-net uses a distinct flag.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
const MAX_HOPS = Number(process.env.PI_COMS_NET_MAX_HOPS) || 5;
const HEARTBEAT_MS = Number(process.env.PI_COMS_NET_HEARTBEAT_MS) || 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const MESSAGE_TIMEOUT_MS = Number(process.env.PI_COMS_NET_MESSAGE_TTL_MS) || 1_800_000;
const HTTP_TIMEOUT_MS = 10_000;
const SHUTDOWN_DELETE_TIMEOUT_MS = 2_000;

const SERVER_URL_ENV = process.env.PI_COMS_NET_SERVER_URL;
const AUTH_TOKEN_ENV = process.env.PI_COMS_NET_AUTH_TOKEN;
const PROJECT_ENV = process.env.PI_COMS_NET_PROJECT;

const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Shared types (canonical block — mirrored on server) ━━━━━━━━━━━━━━━━━━━

type AgentStatus = "online" | "stale" | "offline";
type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

interface AgentCard {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	context_used_pct: number;
	queue_depth: number;
	status: AgentStatus;
}

interface RegisterRequest {
	project: string;
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	explicit: boolean;
}

interface RegisterResponse {
	ok: true;
	agent: AgentCard;
	heartbeat_interval_ms: number;
	sse_url: string;
}

interface HeartbeatRequest {
	project: string;
	context_used_pct: number;
	queue_depth: number;
	model?: string;
	status?: AgentStatus;
}

interface SendRequest {
	project: string;
	sender_session: string;
	target: string;
	target_session: string | null;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
}

interface SendResponse {
	ok: true;
	msg_id: string;
	status: MessageStatus;
	target_session: string;
}

interface ResponseSubmitRequest {
	project: string;
	responder_session: string;
	response: any;
	error: string | null;
}

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	response_schema?: object | null;
	fulfilled: boolean;
}

interface PendingReply {
	resolve: (value: { response?: any; error?: string | null }) => void;
	reject: (err: Error) => void;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
	response_schema?: object | null;
	target_name?: string;
	target_session?: string;
	created_at: string;
}

interface ServerJson {
	version: number;
	project: string;
	pid?: number;
	host?: string;
	port?: number;
	local_url: string;
	public_url?: string;
	started_at?: string;
}

interface ServerSecretJson {
	token: string;
}

class HttpError extends Error {
	status: number;
	body: any;
	constructor(status: number, body: any, message?: string) {
		super(message ?? `HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

// ━━ Helpers — verbatim from coms.ts (lines 131-210) ━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

function hexFg(hex: string, s: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function fallbackColor(sessionId: string): string {
	const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

function parseFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			frontmatter[key] = val;
		}
	}
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		color: frontmatter.color,
		body: match[2],
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function abbreviateModel(model: string): string {
	let m = model || "";
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.length > 14) m = m.slice(0, 14);
	return m;
}

function findSystemPromptPath(argv: string[]): string | null {
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === flag && i + 1 < argv.length) {
				const candidate = argv[i + 1];
				if (candidate.endsWith(".md")) {
					try {
						if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
							return candidate;
						}
					} catch {
						// fall through
					}
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
	const p = findSystemPromptPath(argv);
	if (!p) return {};
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const { name, description, color } = parseFrontmatter(raw);
		return { name, description, color };
	} catch {
		return {};
	}
}

// ━━ Registry / server-discovery I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function projectDir(project: string): string {
	return path.join(COMS_NET_DIR, "projects", project);
}

function readServerJson(project: string): ServerJson | null {
	const p = path.join(projectDir(project), "server.json");
	try {
		if (!fs.existsSync(p)) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerJson;
		if (!parsed || typeof parsed.local_url !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

function readServerSecret(project: string): ServerSecretJson | null {
	const p = path.join(projectDir(project), "server.secret.json");
	try {
		if (!fs.existsSync(p)) return null;
		// Only trust the token if the file is mode 0600.
		const st = fs.statSync(p);
		const mode = st.mode & 0o777;
		if (mode !== 0o600) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerSecretJson;
		if (!parsed || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
		return parsed;
	} catch {
		return null;
	}
}

function resolveServerUrl(project: string, cliFlag: string | undefined): string | null {
	if (cliFlag && cliFlag.length > 0) return cliFlag.replace(/\/+$/, "");
	if (SERVER_URL_ENV && SERVER_URL_ENV.length > 0) return SERVER_URL_ENV.replace(/\/+$/, "");
	const sj = readServerJson(project);
	if (sj && sj.local_url) return sj.local_url.replace(/\/+$/, "");
	return null;
}

function resolveAuthToken(project: string, cliFlag: string | undefined): string | null {
	if (cliFlag && cliFlag.length > 0) return cliFlag;
	if (AUTH_TOKEN_ENV && AUTH_TOKEN_ENV.length > 0) return AUTH_TOKEN_ENV;
	const sec = readServerSecret(project);
	if (sec) return sec.token;
	return null;
}

// ━━ CLI flag shape ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
	serverUrl?: string;
	authToken?: string;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	const name = pi.getFlag("cname") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	const serverUrl = pi.getFlag("server-url") as string | undefined;
	const authToken = pi.getFlag("auth-token") as string | undefined;
	return {
		name: name && name.length > 0 ? name : undefined,
		purpose: purpose && purpose.length > 0 ? purpose : undefined,
		project: project && project.length > 0 ? project : undefined,
		color: color && color.length > 0 ? color : undefined,
		explicit: explicit === true,
		serverUrl: serverUrl && serverUrl.length > 0 ? serverUrl : undefined,
		authToken: authToken && authToken.length > 0 ? authToken : undefined,
	};
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	// ━━ Identity flags ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Agent name flag is `--cname`: pi's harness owns `--name` and resumes it.
	pi.registerFlag("cname", {
		description: "Override coms-net agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("purpose", {
		description: "Override agent purpose (otherwise from frontmatter description)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("project", {
		description: "Project namespace for the coms-net hub",
		type: "string",
		default: "default",
	});
	pi.registerFlag("color", {
		description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("explicit", {
		description: "Hide this agent from auto-discovery; only addressable by exact name",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("server-url", {
		description: "coms-net server base URL (overrides env and local server.json)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("auth-token", {
		description: "Bearer token for the coms-net hub (overrides env and server.secret.json). NEVER logged.",
		type: "string",
		default: undefined,
	});

	// ━━ Module-scope state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let identity: {
		session_id: string;
		name: string;
		purpose: string;
		color: string;
		project: string;
		explicit: boolean;
		cwd: string;
		model: string;
		started_at: string;
	} | null = null;
	let serverUrl: string | null = null;
	let authToken: string | null = null;
	let sseUrlPath: string | null = null;
	const peerCards: Map<string, AgentCard> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	let sseAbort: AbortController | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let reconnectAttempts = 0;
	let notifiedReconnectCap = false;
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	let includeExplicit = false;
	let displayProject: string | null = null;
	let lastWidgetSnapshot = "";
	let shuttingDown = false;

	// ━━ HTTP helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function httpFetch(method: string, urlPath: string, body?: any, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any> {
		if (!serverUrl) throw new Error("coms-net: no server URL");
		if (!authToken) throw new Error("coms-net: no auth token");
		const url = serverUrl + urlPath;
		const headers: Record<string, string> = {
			"Authorization": `Bearer ${authToken}`,
			"Accept": "application/json",
		};
		const init: any = { method, headers };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		// Timeout via AbortController unless caller passed their own signal.
		let timer: any = null;
		const ac = new AbortController();
		const timeoutMs = opts?.timeoutMs ?? HTTP_TIMEOUT_MS;
		if (opts?.signal) {
			init.signal = opts.signal;
		} else {
			init.signal = ac.signal;
			timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
			try { (timer as any).unref?.(); } catch { /* ignore */ }
		}
		let resp: Response;
		try {
			resp = await fetch(url, init);
		} catch (err: any) {
			if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
			throw new Error(`coms-net: fetch failed: ${err?.message ?? String(err)}`);
		}
		if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
		const text = await resp.text();
		let parsed: any = null;
		if (text.length > 0) {
			try { parsed = JSON.parse(text); } catch { parsed = text; }
		}
		if (!resp.ok) {
			throw new HttpError(resp.status, parsed, `HTTP ${resp.status} ${method} ${urlPath}`);
		}
		return parsed;
	}

	// ━━ Audit log helper (never throws) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function audit(event: string, extra: Record<string, any> = {}): void {
		try {
			pi.appendEntry("coms-net-log", { event, ts: nowIso(), ...extra });
		} catch {
			// best-effort
		}
	}

	function elapsedMs(iso: string | undefined): number | null {
		if (!iso) return null;
		const n = Date.parse(iso);
		return Number.isFinite(n) ? Date.now() - n : null;
	}

	function schemaHealth(schema: any, value: any): { ok: boolean; reason?: string } {
		if (!schema || typeof schema !== "object") return { ok: true };
		if (schema.type === "object") {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				return { ok: false, reason: "response is not an object" };
			}
			for (const key of Array.isArray(schema.required) ? schema.required : []) {
				if (!(key in value)) return { ok: false, reason: `missing required field: ${key}` };
			}
		}
		return { ok: true };
	}

	function responseHealth(msg_id: string, status: string, response: any, error: string | null, pending?: PendingReply) {
		const age_ms = elapsedMs(pending?.created_at);
		const health: any = {
			status,
			target: pending?.target_name ?? null,
			target_session: pending?.target_session ?? null,
			age_ms,
			ok: status === "complete" && !error,
			error: error ?? null,
		};
		const schema = schemaHealth(pending?.response_schema, response);
		if (!schema.ok) {
			health.ok = false;
			health.schema_error = schema.reason;
		}
		audit("response_health", { msg_id, ...health });
		return health;
	}

	// ━━ Strip auth token from any user-visible error string ━━━━━━━━━━━━━━━

	function safeError(err: any): string {
		const msg = err instanceof Error ? err.message : String(err);
		if (!authToken) return msg;
		// Defense in depth: never leak the bearer.
		return msg.split(authToken).join("<redacted>");
	}

	// ━━ SSE parser (hand-rolled, no dep) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function makeSseParser(onEvent: (event: string, data: any, id?: string) => void) {
		const decoder = new TextDecoder("utf-8");
		let buf = "";
		return {
			feed(chunk: Uint8Array): void {
				buf += decoder.decode(chunk, { stream: true });
				let idx;
				while ((idx = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					let event = "message";
					const dataLines: string[] = [];
					let id: string | undefined;
					for (const line of frame.split("\n")) {
						if (line.length === 0) continue;
						if (line.startsWith(":")) continue; // SSE comment
						if (line.startsWith("event:")) {
							event = line.slice(6).trimStart();
						} else if (line.startsWith("data:")) {
							let v = line.slice(5);
							if (v.startsWith(" ")) v = v.slice(1);
							dataLines.push(v);
						} else if (line.startsWith("id:")) {
							id = line.slice(3).trimStart();
						}
					}
					if (dataLines.length > 0) {
						const joined = dataLines.join("\n");
						let data: any = joined;
						try { data = JSON.parse(joined); } catch { /* keep as string */ }
						try { onEvent(event, data, id); } catch { /* ignore handler errors */ }
					}
				}
			},
		};
	}

	// ━━ Pool snapshot diff (used to gate widget renders) ━━━━━━━━━━━━━━━━━━━

	function poolSnapshotKey(): string {
		const arr = [...peerCards.values()]
			.map(c => `${c.session_id}|${c.name}|${c.color}|${c.model}|${c.context_used_pct}|${c.queue_depth}|${c.status}|${c.purpose}|${c.explicit ? 1 : 0}`)
			.sort();
		return arr.join("\n");
	}

	function maybeRequestRender(): void {
		const next = poolSnapshotKey();
		if (next === lastWidgetSnapshot) return;
		lastWidgetSnapshot = next;
		// The widget render closure pulls from `peerCards` directly; we just need
		// to re-install / re-render. Pi's TUI invalidates on setWidget no-op; we
		// rely on the next frame.
		if (currentCtx?.hasUI) {
			try {
				installPoolWidget(currentCtx);
			} catch {
				// non-fatal
			}
		}
	}

	// ━━ SSE event dispatch ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function applyAgentPatch(prev: AgentCard, patch: Partial<AgentCard>): AgentCard {
		return { ...prev, ...patch };
	}

	function handleSseEvent(event: string, data: any, _id?: string): void {
		if (!data || typeof data !== "object") return;
		switch (event) {
			case "hello": {
				audit("sse_hello", { server_id: data.server_id, server_time: data.server_time });
				return;
			}
			case "pool_snapshot": {
				peerCards.clear();
				const agents: AgentCard[] = Array.isArray(data.agents) ? data.agents : [];
				for (const a of agents) {
					if (!a || typeof a.session_id !== "string") continue;
					if (identity && a.session_id === identity.session_id) continue;
					peerCards.set(a.session_id, a);
				}
				maybeRequestRender();
				return;
			}
			case "agent_joined": {
				const a: AgentCard | undefined = data.agent;
				if (!a || typeof a.session_id !== "string") return;
				if (identity && a.session_id === identity.session_id) return;
				peerCards.set(a.session_id, a);
				maybeRequestRender();
				return;
			}
			case "agent_updated": {
				const a: Partial<AgentCard> | undefined = data.agent;
				if (!a || typeof a.session_id !== "string") return;
				if (identity && a.session_id === identity.session_id) return;
				const prev = peerCards.get(a.session_id);
				if (prev) {
					peerCards.set(a.session_id, applyAgentPatch(prev, a));
				} else if (a.name && a.color && a.model) {
					// Defensive: treat as a join.
					peerCards.set(a.session_id, a as AgentCard);
				}
				maybeRequestRender();
				return;
			}
			case "agent_stale": {
				const sid: string | undefined = data.session_id;
				if (!sid) return;
				const prev = peerCards.get(sid);
				if (prev) {
					peerCards.set(sid, { ...prev, status: "stale" });
					maybeRequestRender();
				}
				return;
			}
			case "agent_left": {
				const sid: string | undefined = data.session_id;
				if (!sid) return;
				if (peerCards.delete(sid)) {
					maybeRequestRender();
				}
				return;
			}
			case "prompt": {
				handleInboundPrompt(data);
				return;
			}
			case "response": {
				handleInboundResponse(data);
				return;
			}
			case "message_status": {
				// Informational. No-op beyond audit at debug level.
				return;
			}
			case "server_ping": {
				return;
			}
			case "error": {
				audit("sse_error", { code: data.code, message: data.message });
				return;
			}
			default:
				return;
		}
	}

	function handleInboundPrompt(data: any): void {
		const msg_id: string | undefined = data?.msg_id;
		if (!msg_id || typeof msg_id !== "string") return;
		const sender = data.sender ?? {};
		const senderName = typeof sender.name === "string" ? sender.name : "unknown";
		const senderCwd = typeof sender.cwd === "string" ? sender.cwd : "?";
		const senderSession = typeof sender.session_id === "string" ? sender.session_id : "?";
		const promptText = typeof data.prompt === "string" ? data.prompt : "";
		const hops = typeof data.hops === "number" ? data.hops : 0;
		const responseSchema = (data.response_schema && typeof data.response_schema === "object") ? data.response_schema : null;

		const inbound: InboundContext = {
			msg_id,
			hops,
			sender_session: senderSession,
			sender_name: senderName,
			sender_cwd: senderCwd,
			response_schema: responseSchema,
			fulfilled: false,
		};
		inboundQueue.set(msg_id, inbound);
		currentInbound = inbound;

		try {
			pi.sendMessage(
				{
					customType: "coms-net-inbound",
					content:
						`[inbound coms-net message from ${senderName} @ ${senderCwd}]\n` +
						`[reply by writing a normal assistant message — your turn output is auto-returned to ${senderName}. ` +
						`DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop. ` +
						`msg_id ${msg_id} belongs to ${senderName}'s outbound, not yours.]\n\n` +
						`${promptText}`,
					display: true,
					details: {
						msg_id,
						sender_session: senderSession,
						response_schema: responseSchema,
						hops,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			try {
				pi.appendEntry("coms-net-log", {
					event: "prompt_in",
					ts: nowIso(),
					msg_id,
					sender: senderSession,
					hops,
				});
			} catch { /* best-effort */ }
		} catch (err) {
			inboundQueue.delete(msg_id);
			currentInbound = null;
			audit("prompt_in_failed", { msg_id, reason: safeError(err) });
		}
	}

	function handleInboundResponse(data: any): void {
		const msg_id: string | undefined = data?.msg_id;
		if (!msg_id) return;
		const responseVal = data.response;
		const errVal: string | null = typeof data.error === "string" ? data.error : null;
		const pending = pendingReplies.get(msg_id);
		if (pending) {
			pending.result = { response: responseVal, error: errVal };
			try { pending.resolve(pending.result); } catch { /* ignore */ }
			try {
				pi.appendEntry("coms-net-log", {
					event: "response_in",
					ts: nowIso(),
					msg_id,
					error: errVal,
				});
			} catch { /* best-effort */ }
		} else {
			audit("orphan_response", { msg_id });
		}
	}

	// ━━ SSE open + read loop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function openSse(): Promise<void> {
		if (!serverUrl || !authToken || !sseUrlPath || !identity) return;
		if (sseAbort) {
			try { sseAbort.abort(); } catch { /* ignore */ }
		}
		const ac = new AbortController();
		sseAbort = ac;
		const url = serverUrl + sseUrlPath;
		const headers: Record<string, string> = {
			"Authorization": `Bearer ${authToken}`,
			"Accept": "text/event-stream",
		};
		let resp: Response;
		try {
			resp = await fetch(url, { method: "GET", headers, signal: ac.signal });
		} catch (err: any) {
			audit("sse_connect_failed", { reason: safeError(err) });
			scheduleReconnect();
			return;
		}
		if (!resp.ok || !resp.body) {
			audit("sse_connect_http_error", { status: resp.status });
			scheduleReconnect();
			return;
		}
		// Connection established. Reset the backoff state.
		reconnectAttempts = 0;
		notifiedReconnectCap = false;
		try {
			pi.appendEntry("coms-net-log", { event: "sse_open", ts: nowIso(), url: sseUrlPath });
		} catch { /* best-effort */ }

		const parser = makeSseParser((event, data, id) => handleSseEvent(event, data, id));
		const reader = resp.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) parser.feed(value);
			}
			audit("sse_disconnect", { reason: "stream_end" });
		} catch (err: any) {
			if (ac.signal.aborted) {
				audit("sse_disconnect", { reason: "aborted" });
				return;
			}
			audit("sse_disconnect", { reason: safeError(err) });
		} finally {
			try { reader.releaseLock(); } catch { /* ignore */ }
		}
		if (!shuttingDown) {
			scheduleReconnect();
		}
	}

	function scheduleReconnect(): void {
		if (shuttingDown) return;
		if (reconnectTimer) return;
		const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
		reconnectAttempts++;
		audit("sse_reconnect_scheduled", { attempt: reconnectAttempts, backoff_ms: backoff });
		if (backoff >= RECONNECT_MAX_MS && !notifiedReconnectCap) {
			notifiedReconnectCap = true;
			if (currentCtx?.hasUI) {
				try { currentCtx.ui.notify("📡 coms-net: reconnect backoff at ceiling", "warning"); } catch { /* ignore */ }
			}
		}
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = null;
			if (shuttingDown) return;
			try {
				await reRegisterAndOpen();
			} catch (err) {
				audit("sse_reconnect_failed", { reason: safeError(err) });
				scheduleReconnect();
			}
		}, backoff);
		try { (reconnectTimer as any).unref?.(); } catch { /* ignore */ }
	}

	async function reRegisterAndOpen(): Promise<void> {
		if (!identity) return;
		// Re-register (server upserts), then re-open SSE.
		const reg = await registerAgent();
		sseUrlPath = reg.sse_url;
		audit("sse_reconnect", { attempt: reconnectAttempts });
		// Fire and forget; openSse manages its own lifecycle.
		void openSse();
	}

	// ━━ Registration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function registerAgent(): Promise<RegisterResponse> {
		if (!identity) throw new Error("coms-net: not initialised");
		const ctx = currentCtx;
		const req: RegisterRequest = {
			project: identity.project,
			session_id: identity.session_id,
			name: identity.name,
			purpose: identity.purpose,
			model: ctx?.model?.id ?? identity.model,
			color: identity.color,
			cwd: identity.cwd,
			explicit: identity.explicit,
		};
		const resp = await httpFetch("POST", "/v1/agents/register", req) as RegisterResponse;
		if (!resp || !resp.agent) {
			throw new Error("coms-net: malformed register response");
		}
		// Server may auto-suffix the name on collision.
		if (resp.agent.name !== identity.name) {
			try {
				pi.appendEntry("coms-net-log", {
					event: "name_collision",
					ts: nowIso(),
					desired: identity.name,
					assigned: resp.agent.name,
					project: identity.project,
				});
			} catch { /* best-effort */ }
			identity.name = resp.agent.name;
		}
		try {
			pi.appendEntry("coms-net-log", {
				event: "register",
				ts: nowIso(),
				session_id: identity.session_id,
				name: identity.name,
				project: identity.project,
			});
		} catch { /* best-effort */ }
		return resp;
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;

		// 1. Resolve identity from CLI > frontmatter > defaults.
		const flags = readCliFlags(pi);
		const fm = readFrontmatterFromArgv(process.argv);
		const project = flags.project || PROJECT_ENV || "default";
		const explicit = flags.explicit === true;
		const session_id = ulid();

		const defaultName = `agent-${session_id.slice(-6)}`;
		const desiredName = flags.name || fm.name || defaultName;
		const purpose = flags.purpose || fm.description || "";

		// Color — fallback chain: --color > frontmatter > deterministic.
		let color = fallbackColor(session_id);
		if (fm.color && isValidHex(fm.color)) color = fm.color;
		if (flags.color && isValidHex(flags.color)) color = flags.color;

		const cwd = ctx.cwd || process.cwd();
		const model = ctx.model?.id ?? "unknown";
		const started_at = nowIso();

		identity = {
			session_id,
			name: desiredName,
			purpose,
			color,
			project,
			explicit,
			cwd,
			model,
			started_at,
		};
		displayProject = project;
		includeExplicit = false;

		// 2. Resolve server URL.
		serverUrl = resolveServerUrl(project, flags.serverUrl);
		if (!serverUrl) {
			ctx.ui?.notify?.(
				`📡 coms-net: no server URL for project "${project}". Start one with: bun scripts/coms-net-server.ts`,
				"error",
			);
			audit("boot_failed", { reason: "no_server_url", project });
			return;
		}

		// 3. Resolve auth token.
		authToken = resolveAuthToken(project, flags.authToken);
		if (!authToken) {
			ctx.ui?.notify?.(
				`📡 coms-net: no auth token for project "${project}". Set PI_COMS_NET_AUTH_TOKEN or pass --auth-token. ` +
				`If running a local server, ensure ~/.pi/coms-net/projects/${project}/server.secret.json exists with mode 0600.`,
				"error",
			);
			audit("boot_failed", { reason: "no_auth_token", project });
			return;
		}

		// 4. Health check — verify reachability without consuming auth surface.
		try {
			await httpFetch("GET", "/health");
		} catch (err) {
			ctx.ui?.notify?.(
				`📡 coms-net: server unreachable at ${serverUrl} — ${safeError(err)}. ` +
				`Start one with: bun scripts/coms-net-server.ts`,
				"error",
			);
			audit("boot_failed", { reason: "health_failed", error: safeError(err) });
			return;
		}

		// 5. Register agent.
		let reg: RegisterResponse;
		try {
			reg = await registerAgent();
		} catch (err) {
			ctx.ui?.notify?.(
				`📡 coms-net: register failed — ${safeError(err)}`,
				"error",
			);
			audit("boot_failed", { reason: "register_failed", error: safeError(err) });
			return;
		}
		sseUrlPath = reg.sse_url;

		// 6. Boot audit.
		try {
			pi.appendEntry("coms-net-log", {
				event: "boot",
				ts: nowIso(),
				session_id: identity.session_id,
				name: identity.name,
				project: identity.project,
				server_url: serverUrl,
			});
		} catch { /* best-effort */ }

		// 7. Install widget + status. Success is the default — only failures notify
		// (status line + widget already convey the connected state).
		try {
			ctx.ui.setStatus("coms-net", `📡 ${identity.name}@${identity.project}`);
			installPoolWidget(ctx);
		} catch {
			// hasUI may be false in some contexts.
		}

		// 8. Open SSE — fire and forget.
		void openSse();

		// 9. Heartbeat loop.
		heartbeatTimer = setInterval(() => {
			if (!identity || shuttingDown) return;
			const ctxNow = currentCtx;
			const pct = Math.round(ctxNow?.getContextUsage()?.percent ?? 0);
			const hbReq: HeartbeatRequest = {
				project: identity.project,
				context_used_pct: pct,
				queue_depth: inboundQueue.size,
				model: ctxNow?.model?.id ?? identity.model,
				status: "online",
			};
			httpFetch("POST", `/v1/agents/${encodeURIComponent(identity.session_id)}/heartbeat`, hbReq, { timeoutMs: 5_000 })
				.catch((err) => {
					audit("heartbeat_failed", { reason: safeError(err) });
				});
		}, HEARTBEAT_MS);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
	});

	// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function renderPool(width: number, theme: Theme): string[] {
		interface Row {
			name: string;
			model: string;
			color: string;
			purpose: string;
			pct: number | null;
			pending: boolean;
			stale: boolean;
		}

		const rows: Row[] = [];
		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			if (!includeExplicit && card.explicit) continue;
			rows.push({
				name: card.name,
				model: card.model,
				color: card.color,
				purpose: card.purpose,
				pct: typeof card.context_used_pct === "number" ? card.context_used_pct : null,
				pending: card.status === "stale",
				stale: card.status === "offline",
			});
		}

		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 16) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms-net ");
			const leftFill = theme.fg("dim", "━");
			const nameLen = identity ? identity.name.length : 0;
			const rightTagVisLen = identity ? nameLen + 4 : 0;
			// "┏━ coms-net ━" prefix has 13 visible cells.
			const remaining = safeWidth - 13 - rightTagVisLen - 1; // -1 for "┓"
			if (identity && remaining >= 1) {
				const rightTag =
					theme.fg("dim", " ") +
					hexFg(identity.color, identity.name) +
					theme.fg("dim", " ━");
				const middle = theme.fg("dim", "━".repeat(remaining));
				const right = theme.fg("dim", "┓");
				topBorder = left + leftFill + middle + rightTag + right;
			} else {
				const fallbackRemaining = Math.max(0, safeWidth - 2 /* "┏━" */ - 10 /* " coms-net " */ - 1 /* "┓" */);
				const right = theme.fg("dim", "━".repeat(fallbackRemaining) + "┓");
				topBorder = left + right;
			}
			bottomBorder = theme.fg("dim", "┗" + "━".repeat(safeWidth - 2) + "┛");
		}

		if (rows.length === 0) {
			const emptyMsg = theme.fg("muted", "no peers connected");
			return [
				topBorder,
				truncateToWidth(theme.fg("dim", " ") + emptyMsg, width),
				bottomBorder,
			];
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));

		const out: string[] = [topBorder];

		for (const r of rows) {
			const pctNum = r.pct ?? 0;
			const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
			const empty = 15 - filled;
			const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;

			if (r.stale) {
				const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
				out.push(truncateToWidth(" " + theme.fg("dim", dimRow), width));
				continue;
			}

			const swatch = r.pending ? theme.fg("dim", "●") : hexFg(r.color, "●");
			const namePart = theme.fg("accent", r.name.padEnd(12));
			const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
			const barFill = r.pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(r.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
			const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
			const pctPart = " " + theme.fg("accent", pctLabel.padStart(4));
			const sep = theme.fg("dim", "  —  ");
			const purposePart = theme.fg("muted", r.purpose || "");

			const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + sep + purposePart;
			out.push(truncateToWidth(line, width));
		}

		out.push(bottomBorder);
		return out;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-net-pool", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}), { placement: "belowEditor" });
		} catch {
			// non-fatal
		}
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "coms_net_list",
		label: "Coms Net List",
		description:
			"List peer agents on the coms-net hub for the current project. Returns names, models, and live context-window usage. " +
			"Set include_explicit=true to reveal agents launched with --explicit.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name (defaults to caller's project)." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms-net not initialised");
			}
			const projectFilter = (params as any).project ?? identity.project;
			const includeExp = (params as any).include_explicit === true;
			const qs = `?project=${encodeURIComponent(projectFilter)}&include_explicit=${includeExp ? "true" : "false"}`;
			const resp = await httpFetch("GET", `/v1/agents${qs}`);
			const agents: AgentCard[] = Array.isArray(resp?.agents) ? resp.agents : [];
			const peers = agents.filter(a => a.session_id !== identity!.session_id);

			const lines = peers.length === 0
				? "No peer agents found."
				: peers.map((a) => {
					const live = a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗";
					const ctxStr = typeof a.context_used_pct === "number" ? ` ${a.context_used_pct}%` : " ?%";
					return `${live} ${a.name} (${abbreviateModel(a.model)})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${peers.length} peer(s):\n${lines}` }],
				details: { agents: peers, project: projectFilter },
			};
		},
		renderCall(args, theme) {
			const proj = (args as any).project;
			const filter = proj ? ` ${proj}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_list")) + theme.fg("dim", filter),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			const agents: any[] = details?.agents ?? [];
			const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) {
				return new Text(header, 0, 0);
			}
			const rows = agents.map((a) => {
				const dot = a.status === "online" ? theme.fg("success", "●")
					: a.status === "stale" ? theme.fg("warning", "~")
					: theme.fg("error", "✗");
				const pct = typeof a.context_used_pct === "number" ? `${a.context_used_pct}%` : "?%";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", abbreviateModel(a.model))} ${theme.fg("warning", pct)}`;
			}).join("\n");
			return new Text(header + "\n" + rows, 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_net_send",
		label: "Coms Net Send",
		description:
			"INITIATE a new outbound message to a peer agent on the coms-net hub. " +
			"Returns synchronously with a msg_id once the server queues the prompt. " +
			"Use coms_net_get (non-blocking) or coms_net_await (blocking) with that msg_id to retrieve the peer's reply.\n\n" +
			"⚠️  DO NOT call this tool to REPLY to an inbound message. " +
			"When you receive a `[from <peer>] …` follow-up, just write your answer as your normal assistant message — " +
			"the coms-net extension automatically captures the final assistant text at the end of your turn and " +
			"submits it back to the original caller. Calling coms_net_send in response creates an infinite ping-pong loop.\n\n" +
			"Only valid uses: (a) you, the user, or your task explicitly ask to start a new conversation with a peer; " +
			"(b) you are forwarding/delegating to a *different* peer than the one whose prompt you are currently answering; " +
			"in that case `hops` is auto-incremented and the hop limit will eventually stop runaway chains.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred, scoped to your project) or session_id." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms-net not initialised");

			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms-net: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}

			const req: SendRequest = {
				project: identity.project,
				sender_session: identity.session_id,
				target: params.target,
				target_session: null,
				prompt: params.prompt,
				conversation_id: (params as any).conversation_id ?? null,
				response_schema: ((params as any).response_schema as object | undefined) ?? null,
				hops,
			};

			let resp: SendResponse;
			try {
				resp = await httpFetch("POST", "/v1/messages", req) as SendResponse;
			} catch (err) {
				if (err instanceof HttpError) {
					const detail = (err.body && err.body.error) || err.message;
					throw new Error(`coms-net: send failed (${err.status}): ${detail}`);
				}
				throw new Error(`coms-net: send failed: ${safeError(err)}`);
			}
			const { msg_id, target_session } = resp;

			// Park a pending entry that the SSE `response` event will resolve.
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			let rejectFn!: (e: Error) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res, rej) => {
				resolveFn = res;
				rejectFn = rej;
			});
			pendingReplies.set(msg_id, {
				resolve: resolveFn,
				reject: rejectFn,
				promise,
				response_schema: req.response_schema,
				target_name: params.target,
				target_session,
				created_at: nowIso(),
			});

			try {
				pi.appendEntry("coms-net-log", {
					event: "prompt_out",
					ts: nowIso(),
					msg_id,
					target: params.target,
					target_session,
					hops,
				});
			} catch { /* best-effort */ }

			return {
				content: [{
					type: "text" as const,
					text: `coms_net_send → ${params.target}\nmsg_id ${msg_id}\nhops ${hops}`,
				}],
				details: { msg_id, target: params.target, target_session, hops },
			};
		},
		renderCall(args, theme) {
			const tgt = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_send ")) +
				theme.fg("accent", tgt) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", "→ ") +
				theme.fg("accent", d.target) +
				theme.fg("dim", `  msg_id `) +
				theme.fg("warning", d.msg_id),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "coms_net_get",
		label: "Coms Net Get",
		description:
			"Non-blocking poll of a reply to YOUR OWN coms_net_send. Returns status pending|complete|error and (when complete) the response. " +
			"Same caveat as coms_net_await: only use msg_ids you got back from coms_net_send, never msg_ids from an inbound `[from <peer>] …` prompt — " +
			"those belong to the peer, and replying to them happens automatically via your normal assistant message at end of turn.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_net_send." }),
		}),
		async execute(_callId, params) {
			const msg_id = (params as any).msg_id as string;
			// Local SSE-resolved fast path.
			const pending = pendingReplies.get(msg_id);
			if (pending && pending.result) {
				const r = pending.result;
				const health = responseHealth(msg_id, r.error ? "error" : "complete", r.response, r.error ?? null, pending);
				const text = r.error
					? `coms_net_get: error — ${r.error}`
					: `coms_net_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status: r.error ? "error" : "complete", response: r.response, error: r.error ?? null, health },
				};
			}
			// Fall back to server.
			let resp: any;
			try {
				resp = await httpFetch("GET", `/v1/messages/${encodeURIComponent(msg_id)}`);
			} catch (err) {
				if (err instanceof HttpError && err.status === 404) {
					return {
						content: [{ type: "text" as const, text: `coms_net_get: unknown msg_id ${msg_id}` }],
						details: { status: "error", error: "unknown msg_id" },
					};
				}
				return {
					content: [{ type: "text" as const, text: `coms_net_get: error — ${safeError(err)}` }],
					details: { status: "error", error: safeError(err) },
				};
			}
			const status = resp?.status ?? "pending";
			if (status === "complete" || status === "error" || status === "timeout") {
				const health = responseHealth(msg_id, status, resp.response, resp.error ?? null, pending);
				const text = resp.error
					? `coms_net_get: ${status} — ${resp.error}`
					: `coms_net_get: ${status}\n${typeof resp.response === "string" ? resp.response : JSON.stringify(resp.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status, response: resp.response, error: resp.error ?? null, health },
				};
			}
			const health = responseHealth(msg_id, status, null, null, pending);
			return {
				content: [{ type: "text" as const, text: `coms_net_get: ${status}` }],
				details: { status, health },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const status = d?.status ?? "?";
			const color = status === "complete" ? "success"
				: status === "pending" || status === "queued" || status === "delivered" ? "warning"
				: "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_net_await",
		label: "Coms Net Await",
		description:
			"Block until the reply to YOUR OWN outbound coms_net_send arrives, or the timeout fires (default 30 min). " +
			"Only call this with a msg_id that YOU received as the return value of a coms_net_send call you just made.\n\n" +
			"⚠️  Do NOT call this with a msg_id that came in via an inbound `[from <peer>] …` prompt — those msg_ids belong to the *peer's* outbound, not yours. " +
			"To reply to an inbound message, do nothing special: just answer normally as your assistant message, " +
			"and the extension will auto-submit your final text back to the caller when your turn ends.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_net_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms). Server cap applies." })),
		}),
		async execute(_callId, params) {
			const msg_id = (params as any).msg_id as string;
			const timeoutMs = typeof (params as any).timeout_ms === "number" && (params as any).timeout_ms > 0
				? (params as any).timeout_ms
				: MESSAGE_TIMEOUT_MS;

			// Local SSE-resolved fast path.
			const pending = pendingReplies.get(msg_id);
			if (pending && pending.result) {
				const r = pending.result;
				const health = responseHealth(msg_id, r.error ? "error" : "complete", r.response, r.error ?? null, pending);
				if (r.error) {
					return {
						content: [{ type: "text" as const, text: `coms_net_await: error — ${r.error}` }],
						details: { error: r.error, health },
					};
				}
				const resp = r.response;
				return {
					content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }],
					details: { response: resp, health },
				};
			}

			// Race local pending promise against server long-poll, capped at timeoutMs.
			const localPromise: Promise<{ response?: any; error?: string | null }> = pending
				? pending.promise
				: new Promise(() => { /* never resolves on its own; SSE will */ });

			// Server long-poll. Cap server timeout to the requested timeout (server enforces its own max too).
			const serverTimeoutMs = Math.min(timeoutMs, MESSAGE_TIMEOUT_MS);
			const ac = new AbortController();
			const serverPromise = httpFetch(
				"GET",
				`/v1/messages/${encodeURIComponent(msg_id)}/await?timeout_ms=${serverTimeoutMs}`,
				undefined,
				{ timeoutMs: serverTimeoutMs + 5_000, signal: ac.signal },
			).then((data: any) => {
				if (data?.status === "complete") return { response: data.response, error: null };
				if (data?.status === "error") return { response: null, error: data.error ?? "error" };
				if (data?.status === "timeout") return { response: null, error: "timeout" };
				return { response: data?.response, error: data?.error ?? null };
			}).catch((err) => {
				if (err instanceof HttpError && err.status === 404) {
					return { response: null, error: "unknown msg_id" };
				}
				return { response: null, error: safeError(err) };
			});

			const timeoutPromise = new Promise<{ error: string }>((resolve) => {
				const t = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
				try { (t as any).unref?.(); } catch { /* ignore */ }
			});

			const winner = await Promise.race([localPromise, serverPromise, timeoutPromise]);
			try { ac.abort(); } catch { /* ignore */ }

			if ((winner as any).error) {
				const health = responseHealth(msg_id, "error", (winner as any).response, (winner as any).error, pending ?? undefined);
				return {
					content: [{ type: "text" as const, text: `coms_net_await: error — ${(winner as any).error}` }],
					details: { error: (winner as any).error, health },
				};
			}
			const resp = (winner as any).response;
			const health = responseHealth(msg_id, "complete", resp, null, pending ?? undefined);
			return {
				content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }],
				details: { response: resp, health },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_await ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});

	// ━━ agent_end: capture turn output and submit response ━━━━━━━━━━━━━━━━

	pi.on("agent_end", async (_event, ctx) => {
		const inbound = [...inboundQueue.values()].reverse().find((i) => !i.fulfilled);
		if (!inbound || !identity) return;

		// Walk the session branch for the most recent assistant text.
		let lastAssistantText = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as any;
				if (typeof m.content === "string") {
					lastAssistantText = m.content;
				} else if (Array.isArray(m.content)) {
					lastAssistantText = m.content
						.filter((b: any) => b && b.type === "text")
						.map((b: any) => b.text)
						.join("\n");
				}
			}
		}

		let payload: any = lastAssistantText;
		let error: string | null = null;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			try {
				payload = JSON.parse(lastAssistantText);
				const health = schemaHealth(inbound.response_schema, payload);
				if (!health.ok) {
					error = health.reason || "response failed schema health check";
					payload = null;
				}
			} catch {
				error = "response not valid JSON";
				payload = null;
			}
		}

		const req: ResponseSubmitRequest = {
			project: identity.project,
			responder_session: identity.session_id,
			response: payload,
			error,
		};

		try {
			await httpFetch("POST", `/v1/messages/${encodeURIComponent(inbound.msg_id)}/response`, req);
			try {
				pi.appendEntry("coms-net-log", {
					event: "response_out",
					ts: nowIso(),
					msg_id: inbound.msg_id,
					error,
					response_health: {
						ok: !error,
						error,
						schema_checked: Boolean(inbound.response_schema),
					},
				});
			} catch { /* best-effort */ }
		} catch (e: any) {
			audit("response_out_failed", { msg_id: inbound.msg_id, reason: safeError(e) });
		}

		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		if (currentInbound && currentInbound.msg_id === inbound.msg_id) {
			currentInbound = null;
		}
	});

	// ━━ /coms-net slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerCommand("coms-net", {
		description: "Refresh the coms-net pool widget; or --all / --project <name> / --server / --reconnect",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (trimmed.includes("--all")) {
				includeExplicit = !includeExplicit;
				try { ctx.ui.notify(`coms-net: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
			}
			if (trimmed.includes("--reconnect")) {
				try { ctx.ui.notify("coms-net: reconnecting SSE...", "info"); } catch { /* ignore */ }
				if (sseAbort) {
					try { sseAbort.abort(); } catch { /* ignore */ }
					sseAbort = null;
				}
				reconnectAttempts = 0;
				notifiedReconnectCap = false;
				try { await reRegisterAndOpen(); } catch (err) { audit("manual_reconnect_failed", { reason: safeError(err) }); }
			}
			if (trimmed.includes("--server")) {
				try {
					const health = await httpFetch("GET", "/health");
					ctx.ui.notify(
						`coms-net server: ${serverUrl} · version ${health?.version ?? "?"} · server_id ${health?.server_id ?? "?"}`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(`coms-net: server health failed — ${safeError(err)}`, "error");
				}
			}
			const projectMatch = trimmed.match(/--project\s+(\S+)/);
			if (projectMatch) {
				displayProject = projectMatch[1];
				try { ctx.ui.notify(`coms-net: displaying project ${displayProject}`, "info"); } catch { /* ignore */ }
			}

			// Bare invocation or after --project: force-refresh.
			try {
				const projectFilter = displayProject ?? identity?.project ?? "default";
				const qs = `?project=${encodeURIComponent(projectFilter)}&include_explicit=${includeExplicit ? "true" : "false"}`;
				const resp = await httpFetch("GET", `/v1/agents${qs}`);
				const agents: AgentCard[] = Array.isArray(resp?.agents) ? resp.agents : [];
				peerCards.clear();
				for (const a of agents) {
					if (identity && a.session_id === identity.session_id) continue;
					peerCards.set(a.session_id, a);
				}
				maybeRequestRender();
			} catch (err) {
				audit("refresh_failed", { reason: safeError(err) });
			}
		},
	});

	// ━━ Clean shutdown (idempotent) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;

		if (heartbeatTimer) {
			try { clearInterval(heartbeatTimer); } catch { /* ignore */ }
			heartbeatTimer = null;
		}
		if (reconnectTimer) {
			try { clearTimeout(reconnectTimer); } catch { /* ignore */ }
			reconnectTimer = null;
		}
		if (sseAbort) {
			try { sseAbort.abort(); } catch { /* ignore */ }
			sseAbort = null;
		}

		// Best-effort DELETE with short timeout.
		if (identity && serverUrl && authToken) {
			const ac = new AbortController();
			const t = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, SHUTDOWN_DELETE_TIMEOUT_MS);
			try { (t as any).unref?.(); } catch { /* ignore */ }
			try {
				await httpFetch(
					"DELETE",
					`/v1/agents/${encodeURIComponent(identity.session_id)}?project=${encodeURIComponent(identity.project)}`,
					undefined,
					{ signal: ac.signal },
				);
			} catch {
				// best-effort — server may already be gone.
			} finally {
				try { clearTimeout(t); } catch { /* ignore */ }
			}
		}

		if (identity) {
			try {
				pi.appendEntry("coms-net-log", {
					event: "shutdown",
					ts: nowIso(),
					session_id: identity.session_id,
				});
			} catch { /* best-effort */ }
		}

		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-net-pool", undefined); } catch { /* ignore */ }
			try { currentCtx.ui.setStatus("coms-net", ""); } catch { /* ignore */ }
		}
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
