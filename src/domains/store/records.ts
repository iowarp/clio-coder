/**
 * Records: what Clio observed about each blob, kept in the store itself.
 *
 * Records for tag `T` are write-once blobs in `recordsTag(T)` named
 * `<blob>#<seq>`, `seq` 8-digit zero-padded from 1. Each event is its own
 * put-if-absent, so concurrent writers need no lock: the clio-core backend
 * offers put-if-absent with one winner and no lock service.
 */
import { recordsTag } from "../../core/store-paths.js";
import type { StoreBackend } from "./backend.js";
import { type StoreBackendKind, type StoreBlobStat, StoreRefusal } from "./types.js";

const STORE_RECORD_MAX_BYTES = 64 * 1024;
const SEQ_DIGITS = 8;
const APPEND_LISTINGS = 5;
const PROBES_PER_LISTING = 64;
const SUMMARY_LIST_LIMIT = 5000;
const HISTORY_PAGE = 1000;

export interface StoreRecordIdentity {
	bytes: number;
	modifiedMs: number;
	sha256: string | null;
	hashOmitted?: "too-large" | "cancelled" | "unreadable";
}

export interface StoreRecordUse {
	tag?: string;
	blob?: string;
	path?: string;
	bytes?: number;
	sha256: string | null;
}

export interface StoreRecord {
	v: 1;
	kind: "put" | "note" | "remove";
	tag: string;
	blob: string;
	seq: number;
	/** ISO time. */
	at: string;
	identity?: StoreRecordIdentity;
	/** `key` is the backend's own name for the object: the absolute path on the local backend. */
	receipt?: { backend: StoreBackendKind; key: string; version: number | null };
	/** Workspace-relative. */
	source?: { path: string };
	producedBy: { actor: "main" | "worker"; sessionId?: string; turnId?: string; dispatchRunId?: string };
	generatedBy?: {
		tool: "run_script";
		runId: string;
		script: { path: string; sha256: string | null };
		argv: string[];
		outcome: string;
		finishedAt: string;
		matchedBy: "sha256" | "size-mtime";
	};
	used?: StoreRecordUse[];
	note?: string;
	labels?: string[];
}

export type StoreRecordBody = Omit<StoreRecord, "v" | "seq" | "at">;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function recordName(blob: string, seq: number): string {
	return `${blob}#${String(seq).padStart(SEQ_DIGITS, "0")}`;
}

function parseRecordName(name: string): { blob: string; seq: number } | null {
	const match = /^(.+)#(\d{8})$/u.exec(name);
	if (match === null) return null;
	return { blob: match[1] as string, seq: Number(match[2]) };
}

async function listRecordNames(backend: StoreBackend, tag: string, blob: string): Promise<string[]> {
	const pattern = `${escapeRegExp(blob)}#\\d{${SEQ_DIGITS}}`;
	const names: string[] = [];
	for (let offset = 0; ; offset += HISTORY_PAGE) {
		const page = await backend.listBlobs(recordsTag(tag), { pattern, offset, limit: HISTORY_PAGE });
		names.push(...page.names);
		if (!page.hasMore) return names;
	}
}

async function lastSeq(backend: StoreBackend, tag: string, blob: string): Promise<number> {
	let max = 0;
	for (const name of await listRecordNames(backend, tag, blob)) {
		const parsed = parseRecordName(name);
		if (parsed !== null && parsed.seq > max) max = parsed.seq;
	}
	return max;
}

/**
 * Append one record for a blob at the next free `seq`. A name taken by a
 * concurrent writer moves this writer straight to the following one rather
 * than back to a listing, so twenty writers on one blob need no retry budget
 * of twenty; a writer only tries `n` after seeing `n - 1` exist, so the
 * sequence has no gap.
 */
