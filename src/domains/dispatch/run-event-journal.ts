/**
 * Append-only run event journal.
 *
 * Live dispatch events exist only in `DispatchRunEventRegistry`'s in-memory
 * tail (src/tools/dispatch-run-events.ts), so a separate process cannot see a
 * run in flight: the ledger and receipts are durable but the event stream is
 * not. This module tees that same display tail to disk so a viewer process
 * (`clio-coder fleet view`) can follow a run without sharing the orchestrator's
 * heap.
 *
 * On-disk layout under `clioStateDir()`:
 *   runs/<runId>/events.ndjson    one JSON object per line, newest last
 *
 * Every line carries a monotonically increasing `seq` (per run, starting at 1)
 * and a wall-clock `at`. Line kinds:
 *   open               run opened, carries agentId
 *   event              one display-tail entry; the only droppable kind
 *   journal_truncated  written once, the moment dropping begins
 *   receipt            sealed receipt facts (outcome, exit code, digest)
 *   terminal           always the last write for a run
 *
 * Bounding follows the worker bulk lane's philosophy. Display-only `event`
 * lines are dropped once a run's journal crosses {@link
 * RUN_EVENT_JOURNAL_CAP_BYTES}, and a single `journal_truncated` marker records
 * that dropping began. Lifecycle (`open`, `terminal`) and receipt-bearing lines
 * are never dropped, so a capped journal still answers what the run was and how
 * it ended.
 *
 * Writes are buffered and flushed with one `appendFileSync` per batch rather
 * than queued onto an async chain. A queue would need a timer to drain, and a
 * timer on the dispatch event path either keeps a finished process alive or has
 * to be unref'd and then races finalization; batching keeps the syscall count
 * proportional to bytes written and leaves no handle behind. Every
 * non-droppable line flushes immediately, so the durable file is never behind
 * on the facts a viewer needs.
 *
 * A sink failure (ENOSPC, EPERM, a removed state root) degrades the whole
 * journal to off after one notice. Nothing here ever throws into a dispatch.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeClioCoderEventType } from "../../core/naming-events.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";

/** Directory name under the state root holding one subdirectory per run. */
export const RUN_EVENT_JOURNAL_DIR = "runs";
/** File name inside each run's journal directory. */
export const RUN_EVENT_JOURNAL_FILE = "events.ndjson";
/** Per-run size cap; crossing it drops display-only lines behind one marker. */
export const RUN_EVENT_JOURNAL_CAP_BYTES = 2 * 1024 * 1024;
/** Pending bytes that trigger a flush of droppable lines. */
export const RUN_EVENT_JOURNAL_FLUSH_BYTES = 8 * 1024;
/** Per-process env override, resolved ahead of settings (see runEventJournalEnabled). */
export const RUN_EVENT_JOURNAL_ENV_VAR = "CLIO_CODER_RUN_JOURNAL";

interface JournalLineBase {
	seq: number;
	at: string;
}

/** Everything on a journal line except the `seq`/`at` envelope the writer adds. */
export type RunEventJournalBody =
	| { kind: "open"; runId: string; agentId: string }
	| { kind: "event"; type: string; detail?: string }
	| { kind: "journal_truncated"; reason: string; droppedFromSeq: number }
	| {
			kind: "receipt";
			outcome: string;
			exitCode: number | null;
			digest?: string;
			receiptPath?: string;
			attemptRunId?: string;
	  }
	| { kind: "terminal"; outcome: string; detail?: string };

export type RunEventJournalLine = JournalLineBase & RunEventJournalBody;

/** One display-tail entry, structurally the registry's `RunTailEntry`. */
export interface RunEventJournalEntry {
	at: string;
	type: string;
	detail?: string;
}

/** Sealed receipt facts worth keeping even when display lines are being dropped. */
export interface RunEventJournalReceipt {
	outcome: string;
	exitCode: number | null;
	digest?: string | undefined;
	receiptPath?: string | undefined;
	/** The terminal attempt's run id, recorded only when it differs from the logical run. */
	attemptRunId?: string | undefined;
}

