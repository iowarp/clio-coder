import { normalizeOutputStyle, type OutputStyle } from "../core/defaults.js";
import type { RunIntegrity, RunOrigin, RunValidation } from "../core/run-row.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { loadRunTelemetrySource, runTelemetryJournalStamp } from "../domains/session/telemetry-source.js";
import { sizeCallJournalCache } from "../domains/telemetry/call-journal.js";
import { runTelemetry } from "../domains/telemetry/read-model.js";
import { isStructuredAnswerText } from "../domains/telemetry/worker-progress.js";
/**
 * The workers dashboard's model: which workers the board shows and what each
 * one is doing, read from durable state only.
 *
 * The dashboard runs in its own process inside the workers dock (and works the
 * same over SSH), so it shares nothing with the orchestrator's heap. Three
 * sources feed it: the run ledger (`runs.json`) for identity, route, budget and
 * lifecycle; each run's display feed (src/domains/dispatch/run-feed.ts)
 * for the live stream; and the sealed record, authenticated against its
 * ledger row, for a finished worker's outcome, conformance and trust.
 *
 * Feeds are folded incrementally: a run's fold remembers how many bytes it
 * consumed and reads only what was appended since, so polling four live
 * workers at the monitor cadence costs four small reads rather than four
 * whole files. Everything kept is bounded, and nothing is sanitized here:
 * the renderer cleans every string it draws, at the one place it is drawn.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { clioStateDir } from "../core/xdg.js";
import { refusedCallsWords } from "../domains/dispatch/failure-headline.js";
import {
	RUN_FEED_READ_TAIL_BYTES,
	type RunFeedLine,
	readRunFeedLine,
	runFeedPath,
} from "../domains/dispatch/run-feed.js";
import { readRunResultFacts } from "../domains/dispatch/run-result-facts.js";
import type { LedgerSnapshot } from "../domains/dispatch/state.js";
import { readFleetRun, readLedgerSnapshot } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { HOST_VERIFICATION_EVENT, type VerificationSlotState } from "../domains/dispatch/verification-slot.js";
import { trustStateWord, trustVerdictWord, validationClause } from "../domains/evidence/trust-projection.js";

import type { fleetInspectionScope } from "./fleet-project-scope.js";
import { sealedReportAnswer } from "./run-output.js";

/** Stream rows a run keeps; the head goes first, as in a terminal's scrollback. */
const STREAM_ROW_LIMIT = 600;
/** Characters one prose row keeps of a long answer; the newest text wins. */
const TEXT_ROW_MAX_CHARS = 8000;
/** Bytes one poll folds from a single feed, so a huge backlog cannot stall a frame. */
const FOLD_READ_MAX_BYTES = 512 * 1024;
/** Finished workers the board lists after the running ones. */
const FINISHED_CARD_LIMIT = 24;

// ---------------------------------------------------------------------------
// Selection request
// ---------------------------------------------------------------------------

/**
 * What Clio wrote into the watch selection file. The first line is the run a
 * takeover was requested for (blank asks for the board); `seq` changes on each
 * request so asking for the same run twice still takes the dock over; the
 * session and the boot instant scope the board to this session's workers.
 * A viewer from before this format reads only the first line and keeps working.
 */
export interface WatchRequest {
	outputDetail: OutputStyle;
	runId: string | null;
	seq: string;
	sessionId: string | null;
	sinceMs: number | null;
}

function parseWatchRequest(raw: string): WatchRequest {
	const lines = raw.split("\n");
	const first = lines[0]?.trim() ?? "";
	const fields = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const eq = line.indexOf("=");
		if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	const since = Date.parse(fields.get("since") ?? "");
	const session = fields.get("session") ?? "";
	return {
		outputDetail: normalizeOutputStyle(fields.get("outputDetail")) ?? "standard",
		runId: first.length > 0 && first.length <= 128 ? first : null,
		// Without a counter the run id itself is the request, which is how the
		// one-line format behaved.
		seq: fields.get("seq") ?? `run:${first}`,
		sessionId: session.length > 0 && session.length <= 128 ? session : null,
		sinceMs: Number.isFinite(since) ? since : null,
	};
}

