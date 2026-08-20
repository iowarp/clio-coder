/**
 * Coalescing wrapper around chat events (slice 12.5d).
 *
 * Streaming responses fire text, thinking, and cumulative tool-result updates
 * at very high frequency. The TUI's per-event `requestRender()` call rebuilt the
 * entire transcript on every delta, which scaled linearly with response
 * length and made long answers visibly lag. This wrapper applies events to
 * the panel synchronously (so internal state stays consistent) but defers
 * `requestRender()` for delta events to a single coalesced timer (~16ms =
 * one frame at 60fps). Non-delta events render synchronously so finalizers
 * like `message_end` are never deferred. The one exception is the raw
 * text/thinking wrapper, which is dropped before the panel entirely; see
 * `isTransparentAssistantWrapper`.
 */

import type {
	BashExecutionEntry,
	BranchSummaryEntry,
	CompactionSummaryEntry,
	CustomEntry,
	FileEntryEntry,
	MessageEntry,
	ModelChangeEntry,
	ProtectedArtifactEntry,
	SessionEntry,
	SessionInfoEntry,
	ThinkingLevelChangeEntry,
	WorkerRunEntry,
} from "../domains/session/entries.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import {
	type BashExecutionMessage,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
} from "../engine/messages.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import { isSelfExplainingAbort } from "./chat-loop-messages.js";
import type { ChatPanel } from "./chat-panel.js";
import { renderBranchSummaryEntry } from "./renderers/branch-summary.js";
import { renderCompactionSummaryEntry } from "./renderers/compaction-summary.js";
import { styleTaggedNotice } from "./renderers/notice.js";
import { formatRetryStatus } from "./renderers/retry-status.js";
import { renderBashTranscriptExecution, renderToolResultOnly } from "./renderers/tool-execution.js";
import {
	classifyStreamEvent,
	createStreamPacer,
	type SmoothStreamingMode,
	type StreamPacer,
	type StreamPacerSlice,
} from "./stream-pacer.js";
import { readWorkerReceiptFactsForReplay } from "./worker-receipts.js";
import { workerEntriesFromRunEntries } from "./worker-replay.js";
import type { WorkerReceiptReader } from "./worker-stream.js";

const DEFAULT_COALESCE_MS = 16;
const MAX_REPLAY_TEXT_CHARS = 20_000;

/**
 * Event kinds whose render is deferred into a coalesce window. All other
 * `ChatLoopEvent` kinds render synchronously and cancel any pending timer.
 */
const DELTA_TYPES: ReadonlySet<ChatLoopEvent["type"]> = new Set([
	"text_delta",
	"thinking_delta",
	"tool_execution_update",
]);

/**
 * A raw `message_update` wrapper whose inner event is a text or thinking
 * delta is transparent to the transcript: the panel ignores it, and the
 * derived `text_delta`/`thinking_delta` emitted in the same stack (see
 * turn-runtime's public-event fan-out) is the canonical display input. Yet
 * this renderer classified the wrapper as non-delta, so every provider chunk
 * cancelled the pending coalesce window and requested an immediate render.
 * The coalescer was defeated exactly while streaming, which is the one time
 * it matters. Wrappers carrying tool-call formation stay on the synchronous
 * path, because the panel consumes those directly.
 */
