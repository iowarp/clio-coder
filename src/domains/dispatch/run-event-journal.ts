import type { ToolRoundRecord } from "../../engine/types.js";
/**
 * Run event journal: the display feed in a run's telemetry journal.
 *
 * Live dispatch events exist only in `DispatchRunEventRegistry`'s in-memory
 * tail (src/tools/dispatch-run-events.ts), so a separate process cannot see a
 * run in flight: the ledger and receipts are durable but the event stream is
 * not. This module tees that same display tail to the run's journal so a viewer process
 * (`clio-coder fleet view`) can follow a run without sharing the orchestrator's
 * heap.
 *
 * On-disk layout: the run's telemetry journal, `telemetry/runs/<runId>/journal.jsonl`
 * under `clioStateDir()` (src/domains/telemetry/paths.ts), one line per record, newest last.
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
 * Display lines forward to the run's batched telemetry writer, which owns the
 * file (#434). The display terminal closes the feed, while call facts may still
 * drain before dispatch releases the writer. Nothing here ever throws into a
 * dispatch.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { scanTelemetrySegment } from "../../core/telemetry/segment.js";
import type { CallUsage } from "../../core/token-split.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import type { ToolAuditFacts } from "../../tools/agent-tools.js";
import { TELEMETRY_JOURNAL_FILE, telemetryJournalFiles, telemetryRunsDirectory } from "../telemetry/index.js";
import { runTelemetryJournal } from "./run-telemetry.js";

/** Per-run size cap; crossing it drops display-only lines behind one marker. */
export const RUN_EVENT_JOURNAL_CAP_BYTES = 2 * 1024 * 1024;
interface JournalLineBase {
	seq: number;
	at: string;
}

/**
 * Structured facts an `event` line may carry beside its display `detail`, so a
 * viewer can build a live worker card without the event itself. Every field is
 * already bounded and redacted where it was produced: a tool name, the call
 * descriptor's verb (its object rides in `detail`), a finish outcome and
 * duration, and the token counts one model call reported. Arguments, results
 * and reasoning never appear here.
 */
export interface RunEventJournalFacts {
	audit?: ToolAuditFacts;
	callIndex?: number;
	usage?: CallUsage;
	toolRounds?: ToolRoundRecord[];
	usageScope?: "call" | "run-aggregate";
	tool?: string;
	/** Pairs a tool start with its finish when the producer carried an id. */
	callId?: string;
	/** Present-tense descriptor verb (`reading`); the object is the line's detail. */
	verb?: string;
	outcome?: "ok" | "error" | "blocked";
	durationMs?: number;
	/** Why a call was blocked or failed, or why an approval resolved the way it did. */
	reason?: string;
	/** Tokens one model call processed (input, cache reads, output, cache writes). */
	tokens?: number;
}

/** Everything on a journal line except the `seq`/`at` envelope the writer adds. */
export type RunEventJournalBody =
	| { kind: "open"; runId: string; agentId: string }
	| ({ kind: "event"; type: string; detail?: string } & RunEventJournalFacts)
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