/**
 * What the run event registry writes to. Every method is best-effort and
 * returns void: a journal that cannot write degrades itself and the dispatch
 * never learns about it.
 */
export interface RunEventJournalSink {
	open(runId: string, agentId: string): void;
	append(runId: string, entry: RunEventJournalEntry): void;
	receipt(runId: string, receipt: RunEventJournalReceipt): void;
	terminal(runId: string, outcome: string, detail?: string): void;
}

export interface RunEventJournal extends RunEventJournalSink {
	/** Flush any buffered droppable lines. Called by tests and by terminal writes. */
	flush(): void;
	/** True once a write failed and the journal turned itself off. */
	degraded(): boolean;
}

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

let configuredEnabled: boolean | undefined;

/**
 * Install the `panes.journal` setting. Called from the composition root beside
 * `configureGuardrails` so the journal never reads settings.yaml itself; a
 * settings read on the dispatch event path would be both a cost and a throw
 * site (readSettings rejects an invalid file).
 */
export function configureRunEventJournal(enabled: boolean | undefined): void {
	configuredEnabled = enabled;
}

function parseEnvFlag(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "on") return true;
	if (normalized === "0" || normalized === "false" || normalized === "off") return false;
	return undefined;
}

/** env override > configured settings > on. */
function runEventJournalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseEnvFlag(env[RUN_EVENT_JOURNAL_ENV_VAR]) ?? configuredEnabled ?? true;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root holding one journal directory per run. */
export function runEventJournalRoot(): string {
	return join(clioStateDir(), RUN_EVENT_JOURNAL_DIR);
}

/** One run's journal directory. */
function runEventJournalDir(runId: string, root?: string): string {
	return join(root ?? runEventJournalRoot(), runId);
}

/** One run's NDJSON file. */
export function runEventJournalPath(runId: string, root?: string): string {
	return join(runEventJournalDir(runId, root), RUN_EVENT_JOURNAL_FILE);
}

/**
 * The run whose journal was written to most recently, or null when none exists.
 *
 * `/panes open logs` tails it. Reading mtimes off the journal files is the
 * cheapest honest answer: the ledger orders runs by admission, and the run an
 * operator wants to watch is the one still producing lines, which is not always
 * the newest admitted one.
 */
export function newestRunEventJournalRunId(root?: string): string | null {
	if (stateRootRemoved()) return null;
	const dir = root ?? runEventJournalRoot();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	let newest: { runId: string; at: number } | null = null;
	for (const runId of names) {
		if (!isSafeRunId(runId)) continue;
		const stats = statSync(runEventJournalPath(runId, dir), { throwIfNoEntry: false });
		if (stats === undefined || !stats.isFile()) continue;
		const at = stats.mtimeMs;
		if (newest === null || at > newest.at) newest = { runId, at };
	}
	return newest?.runId ?? null;
}

/**
 * Drop the journal directories of runs that left the ledger ring. Best-effort:
 * retention is bookkeeping and must never fail the persist that triggered it.
 */
export function removeRunEventJournals(runIds: Iterable<string>, root?: string): void {
	if (stateRootRemoved()) return;
	for (const runId of runIds) {
		if (!isSafeRunId(runId)) continue;
		try {
			rmSync(runEventJournalDir(runId, root), { recursive: true, force: true });
		} catch {
			// A directory we could not remove is retained, not an error.
		}
	}
}

/**
 * Run ids are generated by `newRunId()` as base36, and fleet/gate ids add a
 * prefix and hex. Nothing legitimate contains a path separator, so anything
 * that does is refused rather than resolved: this function's only two callers
 * build a path from the id and then remove or write it.
 */
function isSafeRunId(runId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) && runId !== "." && runId !== "..";
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

interface RunJournalState {
	path: string;
	seq: number;
	bytes: number;
	pending: string[];
	pendingBytes: number;
	dropping: boolean;
	closed: boolean;
	touchedAt: number;
}

/**
 * Runs tracked at once. Bounded so a long-lived orchestrator that never sees a
 * terminal event for some run (a crash, an abandoned batch) cannot grow this
 * map without limit. Eviction only forgets the byte counter; the file itself is
 * untouched and a later write to an evicted run reopens it with a fresh count.
 */