function isTransparentAssistantWrapper(event: ChatLoopEvent): boolean {
	if (event.type !== "message_update") return false;
	const inner = (event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent;
	return inner?.type === "text_delta" || inner?.type === "thinking_delta";
}

export interface CreateCoalescingChatRendererDeps {
	chatPanel: ChatPanel;
	requestRender: () => void;
	/** Coalesce window in ms. Defaults to 16 (one frame at 60fps). */
	coalesceMs?: number;
	/** Override for tests. Mirrors the setTimeout signature. */
	setTimer?: (cb: () => void, ms: number) => unknown;
	/** Override for tests. Mirrors the clearTimeout signature. */
	clearTimer?: (id: unknown) => void;
	/** Monotonic clock shared with the pacer; injectable for deterministic tests. */
	now?: () => number;
	/** Sequence captured at canonical projection ingress before this panel consumer runs. */
	visibleEventSequence?: (event: ChatLoopEvent) => number | null;
	onQueue?: (eventSeq: number, action: "admit" | "dequeue") => void;
	onPanelApplied?: (eventSeq: number) => void;
	/** Legacy aggregate callback retained for non-text cumulative tool-update observations. */
	onDelta?: () => void;
	/** Canonical presentation-ingress identity; absent keeps the exact legacy coalescer. */
	streamIngress?: (event: ChatLoopEvent) => { sequence: number; generation: string | number; ingressAt: number } | null;
	getSmoothStreamingMode?: () => SmoothStreamingMode;
	isAutoPacingAllowed?: () => boolean;
	/** Force and await one actual frame plus any stdout drain. */
	commitFrame?: (reason?: string) => Promise<unknown>;
}

export interface CoalescingChatRenderer {
	applyEvent(event: ChatLoopEvent): void;
	/** Cancel the pending coalesce timer (if any) and request one synchronous render. */
	flush(): void;
	/** Ordered barrier for replay, worker, command-output, and other panel mutations. */
	mutate(mutation: () => void, reason?: string): void;
	/** Drop queued presentation content before replacing/resetting the transcript. */
	reset(mutation: () => void): void;
	/** Drain paced content and await the first committed frame containing it. */
	flushAndCommit(reason?: string): Promise<void>;
	/** Apply a live mode change as an immediate ordered drain boundary. */
	setSmoothStreamingMode(mode: SmoothStreamingMode): void;
	dispose(): void;
}

export function createCoalescingChatRenderer(deps: CreateCoalescingChatRendererDeps): CoalescingChatRenderer {
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer =
		deps.clearTimer ??
		((id) => {
			clearTimeout(id as ReturnType<typeof setTimeout>);
		});
	const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;

	let pendingTimer: unknown = null;
	let mutationDepth = 0;
	let transactionNeedsRender = false;
	let disposed = false;
	let pacer: StreamPacer | null = null;

	const fireCoalesced = (): void => {
		if (disposed) return;
		pendingTimer = null;
		deps.requestRender();
	};

	const cancelPending = (): boolean => {
		if (pendingTimer === null) return false;
		clearTimer(pendingTimer);
		pendingTimer = null;
		return true;
	};

	const requestTransactionalRender = (coalesce: boolean): void => {
		if (mutationDepth > 0) {
			transactionNeedsRender = true;
			return;
		}
		if (!coalesce) {
			cancelPending();
			deps.requestRender();
			return;
		}
		deps.onDelta?.();
		if (pendingTimer === null) pendingTimer = setTimer(fireCoalesced, coalesceMs);
	};
	const transaction = (operation: () => void, coalesce = false): void => {
		mutationDepth += 1;
		try {
			operation();
		} finally {
			mutationDepth -= 1;
			if (mutationDepth === 0 && transactionNeedsRender) {
				transactionNeedsRender = false;
				requestTransactionalRender(coalesce);
			}
		}
	};
	const applySlice = (slice: StreamPacerSlice): void => {
		const event =
			slice.kind === "text"
				? ({ type: "text_delta", contentIndex: slice.contentIndex, delta: slice.text, partialText: "" } as const)
				: ({ type: "thinking_delta", contentIndex: slice.contentIndex, delta: slice.text, partialThinking: "" } as const);
		deps.chatPanel.applyEvent(event);
		if (slice.finalForItem) {
			deps.onPanelApplied?.(slice.sequence);
			deps.onQueue?.(slice.sequence, "dequeue");
		}
		requestTransactionalRender(true);
	};
	if (deps.streamIngress && deps.getSmoothStreamingMode) {
		pacer = createStreamPacer({
			mode: deps.getSmoothStreamingMode(),
			onSlice: applySlice,
			onDiscard: (sequence) => deps.onQueue?.(sequence, "dequeue"),
			...(deps.now ? { now: deps.now } : {}),
			...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
			...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
			...(deps.isAutoPacingAllowed ? { isAutoPacingAllowed: deps.isAutoPacingAllowed } : {}),
		});
	}
	const syncPacerMode = (): SmoothStreamingMode => {
		const mode = deps.getSmoothStreamingMode?.() ?? "off";
		if (pacer && pacer.mode !== mode) transaction(() => pacer?.setMode(mode));
		return mode;
	};
	const drainPacer = (reason: string): void => {
		if (pacer?.snapshot().queuedItems) pacer.flush(reason);
	};
	const applyLegacy = (event: ChatLoopEvent): void => {
		const visibleEventSeq = deps.visibleEventSequence?.(event) ?? null;
		if (visibleEventSeq !== null) deps.onQueue?.(visibleEventSeq, "admit");
		deps.chatPanel.applyEvent(event);
		if (visibleEventSeq !== null) {
			deps.onPanelApplied?.(visibleEventSeq);
			deps.onQueue?.(visibleEventSeq, "dequeue");
		}
		if (DELTA_TYPES.has(event.type)) {
			requestTransactionalRender(true);
			return;
		}
		requestTransactionalRender(false);
	};

	const renderer: CoalescingChatRenderer = {
		applyEvent(event) {
			if (disposed) return;
			if (isTransparentAssistantWrapper(event)) return;
			const mode = syncPacerMode();
			const ingress = deps.streamIngress?.(event) ?? null;
			if (!pacer || mode === "off") {
				applyLegacy(event);
				return;
			}
			const classification = classifyStreamEvent(event);
			if (classification === "paced-display-content") {
				if (ingress === null) {
					applyLegacy(event);
					return;
				}
				const delta = event as Extract<ChatLoopEvent, { type: "text_delta" | "thinking_delta" }>;
				if (delta.delta.length === 0) {
					applyLegacy(event);
					return;
				}
				deps.onQueue?.(ingress.sequence, "admit");
				transaction(() => {
					pacer?.enqueue({
						sequence: ingress.sequence,
						generation: ingress.generation,
						kind: delta.type === "text_delta" ? "text" : "thinking",
						contentIndex: delta.contentIndex,
						text: delta.delta,
						ingressAt: ingress.ingressAt,
						folded: delta.type === "thinking_delta" && !deps.chatPanel.isThinkingExpanded(),
					});
				}, true);
				return;
			}
			if (classification === "cumulative-live-state") {
				transaction(() => {
					drainPacer("cumulative-live-state");
					applyLegacy(event);
				}, true);
				return;
			}
			transaction(() => {
				drainPacer(`boundary:${event.type}`);
				applyLegacy(event);
			});
		},
		flush() {
			if (disposed) return;
			transaction(() => drainPacer("explicit-flush"));
			const wasPending = cancelPending();
			if (wasPending) deps.requestRender();
		},
		mutate(mutation, reason = "panel-mutation") {
			if (disposed) return;
			transaction(() => {
				drainPacer(reason);
				mutation();
				requestTransactionalRender(false);
			});
		},
		reset(mutation) {
			if (disposed) return;
			transaction(() => {
				pacer?.invalidateEpoch();
				mutation();
				requestTransactionalRender(false);
			});
		},
		async flushAndCommit(reason = "final-frame") {
			if (disposed) return;
			transaction(() => drainPacer(reason));
			cancelPending();
			if (deps.commitFrame) await deps.commitFrame(reason);
			else deps.requestRender();
		},
		setSmoothStreamingMode(mode) {
			if (disposed || !pacer || pacer.mode === mode) return;
			transaction(() => pacer?.setMode(mode));
		},
		dispose() {
			if (disposed) return;
			transaction(() => pacer?.dispose("renderer-dispose"));
			cancelPending();
			disposed = true;
		},
	};
	return renderer;
}

/**
 * Options for the rehydrate helper used by /resume and /fork.
 */
export interface RehydrateChatPanelOptions {
	/**
	 * Select the active branch ancestry without truncating later sidecars.
	 * Live compaction replay uses this so a summary appended after the current
	 * message leaf remains visible. Unset offline readers retain their
	 * file-order fallback.
	 */
	activeLeafTurnId?: string;
	/**
	 * Pin the active-branch leaf and stop replay after that turn (inclusive).
	 * /tree switches and /fork pass the selected turn id so replay follows
	 * that turn's ancestry. Unset (default) treats the most recently appended
	 * message turn as the leaf.
	 */
	uptoTurnId?: string;
	/**
	 * Render orphan tool results (results with no matching prior call) in full,
	 * without the live view's middle-elision. `/export` sets this so its
	 * throwaway panel writes complete tool bodies; the paired-result path reads
	 * the same intent from the panel's `unboundedToolBodies` option.
	 */
	unboundedToolBodies?: boolean;
	/**
	 * Sealed-receipt reader for the worker blocks a `workerRun` entry names.
	 * Defaults to `<state>/receipts/<runId>.json`; tests inject their own. This
	 * is the one place replay reads outside the entry stream, and it swallows
	 * every failure, so a session whose receipts are gone still replays.
	 */
	readWorkerReceipt?: WorkerReceiptReader;
}

function extractTurnText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Record<string, unknown>;
	if (typeof p.text === "string") return p.text;
	if (Array.isArray(p.content)) {
		for (const block of p.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") return b.text;
		}
	}
	return "";
}

