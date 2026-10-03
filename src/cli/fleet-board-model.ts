/**
 * The workers dashboard's model: which workers the board shows and what each
 * one is doing, read from durable state only.
 *
 * The dashboard runs in its own process inside the workers dock (and works the
 * same over SSH), so it shares nothing with the orchestrator's heap. Three
 * sources feed it: the run ledger (`runs.json`) for identity, route, budget and
 * lifecycle; each run's event journal (src/domains/dispatch/run-event-journal.ts)
 * for the live stream; and the sealed receipt, authenticated against its
 * ledger row, for a finished worker's outcome, conformance and trust.
 *
 * Journals are folded incrementally: a run's fold remembers how many bytes it
 * consumed and reads only what was appended since, so polling four live
 * workers at the monitor cadence costs four small reads rather than four
 * whole files. Everything kept is bounded, and nothing is sanitized here:
 * the renderer cleans every string it draws, at the one place it is drawn.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { clioStateDir } from "../core/xdg.js";
import { readRunReceiptFacts } from "../domains/dispatch/receipt-facts.js";
import {
	parseRunEventJournalLine,
	RUN_EVENT_JOURNAL_READ_TAIL_BYTES,
	type RunEventJournalLine,
	runEventJournalPath,
} from "../domains/dispatch/run-event-journal.js";
import { openLedger, readFleetRun } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { trustStateWord, trustVerdictWord, validationClause } from "../domains/evidence/trust-projection.js";
import { retiredIntegrityVersionOf } from "../domains/evidence/trust-status.js";
import { costAggregateForAmount, formatCostAggregate } from "../domains/observability/cost.js";
import type { fleetInspectionScope } from "./fleet-project-scope.js";

/** Stream rows a run keeps; the head goes first, as in a terminal's scrollback. */
const STREAM_ROW_LIMIT = 600;
/** Characters one prose row keeps of a long answer; the newest text wins. */
const TEXT_ROW_MAX_CHARS = 8000;
/** Bytes one poll folds from a single journal, so a huge backlog cannot stall a frame. */
const FOLD_READ_MAX_BYTES = 512 * 1024;
/** Finished workers the board lists after the running ones. */
const FINISHED_CARD_LIMIT = 24;
/** Lines of a sealed answer the takeover shows under the receipt summary. */
export const ANSWER_PREVIEW_LINES = 12;

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
	runId: string | null;
	seq: string;
	sessionId: string | null;
	sinceMs: number | null;
}