/** One display-tail entry, structurally the registry's `RunTailEntry`, plus optional facts. */
export interface RunEventJournalEntry extends RunEventJournalFacts {
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

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

let configuredEnabled: boolean | undefined;

/**
 * Install the `fleet.history.journal` setting. Called from the composition root beside
 * `configureGuardrails` so the journal never reads settings.yaml itself; a
 * settings read on the dispatch event path would be both a cost and a throw
 * site (readSettings rejects an invalid file).
 */
export function configureRunEventJournal(enabled: boolean | undefined): void {
	configuredEnabled = enabled;
}

/** Effective settings projection, then the shipped default. */
function runEventJournalEnabled(): boolean {
	return configuredEnabled ?? true;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root holding one journal directory per run. */
export function runEventJournalRoot(): string {
	return telemetryRunsDirectory(clioStateDir());
}

/** One run's journal directory. */
function runEventJournalDir(runId: string, root?: string): string {
	return join(root ?? runEventJournalRoot(), runId);
}

/** One run's NDJSON file. */
export function runEventJournalPath(runId: string, root?: string): string {
	return join(runEventJournalDir(runId, root), TELEMETRY_JOURNAL_FILE);
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
 * Run ids are generated by `newRunId()` as base36, and fleet/gate ids add a
 * prefix and hex. Nothing legitimate contains a path separator, so anything
 * that does is refused rather than resolved before a path is built from it.
 */
function isSafeRunId(runId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) && runId !== "." && runId !== "..";
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * The display tail forwards to the run's telemetry writer, which batches it into the run's journal as `run.feed`
 * records (#434). A run without an open telemetry owner gets no transcript: only the telemetry domain writes under
 * the telemetry root, and the open failure that left the run ownerless was already reported where it happened.
 */
function createRunEventJournal(): RunEventJournalSink {
	const forward = (runId: string, body: RunEventJournalBody): void => {
		if (!isSafeRunId(runId) || !runEventJournalEnabled() || stateRootRemoved()) return;
		runTelemetryJournal(runId)?.feed(body, RUN_EVENT_JOURNAL_CAP_BYTES);
	};
	return {
		open(runId, agentId): void {
			forward(runId, { kind: "open", runId, agentId });
		},
		append(runId, entry): void {
			const { at: _at, ...body } = entry;
			forward(runId, { kind: "event", ...body });
		},
		receipt(runId, receipt): void {
			forward(runId, {
				kind: "receipt",
				outcome: receipt.outcome,
				exitCode: receipt.exitCode,
				...(receipt.digest !== undefined ? { digest: receipt.digest } : {}),
				...(receipt.receiptPath !== undefined ? { receiptPath: receipt.receiptPath } : {}),
				...(receipt.attemptRunId !== undefined ? { attemptRunId: receipt.attemptRunId } : {}),
			});
		},
		terminal(runId, outcome, detail): void {
			forward(runId, { kind: "terminal", outcome, ...(detail !== undefined ? { detail } : {}) });
		},
	};
}

// ---------------------------------------------------------------------------
// Process-wide default sink
// ---------------------------------------------------------------------------

let defaultJournal: RunEventJournalSink | null = null;

/** The sink every run event registry attaches to unless it was handed one; created lazily, shared per process. */
export function defaultRunEventJournal(): RunEventJournalSink {
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

export function parseToolAuditFacts(value: unknown): ToolAuditFacts | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.target !== "string" || record.target.length === 0) return undefined;
	const audit: ToolAuditFacts = { target: record.target };
	for (const key of [
		"offset",
		"limit",
		"tail",
		"returnedBytes",
		"observationBytes",
		"poolLimitBytes",
		"poolUsedBeforeBytes",
	] as const) {
		const count = record[key];
		if (typeof count === "number" && Number.isFinite(count) && count >= 0) audit[key] = count;
	}
	for (const key of ["startLine", "endLine"] as const) {
		const count = record[key];
		if (count === null || (typeof count === "number" && Number.isSafeInteger(count) && count >= 1)) audit[key] = count;
	}
	for (const key of ["partialLine", "truncated", "poolExhausted"] as const) {
		if (typeof record[key] === "boolean") audit[key] = record[key];
	}
	if (record.targetTruncated === true) audit.targetTruncated = true;
	if (record.rangeUnit === "physical-lines" || record.rangeUnit === "rendered-lines") audit.rangeUnit = record.rangeUnit;
	return audit;
}

const UNREADABLE = { line: null, record: null } as const;

/** One journal line, read defensively: null for anything malformed or of an unknown kind. */
function parseRunEventJournalLine(raw: string): RunEventJournalLine | null {
	return readRunEventJournalLine(raw).line;
}

/**
 * One journal line, scanned once: the feed line it holds, or the telemetry record beside the feed, such as a call's
 * start or settlement, that is no feed line. Both are null for anything malformed or not framed (#434).
 */
export function readRunEventJournalLine(raw: string): {
	line: RunEventJournalLine | null;
	record: TelemetryRecord | null;
} {
	try {
		const row = scanTelemetrySegment(Buffer.from(`${raw}\n`)).rows[0];
		if (row?.kind !== "record") return UNREADABLE;
		if (row.record.k !== "run.feed_appended") return { line: null, record: row.record };
		return { line: { ...row.record.data.body, seq: row.record.data.seq, at: row.record.t }, record: null };
	} catch {
		return UNREADABLE;
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
		const directory = runEventJournalDir(runId, options.root);
		// The live segment is read even before it exists, so a run that never wrote reads as absent.
		const files = telemetryJournalFiles(readdirSync(directory)).filter((name) => name !== TELEMETRY_JOURNAL_FILE);
		files.push(TELEMETRY_JOURNAL_FILE);
		const chunks: Buffer[] = [];
		let remaining = Math.max(0, Math.floor(tailBytes));
		size = 0;
		for (const file of files.reverse()) {
			const filePath = join(directory, file);
			const length = statSync(filePath).size;
			size += length;
			if (remaining === 0) {
				headDropped ||= length > 0;
				continue;
			}
			const start = Math.max(0, length - remaining);
			const chunk = Buffer.alloc(length - start);
			const handle = openSync(filePath, "r");
			try {
				const count = readSync(handle, chunk, 0, chunk.length, start);
				const bytes = chunk.subarray(0, count);
				chunks.unshift(
					start > 0 ? bytes.subarray(bytes.indexOf(0x0a) < 0 ? bytes.length : bytes.indexOf(0x0a) + 1) : bytes,
				);
			} finally {
				closeSync(handle);
			}
			remaining -= chunk.length;
			headDropped ||= start > 0;
		}
		raw = Buffer.concat(chunks).toString("utf8");
	} catch {
		return empty;
	}
	const lines: RunEventJournalLine[] = [];
	let truncated = headDropped;
	let terminal: { outcome: string; detail?: string } | null = null;
	let agentId: string | null = null;
	for (const candidate of raw.split("\n")) {
		if (candidate.length === 0) continue;
		const parsed = parseRunEventJournalLine(candidate);
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