function stringifyPreview(value: unknown, limit = 600): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
	try {
		const text = JSON.stringify(value);
		if (!text) return "";
		return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
	} catch {
		const text = String(value);
		return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
	}
}

function truncateReplayText(text: string, limit = MAX_REPLAY_TEXT_CHARS): string {
	if (text.length <= limit) return text;
	const omitted = text.length - limit;
	return `${text.slice(0, limit)}\n\n[... ${omitted} more characters truncated from replay context]`;
}

function timestampMillis(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function makeTextMessage(role: "user" | "assistant", text: string, timestamp: string): AgentMessage {
	const message: Record<string, unknown> = {
		role,
		content: [{ type: "text", text }],
		timestamp: timestampMillis(timestamp),
	};
	if (role === "assistant") message.stopReason = "stop";
	return message as unknown as AgentMessage;
}

function cloneContentBlocks(content: unknown, maxTextChars?: number): unknown[] | null {
	if (!Array.isArray(content)) return null;
	return content
		.filter((block) => !!block && typeof block === "object")
		.map((block) => {
			const cloned: Record<string, unknown> = { ...(block as Record<string, unknown>) };
			if (typeof maxTextChars === "number") {
				if (typeof cloned.text === "string") cloned.text = truncateReplayText(cloned.text, maxTextChars);
				if (typeof cloned.thinking === "string") cloned.thinking = truncateReplayText(cloned.thinking, maxTextChars);
			}
			return cloned;
		});
}

function richMessageFromEntry(entry: MessageEntry, maxTextChars?: number): AgentMessage | null {
	if (entry.role !== "user" && entry.role !== "assistant") return null;
	const obj = payloadObject(entry.payload);
	const content = cloneContentBlocks(obj?.content, maxTextChars);
	const text = truncateReplayText(extractTurnText(entry.payload), maxTextChars);
	const stopReason = typeof obj?.stopReason === "string" ? obj.stopReason : undefined;
	if (!content && text.length === 0 && !messageFailure(entry) && stopReason !== "length") return null;
	const message: Record<string, unknown> = {
		role: entry.role,
		content: content ?? [{ type: "text", text }],
		timestamp: timestampMillis(entry.timestamp),
	};
	if (entry.role === "assistant") {
		const failure = messageFailure(entry);
		message.stopReason = failure?.stopReason ?? stopReason ?? "stop";
		if (failure) message.errorMessage = failure.errorMessage;
		for (const key of [
			"usage",
			"api",
			"provider",
			"model",
			"responseModel",
			"responseId",
			"diagnostics",
			"contextUsageInvalidated",
		]) {
			if (obj?.[key] !== undefined) message[key] = obj[key];
		}
	}
	return message as unknown as AgentMessage;
}

function recordToolCallsFromMessage(message: AgentMessage, seen: Set<string>): void {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type !== "toolCall") continue;
		if (typeof b.id === "string" && b.id.length > 0) seen.add(b.id);
	}
}

function toolCallMessageFromEntry(entry: MessageEntry): AgentMessage {
	const call = extractToolCall(entry);
	const block: Record<string, unknown> = { type: "toolCall", id: call.id, name: call.name };
	if (call.args !== undefined) block.arguments = call.args;
	return {
		role: "assistant",
		content: [block],
		stopReason: "toolUse",
		timestamp: timestampMillis(entry.timestamp),
	} as unknown as AgentMessage;
}

function toolResultContent(result: unknown): unknown[] {
	const obj = payloadObject(result);
	if (Array.isArray(obj?.content)) {
		return cloneContentBlocks(obj.content, MAX_REPLAY_TEXT_CHARS) ?? [];
	}
	if (isTextResult(result)) return [{ type: "text", text: truncateReplayText(result.text) }];
	if (typeof result === "string") return [{ type: "text", text: truncateReplayText(result) }];
	return [{ type: "text", text: stringifyPreview(result, 10_000) }];
}

