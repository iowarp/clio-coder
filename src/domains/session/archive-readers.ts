import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSessionEntry, type MessageEntry, type MessageRole, type SessionEntry } from "./index.js";

/**
 * Shared read-only readers over the local usage archive: the per-day audit
 * JSONL files and the per-session ledger files under the state dir. Evidence
 * building and the cross-session usage report both consume these; they were
 * factored out of evidence/build.ts so the parsers exist exactly once.
 *
 * The module lives in the session domain because that is its only dependency,
 * and it is re-exported from the session index so consumers reach it through
 * the barrel. It used to live under observability, where the barrel could not
 * be used: the observability extension imports the evidence domain, so an
 * evidence-side import through the observability index would cycle.
 */

export interface AuditJsonRow {
	file: string;
	line: number;
	row: Record<string, unknown>;
	ts: string | null;
	auditKind: string;
	correlationId: string;
}

export interface AuditReadResult {
	rows: AuditJsonRow[];
	errors: string[];
}

export interface SessionReadResult {
	entries: SessionEntry[];
	missing: boolean;
	errors: string[];
}

/** A discovered session ledger file under <stateDir>/sessions/. */
export interface SessionLedgerRef {
	cwdHash: string;
	sessionId: string;
	path: string;
}

/**
 * Read every `<stateDir>/audit/<date>.jsonl` row. Malformed lines are skipped
 * and reported in `errors` instead of failing the read.
 */
export async function readAuditRows(stateDir: string): Promise<AuditReadResult> {
	const root = join(stateDir, "audit");
	let files: string[];
	try {
		files = await readdir(root);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { rows: [], errors: [] };
		return { rows: [], errors: [`audit root read error: ${err.message ?? String(err)}`] };
	}
	const rows: AuditJsonRow[] = [];
	const errors: string[] = [];
	for (const file of files.filter((name) => name.endsWith(".jsonl")).sort(compareStrings)) {
		const path = join(root, file);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			errors.push(`${path}: ${err.message ?? String(err)}`);
			continue;
		}
		const lines = raw.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === undefined || line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${path}:${index + 1}: invalid JSON: ${message}`);
				continue;
			}
			if (!isRecord(parsed)) {
				errors.push(`${path}:${index + 1}: expected object`);
				continue;
			}
			const auditKind = readOptionalString(parsed.kind) ?? "tool_call";
			rows.push({
				file,
				line: index + 1,
				row: parsed,
				ts: readOptionalString(parsed.ts),
				auditKind,
				correlationId: readOptionalString(parsed.correlationId) ?? "",
			});
		}
	}
	return { rows, errors };
}

/**
 * Find and parse the ledger for one session id by scanning the cwd-hash
 * directories. `missing` is true when no ledger exists anywhere.
 */
export async function readSessionEntriesForId(stateDir: string, sessionId: string): Promise<SessionReadResult> {
	const root = join(stateDir, "sessions");
	let cwdHashes: string[];
	try {
		cwdHashes = await readdir(root);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { entries: [], missing: true, errors: [] };
		return { entries: [], missing: false, errors: [`session root read error: ${err.message ?? String(err)}`] };
	}
	for (const cwdHash of cwdHashes.sort(compareStrings)) {
		const currentPath = join(root, cwdHash, sessionId, "current.jsonl");
		let raw: string;
		let source = currentPath;
		try {
			raw = await readFile(currentPath, "utf8");
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				const tmpPath = `${currentPath}.tmp`;
				try {
					raw = await readFile(tmpPath, "utf8");
					source = tmpPath;
				} catch {
					continue;
				}
			} else if (err.code === "ENOTDIR") {
				continue;
			} else {
				return { entries: [], missing: false, errors: [`${currentPath}: ${err.message ?? String(err)}`] };
			}
		}
		return parseSessionEntries(raw, source);
	}
	return { entries: [], missing: true, errors: [] };
}

/**
 * Parse a session ledger's JSONL content. Lines that are not valid JSON are
 * reported in `errors`; JSON lines that do not resolve to a session entry are
 * silently skipped (the ledger carries engine rows this reader does not model).
 */
export function parseSessionEntries(raw: string, source: string): SessionReadResult {
	const entries: SessionEntry[] = [];
	const errors: string[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${source}:${index + 1}: invalid JSON: ${message}`);
			continue;
		}
		const entry = parseSessionEntryLine(parsed);
		if (entry !== null) entries.push(entry);
	}
	return { entries, missing: false, errors };
}

/**
 * Enumerate every session ledger under `<stateDir>/sessions/`, optionally
 * restricted to one cwd hash. Read-only; missing roots yield an empty list.
 */
export async function listSessionLedgerRefs(stateDir: string, onlyCwdHash?: string): Promise<SessionLedgerRef[]> {
	const root = join(stateDir, "sessions");
	let cwdHashes: string[];
	try {
		cwdHashes = await readdir(root);
	} catch {
		return [];
	}
	const refs: SessionLedgerRef[] = [];
	for (const cwdHash of cwdHashes.sort(compareStrings)) {
		if (onlyCwdHash !== undefined && cwdHash !== onlyCwdHash) continue;
		let sessionIds: string[];
		try {
			sessionIds = await readdir(join(root, cwdHash));
		} catch {
			continue;
		}
		for (const sessionId of sessionIds.sort(compareStrings)) {
			refs.push({ cwdHash, sessionId, path: join(root, cwdHash, sessionId, "current.jsonl") });
		}
	}
	return refs;
}

function parseSessionEntryLine(value: unknown): SessionEntry | null {
	if (isSessionEntry(value)) return value;
	if (!isRecord(value)) return null;
	const id = readOptionalString(value.id);
	const parentId = readOptionalNullableString(value.parentId);
	const at = readOptionalString(value.at);
	const kind = readOptionalMessageRole(value.kind);
	if (id === null || parentId === undefined || at === null || kind === null || !Object.hasOwn(value, "payload")) {
		return null;
	}
	const entry: MessageEntry = {
		kind: "message",
		turnId: id,
		parentTurnId: parentId,
		timestamp: at,
		role: kind,
		payload: value.payload,
	};
	return entry;
}

const MESSAGE_ROLES: ReadonlySet<MessageRole> = new Set([
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"system",
	"checkpoint",
]);

function readOptionalMessageRole(value: unknown): MessageRole | null {
	if (typeof value !== "string") return null;
	return MESSAGE_ROLES.has(value as MessageRole) ? (value as MessageRole) : null;
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value === "string") return value;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}