const RUN_STATE_LIMIT = 256;

export interface CreateRunEventJournalOptions {
	/** Override the journal root. Defaults to `clioStateDir()/runs`, resolved per write. */
	root?: string;
	capBytes?: number;
	flushBytes?: number;
	warn?: (message: string) => void;
	now?: () => Date;
	/** Override enablement. Defaults to {@link runEventJournalEnabled}. */
	isEnabled?: () => boolean;
}

function createRunEventJournal(options: CreateRunEventJournalOptions = {}): RunEventJournal {
	const capBytes = options.capBytes ?? RUN_EVENT_JOURNAL_CAP_BYTES;
	const flushBytes = options.flushBytes ?? RUN_EVENT_JOURNAL_FLUSH_BYTES;
	const warn = options.warn ?? ((message: string) => process.stderr.write(`[clio-coder:journal] ${message}\n`));
	const now = options.now ?? (() => new Date());
	const isEnabled = options.isEnabled ?? (() => runEventJournalEnabled());
	const runs = new Map<string, RunJournalState>();
	let degraded = false;

	const degrade = (error: unknown): void => {
		if (degraded) return;
		degraded = true;
		runs.clear();
		warn(
			`run event journal disabled for this process: ${error instanceof Error ? error.message : String(error)}. ` +
				"Dispatch is unaffected; `clio-coder fleet view` will have no transcript for runs started from here.",
		);
	};

	const pruneRunStates = (): void => {
		while (runs.size > RUN_STATE_LIMIT) {
			let oldestKey: string | null = null;
			let oldestSeen = Number.POSITIVE_INFINITY;
			for (const [key, state] of runs) {
				if (state.pending.length > 0 || state.touchedAt >= oldestSeen) continue;
				oldestKey = key;
				oldestSeen = state.touchedAt;
			}
			if (oldestKey === null) break;
			runs.delete(oldestKey);
		}
	};

	const stateFor = (runId: string): RunJournalState | null => {
		if (degraded || !isSafeRunId(runId) || !isEnabled()) return null;
		const existing = runs.get(runId);
		if (existing !== undefined) {
			if (existing.closed) return null;
			existing.touchedAt = Date.now();
			return existing;
		}
		if (stateRootRemoved()) return null;
		let path: string;
		try {
			const dir = runEventJournalDir(runId, options.root);
			mkdirSync(dir, { recursive: true });
			path = join(dir, RUN_EVENT_JOURNAL_FILE);
		} catch (error) {
			degrade(error);
			return null;
		}
		// A run reopened after state eviction (or after a resume) continues the
		// existing file, so the byte counter starts from what is already there
		// and the cap keeps meaning the same thing.
		let bytes = 0;
		let seq = 0;
		try {
			const stat = statSync(path);
			bytes = stat.size;
		} catch {
			// First write for this run; the file does not exist yet.
		}
		if (bytes > 0) seq = countJournalSeq(path);
		const state: RunJournalState = {
			path,
			seq,
			bytes,
			pending: [],
			pendingBytes: 0,
			dropping: bytes >= capBytes,
			closed: false,
			touchedAt: Date.now(),
		};
		runs.set(runId, state);
		pruneRunStates();
		return state;
	};

	const flushState = (state: RunJournalState): void => {
		if (state.pending.length === 0) return;
		const payload = state.pending.join("");
		state.pending = [];
		state.pendingBytes = 0;
		if (stateRootRemoved()) return;
		try {
			appendFileSync(state.path, payload, "utf8");
		} catch (error) {
			degrade(error);
		}
	};

	const write = (state: RunJournalState, line: RunEventJournalBody, droppable: boolean): void => {
		if (droppable && state.dropping) return;
		if (droppable && state.bytes + state.pendingBytes >= capBytes) {
			state.dropping = true;
			write(state, { kind: "journal_truncated", reason: "per-run size cap", droppedFromSeq: state.seq + 1 }, false);
			return;
		}
		state.seq += 1;
		const serialized = `${JSON.stringify({ seq: state.seq, at: now().toISOString(), ...line })}\n`;
		const size = Buffer.byteLength(serialized, "utf8");
		state.pending.push(serialized);
		state.pendingBytes += size;
		state.bytes += size;
		if (!droppable || state.pendingBytes >= flushBytes) flushState(state);
	};

	return {
		open(runId, agentId): void {
			const state = stateFor(runId);
			if (state === null) return;
			// Reopening a run that already has lines is a resume or a second
			// registration of the same logical run; the file keeps its history and
			// gains a fresh open line rather than being rewritten.
			write(state, { kind: "open", runId, agentId }, false);
		},
		append(runId, entry): void {
			const state = stateFor(runId);
			if (state === null) return;
			write(
				state,
				entry.detail === undefined
					? { kind: "event", type: entry.type }
					: { kind: "event", type: entry.type, detail: entry.detail },
				true,
			);
		},
		receipt(runId, receipt): void {
			const state = stateFor(runId);
			if (state === null) return;
			write(
				state,
				{
					kind: "receipt",
					outcome: receipt.outcome,
					exitCode: receipt.exitCode,
					...(receipt.digest !== undefined ? { digest: receipt.digest } : {}),
					...(receipt.receiptPath !== undefined ? { receiptPath: receipt.receiptPath } : {}),
					...(receipt.attemptRunId !== undefined ? { attemptRunId: receipt.attemptRunId } : {}),
				},
				false,
			);
		},
		terminal(runId, outcome, detail): void {
			const state = stateFor(runId);
			if (state === null) return;
			write(state, detail === undefined ? { kind: "terminal", outcome } : { kind: "terminal", outcome, detail }, false);
			flushState(state);
			// Closing here is what makes the terminal line the last write: any
			// later event for this run finds a closed state and is discarded.
			state.closed = true;
		},
		flush(): void {
			for (const state of runs.values()) flushState(state);
		},
		degraded(): boolean {
			return degraded;
		},
	};
}

