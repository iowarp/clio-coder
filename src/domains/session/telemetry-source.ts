import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { CallJournalRead } from "../observability/call-journal.js";
import { readCallJournal, readCallJournalSync } from "../observability/call-journal.js";
import type { OutOfTurnUsageRow } from "../observability/out-of-turn-usage.js";
import { outOfTurnUsagePath, parseOutOfTurnUsageRows } from "../observability/out-of-turn-usage.js";
import type { JournalSource, SessionSource } from "../observability/read-model.js";
import { journalSourceFromRead } from "../observability/read-model.js";
import type { SessionEntry, SessionHeader } from "./entries.js";
import { isSessionEntry, isSessionHeader } from "./entries.js";
import { importLegacySession } from "./legacy-import.js";

/**
 * Cold-path loader for the telemetry read model (#434 §11): a session's own journal, the ledger rows the journal
 * never held (folded through the legacy importer with stable ids), the run journals it referenced, and its fork
 * ancestors. Session spend is whole-session: every branch the account paid for counts. A fork child's journal holds
 * only its own calls, so the ledger prefix it copied from its parent is left to the parent's own fold.
 *
 * The loader is one generator over its file reads, run synchronously for the CLI and asynchronously for the live
 * model's seed, so the seed and `clio-coder telemetry` cannot read a session two different ways.
 */

const MAX_LINEAGE = 32;

type Io =
	| { op: "journal"; directory: string; file: "calls.jsonl" | "events.ndjson" }
	| { op: "text"; path: string }
	| { op: "list"; path: string }
	| { op: "exists"; path: string }
	| { op: "mtime"; path: string };
type Load<T> = Generator<Io, T, unknown>;

function* journal(directory: string, file: "calls.jsonl" | "events.ndjson"): Load<CallJournalRead> {
	return (yield { op: "journal", directory, file }) as CallJournalRead;
}
/** Null when the file cannot be read for any reason. */
function* text(path: string): Load<string | null> {
	return (yield { op: "text", path }) as string | null;
}
/** Null when the directory cannot be listed. */
function* list(path: string): Load<string[] | null> {
	return (yield { op: "list", path }) as string[] | null;
}
function* exists(path: string): Load<boolean> {
	return (yield { op: "exists", path }) as boolean;
}
/** Last write time in epoch ms; null when the file cannot be stat'ed. */
function* mtime(path: string): Load<number | null> {
	return (yield { op: "mtime", path }) as number | null;
}

function performSync(io: Io): unknown {
	switch (io.op) {
		case "journal":
			return readCallJournalSync(io.directory, io.file);
		case "text":
			try {
				return readFileSync(io.path, "utf8");
			} catch {
				// Every caller treats an unreadable file as an absent one.
				return null;
			}
		case "list":
			try {
				return readdirSync(io.path);
			} catch {
				// No directory: nothing to list.
				return null;
			}
		case "exists":
			return existsSync(io.path);
		case "mtime":
			try {
				return statSync(io.path).mtimeMs;
			} catch {
				// No file: nothing to order by.
				return null;
			}
	}
}

async function performAsync(io: Io): Promise<unknown> {
	switch (io.op) {
		case "journal":
			return readCallJournal(io.directory, io.file);
		case "text":
			return readFile(io.path, "utf8").catch(() => null);
		case "list":
			return readdir(io.path).catch(() => null);
		case "exists":
			return access(io.path).then(
				() => true,
				() => false,
			);
		case "mtime":
			return stat(io.path).then(
				(info) => info.mtimeMs,
				() => null,
			);
	}
}

function runSync<T>(load: Load<T>): T {
	let step = load.next();
	while (!step.done) {
		let value: unknown;
		try {
			value = performSync(step.value);
		} catch (error) {
			step = load.throw(error);
			continue;
		}
		step = load.next(value);
	}
	return step.value;
}

async function runAsync<T>(load: Load<T>): Promise<T> {
	let step = load.next();
	while (!step.done) {
		let value: unknown;
		try {
			value = await performAsync(step.value);
		} catch (error) {
			step = load.throw(error);
			continue;
		}
		step = load.next(value);
	}
	return step.value;
}

/** Session ids are path components under a workspace bucket; the first bucket holding the id wins. */
function* findSessionDirectory(stateDir: string, sessionId: string): Load<string | null> {
	assertSafeId(sessionId, "session");
	const root = join(stateDir, "sessions");
	const buckets = (yield* list(root))?.sort() ?? [];
	for (const bucket of buckets) {
		const directory = join(root, bucket, sessionId);
		if ((yield* exists(join(directory, "current.jsonl"))) || (yield* exists(join(directory, "calls.jsonl"))))
			return directory;
	}
	return null;
}