function displayReplayToolResult(result: unknown): unknown {
	const content = toolResultContent(result);
	// Preserve the details record (observation envelope, exec records) so the
	// replayed ledger line carries the same outcome facts as the live one.
	const details = payloadObject(result)?.details;
	return details !== null && details !== undefined && typeof details === "object" ? { content, details } : content;
}

function textFromContentBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("");
}

function toolResultText(result: unknown): string {
	const obj = payloadObject(result);
	const contentText = textFromContentBlocks(obj?.content);
	if (contentText.length > 0) return contentText;
	if (isTextResult(result)) return result.text;
	if (typeof result === "string") return result;
	return stringifyPreview(result, 10_000);
}

function comparableReplayText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function messagePayloadComparableText(payload: unknown): string {
	const text = extractTurnText(payload);
	if (text.length > 0) return text;
	return textFromContentBlocks(payloadObject(payload)?.content);
}

function isLegacyToolResultAssistantDuplicate(toolResult: MessageEntry, assistant: MessageEntry): boolean {
	const priorText = comparableReplayText(toolResultText(extractToolResult(toolResult).result));
	if (priorText.length === 0) return false;
	const assistantText = comparableReplayText(messagePayloadComparableText(assistant.payload));
	return assistantText.length > 0 && assistantText === priorText;
}

function isTextResult(value: unknown): value is { text: string } {
	return payloadObject(value)?.text !== undefined && typeof (value as { text?: unknown }).text === "string";
}

function toolResultMessageFromEntry(entry: MessageEntry): AgentMessage {
	const result = extractToolResult(entry);
	return {
		role: "toolResult",
		content: toolResultContent(result.result),
		toolCallId: result.id ?? entry.turnId,
		toolName: result.name,
		isError: result.isError,
		timestamp: timestampMillis(entry.timestamp),
	} as AgentMessage;
}

function textBlockFromEntry(entry: MessageEntry): string {
	const text = extractTurnText(entry.payload);
	if (text.length > 0) return text;
	return stringifyPreview(entry.payload);
}

function chatMessageText(entry: MessageEntry): string {
	return extractTurnText(entry.payload);
}

const LEADING_SYSTEM_REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/u;

/**
 * What the operator typed for a replayed user turn. The persisted text is the
 * composed prompt (a system-reminder block and any skill preamble ride ahead of
 * the operator's words, as visible text the model receives), and the live
 * transcript only ever showed the typed part. Entries written since the
 * operator text was persisted carry it directly; older entries drop the
 * leading reminder scaffolding so a /fork or /resume redraw does not attribute
 * it to the operator (#81).
 */
function replayedUserText(entry: MessageEntry): string {
	const obj = payloadObject(entry.payload);
	if (typeof obj?.operatorText === "string") return obj.operatorText;
	let text = extractTurnText(entry.payload);
	for (;;) {
		const stripped = text.replace(LEADING_SYSTEM_REMINDER, "");
		if (stripped === text) return text;
		text = stripped;
	}
}

function messageFailure(entry: MessageEntry): { stopReason: "error" | "aborted"; errorMessage: string } | null {
	const obj = payloadObject(entry.payload);
	if (!obj) return null;
	const stopReason = obj?.stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const raw = obj.errorMessage;
	if (isSelfExplainingAbort({ stopReason, errorMessage: raw, text: extractTurnText(entry.payload) })) return null;
	const errorMessage =
		typeof raw === "string" && raw.length > 0
			? raw
			: stopReason === "aborted"
				? "request aborted"
				: "model target returned an error";
	return { stopReason, errorMessage };
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function firstContentBlock(payload: unknown, type: string): Record<string, unknown> | null {
	const obj = payloadObject(payload);
	const content = obj?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === type) return b;
	}
	return null;
}

interface ReplayToolCall {
	id: string;
	name: string;
	args: unknown;
}

function extractToolCall(entry: MessageEntry): ReplayToolCall {
	const payload = entry.payload;
	const obj = payloadObject(payload);
	const block = firstContentBlock(payload, "toolCall");
	const fn = payloadObject(obj?.function);
	const id =
		(typeof obj?.id === "string" && obj.id) ||
		(typeof obj?.toolCallId === "string" && obj.toolCallId) ||
		(typeof obj?.tool_call_id === "string" && obj.tool_call_id) ||
		(typeof block?.id === "string" && block.id) ||
		entry.turnId;
	const name =
		(typeof obj?.name === "string" && obj.name) ||
		(typeof obj?.toolName === "string" && obj.toolName) ||
		(typeof obj?.tool === "string" && obj.tool) ||
		(typeof fn?.name === "string" && fn.name) ||
		(typeof block?.name === "string" && block.name) ||
		"tool";
	const args =
		obj?.arguments ??
		obj?.args ??
		obj?.input ??
		parseMaybeJson(fn?.arguments) ??
		block?.arguments ??
		block?.args ??
		undefined;
	return { id, name, args };
}

interface ReplayToolResult {
	id: string | null;
	name: string;
	result: unknown;
	isError: boolean;
	durationMs?: number;
	resultSummary?: Record<string, unknown>;
	/** Persisted admission verdict; absent on history written before it was recorded. */
	outcome?: string;
	blockReason?: string;
}

