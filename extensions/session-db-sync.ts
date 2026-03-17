/**
 * Session DB Sync Extension — Mirrors Pi session entries to SQLite
 *
 * Hooks into Pi lifecycle events and upserts session entries into a local
 * SQLite database for searchability and auditing. The database preserves
 * Pi's tree structure (entry_id / parent_id) and tracks the active leaf.
 *
 * Features:
 * - Full sync on session_start / session_switch / session_fork
 * - Incremental sync on message_end / turn_end / compaction / tree nav
 * - Mutation detection via payload comparison (re-upserts changed entries)
 * - Fire-and-forget error handling (never crashes Pi)
 * - WAL mode + busy_timeout for multi-terminal safety
 *
 * Usage: pi -e extensions/session-db-sync.ts
 * DB location: ~/.pi/sessions.db (override with PI_SESSION_DB env var)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

const DB_PATH = process.env.PI_SESSION_DB || join(process.env.HOME!, ".pi", "sessions.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export default function (pi: ExtensionAPI) {
	const db = new Database(DB_PATH);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=NORMAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			session_id TEXT PRIMARY KEY,
			cwd TEXT,
			active_leaf_id TEXT,
			updated_at TEXT DEFAULT (datetime('now')),
			started_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS session_entries (
			session_id TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			parent_id TEXT,
			entry_type TEXT NOT NULL,
			message_role TEXT,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (session_id, entry_id),
			FOREIGN KEY (session_id) REFERENCES sessions(session_id)
		);
		CREATE INDEX IF NOT EXISTS idx_entries_type ON session_entries(entry_type);
		CREATE INDEX IF NOT EXISTS idx_entries_role ON session_entries(message_role);
		CREATE INDEX IF NOT EXISTS idx_entries_parent ON session_entries(session_id, parent_id);
	`);

	const upsertSession = db.prepare(
		`INSERT INTO sessions (session_id, cwd, active_leaf_id) VALUES (?, ?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET
		   cwd = excluded.cwd,
		   active_leaf_id = excluded.active_leaf_id,
		   updated_at = datetime('now')`
	);
	const upsertEntry = db.prepare(
		`INSERT INTO session_entries (session_id, entry_id, parent_id, entry_type, message_role, payload, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (session_id, entry_id) DO UPDATE SET payload = excluded.payload`
	);

	// Track (session_id:entry_id) → serialized payload for mutation detection
	const syncedPayloads = new Map<string, string>();
	let lastSeenLeafId: string | null = null;

	function entryKey(sessionId: string, entryId: string) {
		return `${sessionId}:${entryId}`;
	}

	function getMessageRole(entry: SessionEntry): string | null {
		if (entry.type === "message") {
			return (entry as SessionMessageEntry).message?.role ?? null;
		}
		return null;
	}

	function getTimestamp(entry: SessionEntry): string {
		// SessionEntryBase.timestamp is an ISO string
		return entry.timestamp
			? new Date(entry.timestamp).toISOString()
			: new Date().toISOString();
	}

	function insertEntry(sessionId: string, entry: SessionEntry, payloadStr: string) {
		try {
			upsertEntry.run(
				sessionId,
				entry.id,
				entry.parentId,
				entry.type,
				getMessageRole(entry),
				payloadStr,
				getTimestamp(entry)
			);
			syncedPayloads.set(entryKey(sessionId, entry.id), payloadStr);
		} catch (err) {
			console.error(`[db-sync] Insert error for entry ${entry.id}:`, err);
		}
	}

	function ensureSession(ctx: ExtensionContext) {
		const currentLeafId = ctx.sessionManager.getLeafId() ?? null;
		if (currentLeafId === lastSeenLeafId) return;

		try {
			upsertSession.run(
				ctx.sessionManager.getSessionId(),
				ctx.sessionManager.getCwd(),
				currentLeafId
			);
			lastSeenLeafId = currentLeafId;
		} catch (err) {
			console.error("[db-sync] Failed to upsert session:", err);
		}
	}

	function syncNewEntries(ctx: ExtensionContext) {
		ensureSession(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		for (const entry of ctx.sessionManager.getEntries()) {
			try {
				const key = entryKey(sessionId, entry.id);
				const payloadStr = JSON.stringify(entry);
				if (syncedPayloads.get(key) !== payloadStr) {
					insertEntry(sessionId, entry, payloadStr);
				}
			} catch (err) {
				console.error(`[db-sync] Failed to sync entry ${entry.id}:`, err);
			}
		}
	}

	// Session lifecycle: full sync on start/switch/fork
	pi.on("session_start", (_event, ctx) => {
		syncNewEntries(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		syncedPayloads.clear();
		lastSeenLeafId = null;
		syncNewEntries(ctx);
	});

	pi.on("session_fork", (_event, ctx) => {
		syncNewEntries(ctx);
	});

	// Incremental sync on message/turn boundaries
	pi.on("message_end", (_event, ctx) => syncNewEntries(ctx));
	pi.on("turn_end", (_event, ctx) => syncNewEntries(ctx));

	// Structural changes
	pi.on("session_compact", (_event, ctx) => syncNewEntries(ctx));
	pi.on("session_tree", (_event, ctx) => syncNewEntries(ctx));
	pi.on("model_select", (_event, ctx) => syncNewEntries(ctx));

	// Cleanup
	pi.on("session_shutdown", () => {
		try {
			db.close();
		} catch (err) {
			console.error("[db-sync] Failed to close database:", err);
		}
	});
}
