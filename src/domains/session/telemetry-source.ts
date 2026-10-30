import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import type { ReceiptEvidenceV1 } from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { readReceiptEvidence } from "../dispatch/receipt-facts.js";
import type { RunEnvelope, RunReceipt } from "../dispatch/types.js";
import type { ReceiptIntegrityOutcome } from "../evidence/trust-status.js";
import { verifyReceiptIntegrityOutcome } from "../evidence/trust-status.js";
import type { CallJournalRead } from "../observability/call-journal.js";
import { readCallJournal, readCallJournalSync } from "../observability/call-journal.js";
import type { OutOfTurnUsageRow } from "../observability/out-of-turn-usage.js";
import { outOfTurnUsagePath, parseOutOfTurnUsageRows } from "../observability/out-of-turn-usage.js";
import type { JournalSource, ProcessIdentity, SessionSource } from "../observability/read-model.js";
import { journalSourceFromRead } from "../observability/read-model.js";
import type { SessionEntry, SessionHeader } from "./entries.js";
import { isSessionEntry, isSessionHeader } from "./entries.js";
import type { LegacyReceiptSeal } from "./legacy-import.js";
import { importLegacyReceipt, importLegacySession } from "./legacy-import.js";

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
	| { op: "mtime"; path: string }
	| { op: "runRow"; ledger: string; runId: string };
type FileIo = Exclude<Io, { op: "runRow" }>;
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
/** The run's `runs.json` row, read once per load and only when a receipt needs it; null when the ring holds none. */
function* runRow(stateDir: string, runId: string): Load<Record<string, unknown> | null> {
	return (yield { op: "runRow", ledger: join(stateDir, "runs.json"), runId }) as Record<string, unknown> | null;
}
/** Last write time in epoch ms; null when the file cannot be stat'ed. */
function* mtime(path: string): Load<number | null> {
	return (yield { op: "mtime", path }) as number | null;
}