export function readWatchRequest(path: string): WatchRequest | null {
	try {
		return parseWatchRequest(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Run fold
// ---------------------------------------------------------------------------

export type StreamRowKind = "tool" | "text" | "thinking" | "approval" | "decision" | "error" | "note";

/** One row of a worker's live stream, in the order it happened. */
export interface StreamRow {
	at: string;
	kind: StreamRowKind;
	/** Prose, a call's object, or a note; raw, sanitized by the renderer. */
	text: string;
	tool?: string;
	verb?: string;
	outcome?: "ok" | "error" | "blocked";
	durationMs?: number;
	reason?: string;
	/** A call that started and has not finished. */
	pending?: boolean;
}

/** `verification-queued` and `verifying` follow the worker: its checks wait for, then hold, the verification slot. */
export type WorkerPhase =
	| "starting"
	| "thinking"
	| "writing"
	| "tool"
	| "waiting"
	| "verification-queued"
	| "verifying"
	| "settled";

export interface RunFold {
	present: boolean;
	/** True when the writer dropped lines, this reader skipped a head, or rows fell off the top. */
	truncated: boolean;
	rows: StreamRow[];
	droppedRows: number;
	/** The feed lost events this fold never saw, at the writer's size cap or a head this reader skipped. */
	eventsUnread: boolean;
	/** The call running now, if any. */
	current: StreamRow | null;
	/** The call that finished last. */
	last: StreamRow | null;
	/** The permission ask the worker escalated to the operator and nobody has answered yet. */
	asking: StreamRow | null;
	phase: WorkerPhase;
	terminal: { outcome: string; detail?: string } | null;
}

interface FoldCursor {
	path: string;
	offset: number;
	decoder: StringDecoder;
	partial: string;
	/** Drop the first line read: it is the tail of a line the read started inside. */
	skipFirst: boolean;
	/** Starts still waiting for a finish, by correlation id. */
	pendingById: Map<string, StreamRow>;
	/** The next prose delta starts a new row rather than continuing the last one. */
	paragraphBreak: boolean;
	/** The prose row the worker's accepted report streamed into; its last deltas can land after the acceptance. */
	reportRow: StreamRow | null;
	fold: RunFold;
}

function emptyFold(): RunFold {
	return {
		present: false,
		truncated: false,
		rows: [],
		droppedRows: 0,
		eventsUnread: false,
		current: null,
		last: null,
		asking: null,
		phase: "starting",
		terminal: null,
	};
}

function newCursor(path: string): FoldCursor {
	return {
		path,
		offset: 0,
		decoder: new StringDecoder("utf8"),
		partial: "",
		skipFirst: false,
		pendingById: new Map(),
		paragraphBreak: true,
		reportRow: null,
		fold: emptyFold(),
	};
}

function pushRow(cursor: FoldCursor, row: StreamRow): StreamRow {
	const fold = cursor.fold;
	fold.rows.push(row);
	if (fold.rows.length > STREAM_ROW_LIMIT) {
		const dropped = fold.rows.splice(0, fold.rows.length - STREAM_ROW_LIMIT);
		fold.droppedRows += dropped.length;
		fold.truncated = true;
	}
	return row;
}

function lastPendingFor(fold: RunFold, tool: string): StreamRow | undefined {
	for (let index = fold.rows.length - 1; index >= 0; index -= 1) {
		const row = fold.rows[index];
		if (row?.kind === "tool" && row.pending === true && row.tool === tool) return row;
	}
	return undefined;
}

function latestPending(fold: RunFold): StreamRow | null {
	for (let index = fold.rows.length - 1; index >= 0; index -= 1) {
		const row = fold.rows[index];
		if (row?.kind === "tool" && row.pending === true) return row;
	}
	return null;
}

function appendText(cursor: FoldCursor, at: string, text: string): void {
	const fold = cursor.fold;
	const last = fold.rows[fold.rows.length - 1];
	if (!cursor.paragraphBreak && last?.kind === "text") {
		const joined = last.text + text;
		last.text = joined.length > TEXT_ROW_MAX_CHARS ? `…${joined.slice(joined.length - TEXT_ROW_MAX_CHARS)}` : joined;
	} else {
		pushRow(cursor, {
			at,
			kind: "text",
			text: text.length > TEXT_ROW_MAX_CHARS ? text.slice(-TEXT_ROW_MAX_CHARS) : text,
		});
	}
	cursor.paragraphBreak = false;
	fold.phase = "writing";
}

/**
 * Once its message ends, the accepted report's prose row becomes a note: the JSON repeats the run record, which reads
 * the same report in words. A row holding more than the one object stays the prose it is.
 */
function settleReportRow(cursor: FoldCursor): void {
	const row = cursor.reportRow;
	cursor.reportRow = null;
	if (row?.kind !== "text") return;
	try {
		const value: unknown = JSON.parse(row.text);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	} catch {
		return;
	}
	row.kind = "note";
	row.text = "result submitted";
}

function applyEvent(cursor: FoldCursor, line: Extract<RunFeedLine, { kind: "event" }>): void {
	const fold = cursor.fold;
	const detail = line.detail ?? "";
	switch (line.type) {
		case "text":
			if (detail.length > 0) appendText(cursor, line.at, detail);
			return;
		case "thinking": {
			cursor.paragraphBreak = true;
			fold.phase = "thinking";
			const last = fold.rows[fold.rows.length - 1];
			if (last?.kind !== "thinking") pushRow(cursor, { at: line.at, kind: "thinking", text: "" });
			return;
		}
		case "clio_coder_tool_start": {
			cursor.paragraphBreak = true;
			const tool = line.tool ?? "tool";
			const row = pushRow(cursor, {
				at: line.at,
				kind: "tool",
				text: detail,
				tool,
				...(line.verb !== undefined ? { verb: line.verb } : {}),
				pending: true,
			});
			if (line.callId !== undefined) cursor.pendingById.set(line.callId, row);
			fold.current = row;
			fold.phase = "tool";
			return;
		}
		case "clio_coder_tool_finish": {
			cursor.paragraphBreak = true;
			const tool = line.tool ?? "tool";
			const outcome = line.outcome;
			let row = line.callId !== undefined ? cursor.pendingById.get(line.callId) : undefined;
			if (line.callId !== undefined) cursor.pendingById.delete(line.callId);
			row ??= lastPendingFor(fold, tool);
			if (row === undefined) {
				row = pushRow(cursor, {
					at: line.at,
					kind: "tool",
					text: detail,
					tool,
					...(line.verb !== undefined ? { verb: line.verb } : {}),
				});
			}
			row.pending = false;
			if (outcome !== undefined) row.outcome = outcome;
			if (line.durationMs !== undefined) row.durationMs = line.durationMs;
			if (line.reason !== undefined) row.reason = line.reason;
			fold.last = row;
			fold.current = latestPending(fold);
			fold.phase = fold.current === null ? "waiting" : "tool";
			return;
		}
		case "message_end":
			settleReportRow(cursor);
			cursor.paragraphBreak = true;
			// Only a message that streamed no prose carries its text here (an ACP peer).
			if (detail.length > 0) {
				appendText(cursor, line.at, detail);
				cursor.paragraphBreak = true;
			}
			if (fold.phase === "writing" || fold.phase === "thinking") fold.phase = "waiting";
			return;
		case "clio_coder_permission_escalated":
			fold.asking = pushRow(cursor, {
				at: line.at,
				kind: "approval",
				text: detail,
				...(line.tool ? { tool: line.tool } : {}),
			});
			return;
		case "clio_coder_permission_resolved":
			fold.asking = null;
			pushRow(cursor, {
				at: line.at,
				kind: "decision",
				text: detail,
				...(line.tool ? { tool: line.tool } : {}),
				outcome: line.outcome ?? "blocked",
				...(line.reason ? { reason: line.reason } : {}),
			});
			return;
		case "clio_coder_run_outcome":
			pushRow(cursor, { at: line.at, kind: "error", text: detail, ...(line.reason ? { reason: line.reason } : {}) });
			return;
		case "clio_coder_helper_result": {
			const last = fold.rows[fold.rows.length - 1];
			cursor.reportRow = last?.kind === "text" ? last : null;
			return;
		}
		case "clio_coder_helper_result_rejected":
			pushRow(cursor, {
				at: line.at,
				kind: "error",
				text: `result rejected${line.reason ? `: ${line.reason}` : ""}`,
				...(detail.length > 0 ? { reason: `submitted ${detail}` } : {}),
			});
			return;
		case "clio_coder_steer_received":
			pushRow(cursor, { at: line.at, kind: "note", text: `steering received${detail ? ` (${detail})` : ""}` });
			return;
		case "agent_start":
			fold.phase = "starting";
			return;
		case "agent_end":
			settleReportRow(cursor);
			fold.current = null;
			fold.phase = "waiting";
			return;
		case HOST_VERIFICATION_EVENT:
			fold.current = null;
			fold.phase =
				detail === ("waiting for a verification slot" satisfies VerificationSlotState)
					? "verification-queued"
					: "verifying";
			if (detail.length > 0) pushRow(cursor, { at: line.at, kind: "note", text: detail });
			return;
		default:
			if (detail.length > 0) pushRow(cursor, { at: line.at, kind: "note", text: `${line.type}: ${detail}` });
	}
}

function applyLine(cursor: FoldCursor, line: RunFeedLine): void {
	const fold = cursor.fold;
	switch (line.kind) {
		case "open":
			return;
		case "event":
			applyEvent(cursor, line);
			return;
		case "journal_truncated":
			fold.truncated = true;
			fold.eventsUnread = true;
			pushRow(cursor, { at: line.at, kind: "note", text: "the feed reached its size cap; later events were dropped" });
			return;
		case "result":
			return;
		case "terminal":
			settleReportRow(cursor);
			fold.terminal =
				line.detail === undefined ? { outcome: line.outcome } : { outcome: line.outcome, detail: line.detail };
			for (const row of fold.rows) {
				if (row.pending === true) row.pending = false;
			}
			cursor.pendingById.clear();
			fold.current = null;
			fold.asking = null;
			fold.phase = "settled";
	}
}

/**
 * Fold what was appended to a run's feed since the last call. A file that
 * shrank was replaced, and its fold starts over; a first read of a large file
 * starts at the reader tail like `readRunFeed` does.
 */
function advance(cursor: FoldCursor): FoldCursor {
	let size: number;
	try {
		size = statSync(cursor.path).size;
	} catch {
		cursor.fold.present = false;
		return cursor;
	}
	let current = cursor;
	if (size < current.offset) current = newCursor(current.path);
	current.fold.present = true;
	if (size === current.offset) return current;
	if (current.offset === 0 && size > RUN_FEED_READ_TAIL_BYTES) {
		current.offset = size - RUN_FEED_READ_TAIL_BYTES;
		current.skipFirst = true;
		current.fold.truncated = true;
		current.fold.eventsUnread = true;
	}
	const length = Math.min(size - current.offset, FOLD_READ_MAX_BYTES);
	const buffer = Buffer.allocUnsafe(length);
	let read = 0;
	try {
		const fd = openSync(current.path, "r");
		try {
			read = readSync(fd, buffer, 0, length, current.offset);
		} finally {
			closeSync(fd);
		}
	} catch {
		return current;
	}
	current.offset += read;
	const lines = (current.partial + current.decoder.write(buffer.subarray(0, read))).split("\n");
	current.partial = lines.pop() ?? "";
	if (current.skipFirst) {
		lines.shift();
		current.skipFirst = false;
	}
	for (const raw of lines) {
		if (raw.length === 0) continue;
		const line = readRunFeedLine(raw);
		if (line !== null) applyLine(current, line);
	}
	return current;
}

/** Folds for every run the dashboard has looked at, advanced on each poll. */
export interface RunFoldCache {
	fold(runId: string): RunFold;
	/** Forget runs no longer on the board, so a long session does not keep every fold. */
	retain(runIds: ReadonlySet<string>): void;
}

function createRunFoldCache(stateDir: string): RunFoldCache {
	const cursors = new Map<string, FoldCursor>();
	return {
		fold(runId: string): RunFold {
			const cursor = cursors.get(runId) ?? newCursor(runFeedPath(runId, stateDir));
			const advanced = advance(cursor);
			cursors.set(runId, advanced);
			return advanced.fold;
		},
		retain(runIds: ReadonlySet<string>): void {
			for (const runId of cursors.keys()) {
				if (!runIds.has(runId)) cursors.delete(runId);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Run record facts
// ---------------------------------------------------------------------------

/** What a finished card and the takeover's summary say about the sealed record. */
export interface RunRecordView {
	outcome: string;
	outcomeCode?: string;
	contract?: string;
	/** The artifact-integrity words (`sealed`, `seal broken`), from an authenticated read-back only. */
	seal?: string;
	/** The overall trust verdict in the shared vocabulary (`grounded`, `unverified`, …). */
	verdict?: string;
	validation?: string;
	/** The run row's integrity input: verified only on an authenticated seal, compromised on a broken one. */
	integrity: RunIntegrity;
	/** The run row's validation input, from the record's validation grounding. */
	validationState: RunValidation;
	failure?: string;
	answer?: string;
	changedPaths?: ReadonlyArray<string>;
	/** The calls kept from running, in words that say who stopped them (`2 calls refused`), as the worker card says. */
	refused?: string;
}

/** Whether a record's seal has been checked, verified or broken; before then its words are provisional. */
function sealChecked(view: RunRecordView | null): boolean {
	return (
		view?.seal === trustStateWord("artifactIntegrity", "verified") ||
		view?.seal === trustStateWord("artifactIntegrity", "failed")
	);
}

function integrityInput(state: string | undefined): RunIntegrity {
	if (state === "verified" || state === "not_applicable") return "verified";
	return state === "failed" ? "compromised" : "unverified";
}

/** A validation claimed and never observed passed only on the worker's own report. */
function validationInput(state: string | undefined): RunValidation {
	switch (state) {
		case "validated":
			return "passed";
		case "failed":
			return "failed";
		case "ungrounded":
			return "self-reported";
		case "absent":
		case "not_applicable":
			return "none";
		default:
			return "unknown";
	}
}

function runRecordView(runId: string, stateDir: string): RunRecordView | null {
	const facts = readRunResultFacts(runId, stateDir);
	if (facts === null) return null;
	const integrity = facts.trust?.artifactIntegrity;
	const changedPaths =
		facts.changedPaths !== undefined && facts.changedPaths.length > 0 ? facts.changedPaths : undefined;
	return {
		outcome: facts.outcome,
		integrity: integrityInput(integrity?.state),
		validationState: validationInput(facts.trust?.validationGrounding.state),
		...(facts.outcomeCode !== undefined ? { outcomeCode: facts.outcomeCode } : {}),
		...(facts.contract !== undefined ? { contract: facts.contract } : {}),
		...(integrity !== undefined ? { seal: trustStateWord("artifactIntegrity", integrity.state) } : {}),
		...(facts.trust !== undefined
			? { verdict: trustVerdictWord(facts.trust), validation: validationClause(facts.trust) }
			: {}),
		...(facts.failureMessage !== undefined ? { failure: facts.failureMessage } : {}),

		// A sealed report reads in its own words, as the transcript card reads it; its changed paths are already listed.
		...(facts.text !== undefined && facts.text.trim().length > 0
			? { answer: sealedReportAnswer(facts.text, facts.structured, { changed: changedPaths === undefined }) }
			: {}),
		...(changedPaths !== undefined ? { changedPaths } : {}),
		...(facts.refusedCalls !== undefined && facts.refusedCalls > 0
			? { refused: refusedCallsWords(facts.refusedCalls, facts.guardedCalls ?? 0) }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type CardState = "queued" | "running" | "stale" | "succeeded" | "failed" | "canceled";

export interface WorkerCard {
	runId: string;
	agentId: string;
	task: string;
	state: CardState;
	startedAtMs: number;
	endedAtMs: number | null;
	target: string;
	model: string;
	/** Who asked for the run, for the identity cell. */
	origin: RunOrigin;
	/** A helper CLIO Coder runs for the model (`↳`). */
	helper: boolean;
	toolCalls: number;
	elapsed?: string;
	/** The run's clock in milliseconds, live or stopped at its end. */
	elapsedMs?: number;
	toolCallsDisplay?: string;
	toolCap?: number;
	/** The run's tokens as the read model words a count: `~` estimated, `≥` with its unknown calls when partial. */
	tokens?: string;
	/** Formatted cost when something priced the run; absent rather than `$0.00` when nothing did. */
	cost?: string;
	phase: WorkerPhase;
	current: StreamRow | null;
	last: StreamRow | null;
	/** A permission ask waiting on the operator while the run is live. */
	asking: StreamRow | null;
	/** The newest finished calls, oldest first, for the detail's tool trail. */
	trail: StreamRow[];
	/** Newest prose, for a running card that is writing rather than calling tools. */
	lastText?: string;
	record: RunRecordView | null;
	/** Present on a step of a fleet run: the root it belongs to. */
	fleetRootId?: string;
	attempt: number;
	/** The ledger closed the row without a record; its own words. */
	ledgerDetail?: string;
}

function cardState(run: RunEnvelope): CardState {
	if (run.endedAt === null) {
		if (run.status === "queued") return "queued";
		if (run.status === "stale") return "stale";
		return "running";
	}
	const outcome = run.outcome ?? (run.status === "completed" ? "succeeded" : "failed");
	if (outcome === "succeeded") return "succeeded";
	if (outcome === "canceled") return "canceled";
	return "failed";
}

export function isLive(state: CardState): boolean {
	return state === "queued" || state === "running" || state === "stale";
}

function toolCapOf(run: RunEnvelope): number | undefined {
	const effective = run.budget?.effective;
	const cap = effective?.ceiling ?? effective?.toolCalls;
	return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

function lastProse(fold: RunFold): string | undefined {
	for (let index = fold.rows.length - 1; index >= 0; index -= 1) {
		const row = fold.rows[index];
		// A result-contract report is not prose: the card says the worker is writing, not its first JSON line.
		if (row?.kind === "text" && row.text.trim().length > 0)
			return isStructuredAnswerText(row.text) ? undefined : row.text;
		if (row?.kind === "tool") return undefined;
	}
	return undefined;
}

export interface BoardSource {
	stateDir: string;
	folds: RunFoldCache;
	/** Run records are immutable once sealed, so each is authenticated and read once its seal is checked. */
	records: Map<string, RunRecordView | null>;
	/**
	 * When a finished run whose seal was not yet checked is read again. The ledger closes a run before its record is
	 * sealed, and a read in that gap kept `seal unchecked` on the dock while `evidence inspect` said verified (bt-11).
	 */
	unsealed: Map<string, number>;
	ledger: LedgerSnapshot | null;
	/** A finished run's telemetry facts, kept while its journal's stamp is unchanged, so a sealed run folds once. */
	telemetry: Map<string, { stamp: string; facts: CardTelemetry }>;
}

export function createBoardSource(stateDir: string = clioStateDir()): BoardSource {
	return {
		stateDir,
		folds: createRunFoldCache(stateDir),
		records: new Map(),
		unsealed: new Map(),
		ledger: null,
		telemetry: new Map(),
	};
}

/** The ledger rows, re-read only when `runs.json` changed. A torn or failed read keeps the last good copy. */
export function ledgerRuns(source: BoardSource): ReadonlyArray<RunEnvelope> {
	source.ledger = readLedgerSnapshot(source.ledger, source.stateDir);
	return source.ledger.runs;
}

/** A finished record is re-read at most this often until its seal is checked, and not past the wait after it ended. */
const UNSEALED_REREAD_MS = 1_000;
const UNSEALED_WAIT_MS = 60_000;

function finishedRecord(source: BoardSource, run: RunEnvelope, nowMs: number): RunRecordView | null {
	const retryAt = source.unsealed.get(run.id);
	if (source.records.has(run.id) && (retryAt === undefined || nowMs < retryAt))
		return source.records.get(run.id) ?? null;
	const view = runRecordView(run.id, source.stateDir);
	source.records.set(run.id, view);
	const endedAtMs = run.endedAt === null ? nowMs : Date.parse(run.endedAt);
	if (sealChecked(view) || !(nowMs - endedAtMs < UNSEALED_WAIT_MS)) source.unsealed.delete(run.id);
	else source.unsealed.set(run.id, nowMs + UNSEALED_REREAD_MS);
	return view;
}

interface CardTelemetry {
	toolCalls: number;
	elapsed: string;
	elapsedMs: number;
	toolCallsDisplay: string;
	tokens: string | undefined;
	cost: string | null;
}

/**
 * A run's telemetry as its card shows it. A finished run's clock stops at the ledger's end, so its facts depend on
 * its journal alone and are folded again only when the journal's stamp changes; a live run's clock moves every poll.
 */
function cardTelemetry(source: BoardSource, run: RunEnvelope, nowMs: number): CardTelemetry {
	const endedAtMs = run.endedAt === null ? Number.NaN : Date.parse(run.endedAt);
	const stamp = Number.isFinite(endedAtMs) ? runTelemetryJournalStamp(source.stateDir, run.id) : null;
	const kept = source.telemetry.get(run.id);
	if (stamp !== null && kept?.stamp === stamp) return kept.facts;
	const telemetry = runTelemetry(run.id, loadRunTelemetrySource(source.stateDir, run.id), {
		now: new Date(stamp !== null ? endedAtMs : nowMs),
	});
	const facts: CardTelemetry = {
		toolCalls: factKnownValue(telemetry.activity.toolCalls.fact),
		elapsed: telemetry.activity.elapsed.display,
		elapsedMs: factKnownValue(telemetry.activity.elapsed.fact),
		toolCallsDisplay: telemetry.activity.toolCalls.display,
		tokens: telemetry.row.tokens.display,
		cost: telemetry.row.usd.display,
	};
	if (stamp !== null) source.telemetry.set(run.id, { stamp, facts });
	return facts;
}

/** Rows of the detail's tool trail at the most generous tier. */
const TRAIL_ROWS = 3;

function runOrigin(run: RunEnvelope): RunOrigin {
	const origin = run.rootRequestOrigin ?? run.requestOrigin;
	return origin === "user" ? "operator" : origin === "agent" || origin === undefined ? "model" : "harness";
}

function toolTrail(fold: RunFold): StreamRow[] {
	const trail: StreamRow[] = [];
	for (let index = fold.rows.length - 1; index >= 0 && trail.length < TRAIL_ROWS; index -= 1) {
		const row = fold.rows[index];
		if (row?.kind === "tool" && row.pending !== true) trail.unshift(row);
	}
	return trail;
}

function buildCard(source: BoardSource, run: RunEnvelope, nowMs: number): WorkerCard {
	const fold = source.folds.fold(run.id);
	const state = cardState(run);
	let record: RunRecordView | null = null;
	if (!isLive(state)) record = finishedRecord(source, run, nowMs);
	const startedAtMs = Date.parse(run.startedAt);
	const endedAtMs = run.endedAt === null ? null : Date.parse(run.endedAt);
	const toolCap = toolCapOf(run);
	const telemetry = cardTelemetry(source, run, nowMs);
	const tokens = telemetry.tokens;
	const cost = telemetry.cost;
	const lastText = lastProse(fold);
	const rootRunId = run.lineage?.rootRunId;
	return {
		runId: run.id,
		agentId: run.agentId,
		task: run.task,
		state,
		startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : nowMs,
		endedAtMs: endedAtMs !== null && Number.isFinite(endedAtMs) ? endedAtMs : null,
		target: run.targetId,
		model: run.wireModelId,
		origin: runOrigin(run),
		helper: run.agentAudience === "shadow" || run.agentAudience === "internal",
		toolCalls: telemetry.toolCalls,
		elapsed: telemetry.elapsed,
		elapsedMs: telemetry.elapsedMs,
		toolCallsDisplay: telemetry.toolCallsDisplay,
		...(toolCap !== undefined ? { toolCap } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(cost !== null ? { cost } : {}),
		phase: isLive(state) ? fold.phase : "settled",
		current: isLive(state) ? fold.current : null,
		last: fold.last,
		asking: isLive(state) ? fold.asking : null,
		trail: toolTrail(fold),
		...(lastText !== undefined ? { lastText } : {}),
		record,
		...(rootRunId?.startsWith("fleet-") ? { fleetRootId: rootRunId } : {}),
		attempt: run.lineage?.attempt ?? 0,
		...(record === null && !isLive(state) && run.outcomeDetail ? { ledgerDetail: run.outcomeDetail } : {}),
	};
}

export interface BoardModel {
	running: WorkerCard[];
	finished: WorkerCard[];
	/** True when the scope came from a session id rather than only the boot instant. */
	scopedToSession: boolean;
}

/** Where a finished run sorts on the board: its end, else its start, as its card reads them. */
function finishedOrderMs(run: RunEnvelope, nowMs: number): number {
	const endedAtMs = run.endedAt === null ? Number.NaN : Date.parse(run.endedAt);
	if (Number.isFinite(endedAtMs)) return endedAtMs;
	const startedAtMs = Date.parse(run.startedAt);
	return Number.isFinite(startedAtMs) ? startedAtMs : nowMs;
}

/**
 * The board: this session's workers in the inspection scope, running first
 * (newest first), then the most recent finished ones. A run with no session
 * stamp belongs here when it started after this Clio did.
 */
export function loadBoard(
	source: BoardSource,
	request: WatchRequest | null,
	scope: ReturnType<typeof fleetInspectionScope>,
	nowMs: number,
): BoardModel {
	const runs = ledgerRuns(source);
	const sessionId = request?.sessionId ?? null;
	const sinceMs = request?.sinceMs ?? null;
	// Every attempt of a failover is its own card, as on the Fleet Runs board: an earlier failed attempt is a run with
	// its own route and reason, and the counts of the two surfaces agree.
	const mine = runs.filter((run) => {
		if (!scope.seesRun(run)) return false;
		if (sessionId !== null && run.sessionId === sessionId) return true;
		const started = Date.parse(run.startedAt);
		if (sinceMs !== null) return run.sessionId === null || sessionId === null ? started >= sinceMs : false;
		return sessionId === null;
	});
	// Rows are picked before any card is built: the ledger keeps up to a thousand, and each card reads a journal.
	const live = mine.filter((run) => isLive(cardState(run)));
	const shown = mine
		.filter((run) => !isLive(cardState(run)))
		.sort((a, b) => finishedOrderMs(b, nowMs) - finishedOrderMs(a, nowMs))
		.slice(0, FINISHED_CARD_LIMIT);
	sizeCallJournalCache(live.length + shown.length);
	const running = live.map((run) => buildCard(source, run, nowMs)).sort((a, b) => b.startedAtMs - a.startedAtMs);
	const finished = shown.map((run) => buildCard(source, run, nowMs));
	// A run that leaves the board but stays in the ledger can come back; its fold resumes rather than restarts.
	const ledgerIds = new Set(runs.map((run) => run.id));
	source.folds.retain(ledgerIds);
	for (const runId of source.telemetry.keys()) if (!ledgerIds.has(runId)) source.telemetry.delete(runId);
	return { running, finished, scopedToSession: sessionId !== null };
}

// ---------------------------------------------------------------------------
// Takeover
// ---------------------------------------------------------------------------

export interface FleetContext {
	rootId: string;
	name: string;
	plannedSteps: number;
	settledSteps: number;
	running: boolean;
}

export interface TakeoverModel {
	card: WorkerCard;
	fold: RunFold;
	fleet: FleetContext | null;
}

function loadFleetContext(rootId: string): FleetContext | null {
	try {
		const record = readFleetRun(rootId);
		if (record === null) return null;
		return {
			rootId,
			name: record.fleet,
			plannedSteps: record.stepIds?.length ?? 0,
			settledSteps: record.steps?.length ?? 0,
			running: record.endedAt === null,
		};
	} catch {
		return null;
	}
}

export function loadTakeover(source: BoardSource, runId: string, nowMs: number): TakeoverModel | null {
	const run = ledgerRuns(source).find((entry) => entry.id === runId);
	if (run === undefined) return null;
	const card = buildCard(source, run, nowMs);
	const fleet = card.fleetRootId === undefined ? null : loadFleetContext(card.fleetRootId);
	return { card, fold: source.folds.fold(runId), fleet };
}

/**
 * The run that carries a finished run's work on: a retry of it, or the next
 * step of the fleet run it belonged to. A live one is preferred, then the
 * newest started. The takeover follows it so watching a fleet run or a
 * retried worker never ends on a run that already finished.
 */
export function successorRun(source: BoardSource, runId: string): string | null {
	const runs = ledgerRuns(source);
	const run = runs.find((entry) => entry.id === runId);
	if (run === undefined || run.endedAt === null) return null;
	const startedMs = Date.parse(run.startedAt);
	const fleetRoot = run.lineage?.rootRunId?.startsWith("fleet-") ? run.lineage.rootRunId : null;
	const candidates = runs.filter(
		(entry) =>
			entry.id !== run.id &&
			Date.parse(entry.startedAt) >= startedMs &&
			(entry.lineage?.parentRunId === run.id || (fleetRoot !== null && entry.lineage?.rootRunId === fleetRoot)),
	);
	if (candidates.length === 0) return null;
	const live = candidates.filter((entry) => entry.endedAt === null);
	const pool = live.length > 0 ? live : candidates;
	pool.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	return pool[0]?.id ?? null;
}