export function parseWatchRequest(raw: string): WatchRequest {
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

export type WorkerPhase = "starting" | "thinking" | "writing" | "tool" | "waiting" | "settled";

export interface RunFold {
	present: boolean;
	/** True when the writer dropped lines, this reader skipped a head, or rows fell off the top. */
	truncated: boolean;
	rows: StreamRow[];
	droppedRows: number;
	toolCalls: number;
	/** Tokens the run's model calls processed so far; undefined until one reports. */
	tokens: number | undefined;
	/** The call running now, if any. */
	current: StreamRow | null;
	/** The call that finished last. */
	last: StreamRow | null;
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
	fold: RunFold;
}

function emptyFold(): RunFold {
	return {
		present: false,
		truncated: false,
		rows: [],
		droppedRows: 0,
		toolCalls: 0,
		tokens: undefined,
		current: null,
		last: null,
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

function applyEvent(cursor: FoldCursor, line: Extract<RunEventJournalLine, { kind: "event" }>): void {
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
			fold.toolCalls += 1;
			fold.current = row;
			fold.phase = "tool";
			return;
		}
		case "clio_coder_tool_finish": {
			cursor.paragraphBreak = true;
			// Journals written before the feed carried facts spell the finish as
			// `<tool> <outcome>` in the detail and nothing else.
			const legacy = line.tool === undefined ? detail.split(" ") : null;
			const tool = line.tool ?? legacy?.[0] ?? "tool";
			const legacyOutcome = legacy?.[1];
			const outcome =
				line.outcome ??
				(legacyOutcome === "ok" || legacyOutcome === "error" || legacyOutcome === "blocked" ? legacyOutcome : undefined);
			let row = line.callId !== undefined ? cursor.pendingById.get(line.callId) : undefined;
			if (line.callId !== undefined) cursor.pendingById.delete(line.callId);
			row ??= lastPendingFor(fold, tool);
			if (row === undefined) {
				fold.toolCalls += 1;
				row = pushRow(cursor, {
					at: line.at,
					kind: "tool",
					text: legacy === null ? detail : "",
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
			cursor.paragraphBreak = true;
			if (line.tokens !== undefined) fold.tokens = (fold.tokens ?? 0) + line.tokens;
			// Only a message that streamed no prose carries its text here (an ACP
			// peer, or a journal from before the feed coalesced deltas).
			if (detail.length > 0) {
				appendText(cursor, line.at, detail);
				cursor.paragraphBreak = true;
			}
			if (fold.phase === "writing" || fold.phase === "thinking") fold.phase = "waiting";
			return;
		case "clio_coder_permission_escalated":
			pushRow(cursor, { at: line.at, kind: "approval", text: detail, ...(line.tool ? { tool: line.tool } : {}) });
			return;
		case "clio_coder_permission_resolved":
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
		case "clio_coder_steer_received":
			pushRow(cursor, { at: line.at, kind: "note", text: `steering received${detail ? ` (${detail})` : ""}` });
			return;
		case "agent_start":
			fold.phase = "starting";
			return;
		case "agent_end":
			fold.current = null;
			fold.phase = "waiting";
			return;
		// Written by journals from before the feed; the richer lines cover them.
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
		case "message_start":
		case "turn_start":
		case "turn_end":
		case "text_delta":
			return;
		default:
			if (detail.length > 0) pushRow(cursor, { at: line.at, kind: "note", text: `${line.type}: ${detail}` });
	}
}

function applyLine(cursor: FoldCursor, line: RunEventJournalLine): void {
	const fold = cursor.fold;
	switch (line.kind) {
		case "open":
			return;
		case "event":
			applyEvent(cursor, line);
			return;
		case "journal_truncated":
			fold.truncated = true;
			pushRow(cursor, { at: line.at, kind: "note", text: "the journal reached its size cap; later events were dropped" });
			return;
		case "receipt":
			return;
		case "terminal":
			fold.terminal =
				line.detail === undefined ? { outcome: line.outcome } : { outcome: line.outcome, detail: line.detail };
			for (const row of fold.rows) {
				if (row.pending === true) row.pending = false;
			}
			cursor.pendingById.clear();
			fold.current = null;
			fold.phase = "settled";
	}
}

/**
 * Fold what was appended to a run's journal since the last call. A file that
 * shrank was replaced, and its fold starts over; a first read of a large file
 * starts at the reader tail like `readRunEventJournal` does.
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
	if (current.offset === 0 && size > RUN_EVENT_JOURNAL_READ_TAIL_BYTES) {
		current.offset = size - RUN_EVENT_JOURNAL_READ_TAIL_BYTES;
		current.skipFirst = true;
		current.fold.truncated = true;
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
		const parsed = parseRunEventJournalLine(raw);
		if (parsed !== null) applyLine(current, parsed);
	}
	return current;
}

/** Folds for every run the dashboard has looked at, advanced on each poll. */
export interface RunFoldCache {
	fold(runId: string): RunFold;
	/** Forget runs no longer on the board, so a long session does not keep every fold. */
	retain(runIds: ReadonlySet<string>): void;
}

export function createRunFoldCache(journalRoot?: string): RunFoldCache {
	const cursors = new Map<string, FoldCursor>();
	return {
		fold(runId: string): RunFold {
			const cursor = cursors.get(runId) ?? newCursor(runEventJournalPath(runId, journalRoot));
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
// Receipt facts
// ---------------------------------------------------------------------------

/** What a finished card and the takeover's summary say about the sealed receipt. */
export interface ReceiptView {
	outcome: string;
	outcomeCode?: string;
	contract?: string;
	/** The artifact-integrity words (`sealed`, `seal broken`), from an authenticated read-back only. */
	seal?: string;
	/** The overall trust verdict in the shared vocabulary (`grounded`, `unverified`, …). */
	verdict?: string;
	validation?: string;
	failure?: string;
	toolCalls?: number;
	tokens?: number;
	durationMs?: number;
	answer?: string;
	changedPaths?: ReadonlyArray<string>;
}

function receiptView(runId: string, stateDir: string): ReceiptView | null {
	const facts = readRunReceiptFacts(runId, stateDir);
	if (facts === null) return null;
	const integrity = facts.trust?.artifactIntegrity;
	return {
		outcome: facts.outcome,
		...(facts.outcomeCode !== undefined ? { outcomeCode: facts.outcomeCode } : {}),
		...(facts.contract !== undefined ? { contract: facts.contract } : {}),
		...(integrity !== undefined
			? {
					seal:
						retiredIntegrityVersionOf(integrity) !== null
							? "seal retired"
							: trustStateWord("artifactIntegrity", integrity.state),
				}
			: {}),
		...(facts.trust !== undefined
			? { verdict: trustVerdictWord(facts.trust), validation: validationClause(facts.trust) }
			: {}),
		...(facts.failureMessage !== undefined ? { failure: facts.failureMessage } : {}),
		...(facts.toolCalls !== undefined ? { toolCalls: facts.toolCalls } : {}),
		...(facts.tokenCount !== undefined ? { tokens: facts.tokenCount } : {}),
		...(facts.durationMs !== undefined ? { durationMs: facts.durationMs } : {}),
		...(facts.text !== undefined && facts.text.trim().length > 0 ? { answer: facts.text } : {}),
		...(facts.changedPaths !== undefined && facts.changedPaths.length > 0 ? { changedPaths: facts.changedPaths } : {}),
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
	toolCalls: number;
	toolCap?: number;
	tokens?: number;
	/** Formatted cost when something priced the run; absent rather than `$0.00` when nothing did. */
	cost?: string;
	phase: WorkerPhase;
	current: StreamRow | null;
	last: StreamRow | null;
	/** Newest prose, for a running card that is writing rather than calling tools. */
	lastText?: string;
	receipt: ReceiptView | null;
	/** Present on a step of a fleet run: the root it belongs to. */
	fleetRootId?: string;
	attempt: number;
	/** The ledger closed the row without a receipt; its own words. */
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
		if (row?.kind === "text" && row.text.trim().length > 0) return row.text;
		if (row?.kind === "tool") return undefined;
	}
	return undefined;
}

export interface BoardSource {
	stateDir: string;
	folds: RunFoldCache;
	/** Receipts are immutable once sealed, so each is authenticated and read once. */
	receipts: Map<string, ReceiptView | null>;
	ledger: { mtimeMs: number; size: number; runs: ReadonlyArray<RunEnvelope> } | null;
}

export function createBoardSource(stateDir: string = clioStateDir(), journalRoot?: string): BoardSource {
	return { stateDir, folds: createRunFoldCache(journalRoot), receipts: new Map(), ledger: null };
}

/** The ledger rows, re-read only when `runs.json` changed. A torn or failed read keeps the last good copy. */
export function ledgerRuns(source: BoardSource): ReadonlyArray<RunEnvelope> {
	const path = join(source.stateDir, "runs.json");
	let mtimeMs = 0;
	let size = 0;
	try {
		const stat = statSync(path);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
	} catch {
		source.ledger = { mtimeMs: 0, size: 0, runs: [] };
		return [];
	}
	if (source.ledger !== null && source.ledger.mtimeMs === mtimeMs && source.ledger.size === size)
		return source.ledger.runs;
	try {
		source.ledger = { mtimeMs, size, runs: openLedger().list() };
	} catch {
		// The writer replaces the file atomically; a failed parse is a race the next poll wins.
	}
	return source.ledger?.runs ?? [];
}

/**
 * A later attempt of the same work replaces an earlier one on the board: the
 * failed attempt is history the replacement's card already counts.
 */
function supersededIds(runs: ReadonlyArray<RunEnvelope>): Set<string> {
	const superseded = new Set<string>();
	for (const run of runs) {
		const lineage = run.lineage;
		if (lineage !== undefined && lineage.attempt > 0 && lineage.parentRunId !== null) superseded.add(lineage.parentRunId);
	}
	return superseded;
}

export function buildCard(source: BoardSource, run: RunEnvelope, nowMs: number): WorkerCard {
	const fold = source.folds.fold(run.id);
	const state = cardState(run);
	let receipt: ReceiptView | null = null;
	if (!isLive(state)) {
		if (!source.receipts.has(run.id)) source.receipts.set(run.id, receiptView(run.id, source.stateDir));
		receipt = source.receipts.get(run.id) ?? null;
	}
	const startedAtMs = Date.parse(run.startedAt);
	const endedAtMs = run.endedAt === null ? null : Date.parse(run.endedAt);
	const toolCap = toolCapOf(run);
	// Live, the journal's per-call counts are the only running total; once
	// sealed, the receipt's count is the authenticated one.
	const ledgerTokens = run.tokenCount > 0 ? run.tokenCount : undefined;
	const tokens = isLive(state) ? (fold.tokens ?? ledgerTokens) : (receipt?.tokens ?? ledgerTokens ?? fold.tokens);
	const cost =
		run.endedAt === null ? null : formatCostAggregate(costAggregateForAmount(run.costUsd, run.costProvenance));
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
		toolCalls: receipt?.toolCalls ?? fold.toolCalls,
		...(toolCap !== undefined ? { toolCap } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(cost !== null ? { cost } : {}),
		phase: isLive(state) ? fold.phase : "settled",
		current: isLive(state) ? fold.current : null,
		last: fold.last,
		...(lastText !== undefined ? { lastText } : {}),
		receipt,
		...(rootRunId?.startsWith("fleet-") ? { fleetRootId: rootRunId } : {}),
		attempt: run.lineage?.attempt ?? 0,
		...(receipt === null && !isLive(state) && run.outcomeDetail ? { ledgerDetail: run.outcomeDetail } : {}),
	};
}

export interface BoardModel {
	running: WorkerCard[];
	finished: WorkerCard[];
	/** True when the scope came from a session id rather than only the boot instant. */
	scopedToSession: boolean;
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
	const superseded = supersededIds(runs);
	const sessionId = request?.sessionId ?? null;
	const sinceMs = request?.sinceMs ?? null;
	const mine = runs.filter((run) => {
		if (superseded.has(run.id) || !scope.seesRun(run)) return false;
		if (sessionId !== null && run.sessionId === sessionId) return true;
		const started = Date.parse(run.startedAt);
		if (sinceMs !== null) return run.sessionId === null || sessionId === null ? started >= sinceMs : false;
		return sessionId === null;
	});
	const cards = mine.map((run) => buildCard(source, run, nowMs));
	const running = cards.filter((card) => isLive(card.state)).sort((a, b) => b.startedAtMs - a.startedAtMs);
	const finished = cards
		.filter((card) => !isLive(card.state))
		.sort((a, b) => (b.endedAtMs ?? b.startedAtMs) - (a.endedAtMs ?? a.startedAtMs))
		.slice(0, FINISHED_CARD_LIMIT);
	source.folds.retain(new Set([...running, ...finished].map((card) => card.runId)));
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

export function loadFleetContext(rootId: string): FleetContext | null {
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
