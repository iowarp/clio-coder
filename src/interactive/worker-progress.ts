/**
 * The one projection of a worker's live progress.
 *
 * A dispatched run publishes its events on a single stream, and two surfaces
 * read them: the transcript block a `/run` or `/delegate` opens, and the Fleet
 * Runs board. Both used to interpret that stream themselves, so the same event
 * could mean two things and the board could only manage a richer spinner while
 * the transcript already held the answer. This module is the fold both now go
 * through, so what an operator reads about a worker is one story told twice
 * rather than two stories.
 *
 * Three rules it enforces rather than documents:
 *
 *   - Arguments never arrive here. A tool's name comes from the `clio_*`
 *     telemetry events, and what the call is doing comes from the bounded
 *     {@link CallActionDescriptor} composed at the tool-admission seam. The
 *     `tool_execution_*` events, whose `args` carry the literal call arguments,
 *     are not read at all.
 *   - Reasoning content is never retained. A `thinking_delta` moves the phase
 *     and nothing else: the operator learns that the worker is thinking, never
 *     what it is thinking.
 *   - Everything is bounded before it is kept. Lines, bytes, the action trail,
 *     the distinct tool names, and the rate at which delta bytes are accepted
 *     all have explicit caps, so neither a long run nor a hostile one can grow
 *     what a render has to walk.
 *
 * Pure: no I/O, no bus, no clock of its own. `observe` takes the instant it
 * should measure the rate window against, so every sequence below is testable.
 */

import { durableAssistantTextFromEvent, WORKER_OUTPUT_MAX_BYTES } from "../domains/dispatch/event-pump.js";
import type { CallActionDescriptor } from "../domains/safety/call-target.js";
import { truncateUtf8 } from "../tools/truncate-utf8.js";

/**
 * Lines of worker prose kept while a run is live. The tail is what a streaming
 * answer is about, so the head is what gets dropped; once the run settles the
 * body is replaced by the receipt-sealed answer and anchors at the head, which
 * is the same rule the thinking block already follows.
 */
export const WORKER_LIVE_TAIL_LINES = 40;

/**
 * Bytes of live tail retained. The line bound alone leaves a worker that emits
 * one enormous line unbounded, so the byte bound is the backstop: whole lines
 * leave the head until the tail fits, and a single line larger than the bound
 * is cut at its head.
 */
export const WORKER_LIVE_TAIL_MAX_BYTES = 4096;

/** Distinct tool names carried on an entry. The receipt's call count carries the total. */
export const WORKER_TOOL_NAME_LIMIT = 8;

/** Finished actions kept as the recent trail, newest first. */
export const WORKER_ACTION_TRAIL_LIMIT = 4;

/**
 * The rate window for accepted delta bytes. A worker streaming faster than an
 * operator can read is not producing more information, only more work for the
 * fold, so bytes past the budget in one window are counted and dropped rather
 * than concatenated into a tail that would immediately discard them anyway.
 */
export const WORKER_PROGRESS_WINDOW_MS = 250;

/** Delta bytes accepted per {@link WORKER_PROGRESS_WINDOW_MS}. */
export const WORKER_PROGRESS_WINDOW_BYTES = 16_384;

const TAIL_TRUNCATION_MARKER = "";

/**
 * Where a worker is in its turn. Derived from the event stream and never from
 * reasoning content: `thinking` says only that a reasoning block is open.
 */
export type WorkerProgressPhase = "starting" | "thinking" | "writing" | "tool" | "waiting" | "settled";

/** One tool call as an operator surface may show it: the name plus its redacted descriptor. */
export interface WorkerAction {
	tool: string;
	/** Absent when the runtime emitted no descriptor, so the name stands alone. */
	descriptor?: CallActionDescriptor;
}

/**
 * Everything both surfaces read about a live worker, bounded. Snapshots are
 * immutable and `revision` changes only when a visible field does, so a
 * renderer can skip a repaint by identity rather than by diffing text.
 */
export interface WorkerProgressSnapshot {
	revision: number;
	phase: WorkerProgressPhase;
	/** Bounded worker prose: the live tail while running, the sealed answer once settled. */
	tailText: string;
	/** Lines the bounds dropped from `tailText`. */
	droppedLines: number;
	/** Bytes refused by the rate window or cut from an oversized line. */
	droppedBytes: number;
	/** The call executing now; null between calls and once settled. */
	currentAction: WorkerAction | null;
	/** Finished calls, newest first, bounded by {@link WORKER_ACTION_TRAIL_LIMIT}. */
	recentActions: ReadonlyArray<WorkerAction>;
	/** Distinct tool names in first-use order, bounded by {@link WORKER_TOOL_NAME_LIMIT}. */
	toolNames: ReadonlyArray<string>;
	settled: boolean;
}