function extractToolResult(entry: MessageEntry): ReplayToolResult {
	const payload = entry.payload;
	const obj = payloadObject(payload);
	const contentText = extractTurnText(payload);
	const id =
		(typeof obj?.toolCallId === "string" && obj.toolCallId) ||
		(typeof obj?.tool_call_id === "string" && obj.tool_call_id) ||
		(typeof obj?.id === "string" && obj.id) ||
		null;
	const name =
		(typeof obj?.toolName === "string" && obj.toolName) ||
		(typeof obj?.name === "string" && obj.name) ||
		(typeof obj?.tool === "string" && obj.tool) ||
		"tool";
	const result =
		obj?.result ?? obj?.output ?? obj?.out ?? obj?.content ?? (contentText.length > 0 ? contentText : payload);
	const durationMs = typeof obj?.durationMs === "number" && Number.isFinite(obj.durationMs) ? obj.durationMs : undefined;
	const resultSummary = payloadObject(obj?.resultSummary) ?? undefined;
	const outcome = typeof obj?.outcome === "string" && obj.outcome.length > 0 ? obj.outcome : undefined;
	const blockReason = typeof obj?.blockReason === "string" && obj.blockReason.length > 0 ? obj.blockReason : undefined;
	return {
		id,
		name,
		result,
		isError: obj?.isError === true || obj?.error === true,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(resultSummary !== undefined ? { resultSummary } : {}),
		...(outcome !== undefined ? { outcome } : {}),
		...(blockReason !== undefined ? { blockReason } : {}),
	};
}

function renderReplayLine(text: string, width: number): string[] {
	// Style a leading bracketed tag (`[skill]`, `[checkpoint]`, ...) dim with a
	// muted body; free-form lines such as `system:` prefixes pass through
	// unchanged so only bracketed notices pick up the treatment.
	return wrapTextWithAnsi(styleTaggedNotice(text), width);
}

function appendReplayLine(chatPanel: ChatPanel, text: string): void {
	chatPanel.appendReplayBlock((width) => renderReplayLine(truncateReplayText(text), width));
}

function renderBashExecutionEntry(entry: BashExecutionEntry, width: number): string[] {
	return renderBashTranscriptExecution(
		{
			command: entry.command,
			output: truncateReplayText(entry.output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/g, "")),
			running: false,
			exitCode: entry.exitCode,
			cancelled: entry.cancelled,
			truncated: entry.truncated,
			fullOutputPath: entry.fullOutputPath,
			excludeFromContext: entry.excludeFromContext,
		},
		width,
	);
}

function renderRetryStatusEntry(entry: CustomEntry, width: number): string[] {
	const data = payloadObject(entry.data);
	if (!data) return wrapTextWithAnsi(styleTaggedNotice("[retry] status"), width);
	const rawPhase = data.phase;
	if (
		rawPhase !== "scheduled" &&
		rawPhase !== "waiting" &&
		rawPhase !== "retrying" &&
		rawPhase !== "cancelled" &&
		rawPhase !== "exhausted" &&
		rawPhase !== "recovered"
	) {
		return wrapTextWithAnsi(styleTaggedNotice("[retry] status"), width);
	}
	const attempt = typeof data.attempt === "number" ? data.attempt : null;
	const maxAttempts = typeof data.maxAttempts === "number" ? data.maxAttempts : null;
	if (attempt === null || maxAttempts === null) return wrapTextWithAnsi(styleTaggedNotice("[retry] status"), width);
	const status: RetryStatusPayload = {
		phase: rawPhase,
		attempt,
		maxAttempts,
		...(typeof data.errorMessage === "string" && data.errorMessage.length > 0 ? { errorMessage: data.errorMessage } : {}),
		...(typeof data.delayMs === "number" ? { delayMs: data.delayMs } : {}),
		...(typeof data.seconds === "number" ? { seconds: data.seconds } : {}),
	};
	return wrapTextWithAnsi(formatRetryStatus(status), width);
}

/**
 * Custom entries the replay renders. A custom entry is an extension point: some
 * carry operator-facing text, and the rest are diagnostics the live transcript
 * never shows. `promptRecompiled` is the latter, and replay dumped it as the
 * literal type name plus a JSON blob of hashes in the middle of a resumed
 * conversation, so a fork or resume showed a line the session itself never did.
 * Rendering is opt-in: a known type, or `display: true` from a writer that means
 * the entry to be seen.
 */
function rendersCustomEntry(entry: CustomEntry): boolean {
	if (entry.display === false) return false;
	if (entry.customType === "retryStatus") return true;
	if (entry.customType === "finishContractAdvisory" || entry.customType === "middlewareReminder") return true;
	return entry.display === true;
}

function renderCustomEntry(entry: CustomEntry, width: number): string[] {
	if (entry.customType === "retryStatus") return renderRetryStatusEntry(entry, width);
	// "finishContractAdvisory" is the pre-middleware name for the same entry
	// shape; older session ledgers still carry it.
	if (entry.customType === "finishContractAdvisory" || entry.customType === "middlewareReminder") {
		return renderReminderMessageEntry(entry, width);
	}
	if (entry.display !== true) return [];
	const body = stringifyPreview(entry.data);
	const suffix = body.length > 0 ? ` ${body}` : "";
	return wrapTextWithAnsi(`custom:${entry.customType}${suffix}`, width);
}

function renderReminderMessageEntry(entry: CustomEntry, width: number): string[] {
	const data = payloadObject(entry.data);
	const message = typeof data?.message === "string" && data.message.length > 0 ? data.message : "middleware reminder";
	return wrapTextWithAnsi(message, width);
}

function renderModelChangeEntry(entry: ModelChangeEntry, width: number): string[] {
	const target = entry.target ? `${entry.target}/` : "";
	return wrapTextWithAnsi(styleTaggedNotice(`[model] ${target}${entry.provider}/${entry.modelId}`), width);
}

function renderThinkingChangeEntry(entry: ThinkingLevelChangeEntry, width: number): string[] {
	return wrapTextWithAnsi(styleTaggedNotice(`[thinking] ${entry.thinkingLevel}`), width);
}

