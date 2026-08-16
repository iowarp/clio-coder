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
 * Two rules the fold enforces rather than documents:
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
import { truncateUtf8 } from "../tools/truncate-utf8.js";

/** Origins that reach the transcript. Internal runs stay on the board. */
export type WorkerOrigin = "user" | "agent";

/**
 * Runtime family named in the entry header. Every family shares one entry
 * shape; the header exists so an operator can tell a local Clio worker from a
 * Claude subprocess from a delegated ACP peer without opening the board.
 */
export type WorkerRuntimeKind = "clio" | "acp" | "claude-sdk" | "claude-code";

export interface WorkerRuntimeIdentity {
	kind: WorkerRuntimeKind;
	/** Route facts for the runtimes that have one; ACP peers have none. */
	targetId?: string;
	wireModelId?: string;
	/** Delegation peer id; ACP only. */
	peerId?: string;
}

export interface WorkerAttempt {
	runId: string;
	targetLabel: string;
	outcome?: string;
}

export type WorkerResultContract = "pass" | "fail" | "not-reached" | "unmeasured";

/** Terminal facts drawn from the sealed receipt, or from the terminal event when no receipt was readable. */
export interface WorkerReceiptFacts {
	outcome: string;
	outcomeCode?: string | undefined;
	exitCode?: number | undefined;
	failureMessage?: string | undefined;
	tokenCount?: number | undefined;
	durationMs?: number | undefined;
	toolCalls?: number | undefined;
	contract?: WorkerResultContract | undefined;
	/** Receipt-sealed assistant answer; absent when the receipt was unreadable. */
	text?: string | undefined;
}

export interface WorkerReceiptSummary {
	outcome: string;
	outcomeCode?: string;
	tokens: number;
	elapsedMs: number;
	contract?: WorkerResultContract;
	toolCalls?: number;
	exitCode?: number;
	failureMessage?: string;
	/**
	 * True when the summary came from an abort marker rather than a sealed
	 * terminal event. A later DispatchCompleted/DispatchFailed replaces it.
	 */
	provisional?: boolean;
	/** True when the terminal event landed but no receipt could be read for it. */
	receiptUnavailable?: boolean;
}

export interface WorkerEntryState {
	assignmentId: string;
	/** Current attempt's run id. */
	runId: string;
	origin: WorkerOrigin;
	agentId: string;
	runtime: WorkerRuntimeIdentity;
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
	/** Wall clock at the current attempt's start; the abort fallback measures against it. */
	startedAtMs: number;
}

export type WorkerStreamChange =
	| { kind: "created"; entry: WorkerEntryState }
	| { kind: "updated"; entry: WorkerEntryState };

export interface WorkerStreamOptions {
	now?: () => number;
	/**
	 * Sealed terminal facts for a finished run. The receipt is the terminal
	 * truth; the bus payload is only the fallback for when it cannot be read.
	 */
	readReceipt?: (runId: string) => WorkerReceiptFacts | null;
	/** Assignments retained before the oldest settled one is evicted. */
	maxEntries?: number;
}