function* readLedger(directory: string): Load<{ header: SessionHeader | null; entries: SessionEntry[] }> {
	// A journal-only session has no ledger rows to import.
	const raw = (yield* text(join(directory, "current.jsonl"))) ?? "";
	let header: SessionHeader | null = null;
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionHeader(value)) header ??= value;
			else if (isSessionEntry(value)) entries.push(value);
		} catch {
			// A torn or foreign line carries no call; the fold counts what it can read.
		}
	}
	return { header, entries };
}

function* loadRun(stateDir: string, runId: string): Load<JournalSource> {
	assertSafeId(runId, "run");
	const directory = join(stateDir, "runs", runId);
	try {
		const read = yield* journal(directory, "events.ndjson");
		return journalSourceFromRead(read, yield* exists(join(directory, "events.ndjson")), runId);
	} catch {
		// An unreadable run journal stays visible as unknown coverage (#434).
		return { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
	}
}

/** The ledger's copied fork prefix: the fork point's ancestry, plus a native checkpoint taken at the fork point. */
function copiedFromParent(entries: readonly SessionEntry[], forkPoint: string, forkedAt: string | null): Set<string> {
	const parentOf = new Map(entries.map((entry) => [entry.turnId, entry.parentTurnId]));
	const copied = new Set<string>();
	for (let id: string | null | undefined = forkPoint; id && !copied.has(id); id = parentOf.get(id)) copied.add(id);
	for (const entry of entries)
		if (
			entry.kind === "compactionSummary" &&
			entry.parentTurnId === forkPoint &&
			(forkedAt === null || entry.timestamp <= forkedAt)
		)
			copied.add(entry.turnId);
	return copied;
}

function* legacyRecords(
	stateDir: string,
	sessionId: string,
	entries: readonly SessionEntry[],
	journal: readonly TelemetryRecord[],
	copied: ReadonlySet<string>,
): Load<SessionSource["legacy"]> {
	const journaled = new Set<string>();
	for (const record of journal)
		if (record.k === "call.started" || record.k === "call.settled") journaled.add(record.data.callId);
	// Only rows the journal never held: an assistant message or checkpoint whose call ids resolve is journal-owned.
	const unjournaled = entries.filter((entry) => {
		if (copied.has(entry.turnId) && (entry.kind === "compactionSummary" || entry.kind === "message")) return false;
		if (entry.kind === "compactionSummary")
			return !(entry.callIds?.length && entry.callIds.every((id) => journaled.has(id)));
		if (entry.kind !== "message" || entry.role !== "assistant") return true;
		const callId = (entry.payload as { callId?: unknown } | null)?.callId;
		return !(typeof callId === "string" && journaled.has(callId));
	});
	// Every writer of this store skips a call that carries a journal call id (`recordOutOfTurnUsageFor` in
	// chat-loop.ts, turn-prewarm.ts, system-one-host.ts, compaction-usage.ts), so each row is a call no journal
	// holds and counts whole. A time boundary would drop a row written after the journal opened for a round that
	// had no owned journal. The store is machine-wide; a safe session id appears verbatim in its own rows, so only
	// those lines are parsed.
	const path = outOfTurnUsagePath(stateDir);
	const raw = yield* text(path);
	const mine = raw
		?.split("\n")
		.filter((line) => line.includes(sessionId))
		.join("\n");
	const rows: OutOfTurnUsageRow[] = mine ? parseOutOfTurnUsageRows(mine, path).rows : [];
	const outOfTurn = rows.filter((row) => row.sessionId === sessionId);
	const imported = importLegacySession(sessionId, unjournaled, { outOfTurn, ids: "derived" });
	return { records: imported.records, aggregates: imported.aggregates + imported.invalid };
}

/**
 * Null when no session directory holds the id. A missing or unreadable ancestor leaves `parent.source` null, which
 * the lineage fold reports as unknown coverage.
 */
function* loadSession(
	stateDir: string,
	sessionId: string,
	given: string | null | undefined,
	seen: Set<string>,
): Load<SessionSource | null> {
	const directory = given === undefined ? yield* findSessionDirectory(stateDir, sessionId) : given;
	if (directory === null) return null;
	seen.add(sessionId);
	const own = journalSourceFromRead(
		yield* journal(directory, "calls.jsonl"),
		yield* exists(join(directory, "calls.jsonl")),
	);
	const { header, entries } = yield* readLedger(directory);
	const forked = own.records.find((record) => record.k === "session.forked_from");
	const lineage =
		forked?.k === "session.forked_from"
			? {
					sessionId: forked.data.parentSessionId,
					turnId: forked.data.parentTurnId,
					at: forked.data.parentTurnAt,
					directory: join(stateDir, "sessions", forked.data.parentCwdHash, forked.data.parentSessionId),
				}
			: header?.parentSession && header.parentTurnId
				? { sessionId: header.parentSession, turnId: header.parentTurnId, at: header.timestamp, directory: undefined }
				: null;
	const copied = lineage ? copiedFromParent(entries, lineage.turnId, header?.timestamp ?? null) : new Set<string>();
	const runs = new Map<string, JournalSource>();
	for (const record of own.records)
		if ((record.k === "call.ref" || record.k === "run.ref") && !runs.has(record.data.runId))
			runs.set(record.data.runId, yield* loadRun(stateDir, record.data.runId));
	let parent: SessionSource | null = null;
	if (lineage && !seen.has(lineage.sessionId) && seen.size < MAX_LINEAGE) {
		try {
			assertSafeId(lineage.sessionId, "parent session");
			parent = yield* loadSession(stateDir, lineage.sessionId, lineage.directory, seen);
		} catch {
			// A missing or unsupported ancestor cannot prevent reading the child's own facts (#434).
			parent = null;
		}
	}
	return {
		sessionId,
		journal: own,
		legacy: yield* legacyRecords(stateDir, sessionId, entries, own.records, copied),
		runs,
		parent: lineage ? { sessionId: lineage.sessionId, turnId: lineage.turnId, at: lineage.at, source: parent } : null,
	};
}

export function loadRunTelemetrySource(stateDir: string, runId: string): JournalSource {
	return runSync(loadRun(stateDir, runId));
}

/** The same read off the event loop's critical path, for the live model and ACP (#434). */
export function loadRunTelemetrySourceAsync(stateDir: string, runId: string): Promise<JournalSource> {
	return runAsync(loadRun(stateDir, runId));
}

export function loadSessionTelemetrySource(
	stateDir: string,
	sessionId: string,
	directory?: string | null,
): SessionSource | null {
	return runSync(loadSession(stateDir, sessionId, directory, new Set()));
}

export function loadSessionTelemetrySourceAsync(stateDir: string, sessionId: string): Promise<SessionSource | null> {
	return runAsync(loadSession(stateDir, sessionId, undefined, new Set()));
}

/** The keyset after a page of run journals: the last row's write time and id. */
export interface RunListCursor {
	writtenMs: number | null;
	runId: string;
}
export interface RunTelemetryListing {
	runs: Array<{ runId: string; writtenAt: string | null; source: JournalSource }>;
	/** Null on the last page. */
	nextBefore: RunListCursor | null;
}

const writeKey = (writtenMs: number | null) => writtenMs ?? -1;
/** Newest write first, then the higher id, so two runs written in the same millisecond page deterministically. */
function newestFirst(a: { runId: string; writtenMs: number | null }, b: { runId: string; writtenMs: number | null }) {
	return writeKey(b.writtenMs) - writeKey(a.writtenMs) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0);
}