function renderFileEntry(entry: FileEntryEntry, width: number): string[] {
	const bytes = typeof entry.bytes === "number" ? `, ${entry.bytes} bytes` : "";
	return wrapTextWithAnsi(styleTaggedNotice(`[file ${entry.operation}] ${entry.path}${bytes}`), width);
}

function renderProtectedArtifactEntry(entry: ProtectedArtifactEntry, width: number): string[] {
	const validation =
		entry.artifact.validationCommand === undefined
			? ""
			: ` after ${entry.artifact.validationCommand}${entry.artifact.validationExitCode === undefined ? "" : ` exit ${entry.artifact.validationExitCode}`}`;
	return wrapTextWithAnsi(
		styleTaggedNotice(`[protected] ${entry.artifact.path}${validation}: ${entry.artifact.reason}`),
		width,
	);
}

function renderSessionInfoEntry(entry: SessionInfoEntry, width: number): string[] {
	if (entry.name) return wrapTextWithAnsi(styleTaggedNotice(`[session] ${entry.name}`), width);
	if (entry.label && entry.targetTurnId) {
		return wrapTextWithAnsi(styleTaggedNotice(`[label] ${entry.targetTurnId}: ${entry.label}`), width);
	}
	return [];
}

function truncateAtTurn(entries: ReadonlyArray<SessionEntry>, uptoTurnId?: string): SessionEntry[] {
	if (!uptoTurnId) return [...entries];
	const index = entries.findIndex((entry) => entry.turnId === uptoTurnId);
	if (index < 0) return [...entries];
	return entries.slice(0, index + 1);
}

function latestCompactionIndex(entries: ReadonlyArray<SessionEntry>): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.kind === "compactionSummary") return i;
	}
	return -1;
}

function toolCallIdsInEntry(entry: SessionEntry): string[] {
	if (entry.kind !== "message") return [];
	if (entry.role === "tool_call") return [extractToolCall(entry).id];
	if (entry.role !== "assistant") return [];
	const obj = payloadObject(entry.payload);
	if (!Array.isArray(obj?.content)) return [];
	const ids: string[] = [];
	for (const block of obj.content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type !== "toolCall") continue;
		if (typeof record.id === "string" && record.id.length > 0) ids.push(record.id);
	}
	return ids;
}

function toolResultIdInEntry(entry: SessionEntry): string | null {
	if (entry.kind !== "message" || entry.role !== "tool_result") return null;
	return extractToolResult(entry).id;
}

function findPriorToolCallEntry(
	entries: ReadonlyArray<SessionEntry>,
	toolCallId: string,
	endExclusive: number,
): SessionEntry | null {
	for (let index = Math.min(endExclusive, entries.length) - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry) continue;
		if (toolCallIdsInEntry(entry).includes(toolCallId)) return entry;
	}
	return null;
}

function repairToolResultOrphans(
	allEntries: ReadonlyArray<SessionEntry>,
	selected: ReadonlyArray<SessionEntry>,
	compactionIndex: number,
): SessionEntry[] {
	const out: SessionEntry[] = [];
	const seenToolCalls = new Set<string>();
	const emittedTurnIds = new Set<string>();
	const remember = (entry: SessionEntry): void => {
		emittedTurnIds.add(entry.turnId);
		for (const id of toolCallIdsInEntry(entry)) seenToolCalls.add(id);
	};
	for (const entry of selected) {
		const resultId = toolResultIdInEntry(entry);
		if (resultId !== null && !seenToolCalls.has(resultId)) {
			const dependency = findPriorToolCallEntry(allEntries, resultId, compactionIndex);
			if (dependency !== null && !emittedTurnIds.has(dependency.turnId)) {
				out.push(dependency);
				remember(dependency);
			}
		}
		out.push(entry);
		remember(entry);
	}
	return out;
}

/**
 * Normalize a heterogeneous session JSONL stream into the entry sequence the
 * replay surfaces should show. The stream is first narrowed to the active
 * branch of the turn tree (activeLeafTurnId selects a live branch;
 * uptoTurnId selects and historically truncates; otherwise the most recent
 * append wins), so abandoned sibling turns from earlier /tree switches never
 * replay. When the remaining slice contains a compaction boundary, render the
 * latest summary first and keep only the retained suffix plus later entries,
 * mirroring pi-coding-agent's buildSessionContext behavior.
 */
export function selectReplayEntries(
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): SessionEntry[] {
	const active = filterEntriesToActivePath(turns, options.activeLeafTurnId ?? options.uptoTurnId);
	const entries = truncateAtTurn(active, options.uptoTurnId);
	const compactionIndex = latestCompactionIndex(entries);
	if (compactionIndex < 0) return dropLegacyToolResultAssistantDuplicates(entries);

	const compaction = entries[compactionIndex] as CompactionSummaryEntry;
	const selected: SessionEntry[] = [compaction];
	const firstKeptIndex = compaction.firstKeptTurnId
		? entries.findIndex((entry) => entry.turnId === compaction.firstKeptTurnId)
		: -1;
	if (firstKeptIndex >= 0 && firstKeptIndex < compactionIndex) {
		selected.push(...entries.slice(firstKeptIndex, compactionIndex));
	}
	selected.push(...entries.slice(compactionIndex + 1));
	return dropLegacyToolResultAssistantDuplicates(repairToolResultOrphans(entries, selected, compactionIndex));
}

function dropLegacyToolResultAssistantDuplicates(entries: ReadonlyArray<SessionEntry>): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (const entry of entries) {
		const previous = out[out.length - 1];
		if (
			entry.kind === "message" &&
			entry.role === "assistant" &&
			previous?.kind === "message" &&
			previous.role === "tool_result" &&
			isLegacyToolResultAssistantDuplicate(previous, entry)
		) {
			continue;
		}
		out.push(entry);
	}
	return out;
}

