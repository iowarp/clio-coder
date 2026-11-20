/**
 * Antigravity sideband reader (ACP Phase 2.4). agy 1.5.x records some upstream failures only in its own
 * per-conversation SQLite store and ends the ACP prompt as if nothing went wrong, so after a prompt completes the
 * adapter reads the store for error steps the wire never carried.
 *
 * Layout and schema verified read-only on agy 1.5.13 (a copy of a real profile, opened with readOnly):
 * `<appDataDir>/conversations/<sessionId>.db`, WAL journal, table
 * `steps(idx integer PRIMARY KEY, step_type integer, status integer, ..., error_details blob, step_payload blob,
 * step_format integer)` with an index on `step_type`. Error steps have `step_type = 17`, `step_format = 0` (protobuf)
 * and a NULL `error_details`; the provider failure rides inside `step_payload` as text, including the
 * `google.rpc.ErrorInfo` (`reason`, `metadata.quotaResetTimeStamp`, `metadata.quotaResetDelay`) and
 * `google.rpc.RetryInfo` (`retryDelay`) JSON. No `INVALID_THINKING_SIGNATURE` step was present to verify; that
 * classification matches the reason token anywhere in the payload.
 *
 * The reader never writes: the connection opens readOnly with `query_only`, waits at most 100 ms on a lock, reads a
 * bounded number of rows and bytes, and answers "no signal" for anything it cannot read safely.
 */

import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import type { FailureCause } from "../../core/telemetry/enums.js";

type SqliteModule = typeof import("node:sqlite");

/** agy's error-message step type (`CORTEX_STEP_TYPE_ERROR_MESSAGE`), observed as 17 on 1.5.13. */
const ERROR_STEP_TYPE = 17;
/** Newest error rows read per call; older ones past the cursor are skipped, never read. */
const MAX_ROWS = 32;
/** Payload bytes read per row; observed quota payloads are about 3 KiB. */
const MAX_ROW_BYTES = 16 * 1024;
const BUSY_TIMEOUT_MS = 100;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type AntigravitySidebandSignal =
	| {
			readonly kind: "usage-limit";
			readonly idx: number;
			readonly cause: Extract<FailureCause, "usage_limit_reached">;
			readonly reason: "QUOTA_EXHAUSTED";
			/** Bounded text this module authored; never the provider's prose. */
			readonly message: string;
			readonly model?: string;
			/** ISO timestamp from `quotaResetTimeStamp`. */
			readonly resetAt?: string;
			readonly resetDelayMs?: number;
			readonly retryAfterMs?: number;
	  }
	| { readonly kind: "non-resumable"; readonly idx: number; readonly reason: "INVALID_THINKING_SIGNATURE" };

export type AntigravitySidebandNoSignal =
	| "invalid-session-id"
	| "invalid-cursor"
	| "outside-profile"
	| "no-database"
	| "no-steps-table"
	| "unreadable"
	| "sqlite-unavailable";

export interface AntigravitySidebandRead {
	/** Pass back as `afterIdx` on the next read; it covers every step seen, not only error steps. */
	readonly cursor: number;
	readonly signals: readonly AntigravitySidebandSignal[];
	readonly noSignal?: AntigravitySidebandNoSignal;
}

export interface AntigravitySidebandQuery {
	/** Directory holding `conversations/`: agy's `<gemini-dir>/<app-data-dir>`, `~/.gemini/antigravity-cli` by default. */
	readonly profileDir: string;
	readonly sessionId: string;
	/** Last cursor read, `-1` for a new session, or `"latest"` to take a baseline without reading any step. */
	readonly afterIdx: number | "latest";
}

const requireModule = createRequire(import.meta.url);
let sqliteModule: SqliteModule | null | undefined;

/** Node 22 warns on stderr when node:sqlite loads; a terminal frame is no place for it, so that one warning is muted. */
function loadSqlite(): SqliteModule | null {
	if (sqliteModule !== undefined) return sqliteModule;
	const emitWarning = process.emitWarning;
	process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
		const text = typeof warning === "string" ? warning : warning.message;
		const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type;
		if (type === "ExperimentalWarning" && /\bSQLite\b/.test(text)) return;
		Reflect.apply(emitWarning, this, [warning, ...rest]);
	} as typeof process.emitWarning;
	try {
		sqliteModule = requireModule("node:sqlite") as SqliteModule;
	} catch {
		sqliteModule = null;
	} finally {
		process.emitWarning = emitWarning;
	}
	return sqliteModule;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The database path once it and its WAL siblings resolve inside the profile; a string names why not. */
