/**
 * Antigravity sideband reader (ACP Phase 2.4). agy 1.5.x records some upstream failures only in its own
 * per-conversation SQLite store and ends the ACP prompt as if nothing went wrong, so after a prompt completes the
 * adapter reads the store for error steps the wire never carried.
 *
 * Layout and schema verified read-only on agy 1.5.13 (a copy of a real profile, opened with readOnly):
 * `<appDataDir>/conversations/<sessionId>.db`, WAL journal, table
 * `steps(idx integer PRIMARY KEY, step_type integer, status integer, ..., error_details blob, step_payload blob,
 * step_format integer)` with an index on `step_type`. Error steps have `step_type = 17`, `step_format = 0` (protobuf)
 * and a NULL `error_details`; the provider failure rides inside `step_payload` as text, including compact
 * `google.rpc.ErrorInfo` (`reason`, `metadata.quotaResetTimeStamp`, `metadata.quotaResetDelay`) and
 * `google.rpc.RetryInfo` (`retryDelay`) JSON objects, each starting with its `@type`.
 *
 * The reader never writes: the connection opens readOnly with `query_only`, waits at most 100 ms on a lock, reads a
 * bounded number of rows and bytes inside one read transaction, and answers "no signal" for anything it cannot read
 * safely. A store missing either WAL sidecar opens `immutable=1`, because every other read-only open creates both
 * sidecars in a writable directory.
 */

import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { FailureCause } from "../../core/telemetry/enums.js";

type SqliteModule = typeof import("node:sqlite");

/** agy's error-message step type (`CORTEX_STEP_TYPE_ERROR_MESSAGE`), observed as 17 on 1.5.13. */
const ERROR_STEP_TYPE = 17;
/** Error rows read per call, oldest first; a full page leaves the cursor on its last row so the rest come next call. */
export const ANTIGRAVITY_SIDEBAND_MAX_ROWS = 32;
/** Payload bytes read per row; observed quota payloads are about 3 KiB. */
const MAX_ROW_BYTES = 16 * 1024;
const MAX_DETAIL_CHARS = 4096;
const MAX_DETAILS = 16;
const BUSY_TIMEOUT_MS = 100;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";
const RPC_DETAIL_START = /\{\s*"@type"\s*:\s*"type\.googleapis\.com\/google\.rpc\.(?:ErrorInfo|RetryInfo)"/g;
/** A 4xx or 5xx code, optionally closed by `)` and `:`, then the status token: `400 X`, `(code 400): X`. */
const THINKING_SIGNATURE_AFTER_CODE = /\b[45]\d\d\)?:?\s+INVALID_THINKING_SIGNATURE\b/;
/** The exact text Node 22 emits once when node:sqlite loads. */
const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";

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
	/** Pass back as `afterIdx` on the next read; no error row at or below it is read again, none above it is skipped. */
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
		if (type === "ExperimentalWarning" && text === SQLITE_EXPERIMENTAL_WARNING) return;
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

interface ResolvedDatabase {
	readonly path: string;
	/** Both WAL sidecars exist, so a shared read-only open creates nothing. */
	readonly sidecars: boolean;
}

/** The database once it and its WAL siblings resolve inside the profile; a string names why not. */
function resolveDatabase(profileDir: string, sessionId: string): ResolvedDatabase | AntigravitySidebandNoSignal {
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
	let sidecars = true;
	for (const suffix of ["-wal", "-shm"]) {
		try {
			if (lstatSync(`${real}${suffix}`).isSymbolicLink()) return "outside-profile";
		} catch {
			sidecars = false;
		}
	}
	return { path: real, sidecars };
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
	h: 3_600_000,
	m: 60_000,
	s: 1000,
	ms: 1,
	us: 1e-3,
	"\u00b5s": 1e-3,
	"\u03bcs": 1e-3,
	ns: 1e-6,
};
const DURATION_PART = "(\\d+(?:\\.\\d*)?|\\.\\d+)(h|ms|m|s|us|\u00b5s|\u03bcs|ns)";
const DURATION = new RegExp(`^(?:${DURATION_PART})+$`, "u");

/** Go duration text (`167h11m42.85s`, `601902.8s`, `.5s`, `1\u03bcs`, `0`) in milliseconds. */
function goDurationMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	if (value === "0") return 0;
	if (!DURATION.test(value)) return undefined;
	let total = 0;
	for (const part of value.matchAll(new RegExp(DURATION_PART, "gu"))) {
		total += Number(part[1]) * (DURATION_UNIT_MS[part[2] ?? ""] ?? 0);
	}
	return Number.isFinite(total) ? Math.round(total) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Index of the `}` closing the object opened at `start`, string-aware, within the detail bound; -1 if none. */