export async function appendRecord(backend: StoreBackend, body: StoreRecordBody): Promise<StoreRecord> {
	const tag = recordsTag(body.tag);
	await backend.getOrCreateTag(tag);
	for (let listing = 0; listing < APPEND_LISTINGS; listing++) {
		let seq = (await lastSeq(backend, body.tag, body.blob)) + 1;
		for (let probe = 0; probe < PROBES_PER_LISTING; probe++, seq++) {
			const record: StoreRecord = { v: 1, ...body, seq, at: new Date().toISOString() };
			const data = Buffer.from(JSON.stringify(record), "utf8");
			if (data.byteLength > STORE_RECORD_MAX_BYTES) {
				throw new StoreRefusal("io", `A record for ${body.tag}/${body.blob} exceeds ${STORE_RECORD_MAX_BYTES} bytes.`);
			}
			if ((await backend.putRecordIfAbsent(tag, recordName(body.blob, seq), data)) === "written") return record;
		}
	}
	throw new StoreRefusal("io", `Could not claim a record sequence number for ${body.tag}/${body.blob}; try again.`);
}

/**
 * Records for one blob in `seq` order; unparseable bodies are counted and
 * skipped. With `limit`, only the newest `limit` records are read and parsed:
 * names are walked backwards and reading stops once enough have parsed.
 */
export async function readBlobHistory(
	backend: StoreBackend,
	tag: string,
	blob: string,
	options: { limit?: number } = {},
): Promise<{ records: StoreRecord[]; skipped: number }> {
	if (!(await backend.tagExists(recordsTag(tag)))) return { records: [], skipped: 0 };
	const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.limit));
	const records: StoreRecord[] = [];
	let skipped = 0;
	const names = limit === 0 ? [] : await listRecordNames(backend, tag, blob);
	for (let index = names.length - 1; index >= 0 && records.length < limit; index--) {
		const data = await backend.getRecord(recordsTag(tag), names[index] as string);
		if (data === null) continue;
		try {
			const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as Partial<StoreRecord> | null;
			if (parsed?.v === 1 && typeof parsed.seq === "number" && typeof parsed.kind === "string") {
				records.push(parsed as StoreRecord);
			} else {
				skipped++;
			}
		} catch {
			skipped++;
		}
	}
	records.sort((a, b) => a.seq - b.seq);
	return { records, skipped };
}

/** The latest `put` not followed by a `remove`, the notes after it, and whether the blob was removed. */
export function currentState(history: readonly StoreRecord[]): {
	put: StoreRecord | null;
	notes: StoreRecord[];
	removed: boolean;
} {
	let put: StoreRecord | null = null;
	let notes: StoreRecord[] = [];
	let removed = false;
	for (const record of history) {
		if (record.kind === "put") {
			put = record;
			notes = [];
			removed = false;
		} else if (record.kind === "remove") {
			put = null;
			notes = [];
			removed = true;
		} else {
			notes.push(record);
		}
	}
	return { put, notes, removed };
}

/**
 * One listing of the records tag grouped by blob. `recorded` is null for a
 * name not seen when the listing was cut short.
 */
export async function summarizeRecords(
	backend: StoreBackend,
	tag: string,
	names: readonly string[],
): Promise<Map<string, { recorded: boolean | null; lastSeq: number | null }>> {
	const seen = new Map<string, number>();
	let complete = true;
	if (await backend.tagExists(recordsTag(tag))) {
		const page = await backend.listBlobs(recordsTag(tag), { offset: 0, limit: SUMMARY_LIST_LIMIT });
		complete = !page.hasMore;
		for (const name of page.names) {
			const parsed = parseRecordName(name);
			if (parsed !== null) seen.set(parsed.blob, Math.max(seen.get(parsed.blob) ?? 0, parsed.seq));
		}
	}
	const summary = new Map<string, { recorded: boolean | null; lastSeq: number | null }>();
	for (const name of names) {
		const seq = seen.get(name);
		summary.set(
			name,
			seq !== undefined ? { recorded: true, lastSeq: seq } : { recorded: complete ? false : null, lastSeq: null },
		);
	}
	return summary;
}

export type StoreDrift = "none" | "changed" | "missing" | "unrecorded";

/** How a blob's current stat compares with its latest `put` record. */
export function driftOf(put: StoreRecord | null, stat: StoreBlobStat | null): StoreDrift {
	if (put === null) return stat === null ? "none" : "unrecorded";
	if (stat === null) return "missing";
	const identity = put.identity;
	if (identity === undefined) return "changed";
	return identity.bytes === stat.bytes && identity.modifiedMs === stat.modifiedMs ? "none" : "changed";
}