function resolveDatabase(profileDir: string, sessionId: string): string | AntigravitySidebandNoSignal {
	let root: string;
	try {
		root = realpathSync(profileDir);
	} catch {
		return "no-database";
	}
	const candidate = join(root, "conversations", `${sessionId}.db`);
	let real: string;
	try {
		real = realpathSync(candidate);
	} catch {
		return "no-database";
	}
	if (!inside(root, real)) return "outside-profile";
	try {
		if (!lstatSync(real).isFile()) return "no-database";
	} catch {
		return "no-database";
	}
	// SQLite opens `<db>-wal` and `<db>-shm` by name; a link there would leave the profile just as surely.
	for (const suffix of ["-wal", "-shm"]) {
		try {
			if (lstatSync(`${real}${suffix}`).isSymbolicLink()) return "outside-profile";
		} catch {
			// Absent is fine.
		}
	}
	return real;
}

/** Go duration text (`167h11m42.85s`, `601902.8s`, `24m31s`) in milliseconds. */
function goDurationMs(text: string | undefined): number | undefined {
	if (text === undefined || !/^(?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+$/.test(text)) return undefined;
	const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 1e-3, µs: 1e-3, ns: 1e-6 };
	let total = 0;
	for (const part of text.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) {
		total += Number(part[1]) * (unit[part[2] ?? ""] ?? 0);
	}
	return Number.isFinite(total) ? Math.round(total) : undefined;
}

function field(text: string, name: string): string | undefined {
	return new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,128})"`).exec(text)?.[1];
}

function classify(idx: number, payload: string): AntigravitySidebandSignal | null {
	if (/\bINVALID_THINKING_SIGNATURE\b/.test(payload))
		return { kind: "non-resumable", idx, reason: "INVALID_THINKING_SIGNATURE" };
	if (!/"reason"\s*:\s*"QUOTA_EXHAUSTED"/.test(payload)) return null;
	const rawModel = field(payload, "model");
	const model = rawModel !== undefined && MODEL_ID.test(rawModel) ? rawModel : undefined;
	const stamp = Date.parse(field(payload, "quotaResetTimeStamp") ?? "");
	const resetAt = Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined;
	const resetDelayMs = goDurationMs(field(payload, "quotaResetDelay"));
	const retryAfterMs = goDurationMs(field(payload, "retryDelay"));
	return {
		kind: "usage-limit",
		idx,
		cause: "usage_limit_reached",
		reason: "QUOTA_EXHAUSTED",
		message: `Antigravity quota exhausted${model !== undefined ? ` for ${model}` : ""}${resetAt !== undefined ? `; resets at ${resetAt}` : ""}`,
		...(model !== undefined ? { model } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(resetDelayMs !== undefined ? { resetDelayMs } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	};
}

function payloadText(value: unknown): string {
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
	return typeof value === "string" ? value.slice(0, MAX_ROW_BYTES) : "";
}

/**
 * Error steps agy recorded after `afterIdx` in one session's store, classified. Any failure to read answers with no
 * signal and the cursor unchanged, so a missing or busy store never fails the turn that asked.
 */
export function readAntigravitySideband(query: AntigravitySidebandQuery): AntigravitySidebandRead {
	const { afterIdx } = query;
	const start = afterIdx === "latest" ? -1 : afterIdx;
	const none = (noSignal: AntigravitySidebandNoSignal): AntigravitySidebandRead => ({
		cursor: start,
		signals: [],
		noSignal,
	});
	if (afterIdx !== "latest" && !(Number.isSafeInteger(afterIdx) && afterIdx >= -1)) return none("invalid-cursor");
	if (!SESSION_ID.test(query.sessionId)) return none("invalid-session-id");
	const path = resolveDatabase(query.profileDir, query.sessionId);
	if (path === "no-database" || path === "outside-profile") return none(path);
	const sqlite = loadSqlite();
	if (sqlite === null) return none("sqlite-unavailable");
	let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
	try {
		db = new sqlite.DatabaseSync(path, { readOnly: true });
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		db.exec("PRAGMA query_only = ON");
		const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'steps'").get();
		if (table === undefined) return none("no-steps-table");
		const top = db.prepare("SELECT COALESCE(MAX(idx), -1) AS top FROM steps").get()?.top;
		const cursor = Math.max(start, typeof top === "number" ? top : Number(top ?? -1));
		if (afterIdx === "latest") return { cursor, signals: [] };
		const rows = db
			.prepare(
				"SELECT idx, substr(step_payload, 1, ?) AS payload FROM steps WHERE step_type = ? AND idx > ? ORDER BY idx DESC LIMIT ?",
			)
			.all(MAX_ROW_BYTES, ERROR_STEP_TYPE, start, MAX_ROWS);
		const signals: AntigravitySidebandSignal[] = [];
		for (const row of rows.reverse()) {
			const signal = classify(Number(row.idx), payloadText(row.payload));
			if (signal !== null) signals.push(signal);
		}
		return { cursor, signals };
	} catch {
		return none("unreadable");
	} finally {
		db?.close();
	}
}
