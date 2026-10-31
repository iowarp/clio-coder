import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import type { ReceiptEvidenceV1 } from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { readReceiptEvidence } from "../dispatch/receipt-facts.js";
import type { CallJournalRead } from "../telemetry/call-journal.js";
import { readCallJournal, readCallJournalSync } from "../telemetry/call-journal.js";
import {
	isTelemetryJournalFile,
	telemetryJournalPath,
	telemetryProcessDirectory,
	telemetryProcessesDirectory,
	telemetryRunDirectory,
	telemetryRunsDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "../telemetry/index.js";
import type { JournalSource, ProcessIdentity, SessionSource } from "../telemetry/read-model.js";
import { journalSourceFromRead, sessionAccountQuotaWindow } from "../telemetry/read-model.js";
import type { TelemetryScopeFiles } from "../telemetry/seal.js";
import { readTelemetryScopeFiles, readTelemetryScopeFilesSync } from "../telemetry/seal.js";

/**
 * Cold-path loader for the telemetry read model (#434 §11): a session's own journal, the run journals it referenced,
 * and its fork ancestors. Session spend is whole-session: every branch the account paid for counts. A fork child's
 * journal holds only its own calls, so its parent's calls are left to the parent's own fold. The journals are the
 * only source; a session or run without one reads as not measured.
 *
 * The loader is one generator over its file reads, run synchronously for the CLI and asynchronously for the live
 * model's seed, so the seed and `clio-coder telemetry` cannot read a session two different ways.
 */

const MAX_LINEAGE = 32;

type Io =
	| { op: "journal"; directory: string }
	| { op: "text"; path: string }
	| { op: "list"; path: string }
	| { op: "exists"; path: string }
	| { op: "mtime"; path: string }
	| { op: "scope"; directory: string };
type Load<T> = Generator<Io, T, unknown>;

function* journal(directory: string): Load<CallJournalRead> {
	return (yield { op: "journal", directory }) as CallJournalRead;
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

/** A scope directory's files for its seal verdict; null when the directory cannot be read. */
function* scopeFiles(directory: string): Load<TelemetryScopeFiles | null> {
	return (yield { op: "scope", directory }) as TelemetryScopeFiles | null;
}

function performSync(io: Io): unknown {
	switch (io.op) {
		case "scope":
			try {
				return readTelemetryScopeFilesSync(io.directory);
			} catch {
				// No readable scope: the run DTO reports no seal verdict rather than a failed one.
				return null;
			}
		case "journal":
			return readCallJournalSync(io.directory);
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
		case "scope":
			return readTelemetryScopeFiles(io.directory).catch(() => null);
		case "journal":
			return readCallJournal(io.directory);
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

/**
 * The session's store directory, which holds its ledger and meta.json. Session ids are path components under a
 * workspace bucket; the first bucket holding the id wins. Its journal lives apart, under the telemetry root (#434).
 */
function* findSessionDirectory(stateDir: string, sessionId: string): Load<string | null> {
	assertSafeId(sessionId, "session");
	const root = join(stateDir, "sessions");
	const buckets = (yield* list(root))?.sort() ?? [];
	for (const bucket of buckets) {
		const directory = join(root, bucket, sessionId);
		if ((yield* exists(join(directory, "current.jsonl"))) || (yield* exists(join(directory, "meta.json"))))
			return directory;
	}
	return null;
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

function* loadRun(stateDir: string, runId: string): Load<JournalSource> {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	try {
		const read = yield* journal(directory);
		return journalSourceFromRead(read, yield* exists(telemetryJournalPath(directory)), runId);
	} catch {
		// An unreadable run journal stays visible as unknown coverage (#434).
		return { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
	}
}

/**
 * Null when neither a store directory nor a journal holds the id. `given` is the session's store directory, which
 * holds its meta.json; its journal is the telemetry root's. The fork parent is the one the journal's
 * `session.forked` names. A missing or unreadable ancestor leaves `parent.source` null, which the lineage fold
 * reports as unknown coverage.
 */
function* loadSession(
	stateDir: string,
	sessionId: string,
	given: string | null | undefined,
	seen: Set<string>,
	ancestors = true,
): Load<SessionSource | null> {
	const directory = given === undefined ? yield* findSessionDirectory(stateDir, sessionId) : given;
	const journalDirectory = telemetrySessionDirectory(stateDir, sessionId);
	const journaled = yield* exists(telemetryJournalPath(journalDirectory));
	if (directory === null && !journaled) return null;
	seen.add(sessionId);
	const own = journalSourceFromRead(yield* journal(journalDirectory), journaled);
	const ledger = directory === null ? undefined : yield* readLifecycle(directory);
	const forked = own.records.find((record) => record.k === "session.forked");
	const lineage =
		forked?.k === "session.forked"
			? {
					sessionId: forked.data.parentSessionId,
					turnId: forked.data.parentTurnId,
					at: forked.data.parentTurnAt,
					directory: join(stateDir, "sessions", forked.data.parentCwdHash, forked.data.parentSessionId),
				}
			: null;
	const runs = new Map<string, JournalSource>();
	for (const record of own.records)
		if ((record.k === "call.linked" || record.k === "run.linked") && !runs.has(record.data.runId))
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
		runs,
		parent: lineage ? { sessionId: lineage.sessionId, turnId: lineage.turnId, at: lineage.at, source: parent } : null,
		...(ledger ? { ledger } : {}),
	};
}

const PROCESS_ID = /^prc_[0-9a-f-]+$/u;

/**
 * The quota readings this host's process journals hold, oldest journal first. A quota window belongs to the account,
 * so the process that saw it journals it; `since` skips a journal last written before it (#434).
 */
function* hostQuotaRecords(stateDir: string, since: number | null): Load<TelemetryRecord[]> {
	const host = hostname();
	const records: TelemetryRecord[] = [];
	for (const name of ((yield* list(telemetryProcessesDirectory(stateDir))) ?? []).sort()) {
		if (!PROCESS_ID.test(name)) continue;
		const directory = telemetryProcessDirectory(stateDir, name);
		if (since !== null) {
			const written = yield* mtime(telemetryJournalPath(directory));
			if (written === null || written < since) continue;
		}
		for (const { record, origin } of (yield* journal(directory)).records)
			if (record.k === "quota.read" && origin.host === host) records.push(record);
	}
	return records;
}

/** The account readings recorded while the session ran: from its first record to its close, or until now (#434). */
function* withAccountQuota(stateDir: string, load: Load<SessionSource | null>): Load<SessionSource | null> {
	const source = yield* load;
	if (!source) return source;
	const window = sessionAccountQuotaWindow(source.journal.records);
	if (!window) return source;
	const { from, to } = window;
	const accountQuota = (yield* hostQuotaRecords(stateDir, from)).filter((record) => {
		const at = Date.parse(record.t);
		return at >= from && at <= to;
	});
	return accountQuota.length > 0 ? { ...source, accountQuota } : source;
}

/** This host's journaled quota readings, for the live quota view's seed (#434). */
export function loadHostQuotaRecordsAsync(stateDir: string): Promise<TelemetryRecord[]> {
	return runAsync(hostQuotaRecords(stateDir, null));
}

/** One process journal: the calls its process made with no session or run (#434). */
function* loadProcess(stateDir: string, processId: string): Load<JournalSource> {
	assertSafeId(processId, "process");
	const directory = telemetryProcessDirectory(stateDir, processId);
	try {
		return journalSourceFromRead(yield* journal(directory), yield* exists(telemetryJournalPath(directory)));
	} catch {
		// An unreadable process journal stays visible as unknown coverage (#434).
		return { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
	}
}

export function loadProcessTelemetrySourceAsync(stateDir: string, processId: string): Promise<JournalSource> {
	return runAsync(loadProcess(stateDir, processId));
}

export function loadRunTelemetrySource(stateDir: string, runId: string): JournalSource {
	return runSync(loadRun(stateDir, runId));
}

/** The same read off the event loop's critical path, for the live model and ACP (#434). */
export function loadRunTelemetrySourceAsync(stateDir: string, runId: string): Promise<JournalSource> {
	return runAsync(loadRun(stateDir, runId));
}

function* loadRunScope(stateDir: string, runId: string): Load<TelemetryScopeFiles | null> {
	assertSafeId(runId, "run");
	return yield* scopeFiles(telemetryRunDirectory(stateDir, runId));
}

/** A run scope's own files, which the run DTO reads its seal verdict and result object from (#434). */
export function loadRunScopeFiles(stateDir: string, runId: string): TelemetryScopeFiles | null {
	return runSync(loadRunScope(stateDir, runId));
}

export function loadRunScopeFilesAsync(stateDir: string, runId: string): Promise<TelemetryScopeFiles | null> {
	return runAsync(loadRunScope(stateDir, runId));
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
	return runSync(withAccountQuota(stateDir, loadSession(stateDir, sessionId, directory, new Set())));
}

export function loadSessionTelemetrySourceAsync(stateDir: string, sessionId: string): Promise<SessionSource | null> {
	return runAsync(withAccountQuota(stateDir, loadSession(stateDir, sessionId, undefined, new Set())));
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
 * Every run journal under the telemetry root's `runs/`, newest write first. Dispatch run ids are random, and ordering by a run's
 * first record would read every journal, so the page key is the journal file's write time: one stat per run, and
 * only the page's journals are read. A run directory with no journal lists last, as `present: false`, which the
 * read model reports as unknown coverage rather than leaving the run out (#434 R9).
 */
function* listRuns(
	stateDir: string,
	page: { limit: number; before?: RunListCursor | null },
): Load<RunTelemetryListing> {
	const root = telemetryRunsDirectory(stateDir);
	const entries: Array<{ runId: string; writtenMs: number | null }> = [];
	for (const name of (yield* list(root)) ?? []) {
		try {
			assertSafeId(name, "run");
		} catch {
			// A name that is not a run id cannot be a run directory.
			continue;
		}
		entries.push({ runId: name, writtenMs: yield* mtime(telemetryJournalPath(telemetryRunDirectory(stateDir, name))) });
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

/** Run ids with a directory under the telemetry root's `runs/`; none when it does not exist, and other errors throw. */
export function listRunTelemetryIds(stateDir: string): string[] {
	try {
		return readdirSync(telemetryRunsDirectory(stateDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Whether the run has a telemetry directory; one whose journal is missing or torn is unknown coverage, not absent. */
export function runTelemetryDirectoryExists(stateDir: string, runId: string): boolean {
	assertSafeId(runId, "run");
	return statSync(telemetryRunDirectory(stateDir, runId), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** The run journal's last write in epoch ms, the key run listings page by; null when it was never written. */
export function runTelemetryWrittenMs(stateDir: string, runId: string): number | null {
	assertSafeId(runId, "run");
	return (
		statSync(telemetryJournalPath(telemetryRunDirectory(stateDir, runId)), { throwIfNoEntry: false })?.mtimeMs ?? null
	);
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
const accounting = (record: TelemetryRecord) => record.k === "run.usage_reported" || isCall(record);

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
		records.flatMap((record) => (record.k === "run.linked" || record.k === "call.linked" ? [record.data.runId] : [])),
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
				(record) => (record.k !== "run.linked" && record.k !== "call.linked") || runs.has(record.data.runId),
			),
		},
		runs,
		parent: null,
	};
}

/** Newest write among the files `matches` accepts; +∞ when one vanished mid-scan, since it was just written. */
function* newestWrite(directory: string, matches: (name: string) => boolean): Load<number> {
	let newest = Number.NEGATIVE_INFINITY;
	for (const name of (yield* list(directory)) ?? []) {
		if (!matches(name)) continue;
		newest = Math.max(newest, (yield* mtime(join(directory, name))) ?? Number.POSITIVE_INFINITY);
	}
	return newest;
}

const isLedger = (name: string) => name === "current.jsonl";
const safeId = (name: string) => /^[a-zA-Z0-9_-]+$/u.test(name);

function* loadRepo(stateDir: string, window: RepoTelemetryWindow): Load<RepoTelemetrySources> {
	const { from, to } = window;
	const root = join(stateDir, "sessions");
	const buckets = window.cwdHash === null ? ((yield* list(root)) ?? []).filter(safeId).sort() : [window.cwdHash];
	const sessions: SessionSource[] = [];
	const referenced = new Set<string>();
	for (const bucket of buckets)
		for (const sessionId of ((yield* list(join(root, bucket))) ?? []).filter(safeId).sort()) {
			const directory = join(root, bucket, sessionId);
			const written = Math.max(
				yield* newestWrite(directory, isLedger),
				yield* newestWrite(telemetrySessionDirectory(stateDir, sessionId), isTelemetryJournalFile),
			);
			if (written < from) continue;
			const source = yield* loadSession(stateDir, sessionId, directory, new Set(), false);
			if (!source) continue;
			for (const runId of source.runs.keys()) referenced.add(runId);
			sessions.push(windowSession(source, from, to));
		}
	// Every workspace's window also holds a journal whose session no store bucket names; its spend still happened.
	if (window.cwdHash === null) {
		const bucketed = new Set(sessions.map((session) => session.sessionId));
		const journals = telemetrySessionsDirectory(stateDir);
		for (const sessionId of ((yield* list(journals)) ?? []).filter(safeId).sort()) {
			if (bucketed.has(sessionId) || (yield* findSessionDirectory(stateDir, sessionId)) !== null) continue;
			if ((yield* newestWrite(join(journals, sessionId), isTelemetryJournalFile)) < from) continue;
			const source = yield* loadSession(stateDir, sessionId, null, new Set(), false);
			if (!source) continue;
			for (const runId of source.runs.keys()) referenced.add(runId);
			sessions.push(windowSession(source, from, to));
		}
	}
	// A call no session or run owned lives in its process's journal and belongs to no workspace, so only the
	// every-workspace window counts it, as its own sessionless source (#434).
	if (window.cwdHash === null) {
		const processes = telemetryProcessesDirectory(stateDir);
		for (const processId of ((yield* list(processes)) ?? []).filter((name) => PROCESS_ID.test(name)).sort()) {
			if ((yield* newestWrite(join(processes, processId), isTelemetryJournalFile)) < from) continue;
			const journal = yield* loadProcess(stateDir, processId);
			if (!journal.records.some(isCall)) continue;
			const source: SessionSource = { sessionId: processId, journal, runs: new Map(), parent: null };
			sessions.push(windowSession(source, from, to));
		}
	}
	const runs = new Map<string, JournalSource>();
	for (const runId of ((yield* list(telemetryRunsDirectory(stateDir))) ?? []).filter(safeId).sort()) {
		if (referenced.has(runId) || (window.standaloneRuns !== "all" && !window.standaloneRuns.has(runId))) continue;
		// A run directory with no journal was never written, so no window holds it.
		if ((yield* newestWrite(telemetryRunDirectory(stateDir, runId), isTelemetryJournalFile)) < from) continue;
		const source = yield* loadRun(stateDir, runId);
		// A run a session owns belongs to that session's accounting, in or out of this window (#434).
		if (source.records.some((record) => record.ctx.sessionId !== null)) continue;
		const windowed = { ...source, records: windowRecords(source.records, from, to) };
		if (windowed.records.some(accounting) || !source.present) runs.set(runId, windowed);
	}
	return { sessions, runs };
}

/** Every session and standalone run a `usage report` window covers, windowed; a cold, synchronous read for the CLI. */
export function loadRepoTelemetrySources(stateDir: string, window: RepoTelemetryWindow): RepoTelemetrySources {
	return runSync(loadRepo(stateDir, window));
}
