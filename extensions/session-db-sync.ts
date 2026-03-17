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
import Database, { type Statement } from "better-sqlite3";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

const DB_PATH = process.env.PI_SESSION_DB || join(process.env.HOME!, ".pi", "sessions.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export default function (pi: ExtensionAPI) {
	const db = new Database(DB_PATH);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=OFF");     // Mirror DB — JSONL is source of truth
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	db.exec("PRAGMA cache_size=-8000");    // 8MB page cache

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
	const insertNewEntry = db.prepare(
		`INSERT OR IGNORE INTO session_entries (session_id, entry_id, parent_id, entry_type, message_role, payload, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const upsertEntry = db.prepare(
		`INSERT INTO session_entries (session_id, entry_id, parent_id, entry_type, message_role, payload, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (session_id, entry_id) DO UPDATE SET payload = excluded.payload`
	);

	let lastSyncedCount = 0;   // Skip already-iterated entries
	let lastSeenLeafId: string | null = null;

	function getMessageRole(entry: SessionEntry): string | null {
		if (entry.type === "message") {
			return (entry as SessionMessageEntry).message?.role ?? null;
		}
		return null;
	}

	function getTimestamp(entry: SessionEntry): string {
		return entry.timestamp
			? new Date(entry.timestamp).toISOString()
			: new Date().toISOString();
	}

	function writeEntry(stmt: Statement, sessionId: string, entry: SessionEntry) {
		const payloadStr = JSON.stringify(entry);
		stmt.run(
			sessionId,
			entry.id,
			entry.parentId,
			entry.type,
			getMessageRole(entry),
			payloadStr,
			getTimestamp(entry),
		);
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

	const syncInTransaction = db.transaction((sessionId: string, entries: SessionEntry[]) => {
		// Insert only entries we haven't seen (skip first lastSyncedCount)
		for (let i = lastSyncedCount; i < entries.length; i++) {
			writeEntry(insertNewEntry, sessionId, entries[i]);
		}
		// Re-sync the last entry — it may have been mutated (e.g. streaming content)
		if (entries.length > 0) {
			writeEntry(upsertEntry, sessionId, entries[entries.length - 1]);
		}
		lastSyncedCount = entries.length;
	});

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingCtx: ExtensionContext | null = null;

	function syncNewEntries(ctx: ExtensionContext, immediate = false) {
		pendingCtx = ctx;
		if (immediate) {
			flushSync();
			return;
		}
		if (!debounceTimer) {
			debounceTimer = setTimeout(flushSync, 50);
		}
	}

	function flushSync() {
		debounceTimer = null;
		const ctx = pendingCtx;
		if (!ctx) return;
		pendingCtx = null;

		ensureSession(ctx);
		try {
			syncInTransaction(
				ctx.sessionManager.getSessionId(),
				ctx.sessionManager.getEntries(),
			);
		} catch (err) {
			console.error("[db-sync] Transaction failed:", err);
		}
	}

	// Session lifecycle: immediate sync on start/switch/fork
	pi.on("session_start", (_event, ctx) => syncNewEntries(ctx, true));

	pi.on("session_switch", (_event, ctx) => {
		lastSyncedCount = 0;
		lastSeenLeafId = null;
		syncNewEntries(ctx, true);
	});

	pi.on("session_fork", (_event, ctx) => syncNewEntries(ctx, true));

	// Incremental sync (debounced)
	pi.on("turn_end", (_event, ctx) => syncNewEntries(ctx));

	// Structural changes (debounced)
	pi.on("session_compact", (_event, ctx) => {
		lastSyncedCount = 0;  // Entries replaced after compaction
		syncNewEntries(ctx);
	});
	pi.on("session_tree", (_event, ctx) => syncNewEntries(ctx));

	// Cleanup: flush pending sync, then close
	pi.on("session_shutdown", () => {
		try {
			flushSync();
			db.close();
		} catch (err) {
			console.error("[db-sync] Failed to close database:", err);
		}
	});
}