function performSync(io: FileIo): unknown {
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

async function performAsync(io: FileIo): Promise<unknown> {
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

/** `texts` keeps each file read once across one load, such as the machine-wide out-of-turn store. */
/** A run ledger's rows by id; an unreadable or torn ledger holds none, so each receipt verifies on its seal alone. */
function runRowsOf(text: unknown): Map<string, Record<string, unknown>> {
	let parsed: unknown = null;
	try {
		parsed = typeof text === "string" ? JSON.parse(text) : null;
	} catch {
		// A torn ledger authenticates no receipt; each reads as one whose row the ring evicted.
		parsed = null;
	}
	const rows = new Map<string, Record<string, unknown>>();
	if (Array.isArray(parsed))
		for (const row of parsed)
			if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string")
				rows.set((row as { id: string }).id, row as Record<string, unknown>);
	return rows;
}

function runSync<T>(load: Load<T>, texts?: Map<string, unknown>): T {
	const ledgers = new Map<string, Map<string, Record<string, unknown>>>();
	let step = load.next();
	while (!step.done) {
		let value: unknown;
		try {
			const io = step.value;
			if (io.op === "runRow") {
				const rows = ledgers.get(io.ledger) ?? runRowsOf(performSync({ op: "text", path: io.ledger }));
				ledgers.set(io.ledger, rows);
				value = rows.get(io.runId) ?? null;
			} else if (texts && io.op === "text") {
				if (!texts.has(io.path)) texts.set(io.path, performSync(io));
				value = texts.get(io.path);
			} else value = performSync(io);
		} catch (error) {
			step = load.throw(error);
			continue;
		}
		step = load.next(value);
	}
	return step.value;
}

async function runAsync<T>(load: Load<T>): Promise<T> {
	const ledgers = new Map<string, Map<string, Record<string, unknown>>>();
	let step = load.next();
	while (!step.done) {
		let value: unknown;
		try {
			const io = step.value;
			if (io.op === "runRow") {
				const rows = ledgers.get(io.ledger) ?? runRowsOf(await performAsync({ op: "text", path: io.ledger }));
				ledgers.set(io.ledger, rows);
				value = rows.get(io.runId) ?? null;
			} else value = await performAsync(io);
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

/** `meta.json`'s close and owner; absent when the file is missing or unreadable, so nothing claims a clean close. */
function* readLifecycle(directory: string): Load<SessionSource["ledger"] | undefined> {
	const raw = yield* text(join(directory, "meta.json"));
	if (raw === null) return undefined;
	let meta: { endedAt?: unknown; owner?: { host?: unknown; pid?: unknown; birth?: unknown } };
	try {
		meta = JSON.parse(raw) as typeof meta;
	} catch {
		// A torn meta.json cannot say whether the session closed; the journal's writer decides instead.
		return undefined;
	}
	const owner = meta.owner;
	const identity: ProcessIdentity | null =
		owner && typeof owner.host === "string" && owner.host.length > 0 && Number.isSafeInteger(owner.pid)
			? {
					host: owner.host,
					pid: owner.pid as number,
					birthToken: typeof owner.birth === "string" ? owner.birth : null,
				}
			: null;
	return { endedAt: typeof meta.endedAt === "string" ? meta.endedAt : null, owner: identity };
}

/** The run's sealed receipt as one `legacy-import` snapshot; null when it is absent or not this run's. */
function* receiptSource(stateDir: string, runId: string): Load<JournalSource | null> {
	const raw = yield* text(join(stateDir, "receipts", `${runId}.json`));
	if (raw === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		// A torn receipt holds no totals to keep; the run stays unknown coverage.
		return null;
	}
	const record = importLegacyReceipt(runId, value, yield* receiptSeal(stateDir, runId, value));
	return record ? { present: true, records: [record], modes: [], skipped: 0, damaged: 0 } : null;
}

/**
 * The receipt's seal through the verifier every receipt reader uses, against its ledger row when the ring still holds
 * it. A retired seal or none at all is a legacy receipt this build cannot check; only a current seal that fails to
 * verify reads as failed (#434).
 */
function* receiptSeal(stateDir: string, runId: string, value: unknown): Load<LegacyReceiptSeal> {
	if (!value || typeof value !== "object" || (value as { integrity?: unknown }).integrity === undefined) return "legacy";
	let outcome: ReceiptIntegrityOutcome;
	try {
		outcome = verifyReceiptIntegrityOutcome(
			value as RunReceipt,
			(yield* runRow(stateDir, runId)) as unknown as RunEnvelope | null,
		);
	} catch {
		// A receipt the verifier cannot even read is no evidence of what it claims.
		return "failed";
	}
	return outcome.ok ? "verified" : outcome.retired ? "legacy" : "failed";
}

function* loadRun(stateDir: string, runId: string): Load<JournalSource> {
	assertSafeId(runId, "run");
	const directory = join(stateDir, "runs", runId);
	try {
		const read = yield* journal(directory, "events.ndjson");
		const source = journalSourceFromRead(read, yield* exists(join(directory, "events.ndjson")), runId);
		// A run with no journal keeps its sealed receipt's known totals rather than leaving the report smaller (#434).
		return source.present ? source : ((yield* receiptSource(stateDir, runId)) ?? source);
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
	ancestors = true,
): Load<SessionSource | null> {
	const directory = given === undefined ? yield* findSessionDirectory(stateDir, sessionId) : given;
	if (directory === null) return null;
	seen.add(sessionId);
	const own = journalSourceFromRead(
		yield* journal(directory, "calls.jsonl"),
		yield* exists(join(directory, "calls.jsonl")),
	);
	const { header, entries } = yield* readLedger(directory);
	const ledger = yield* readLifecycle(directory);
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
	if (ancestors && lineage && !seen.has(lineage.sessionId) && seen.size < MAX_LINEAGE) {
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
		...(ledger ? { ledger } : {}),
	};
}

export function loadRunTelemetrySource(stateDir: string, runId: string): JournalSource {
	return runSync(loadRun(stateDir, runId));
}

/** The same read off the event loop's critical path, for the live model and ACP (#434). */
export function loadRunTelemetrySourceAsync(stateDir: string, runId: string): Promise<JournalSource> {
	return runAsync(loadRun(stateDir, runId));
}

/** The run's sealed receipt through its integrity check, for the run DTO (#434 §11.1). */
export function loadRunReceiptEvidence(stateDir: string, runId: string): ReceiptEvidenceV1 {
	assertSafeId(runId, "run");
	return readReceiptEvidence(runId, stateDir);
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

/** A report window: one workspace bucket's sessions, or every bucket's, between two epoch-ms bounds (#434 §11.1). */
export interface RepoTelemetryWindow {
	/** Null reads every bucket. */
	cwdHash: string | null;
	from: number;
	to: number;
	/** Run journals with no session that count toward the window: every one, or only the ids the caller attributes. */
	standaloneRuns: "all" | ReadonlySet<string>;
}
export interface RepoTelemetrySources {
	sessions: SessionSource[];
	/** Standalone run journals, windowed. */
	runs: Map<string, JournalSource>;
}

const isCall = (record: TelemetryRecord) => record.k === "call.started" || record.k === "call.settled";
const accounting = (record: TelemetryRecord) => record.k === "run.usage" || isCall(record);

/**
 * An attempt counts in the window its settlement falls in, or its start while it has none; any other record counts by
 * its own time. This is how `usage report` has always windowed calls (#434).
 */
function windowRecords(records: readonly TelemetryRecord[], from: number, to: number): TelemetryRecord[] {
	const within = (at: string) => {
		const ms = Date.parse(at);
		return ms >= from && ms <= to;
	};
	const selected = new Map<string, boolean>();
	for (const record of records)
		if (isCall(record) && (record.k === "call.settled" || !selected.has(record.data.attemptId)))
			selected.set(record.data.attemptId, within(record.t));
	return records.filter((record) => (isCall(record) ? selected.get(record.data.attemptId) === true : within(record.t)));
}

/**
 * A session as the window sees it: its in-window records, the runs with in-window accounting (or none at all but an
 * in-window reference), and no ancestor, since an ancestor in the window is one of the window's own sessions.
 */
function windowSession(source: SessionSource, from: number, to: number): SessionSource {
	const records = windowRecords(source.journal.records, from, to);
	const referenced = new Set(
		records.flatMap((record) => (record.k === "run.ref" || record.k === "call.ref" ? [record.data.runId] : [])),
	);
	const runs = new Map<string, JournalSource>();
	for (const [runId, run] of source.runs) {
		const windowed = { ...run, records: windowRecords(run.records, from, to) };
		if (windowed.records.some(accounting) || (!run.records.some(accounting) && referenced.has(runId)))
			runs.set(runId, windowed);
	}
	return {
		sessionId: source.sessionId,
		journal: {
			...source.journal,
			// A reference to a run the window leaves out would read as an unreadable run.
			records: records.filter(
				(record) => (record.k !== "run.ref" && record.k !== "call.ref") || runs.has(record.data.runId),
			),
		},
		legacy: { ...source.legacy, records: windowRecords(source.legacy.records, from, to) },
		runs,
		parent: null,
	};
}

/** Newest write among the files matching `pattern`; +∞ when one vanished mid-scan, since it was just written. */
function* newestWrite(directory: string, pattern: RegExp): Load<number> {
	let newest = Number.NEGATIVE_INFINITY;
	for (const name of (yield* list(directory)) ?? []) {
		if (!pattern.test(name)) continue;
		newest = Math.max(newest, (yield* mtime(join(directory, name))) ?? Number.POSITIVE_INFINITY);
	}
	return newest;
}

const SESSION_FILES = /^(?:current\.jsonl|calls(?:\.rec_[0-9a-f-]+)?\.jsonl)$/u;
const RUN_FILES = /^events(?:\.rec_[0-9a-f-]+)?\.ndjson$/u;
const safeId = (name: string) => /^[a-zA-Z0-9_-]+$/u.test(name);

function* loadRepo(stateDir: string, window: RepoTelemetryWindow): Load<RepoTelemetrySources> {
	const { from, to } = window;
	// A side call settles into the machine-wide store, not the session's files, so its session counts by its rows.
	const storePath = outOfTurnUsagePath(stateDir);
	const store = yield* text(storePath);
	const sideCalls = (store ? parseOutOfTurnUsageRows(store, storePath).rows : []).filter((row) => {
		const at = Date.parse(row.timestamp);
		return at >= from && at <= to && (window.cwdHash === null || row.repoIdentity === window.cwdHash);
	});
	const sideCallSessions = new Set(sideCalls.flatMap((row) => (row.sessionId ? [row.sessionId] : [])));
	const root = join(stateDir, "sessions");
	const buckets = window.cwdHash === null ? ((yield* list(root)) ?? []).filter(safeId).sort() : [window.cwdHash];
	const sessions: SessionSource[] = [];
	const referenced = new Set<string>();
	for (const bucket of buckets)
		for (const sessionId of ((yield* list(join(root, bucket))) ?? []).filter(safeId).sort()) {
			const directory = join(root, bucket, sessionId);
			if ((yield* newestWrite(directory, SESSION_FILES)) < from && !sideCallSessions.has(sessionId)) continue;
			const source = yield* loadSession(stateDir, sessionId, directory, new Set(), false);
			if (!source) continue;
			for (const runId of source.runs.keys()) referenced.add(runId);
			sessions.push(windowSession(source, from, to));
		}
	sessions.push(...unownedSideCalls(sideCalls, new Set(sessions.map((session) => session.sessionId)), from, to));
	const runs = new Map<string, JournalSource>();
	const runsRoot = join(stateDir, "runs");
	const receiptsRoot = join(stateDir, "receipts");
	const receipted = ((yield* list(receiptsRoot)) ?? []).flatMap((name) =>
		name.endsWith(".json") ? [name.slice(0, -".json".length)] : [],
	);
	const runIds = new Set([...((yield* list(runsRoot)) ?? []), ...receipted]);
	for (const runId of [...runIds].filter(safeId).sort()) {
		if (referenced.has(runId) || (window.standaloneRuns !== "all" && !window.standaloneRuns.has(runId))) continue;
		const journaled = yield* newestWrite(join(runsRoot, runId), RUN_FILES);
		const receiptOnly = journaled === Number.NEGATIVE_INFINITY;
		// A receipt is written once, at seal, after the run ended, so an older file cannot hold an in-window run.
		const written = receiptOnly ? ((yield* mtime(join(receiptsRoot, `${runId}.json`))) ?? journaled) : journaled;
		if (written < from) continue;
		const source = yield* loadRun(stateDir, runId);
		if (receiptOnly) {
			// No session journal references a run from before run journals, so its receipt counts here, unless it only
			// mirrors a session's own spend: a headless main agent's run, or an ACP peer that was a Clio session (#434).
			if (!source.present || (yield* mirroredSession(stateDir, join(receiptsRoot, `${runId}.json`)))) continue;
		}
		// A run a session owns belongs to that session's accounting, in or out of this window (#434).
		else if (source.records.some((record) => record.ctx.sessionId !== null)) continue;
		const windowed = { ...source, records: windowRecords(source.records, from, to) };
		if (windowed.records.some(accounting) || !source.present) runs.set(runId, windowed);
	}
	return { sessions, runs };
}

/** Owner of side calls recorded while no session was current; never a real session id, which is 12 base36 characters. */
const NO_SESSION = "no-session";

/**
 * Side calls whose session the window loaded no source for still count, as pre-0.6.6 reports counted them (#434 R9):
 * a row written while no session was current (no `sessionId`), and a row whose session directory is gone. Each
 * folds as its own sessionless source, through the importer every session's side calls go through.
 */
function unownedSideCalls(
	rows: readonly OutOfTurnUsageRow[],
	loaded: ReadonlySet<string>,
	from: number,
	to: number,
): SessionSource[] {
	const byOwner = new Map<string, OutOfTurnUsageRow[]>();
	for (const row of rows) {
		const sessionId = typeof row.sessionId === "string" ? row.sessionId : null;
		if (sessionId !== null && loaded.has(sessionId)) continue;
		const owner = sessionId !== null && safeId(sessionId) ? sessionId : NO_SESSION;
		const owned = byOwner.get(owner);
		if (owned) owned.push({ ...row, sessionId: owner });
		else byOwner.set(owner, [{ ...row, sessionId: owner }]);
	}
	return [...byOwner]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([owner, owned]) => {
			const imported = importLegacySession(owner, [], { outOfTurn: owned, ids: "derived" });
			return windowSession(
				{
					sessionId: owner,
					journal: { present: false, records: [], modes: [], skipped: 0, damaged: 0 },
					legacy: { records: imported.records, aggregates: imported.aggregates + imported.invalid },
					runs: new Map(),
					parent: null,
				},
				from,
				to,
			);
		});
}

/** True when the receipt's spend is a session's own, which that session's ledger and journal already hold. */
function* mirroredSession(stateDir: string, path: string): Load<boolean> {
	const raw = yield* text(path);
	let receipt: { agentId?: unknown; sessionId?: unknown; delegation?: { acpSessionId?: unknown } | null };
	try {
		receipt = raw === null ? {} : JSON.parse(raw);
	} catch {
		// loadRun already read this file as a receipt; a torn second read keeps the run counted.
		return false;
	}
	const sessionId = receipt.agentId === "main-agent" ? receipt.sessionId : receipt.delegation?.acpSessionId;
	if (typeof sessionId !== "string" || !safeId(sessionId)) return false;
	return (yield* findSessionDirectory(stateDir, sessionId)) !== null;
}

/** Every session and standalone run a `usage report` window covers, windowed; a cold, synchronous read for the CLI. */
export function loadRepoTelemetrySources(stateDir: string, window: RepoTelemetryWindow): RepoTelemetrySources {
	return runSync(loadRepo(stateDir, window), new Map());
}