/**
 * Every run journal under `<state>/runs`, newest write first. Dispatch run ids are random, and ordering by a run's
 * first record would read every journal, so the page key is the journal file's write time: one stat per run, and
 * only the page's journals are read. A run directory with no journal lists last, as `present: false`, which the
 * read model reports as unknown coverage rather than leaving the run out (#434 R9).
 */
function* listRuns(
	stateDir: string,
	page: { limit: number; before?: RunListCursor | null },
): Load<RunTelemetryListing> {
	const root = join(stateDir, "runs");
	const entries: Array<{ runId: string; writtenMs: number | null }> = [];
	for (const name of (yield* list(root)) ?? []) {
		try {
			assertSafeId(name, "run");
		} catch {
			// A name that is not a run id cannot be a run directory.
			continue;
		}
		entries.push({ runId: name, writtenMs: yield* mtime(join(root, name, "events.ndjson")) });
	}
	entries.sort(newestFirst);
	const before = page.before;
	const after = before ? entries.filter((entry) => newestFirst(entry, before) > 0) : entries;
	const window = after.slice(0, Math.max(1, Math.floor(page.limit)));
	const runs: RunTelemetryListing["runs"] = [];
	for (const entry of window)
		runs.push({
			runId: entry.runId,
			writtenAt: entry.writtenMs === null ? null : new Date(entry.writtenMs).toISOString(),
			source: yield* loadRun(stateDir, entry.runId),
		});
	const last = window.at(-1);
	return {
		runs,
		nextBefore: after.length > window.length && last ? { writtenMs: last.writtenMs, runId: last.runId } : null,
	};
}

export function listRunTelemetrySources(
	stateDir: string,
	page: { limit: number; before?: RunListCursor | null },
): RunTelemetryListing {
	return runSync(listRuns(stateDir, page));
}

export function listRunTelemetrySourcesAsync(
	stateDir: string,
	page: { limit: number; before?: RunListCursor | null },
): Promise<RunTelemetryListing> {
	return runAsync(listRuns(stateDir, page));
}