function compactionContextText(entry: CompactionSummaryEntry): string {
	return `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

function branchContextText(entry: BranchSummaryEntry): string {
	return `${BRANCH_SUMMARY_PREFIX}${entry.summary}${BRANCH_SUMMARY_SUFFIX}`;
}

/** Project Clio's ledger entry onto pi's bash message so pi owns the replay wording. */
function bashContextText(entry: BashExecutionEntry): string {
	const message: BashExecutionMessage = {
		role: "bashExecution",
		command: entry.command,
		output: truncateReplayText(entry.output),
		exitCode: entry.exitCode ?? undefined,
		cancelled: entry.cancelled,
		truncated: entry.truncated,
		...(entry.fullOutputPath !== undefined ? { fullOutputPath: entry.fullOutputPath } : {}),
		timestamp: Date.parse(entry.timestamp) || 0,
	};
	return bashExecutionToText(message);
}

function appendContextMessage(out: AgentMessage[], role: "user" | "assistant", text: string, timestamp: string): void {
	const trimmed = text.trim();
	if (trimmed.length === 0) return;
	out.push(makeTextMessage(role, truncateReplayText(trimmed), timestamp));
}

function skillActivationContextText(entry: Extract<SessionEntry, { kind: "skillActivation" }>): string {
	const activation = entry.activation;
	const turn = activation.turnId ? ` turn=${activation.turnId}` : "";
	return `Active skill loaded: ${activation.name} source=${activation.source} hash=${activation.hash} path=${activation.filePath} triggeredBy=${activation.triggeredBy}${turn}. Continue honoring this skill unless the user changes direction.`;
}

export function buildReplayAgentMessagesFromTurns(
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): AgentMessage[] {
	const out: AgentMessage[] = [];
	const seenToolCalls = new Set<string>();
	for (const entry of selectReplayEntries(turns, options)) {
		switch (entry.kind) {
			case "message": {
				const text = textBlockFromEntry(entry);
				if (entry.role === "user" || entry.role === "assistant") {
					if (entry.role === "assistant" && messageFailure(entry)) break;
					const message = richMessageFromEntry(entry, MAX_REPLAY_TEXT_CHARS);
					if (message) {
						out.push(message);
						recordToolCallsFromMessage(message, seenToolCalls);
					}
				} else if (entry.role === "tool_call") {
					const call = extractToolCall(entry);
					if (!seenToolCalls.has(call.id)) {
						const message = toolCallMessageFromEntry(entry);
						out.push(message);
						recordToolCallsFromMessage(message, seenToolCalls);
					}
				} else if (entry.role === "tool_result") {
					out.push(toolResultMessageFromEntry(entry));
				} else if (entry.role === "system") {
					appendContextMessage(out, "user", `System note: ${text}`, entry.timestamp);
				}
				break;
			}
			case "bashExecution":
				if (!entry.excludeFromContext) appendContextMessage(out, "user", bashContextText(entry), entry.timestamp);
				break;
			case "branchSummary":
				appendContextMessage(out, "user", branchContextText(entry), entry.timestamp);
				break;
			case "compactionSummary":
				appendContextMessage(out, "user", compactionContextText(entry), entry.timestamp);
				break;
			case "skillActivation":
				appendContextMessage(out, "user", skillActivationContextText(entry), entry.timestamp);
				break;
			case "custom":
			case "modelChange":
			case "thinkingLevelChange":
			case "fileEntry":
			case "sessionInfo":
			case "label":
			case "protectedArtifact":
			case "taskLedger":
			case "decisionLedger":
			// A worker's answer is not the operator's words and not the model's.
			// It reaches the model only when an operator shares it, and a share
			// is already a user message by the time it lands in the ledger.
			case "workerRun":
				break;
		}
	}
	return out;
}

/**
 * Rehydrate a chat panel from a persisted session's turn list. The
 * interactive layer calls this after /resume or /fork so the user sees the
 * prior transcript instead of a blank pane; without it, swapping the
 * session contract updated meta but left the visible chat untouched
 * (Row 51 and Row 52 on the Phase 12 ledger).
 *
 * Replays a structured SessionEntry stream. Compaction summaries, branch
 * summaries, bash executions, custom entries, and metadata entries are
 * rendered explicitly. Tool call/result entries are best-effort: when a
 * result can be paired to a prior call id it updates that tool segment,
 * otherwise it falls back to a standalone transcript line.
 *
 * Worker blocks are rebuilt from their `workerRun` entries plus the sealed
 * receipts those entries name, so a resumed session shows the answer a `/run`
 * produced rather than a header with nothing under it. The block is applied
 * through the same panel call the live reducer uses, which is what makes an
 * agent-origin card land under the tool segment that spawned it here too.
 *
 * Callers read turns via `openSession(id).turns()` and pass them in explicitly.
 * The receipt reader is the one thing this touches beyond the panel; it is a
 * parameter with a disk-backed default, and it never throws.
 */
export function rehydrateChatPanelFromTurns(
	chatPanel: ChatPanel,
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): void {
	const pendingToolIds: string[] = [];
	const selected = selectReplayEntries(turns, options);
	// One block per assignment, drawn where its first attempt started. Later
	// attempts of the same assignment fold into that block as `↻` rail lines, so
	// a failover replays as the one run it was rather than as two.
	const workerStates = workerEntriesFromRunEntries(
		selected.filter((entry): entry is WorkerRunEntry => entry.kind === "workerRun"),
		options.readWorkerReceipt ?? readWorkerReceiptFactsForReplay,
	);
	const placedAssignments = new Set<string>();
	for (const entry of selected) {
		switch (entry.kind) {
			case "message": {
				if (entry.role === "user") {
					const text = truncateReplayText(replayedUserText(entry));
					if (text.length > 0) chatPanel.appendUser(text);
					break;
				}
				if (entry.role === "assistant") {
					const text = chatMessageText(entry);
					const failure = messageFailure(entry);
					const richMessage = richMessageFromEntry(entry, MAX_REPLAY_TEXT_CHARS);
					if (richMessage || text.length > 0 || failure) {
						const message = richMessage ?? makeTextMessage("assistant", truncateReplayText(text), entry.timestamp);
						if (failure) {
							(message as { stopReason?: string; errorMessage?: string }).stopReason = failure.stopReason;
							(message as { stopReason?: string; errorMessage?: string }).errorMessage = failure.errorMessage;
						}
						chatPanel.applyEvent({ type: "message_end", message });
						chatPanel.applyEvent({ type: "agent_end", messages: [message] });
					}
					break;
				}
				if (entry.role === "tool_call") {
					const call = extractToolCall(entry);
					pendingToolIds.push(call.id);
					chatPanel.applyEvent({
						type: "tool_execution_start",
						toolCallId: call.id,
						toolName: call.name,
						args: call.args,
					});
					chatPanel.markToolReplayed?.(call.id);
					break;
				}
				if (entry.role === "tool_result") {
					const result = extractToolResult(entry);
					const fallbackId = result.id ?? pendingToolIds.pop() ?? null;
					if (fallbackId) {
						const pendingIndex = pendingToolIds.indexOf(fallbackId);
						if (pendingIndex >= 0) pendingToolIds.splice(pendingIndex, 1);
						chatPanel.applyEvent({
							type: "tool_execution_end",
							toolCallId: fallbackId,
							toolName: result.name,
							result: displayReplayToolResult(result.result),
							isError: result.isError,
							...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
							...(result.resultSummary !== undefined ? { resultSummary: result.resultSummary } : {}),
							...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
							...(result.blockReason !== undefined ? { blockReason: result.blockReason } : {}),
						} as ChatLoopEvent);
					} else {
						chatPanel.appendReplayBlock((width) =>
							renderToolResultOnly(
								{
									toolCallId: result.id ?? "",
									toolName: result.name,
									result: displayReplayToolResult(result.result),
									isError: result.isError,
									...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
									...(result.resultSummary !== undefined ? { resultSummary: result.resultSummary } : {}),
									...(result.outcome === "blocked" ? { outcome: "blocked" as const } : {}),
									...(result.blockReason !== undefined ? { blockReason: result.blockReason } : {}),
								},
								width,
								{ unbounded: options.unboundedToolBodies === true },
							),
						);
					}
					break;
				}
				if (entry.role === "system") {
					const text = textBlockFromEntry(entry);
					if (text.length > 0) appendReplayLine(chatPanel, `system: ${text}`);
					break;
				}
				if (entry.role === "checkpoint") {
					const text = textBlockFromEntry(entry);
					appendReplayLine(chatPanel, text.length > 0 ? `[checkpoint] ${text}` : "[checkpoint]");
					break;
				}
				break;
			}
			case "bashExecution":
				chatPanel.appendReplayBlock((width) => renderBashExecutionEntry(entry, width));
				break;
			case "custom":
				if (rendersCustomEntry(entry)) chatPanel.appendReplayBlock((width) => renderCustomEntry(entry, width));
				break;
			case "modelChange":
				chatPanel.appendReplayBlock((width) => renderModelChangeEntry(entry, width));
				break;
			case "thinkingLevelChange":
				chatPanel.appendReplayBlock((width) => renderThinkingChangeEntry(entry, width));
				break;
			case "fileEntry":
				chatPanel.appendReplayBlock((width) => renderFileEntry(entry, width));
				break;
			case "protectedArtifact":
				chatPanel.appendReplayBlock((width) => renderProtectedArtifactEntry(entry, width));
				break;
			case "skillActivation":
				appendReplayLine(chatPanel, `[skill] ${entry.activation.name} ${entry.activation.triggeredBy}`);
				break;
			case "branchSummary":
				if (entry.summary.trim().length > 0) {
					chatPanel.appendReplayBlock((width) =>
						renderBranchSummaryEntry({ ...entry, summary: truncateReplayText(entry.summary) }, width),
					);
				}
				break;
			case "compactionSummary":
				if (entry.summary.trim().length > 0) {
					chatPanel.appendReplayBlock((width) =>
						renderCompactionSummaryEntry({ ...entry, summary: truncateReplayText(entry.summary) }, width),
					);
				}
				break;
			case "sessionInfo":
				if (entry.name || entry.label) chatPanel.appendReplayBlock((width) => renderSessionInfoEntry(entry, width));
				break;
			case "workerRun": {
				if (placedAssignments.has(entry.assignmentId)) break;
				const state = workerStates.get(entry.assignmentId);
				if (state === undefined) break;
				placedAssignments.add(entry.assignmentId);
				chatPanel.applyWorkerState(state);
				break;
			}
			case "label":
			case "taskLedger":
			case "decisionLedger":
				break;
		}
	}
	for (const pendingId of pendingToolIds) {
		chatPanel.applyEvent({
			type: "tool_execution_end",
			toolCallId: pendingId,
			toolName: "tool",
			result: "missing result; session ended before the tool completed",
			isError: true,
		});
	}
	// Replay favors a compact historical ledger even though fresh non-resource
	// calls auto-expand for live arguments and output. Collapse reconstructed
	// tools explicitly; /export re-expands them afterward via
	// toggleAllToolsExpanded, while /resume and /fork retain the compact form.
	chatPanel.collapseAllTools();
}
