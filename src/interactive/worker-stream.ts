/**
 * Worker transcript state machine.
 *
 * One entry per logical assignment, folded from the dispatch lifecycle events
 * the domain already publishes: DispatchStarted opens it, DispatchProgress
 * streams into it, DispatchCompleted/DispatchFailed seal it, RunAborted marks
 * a cancel that no terminal event followed. Nothing here reads disk, subscribes
 * to a bus, or renders; the chat panel owns presentation and the wiring owns
 * I/O, so every sequence below is testable as a pure fold.
 *
 * Three rules the fold enforces rather than documents:
 *
 *   - Tool *names* only. Names come exclusively from the `clio_*` telemetry
 *     events, never from `tool_execution_start`, whose `args` carry the call's
 *     literal arguments. A worker's arguments are its own business and must not
 *     cross into the operator's transcript, which is the same rule the dispatch
 *     board follows.
 *   - Attempts fold into one entry. A failover publishes a second
 *     DispatchStarted under the same `assignmentId`, so it appends an attempt
 *     and keeps streaming into the block the operator is already reading
 *     instead of opening a second one. The retry itself is admitted as an
 *     internal-origin request, so origin gates only the first attempt: the
 *     assignment's origin is what the block carries.
 *   - Only the current attempt can move the block. A late progress, terminal,
 *     or abort event addressed to a superseded attempt is dropped, and a
 *     settled block takes no more progress, so a slow event from an old run
 *     can neither rewrite nor re-settle the attempt that replaced it.
 */

import type {
	DispatchCompletedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
	DispatchStartedPayload,
	RunAbortedPayload,
} from "../core/bus-events.js";
import { durableAssistantTextFromEvent, WORKER_OUTPUT_MAX_BYTES } from "../domains/dispatch/event-pump.js";
import type { RunKind } from "../domains/dispatch/types.js";
import type { WorkerRunOrigin, WorkerRunRuntime, WorkerRunRuntimeKind } from "../domains/session/index.js";
import { truncateUtf8 } from "../tools/truncate-utf8.js";

export interface WorkerAttempt {
	runId: string;
	targetLabel: string;
	outcome?: string;
}

export type WorkerResultContract = "pass" | "fail" | "not-reached" | "unmeasured";

/**
 * Terminal facts a worker block reports. Sealed by the receipt when it can be
 * read, carried by the terminal event otherwise. Every unit is optional and
 * rendered only when known: an ACP peer reports no tokens of its own, and a
 * block that says it spent zero would be claiming something no receipt sealed.
 */
export interface WorkerReceiptSummary {
	outcome: string;
	outcomeCode?: string;
	exitCode?: number;
	failureMessage?: string;
	tokenCount?: number;
	durationMs?: number;
	toolCalls?: number;
	contract?: WorkerResultContract;
	/** From an abort marker rather than a sealed terminal event; a later DispatchCompleted/DispatchFailed replaces it. */
	provisional?: boolean;
	/** The run is over, but no receipt could be read for it. */
	receiptUnavailable?: boolean;
}

/** A receipt's projection: the summary plus the answer it sealed. */
export interface WorkerReceiptFacts extends WorkerReceiptSummary {
	text?: string;
}

/** Reads `receipts/<runId>.json` and projects it; null when it is absent or unreadable. */
export type WorkerReceiptReader = (runId: string) => WorkerReceiptFacts | null;

export interface WorkerEntryState {
	assignmentId: string;
	/** Current attempt's run id. */
	runId: string;
	/** The assignment's origin. Internal runs never open an entry, so it is never "internal". */
	origin: WorkerRunOrigin;
	agentId: string;
	/** Runtime family plus route, as the session entry records it; the header names it. */
	runtime: WorkerRunRuntime;
	/** Bounded worker prose: the live tail while running, the sealed answer once settled. */
	text: string;
	/** Lines the bound dropped from `text`; renders the `/view dispatch:` tail. */
	droppedLines: number;
	/** Distinct tool names in first-use order, bounded. */
	tools: string[];
	/** Every attempt of this assignment, oldest first. */
	attempts: WorkerAttempt[];
	pending: boolean;
	receipt?: WorkerReceiptSummary;
	/** Agent origin: the tool call whose execution spawned this run. */
	parentToolCallId?: string;
}

/**
 * Whether the model asked for this run. The parent tool call is the ground
 * truth: a scout successor an operator approved is admitted as user origin but
 * spawned by a dispatch call, and a compete judge carries no origin at all, so
 * origin alone would draw both as the operator's own work and let bare /share
 * hand the model a run it already has. Any run under a tool call is the
 * model's; the origin label decides only for a run with none.
 */