export interface WorkerProgressFold {
	/**
	 * Fold one dispatch progress event. Returns true when the snapshot changed,
	 * so a caller can decide whether the surface needs anything at all.
	 */
	observe(event: unknown, nowMs?: number): boolean;
	/**
	 * Seal the projection. `text` is the receipt's answer where one could be
	 * read; without it the live tail stands as the run's last honest word.
	 */
	settle(text?: string): boolean;
	/**
	 * A later attempt of the same work takes over. The tail and the trail are
	 * history the operator is already reading and stay; the current call and the
	 * settled mark belong to the attempt that ended and go.
	 */
	restart(): void;
	snapshot(): WorkerProgressSnapshot;
	/** The last durable assistant answer this run streamed, unbounded by the tail. */
	durableText(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Incremental assistant prose carried by one worker event.
 *
 * Native workers slim `message_update` down to `assistantMessageEvent.delta`
 * before it crosses the NDJSON seam (src/worker/event-projection.ts); the ACP
 * mapper emits a top-level `text_delta` carrying `text`. Both spellings are
 * read here so ACP peers need no separate UI path.
 */
export function workerTextDelta(event: unknown): string {
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

/** Whether this event opens or continues a reasoning block. Its content is never read. */
function isThinkingEvent(event: Record<string, unknown>): boolean {
	if (event.type === "thinking_delta") return true;
	if (event.type !== "message_update") return false;
	const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
	return assistantEvent?.type === "thinking_delta";
}

/** The action a `clio_tool_start`/`clio_tool_finish` event names, or null when it is neither. */
function toolEventAction(event: Record<string, unknown>): WorkerAction | null {
	if (event.type !== "clio_tool_start" && event.type !== "clio_tool_finish") return null;
	const payload = isRecord(event.payload) ? event.payload : null;
	const tool = nonEmptyString(payload?.tool);
	if (tool === undefined) return null;
	const raw = isRecord(payload?.action) ? (payload.action as Partial<CallActionDescriptor>) : undefined;
	const verb = nonEmptyString(raw?.verb);
	if (verb === undefined) return { tool };
	const object = nonEmptyString(raw?.object);
	return {
		tool,
		descriptor: {
			verb,
			...(object !== undefined ? { object } : {}),
			...(raw?.truncated === true ? { truncated: true } : {}),
		},
	};
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") lines += 1;
	}
	return lines;
}

/** Keep the newest bytes of one oversized line, cutting on a UTF-8 boundary. */
function keepTailBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	let cut = buffer.byteLength - maxBytes;
	while (cut < buffer.byteLength) {
		const byte = buffer[cut];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		cut += 1;
	}
	return buffer.subarray(cut).toString("utf8");
}

/**
 * Bound the live tail: newest lines first, then whole lines from the head until
 * the byte cap is met, and finally a head cut on a single line larger than the
 * cap on its own.
 */
function boundLiveTail(text: string): { text: string; droppedLines: number; droppedBytes: number } {
	const lines = text.split("\n");
	let droppedLines = 0;
	if (lines.length > WORKER_LIVE_TAIL_LINES) {
		droppedLines = lines.length - WORKER_LIVE_TAIL_LINES;
		lines.splice(0, droppedLines);
	}
	while (lines.length > 1 && Buffer.byteLength(lines.join("\n"), "utf8") > WORKER_LIVE_TAIL_MAX_BYTES) {
		lines.shift();
		droppedLines += 1;
	}
	const joined = lines.join("\n");
	const bytes = Buffer.byteLength(joined, "utf8");
	if (bytes <= WORKER_LIVE_TAIL_MAX_BYTES) return { text: joined, droppedLines, droppedBytes: 0 };
	const kept = keepTailBytes(joined, WORKER_LIVE_TAIL_MAX_BYTES);
	return { text: kept, droppedLines, droppedBytes: bytes - Buffer.byteLength(kept, "utf8") };
}

/** Head-anchored byte bound for a settled answer, matching the receipt's own bound. */
export function boundSettledText(text: string): { text: string; dropped: number } {
	const bounded = truncateUtf8(text, WORKER_OUTPUT_MAX_BYTES, TAIL_TRUNCATION_MARKER);
	if (bounded === text) return { text, dropped: 0 };
	return { text: bounded, dropped: Math.max(0, lineCount(text) - lineCount(bounded)) };
}

const EMPTY_SNAPSHOT: WorkerProgressSnapshot = {
	revision: 0,
	phase: "starting",
	tailText: "",
	droppedLines: 0,
	droppedBytes: 0,
	currentAction: null,
	recentActions: [],
	toolNames: [],
	settled: false,
};

export function createWorkerProgressFold(): WorkerProgressFold {
	let revision = 0;
	let phase: WorkerProgressPhase = "starting";
	let tailText = "";
	let droppedLines = 0;
	let droppedBytes = 0;
	let currentAction: WorkerAction | null = null;
	const recentActions: WorkerAction[] = [];
	const toolNames: string[] = [];
	let settled = false;
	let durable = "";
	/** Start descriptors awaiting their finish, keyed by tool name. */
	const pendingActions = new Map<string, WorkerAction>();
	let windowStartMs = 0;
	let windowBytes = 0;
	let cached: WorkerProgressSnapshot | null = EMPTY_SNAPSHOT;

	const touch = (): true => {
		revision += 1;
		cached = null;
		return true;
	};

	const setPhase = (next: WorkerProgressPhase): boolean => {
		if (phase === next) return false;
		phase = next;
		return touch();
	};

	/**
	 * Admit delta bytes against the rate window. Returns the text to append,
	 * which is empty once the window's budget is spent; the refused bytes are
	 * counted so the surface can say the stream outran it rather than quietly
	 * showing less.
	 */
	const admitDelta = (delta: string, nowMs: number): string => {
		if (nowMs - windowStartMs >= WORKER_PROGRESS_WINDOW_MS) {
			windowStartMs = nowMs;
			windowBytes = 0;
		}
		const bytes = Buffer.byteLength(delta, "utf8");
		if (windowBytes + bytes <= WORKER_PROGRESS_WINDOW_BYTES) {
			windowBytes += bytes;
			return delta;
		}
		windowBytes = WORKER_PROGRESS_WINDOW_BYTES;
		droppedBytes += bytes;
		return "";
	};

	const appendTail = (text: string): boolean => {
		if (text.length === 0) return false;
		const bounded = boundLiveTail(tailText + text);
		tailText = bounded.text;
		droppedLines += bounded.droppedLines;
		droppedBytes += bounded.droppedBytes;
		return touch();
	};

	const noteToolName = (tool: string): boolean => {
		if (toolNames.includes(tool) || toolNames.length >= WORKER_TOOL_NAME_LIMIT) return false;
		toolNames.push(tool);
		return touch();
	};

	return {
		observe(event: unknown, nowMs = Date.now()): boolean {
			if (!isRecord(event) || settled) return false;
			let changed = false;

			const delta = workerTextDelta(event);
			if (delta.length > 0) {
				changed = appendTail(admitDelta(delta, nowMs)) || changed;
				changed = setPhase("writing") || changed;
			} else if (isThinkingEvent(event)) {
				// The phase moves and nothing else: reasoning content is never kept.
				changed = setPhase("thinking") || changed;
			}

			// A durable message_end is the answer as the receipt will seal it. An
			// ACP peer that streamed no deltas reaches a surface only here.
			const durableText = durableAssistantTextFromEvent(event);
			if (durableText.trim().length > 0) {
				durable = durableText;
				if (delta.length === 0 && tailText.trim().length === 0) {
					changed = appendTail(durableText) || changed;
				}
			}

			const action = toolEventAction(event);
			if (action !== null && event.type === "clio_tool_start") {
				pendingActions.set(action.tool, action);
				currentAction = action;
				noteToolName(action.tool);
				touch();
				setPhase("tool");
				changed = true;
			} else if (action !== null && event.type === "clio_tool_finish") {
				const finished = pendingActions.get(action.tool) ?? action;
				pendingActions.delete(action.tool);
				currentAction = null;
				recentActions.unshift(finished);
				if (recentActions.length > WORKER_ACTION_TRAIL_LIMIT) recentActions.length = WORKER_ACTION_TRAIL_LIMIT;
				noteToolName(action.tool);
				touch();
				setPhase("waiting");
				changed = true;
			}

			if (event.type === "agent_start") changed = setPhase("starting") || changed;
			return changed;
		},

		settle(text?: string): boolean {
			const sealed = nonEmptyString(text) ?? nonEmptyString(durable);
			if (sealed !== undefined) {
				const bounded = boundSettledText(sealed);
				tailText = bounded.text;
				droppedLines = bounded.dropped;
			}
			currentAction = null;
			pendingActions.clear();
			settled = true;
			phase = "settled";
			touch();
			return true;
		},

		restart(): void {
			currentAction = null;
			pendingActions.clear();
			settled = false;
			phase = "starting";
			touch();
		},

		snapshot(): WorkerProgressSnapshot {
			if (cached !== null) return cached;
			cached = {
				revision,
				phase,
				tailText,
				droppedLines,
				droppedBytes,
				currentAction: currentAction === null ? null : { ...currentAction },
				recentActions: recentActions.map((entry) => ({ ...entry })),
				toolNames: [...toolNames],
				settled,
			};
			return cached;
		},

		durableText(): string {
			return durable;
		},
	};
}