/**
 * Highest `seq` already in a run's file. Only read when a journal is reopened,
 * which happens on resume or after state eviction, never on the common path.
 */
function countJournalSeq(path: string): number {
	try {
		const raw = readFileSync(path, "utf8");
		let highest = 0;
		for (const line of raw.split("\n")) {
			if (line.length === 0) continue;
			const parsed = parseJournalLine(line);
			if (parsed !== null && parsed.seq > highest) highest = parsed.seq;
		}
		return highest;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Process-wide default sink
// ---------------------------------------------------------------------------

let defaultJournal: RunEventJournal | null = null;

/**
 * The sink every run event registry attaches to unless it was handed one.
 * Created lazily so importing the registry costs nothing, and shared so two
 * registries in one process cannot interleave two byte counters over one file.
 *
 * A run's file path is resolved on its first write and then held, so a state
 * root that moves mid-process (only tests do that) leaves already-opened runs
 * pointing at the old root. Run ids are random, so a fresh root always brings
 * fresh ids with it and nothing observable depends on re-resolving.
 */
export function defaultRunEventJournal(): RunEventJournal {
	defaultJournal ??= createRunEventJournal();
	return defaultJournal;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Tail bytes a reader will pull, so following a capped journal stays cheap. */
export const RUN_EVENT_JOURNAL_READ_TAIL_BYTES = 256 * 1024;

export interface ReadRunEventJournalOptions {
	root?: string;
	/** Keep at most this many lines, newest last. */
	maxLines?: number;
	tailBytes?: number;
}

export interface RunEventJournalRead {
	path: string;
	present: boolean;
	bytes: number;
	lines: RunEventJournalLine[];
	/** True when the writer dropped display lines, or when this read skipped a file head. */
	truncated: boolean;
	terminal: { outcome: string; detail?: string } | null;
	agentId: string | null;
}

function parseJournalLine(raw: string): RunEventJournalLine | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record.seq !== "number" || typeof record.at !== "string" || typeof record.kind !== "string") return null;
	switch (record.kind) {
		case "open":
			if (typeof record.runId !== "string" || typeof record.agentId !== "string") return null;
			return { seq: record.seq, at: record.at, kind: "open", runId: record.runId, agentId: record.agentId };
		case "event": {
			if (typeof record.type !== "string") return null;
			const detail = typeof record.detail === "string" ? record.detail : undefined;
			return {
				seq: record.seq,
				at: record.at,
				kind: "event",
				type: normalizeClioCoderEventType(record.type),
				...(detail === undefined ? {} : { detail }),
			};
		}
		case "journal_truncated":
			return {
				seq: record.seq,
				at: record.at,
				kind: "journal_truncated",
				reason: typeof record.reason === "string" ? record.reason : "unknown",
				droppedFromSeq: typeof record.droppedFromSeq === "number" ? record.droppedFromSeq : record.seq,
			};
		case "receipt": {
			if (typeof record.outcome !== "string") return null;
			return {
				seq: record.seq,
				at: record.at,
				kind: "receipt",
				outcome: record.outcome,
				exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
				...(typeof record.digest === "string" ? { digest: record.digest } : {}),
				...(typeof record.receiptPath === "string" ? { receiptPath: record.receiptPath } : {}),
				...(typeof record.attemptRunId === "string" ? { attemptRunId: record.attemptRunId } : {}),
			};
		}
		case "terminal": {
			if (typeof record.outcome !== "string") return null;
			const detail = typeof record.detail === "string" ? record.detail : undefined;
			return {
				seq: record.seq,
				at: record.at,
				kind: "terminal",
				outcome: record.outcome,
				...(detail === undefined ? {} : { detail }),
			};
		}
		default:
			return null;
	}
}

/**
 * Read one run's journal. Reads at most the last {@link
 * RUN_EVENT_JOURNAL_READ_TAIL_BYTES}, discarding a leading partial line, so a
 * viewer polling a capped journal never pulls megabytes per tick. A head that
 * was skipped reports as `truncated` for the same reason the writer's marker
 * does: the transcript on screen is not the whole run.
 */
export function readRunEventJournal(runId: string, options: ReadRunEventJournalOptions = {}): RunEventJournalRead {
	const path = runEventJournalPath(runId, options.root);
	const empty: RunEventJournalRead = {
		path,
		present: false,
		bytes: 0,
		lines: [],
		truncated: false,
		terminal: null,
		agentId: null,
	};
	if (!isSafeRunId(runId)) return empty;
	const tailBytes = options.tailBytes ?? RUN_EVENT_JOURNAL_READ_TAIL_BYTES;
	let raw: string;
	let size: number;
	let headDropped = false;
	try {
		size = statSync(path).size;
		if (size <= tailBytes) {
			raw = readFileSync(path, "utf8");
		} else {
			const buffer = readFileSync(path);
			raw = buffer.subarray(size - tailBytes).toString("utf8");
			const firstBreak = raw.indexOf("\n");
			raw = firstBreak === -1 ? "" : raw.slice(firstBreak + 1);
			headDropped = true;
		}
	} catch {
		return empty;
	}
	const lines: RunEventJournalLine[] = [];
	let truncated = headDropped;
	let terminal: { outcome: string; detail?: string } | null = null;
	let agentId: string | null = null;
	for (const candidate of raw.split("\n")) {
		if (candidate.length === 0) continue;
		const parsed = parseJournalLine(candidate);
		// A trailing partial line is the writer mid-flush, not corruption.
		if (parsed === null) continue;
		if (parsed.kind === "journal_truncated") truncated = true;
		if (parsed.kind === "open") agentId = parsed.agentId;
		if (parsed.kind === "terminal") {
			terminal =
				parsed.detail === undefined ? { outcome: parsed.outcome } : { outcome: parsed.outcome, detail: parsed.detail };
		}
		lines.push(parsed);
	}
	const maxLines = options.maxLines;
	if (maxLines !== undefined && lines.length > maxLines) {
		lines.splice(0, lines.length - maxLines);
		truncated = true;
	}
	return { path, present: true, bytes: size, lines, truncated, terminal, agentId };
}