export function workerAskedByModel(state: Pick<WorkerEntryState, "origin" | "parentToolCallId">): boolean {
	return state.parentToolCallId !== undefined || state.origin === "agent";
}

export type WorkerStreamChange =
	| { kind: "created"; entry: WorkerEntryState }
	| { kind: "updated"; entry: WorkerEntryState };

export interface WorkerStreamOptions {
	/**
	 * Sealed terminal facts for a finished run. The receipt is the terminal
	 * truth; the bus payload is only the fallback for when it cannot be read.
	 */
	readReceipt?: WorkerReceiptReader;
}

export interface WorkerStream {
	started(payload: DispatchStartedPayload): WorkerStreamChange | null;
	progress(payload: DispatchProgressPayload): WorkerStreamChange | null;
	completed(payload: DispatchCompletedPayload): WorkerStreamChange | null;
	failed(payload: DispatchFailedPayload): WorkerStreamChange | null;
	aborted(payload: RunAbortedPayload): WorkerStreamChange | null;
	get(assignmentId: string): WorkerEntryState | undefined;
	/**
	 * Forget every assignment. Called with the transcript's own reset, so a
	 * session change clears the routing table and the visible blocks together:
	 * a late event for a run of the old session then finds no entry, rather than
	 * repainting an old block into the new transcript.
	 */
	reset(): void;
}

/**
 * Lines of worker prose kept while a run is live. The tail is what a streaming
 * answer is about, so the head is what gets dropped; once the run settles the
 * body is replaced by the receipt-sealed answer and anchors at the head, which
 * is the same rule the thinking block already follows.
 */
export const WORKER_LIVE_TAIL_LINES = 40;

/** Distinct tool names carried on an entry. The receipt's call count carries the total. */
export const WORKER_TOOL_NAME_LIMIT = 8;

const WORKER_TEXT_TRUNCATION_MARKER = "";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function workerRuntimeKind(
	runtimeKind: RunKind | undefined,
	runtimeId: string | undefined,
): WorkerRunRuntimeKind {
	if (runtimeKind === "acp-delegation") return "acp";
	if (runtimeId === "claude-code") return "claude-code";
	if (runtimeId === "claude-sdk") return "claude-sdk";
	return "clio";
}

function runtimeIdentity(payload: DispatchStartedPayload): WorkerRunRuntime {
	const kind = workerRuntimeKind(payload.runtimeKind, payload.runtimeId);
	if (kind === "acp") {
		const peerId = nonEmptyString(payload.agentId);
		return { kind, ...(peerId !== undefined ? { peerId } : {}) };
	}
	const targetId = nonEmptyString(payload.targetId);
	const wireModelId = nonEmptyString(payload.wireModelId);
	return {
		kind,
		...(targetId !== undefined ? { targetId } : {}),
		...(wireModelId !== undefined ? { wireModelId } : {}),
	};
}

/** Short route label for an attempt line: the model that ran it, or the peer that did. */
export function workerTargetLabel(runtime: WorkerRunRuntime): string {
	if (runtime.kind === "acp") return runtime.peerId ?? "acp";
	if (runtime.targetId !== undefined && runtime.wireModelId !== undefined) {
		return `${runtime.targetId}/${runtime.wireModelId}`;
	}
	return runtime.targetId ?? runtime.wireModelId ?? "unknown";
}

/**
 * Incremental assistant prose carried by one worker event.
 *
 * Native workers slim `message_update` down to `assistantMessageEvent.delta`
 * before it crosses the NDJSON seam (src/worker/event-projection.ts); the ACP
 * mapper emits a top-level `text_delta` carrying `text`. Both spellings are
 * read here so ACP peers need no separate UI path.
 */
function textDelta(event: unknown): string {
	if (!isRecord(event)) return "";
	if (event.type === "message_update") {
		const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
		if (assistantEvent?.type !== "text_delta") return "";
		return typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
	}
	if (event.type !== "text_delta") return "";
	if (typeof event.delta === "string") return event.delta;
	return typeof event.text === "string" ? event.text : "";
}

/** Tool name from Clio's own telemetry. Never from `tool_execution_*`, whose args are the call's arguments. */
function toolName(event: unknown): string | undefined {
	if (!isRecord(event)) return undefined;
	if (event.type !== "clio_tool_start" && event.type !== "clio_tool_finish") return undefined;
	const payload = isRecord(event.payload) ? event.payload : null;
	return nonEmptyString(payload?.tool);
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") lines += 1;
	}
	return lines;
}