export interface WorkerStream {
	started(payload: DispatchStartedPayload): WorkerStreamChange | null;
	progress(payload: DispatchProgressPayload): WorkerStreamChange | null;
	completed(payload: DispatchCompletedPayload): WorkerStreamChange | null;
	failed(payload: DispatchFailedPayload): WorkerStreamChange | null;
	aborted(payload: RunAbortedPayload): WorkerStreamChange | null;
	get(assignmentId: string): WorkerEntryState | undefined;
	/** Every retained entry, oldest first. `/share` reads it to find a finished run. */
	entries(): ReadonlyArray<WorkerEntryState>;
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
const DEFAULT_MAX_ENTRIES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function workerRuntimeKind(runtimeKind: RunKind | undefined, runtimeId: string | undefined): WorkerRuntimeKind {
	if (runtimeKind === "acp-delegation") return "acp";
	if (runtimeId === "claude-code") return "claude-code";
	if (runtimeId === "claude-sdk") return "claude-sdk";
	return "clio";
}

function runtimeIdentity(payload: DispatchStartedPayload): WorkerRuntimeIdentity {
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
export function workerTargetLabel(runtime: WorkerRuntimeIdentity): string {
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

function receiptSummary(facts: WorkerReceiptFacts, fallbackElapsedMs: number): WorkerReceiptSummary {
	return {
		outcome: facts.outcome,
		...(facts.outcomeCode !== undefined && facts.outcomeCode !== null ? { outcomeCode: facts.outcomeCode } : {}),
		tokens: facts.tokenCount ?? 0,
		elapsedMs: facts.durationMs ?? fallbackElapsedMs,
		...(facts.contract !== undefined ? { contract: facts.contract } : {}),
		...(facts.toolCalls !== undefined ? { toolCalls: facts.toolCalls } : {}),
		...(facts.exitCode !== undefined ? { exitCode: facts.exitCode } : {}),
		...(facts.failureMessage !== undefined ? { failureMessage: facts.failureMessage } : {}),
	};
}

export function createWorkerStream(options: WorkerStreamOptions = {}): WorkerStream {
	const now = (): number => options.now?.() ?? Date.now();
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	/** Insertion-ordered; eviction takes the oldest settled entry. */
	const byAssignment = new Map<string, WorkerEntryState>();
	/** Current attempt run id to its assignment, so progress and terminal events find their entry. */
	const assignmentByRun = new Map<string, string>();
	/** Durable answer text observed live, per attempt; the receipt wins when it is readable. */
	const durableTextByRun = new Map<string, string>();

	const prune = (): void => {
		if (byAssignment.size <= maxEntries) return;
		for (const [assignmentId, entry] of byAssignment) {
			if (byAssignment.size <= maxEntries) break;
			if (entry.pending) continue;
			byAssignment.delete(assignmentId);
			for (const attempt of entry.attempts) assignmentByRun.delete(attempt.runId);
			for (const attempt of entry.attempts) durableTextByRun.delete(attempt.runId);
		}
	};

	/** The entry a run id addresses, and only while that run is the entry's current attempt. */
	const currentEntryForRun = (runId: unknown): WorkerEntryState | undefined => {
		const id = nonEmptyString(runId);
		if (id === undefined) return undefined;
		const assignmentId = assignmentByRun.get(id);
		const entry = assignmentId === undefined ? undefined : byAssignment.get(assignmentId);
		return entry?.runId === id ? entry : undefined;
	};

	const settle = (entry: WorkerEntryState, payloadFacts: WorkerReceiptFacts): WorkerStreamChange => {
		const sealed = options.readReceipt?.(entry.runId) ?? null;
		const facts: WorkerReceiptFacts = sealed ?? payloadFacts;
		entry.receipt = {
			...receiptSummary(facts, Math.max(0, now() - entry.startedAtMs)),
			...(sealed === null ? { receiptUnavailable: true } : {}),
		};
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
		prune();
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
				// A later attempt of work the operator is already watching. The block
				// keeps its identity, gains a rail line, and streams again. Its origin
				// is the assignment's, not the retry request's.
				existing.runId = runId;
				existing.runtime = runtime;
				existing.pending = true;
				existing.startedAtMs = now();
				delete existing.receipt;
				existing.attempts.push({ runId, targetLabel: workerTargetLabel(runtime) });
				assignmentByRun.set(runId, assignmentId);
				return { kind: "updated", entry: existing };
			}
			if (payload.requestOrigin !== "user" && payload.requestOrigin !== "agent") return null;
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
				startedAtMs: now(),
				...(payload.parentToolCallId !== undefined ? { parentToolCallId: payload.parentToolCallId } : {}),
			};
			byAssignment.set(assignmentId, entry);
			assignmentByRun.set(runId, assignmentId);
			prune();
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
			entry.pending = false;
			entry.receipt = {
				outcome: "canceled",
				tokens: 0,
				elapsedMs: finiteNumber(payload.elapsedMs) ?? Math.max(0, now() - entry.startedAtMs),
				...(nonEmptyString(payload.reason) !== undefined ? { failureMessage: payload.reason } : {}),
				provisional: true,
			};
			const attempt = entry.attempts[entry.attempts.length - 1];
			if (attempt !== undefined) attempt.outcome = "canceled";
			return { kind: "updated", entry };
		},

		get(assignmentId): WorkerEntryState | undefined {
			return byAssignment.get(assignmentId);
		},

		entries(): ReadonlyArray<WorkerEntryState> {
			return [...byAssignment.values()];
		},
	};
}