function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	const limit = Math.min(text.length, start + MAX_DETAIL_CHARS);
	for (let i = start; i < limit; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Every parseable `google.rpc` ErrorInfo and RetryInfo object in the payload, in order. */
function rpcDetails(text: string): Array<Record<string, unknown>> {
	const details: Array<Record<string, unknown>> = [];
	for (const match of text.matchAll(RPC_DETAIL_START)) {
		if (details.length >= MAX_DETAILS) break;
		const end = objectEnd(text, match.index);
		if (end < 0) continue;
		try {
			const parsed: unknown = JSON.parse(text.slice(match.index, end + 1));
			if (isRecord(parsed) && (parsed["@type"] === ERROR_INFO || parsed["@type"] === RETRY_INFO)) details.push(parsed);
		} catch {
			// Not JSON after all; skip it.
		}
	}
	return details;
}

/**
 * QUOTA_EXHAUSTED counts only as the reason of a parsed ErrorInfo, so quoted output naming it is no signal, and it
 * wins over an echoed thinking-signature token. INVALID_THINKING_SIGNATURE counts as an ErrorInfo reason or as the
 * status token right after a 4xx/5xx code; no store held one to verify against.
 */
function classify(idx: number, payload: string): AntigravitySidebandSignal | null {
	const details = rpcDetails(payload);
	const errorInfos = details.filter((detail) => detail["@type"] === ERROR_INFO);
	const quota = errorInfos.find((info) => info.reason === "QUOTA_EXHAUSTED");
	if (quota !== undefined) {
		const metadata = isRecord(quota.metadata) ? quota.metadata : {};
		const model = typeof metadata.model === "string" && MODEL_ID.test(metadata.model) ? metadata.model : undefined;
		const stamp =
			typeof metadata.quotaResetTimeStamp === "string" ? Date.parse(metadata.quotaResetTimeStamp) : Number.NaN;
		const resetAt = Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined;
		const resetDelayMs = goDurationMs(metadata.quotaResetDelay);
		const retryAfterMs = goDurationMs(details.find((detail) => detail["@type"] === RETRY_INFO)?.retryDelay);
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
	if (
		errorInfos.some((info) => info.reason === "INVALID_THINKING_SIGNATURE") ||
		THINKING_SIGNATURE_AFTER_CODE.test(payload)
	)
		return { kind: "non-resumable", idx, reason: "INVALID_THINKING_SIGNATURE" };
	return null;
}

function payloadText(value: unknown): string {
	return value instanceof Uint8Array
		? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8")
		: "";
}

function idxNumber(value: unknown, fallback: number): number {
	const n = typeof value === "bigint" ? Number(value) : value;
	return typeof n === "number" && Number.isSafeInteger(n) ? n : fallback;
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
	const database = resolveDatabase(query.profileDir, query.sessionId);
	if (typeof database === "string") return none(database);
	const sqlite = loadSqlite();
	if (sqlite === null) return none("sqlite-unavailable");
	let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
	try {
		// Without both sidecars every shared read-only open creates them; immutable reads the main file alone.
		const name = database.sidecars ? database.path : `${pathToFileURL(database.path).href}?immutable=1`;
		db = new sqlite.DatabaseSync(name, { readOnly: true });
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		db.exec("PRAGMA query_only = ON");
		// One snapshot for the cursor and the rows, so a step committed between them is neither lost nor repeated.
		db.exec("BEGIN");
		const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'steps'").get();
		if (table === undefined) return none("no-steps-table");
		const top = idxNumber(db.prepare("SELECT COALESCE(MAX(idx), -1) AS top FROM steps").get()?.top, -1);
		if (afterIdx === "latest") {
			db.exec("COMMIT");
			return { cursor: Math.max(start, top), signals: [] };
		}
		const rows = db
			.prepare(
				"SELECT idx, substr(CAST(step_payload AS BLOB), 1, ?) AS payload FROM steps WHERE step_type = ? AND idx > ? ORDER BY idx ASC LIMIT ?",
			)
			.all(MAX_ROW_BYTES, ERROR_STEP_TYPE, start, ANTIGRAVITY_SIDEBAND_MAX_ROWS);
		db.exec("COMMIT");
		const signals: AntigravitySidebandSignal[] = [];
		let last = start;
		for (const row of rows) {
			last = idxNumber(row.idx, last);
			const signal = classify(last, payloadText(row.payload));
			if (signal !== null) signals.push(signal);
		}
		const cursor = rows.length >= ANTIGRAVITY_SIDEBAND_MAX_ROWS ? last : Math.max(start, top);
		return { cursor, signals };
	} catch {
		return none("unreadable");
	} finally {
		db?.close();
	}
}