/** Keep the newest `WORKER_LIVE_TAIL_LINES` lines; report what that cost. */
function boundLiveText(text: string): { text: string; dropped: number } {
	const lines = text.split("\n");
	if (lines.length <= WORKER_LIVE_TAIL_LINES) return { text, dropped: 0 };
	const dropped = lines.length - WORKER_LIVE_TAIL_LINES;
	return { text: lines.slice(dropped).join("\n"), dropped };
}

/** Head-anchored byte bound for a settled answer, matching the receipt's own bound. */
function boundSettledText(text: string): { text: string; dropped: number } {
	const bounded = truncateUtf8(text, WORKER_OUTPUT_MAX_BYTES, WORKER_TEXT_TRUNCATION_MARKER);
	if (bounded === text) return { text, dropped: 0 };
	return { text: bounded, dropped: Math.max(0, lineCount(text) - lineCount(bounded)) };
}

/**
 * Terminal facts a lifecycle payload can supply on its own. Used only when the
 * sealed receipt is unreadable, so the block still reports an honest outcome
 * instead of hanging on a spinner.
 */
function terminalFacts(payload: DispatchCompletedPayload | DispatchFailedPayload): WorkerReceiptFacts {
	const detail = nonEmptyString(payload.outcomeDetail);
	const tokenCount = finiteNumber(payload.tokenCount);
	const durationMs = finiteNumber(payload.durationMs);
	const exitCode = finiteNumber(payload.exitCode);
	return {
		outcome: payload.outcome,
		...(payload.outcomeCode !== null && payload.outcomeCode !== undefined ? { outcomeCode: payload.outcomeCode } : {}),
		...(detail !== undefined ? { failureMessage: detail } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(tokenCount !== undefined ? { tokenCount } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(payload.toolActivity ? { toolCalls: payload.toolActivity.calls } : {}),
	};
}

/**
 * The one projection from receipt facts to the summary a block's footer
 * reports, shared by live settlement and by replay so both draw the same
 * numbers from the same bytes. Null is a run whose receipt is gone (an expired
 * state dir, a session copied without its receipts): the run is over and the
 * transcript says so, even when it cannot say how.
 */
export function workerReceiptSummary(facts: WorkerReceiptFacts | null): WorkerReceiptSummary {
	if (facts === null) return { outcome: "unknown", receiptUnavailable: true };
	const { text: _text, ...summary } = facts;
	return summary;
}

export function createWorkerStream(options: WorkerStreamOptions = {}): WorkerStream {
	const byAssignment = new Map<string, WorkerEntryState>();
	/** Highest attempt number seen per assignment; a DispatchStarted at or below it is a duplicate or a straggler. */
	const attemptByAssignment = new Map<string, number>();
	/** Every attempt run id to its assignment, so progress and terminal events find their entry. */
	const assignmentByRun = new Map<string, string>();
	/** Durable answer text observed live, per attempt; the receipt wins when it is readable. */
	const durableTextByRun = new Map<string, string>();

	/** The entry a run id addresses, and only while that run is the entry's current attempt. */
	const currentEntryForRun = (runId: unknown): WorkerEntryState | undefined => {
		const id = nonEmptyString(runId);
		if (id === undefined) return undefined;
		const assignmentId = assignmentByRun.get(id);
		const entry = assignmentId === undefined ? undefined : byAssignment.get(assignmentId);
		return entry?.runId === id ? entry : undefined;
	};

	const settle = (entry: WorkerEntryState, payloadFacts: WorkerReceiptFacts): WorkerStreamChange => {
		const facts = options.readReceipt?.(entry.runId) ?? { ...payloadFacts, receiptUnavailable: true };
		entry.receipt = workerReceiptSummary(facts);
		entry.pending = false;
		const attempt = entry.attempts[entry.attempts.length - 1];
		if (attempt !== undefined) attempt.outcome = facts.outcome;
		// Terminal truth is the sealed answer. A run whose receipt could not be
		// read keeps whatever durable text its own stream produced, and a run that
		// produced none keeps the live tail rather than blanking the block.
		const settled = nonEmptyString(facts.text) ?? nonEmptyString(durableTextByRun.get(entry.runId));
		if (settled !== undefined) {
			const bounded = boundSettledText(settled);
			entry.text = bounded.text;
			entry.droppedLines = bounded.dropped;
		}
		return { kind: "updated", entry };
	};

	return {
		started(payload): WorkerStreamChange | null {
			const runId = nonEmptyString(payload.runId);
			const assignmentId = nonEmptyString(payload.assignmentId) ?? runId;
			if (runId === undefined || assignmentId === undefined) return null;
			const runtime = runtimeIdentity(payload);
			const existing = byAssignment.get(assignmentId);
			if (existing !== undefined) {
				if (payload.attempt <= (attemptByAssignment.get(assignmentId) ?? -1)) return null;
				// A later attempt of work the operator is already watching. The block
				// keeps its identity, gains a rail line, and streams again. Its origin
				// is the assignment's, not the retry request's.
				attemptByAssignment.set(assignmentId, payload.attempt);
				existing.runId = runId;
				existing.runtime = runtime;
				existing.pending = true;
				delete existing.receipt;
				existing.attempts.push({ runId, targetLabel: workerTargetLabel(runtime) });
				assignmentByRun.set(runId, assignmentId);
				return { kind: "updated", entry: existing };
			}
			if (payload.requestOrigin !== "user" && payload.requestOrigin !== "agent") return null;
			attemptByAssignment.set(assignmentId, payload.attempt);
			const entry: WorkerEntryState = {
				assignmentId,
				runId,
				origin: payload.requestOrigin,
				agentId: payload.agentId,
				runtime,
				text: "",
				droppedLines: 0,
				tools: [],
				attempts: [{ runId, targetLabel: workerTargetLabel(runtime) }],
				pending: true,
				...(payload.parentToolCallId !== undefined ? { parentToolCallId: payload.parentToolCallId } : {}),
			};
			byAssignment.set(assignmentId, entry);
			assignmentByRun.set(runId, assignmentId);
			return { kind: "created", entry };
		},

		progress(payload): WorkerStreamChange | null {
			const entry = currentEntryForRun(payload.runId);
			if (entry === undefined || !entry.pending) return null;
			const event = payload.event;
			let changed = false;

			const delta = textDelta(event);
			if (delta.length > 0) {
				const bounded = boundLiveText(entry.text + delta);
				entry.text = bounded.text;
				entry.droppedLines += bounded.dropped;
				changed = true;
			}

			// A durable message_end is the answer as the receipt will seal it. An
			// ACP peer that streamed no deltas reaches the transcript only here.
			const durable = durableAssistantTextFromEvent(event);
			if (durable.trim().length > 0) {
				durableTextByRun.set(entry.runId, durable);
				if (delta.length === 0 && entry.text.trim().length === 0) {
					const bounded = boundLiveText(durable);
					entry.text = bounded.text;
					entry.droppedLines += bounded.dropped;
				}
				changed = true;
			}

			const tool = toolName(event);
			if (tool !== undefined && !entry.tools.includes(tool) && entry.tools.length < WORKER_TOOL_NAME_LIMIT) {
				entry.tools.push(tool);
				changed = true;
			}

			return changed ? { kind: "updated", entry } : null;
		},

		completed(payload): WorkerStreamChange | null {
			const entry = currentEntryForRun(payload.runId);
			if (entry === undefined) return null;
			return settle(entry, terminalFacts(payload));
		},

		failed(payload): WorkerStreamChange | null {
			const entry = currentEntryForRun(payload.runId);
			if (entry === undefined) return null;
			return settle(entry, terminalFacts(payload));
		},

		aborted(payload): WorkerStreamChange | null {
			const entry = currentEntryForRun(payload.runId);
			// A cancelled stream or a loop-guard stop names no dispatched run; only
			// an abort that hits a live worker of ours settles anything.
			if (entry === undefined || !entry.pending) return null;
			const durationMs = finiteNumber(payload.elapsedMs);
			const failureMessage = nonEmptyString(payload.reason);
			entry.pending = false;
			entry.receipt = {
				outcome: "canceled",
				...(durationMs !== undefined ? { durationMs } : {}),
				...(failureMessage !== undefined ? { failureMessage } : {}),
				provisional: true,
			};
			const attempt = entry.attempts[entry.attempts.length - 1];
			if (attempt !== undefined) attempt.outcome = "canceled";
			return { kind: "updated", entry };
		},

		get(assignmentId): WorkerEntryState | undefined {
			return byAssignment.get(assignmentId);
		},

		reset(): void {
			byAssignment.clear();
			attemptByAssignment.clear();
			assignmentByRun.clear();
			durableTextByRun.clear();
		},
	};
}
