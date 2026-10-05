/**
 * Coalescing wrapper around chat events.
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

import { existsSync } from "node:fs";
import { CONTEXT_OPERATION_CUSTOM_TYPE, readContextOperation } from "../core/context-operation.js";
import { isSkillSurfaceChange, SKILL_SURFACE_ENTRY } from "../core/skill-activation.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import type {
	BashExecutionEntry,
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
import {
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SEED_CUSTOM_TYPE,
	isHandoffNoteData,
	isHandoffSeedData,
} from "../domains/session/handoff.js";
import { stripInjectedPreamble } from "../domains/session/history.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent, RetryStatusPayload, SpeculativeDispatchCounts } from "../session-control/chat-loop.js";
import { hasStructuredToolCall, toolResultSummary } from "../session-control/chat-loop-messages.js";
import { isNoticeSource, type NoticeSource } from "../session-control/notice-source.js";
import type { RehydrateChatPanelOptions, ReplayToolResult } from "../session-control/session-replay-messages.js";
import {
	extractToolCall,
	extractToolResult,
	extractTurnText,
	makeTextMessage,
	messageFailure,
	payloadObject,
	richMessageFromEntry,
	selectReplayEntries,
	stringifyPreview,
	textBlockFromEntry,
	timestampMillis,
	toolResultContent,
	truncateReplayText,
} from "../session-control/session-replay-messages.js";
import { readWorkerReceiptFactsForReplay } from "../session-control/worker-receipts.js";
import { toolResultPresentationText } from "../tools/result-disposition.js";
import type { ChatPanel, ReplayedRunFacts } from "./chat-panel.js";
import { OPERATOR_COMMAND_ENTRY, renderOperatorCommandRows } from "./command-output.js";
import { showsContextResult } from "./context-operation-view.js";
import { renderBranchSummaryEntry } from "./renderers/branch-summary.js";
import { renderCompactionSummaryEntry } from "./renderers/compaction-summary.js";
import { renderContextOperationResult } from "./renderers/context-operation.js";
import { type NoticeMark, renderNoticeRow } from "./renderers/notice.js";
import { renderRetryStatus } from "./renderers/retry-status.js";
import { renderSkillSurfaceRow } from "./renderers/skill-rows.js";
import { renderBashTranscriptExecution, renderToolResultOnly } from "./renderers/tool-execution.js";
import {
	classifyStreamEvent,
	createStreamPacer,
	type SmoothStreamingMode,
	type StreamPacer,
	type StreamPacerSlice,
} from "./stream-pacer.js";
import type { TranscriptDetailPolicy } from "./transcript-detail.js";
import {
	WORKER_SETTLED_ENTRY,
	type WorkerSettledFields,
	workerEntriesFromRunEntries,
	workerSettledFromData,
} from "./worker-replay.js";

export type { RehydrateChatPanelOptions } from "../session-control/session-replay-messages.js";
export {
	activeEntriesBeforeCompactionCut,
	buildReplayAgentMessagesFromTurns,
	retireActiveUserContextForNextOperator,
	selectReplayEntries,
} from "../session-control/session-replay-messages.js";

const DEFAULT_COALESCE_MS = 16;
/**
 * Event kinds whose render is deferred into a coalesce window. All other
 * `ChatLoopEvent` kinds render synchronously and cancel any pending timer.
 */
const DELTA_TYPES: ReadonlySet<ChatLoopEvent["type"]> = new Set([
	"text_delta",
	"text_frame",
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
	const clock = deps.now ?? (() => performance.now());
	/** When this renderer last asked for a frame; the coalesce window runs from here. */
	let lastRequestAt = Number.NEGATIVE_INFINITY;

	const requestNow = (): void => {
		lastRequestAt = clock();
		deps.requestRender();
	};

	const fireCoalesced = (): void => {
		if (disposed) return;
		pendingTimer = null;
		requestNow();
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
			requestNow();
			return;
		}
		deps.onDelta?.();
		if (pendingTimer !== null) return;
		// Leading edge: a delta that arrives after a quiet window asks for its
		// frame at once, and only the deltas inside a window wait for its end.
		// A trailing-only timer held every first token of a burst for a full
		// window before the renderer's own frame throttle added another.
		const wait = coalesceMs - (clock() - lastRequestAt);
		if (wait <= 0) {
			requestNow();
			return;
		}
		pendingTimer = setTimer(fireCoalesced, wait);
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
			if (wasPending) requestNow();
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
			lastRequestAt = clock();
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

function displayReplayToolResult(result: unknown, unbounded = false): unknown {
	const presentationText = toolResultPresentationText(result);
	const content =
		presentationText === null
			? toolResultContent(result, unbounded)
			: [{ type: "text", text: unbounded ? presentationText : truncateReplayText(presentationText) }];
	// Preserve the details record (observation envelope, exec records) so the
	// replayed ledger line carries the same outcome facts as the live one.
	const details = payloadObject(result)?.details;
	return details !== null && details !== undefined && typeof details === "object" ? { content, details } : content;
}

function chatMessageText(entry: MessageEntry): string {
	return extractTurnText(entry.payload);
}

/**
 * What the operator typed for a replayed user turn. The persisted text is the
 * composed prompt (a system-reminder block and any skill preamble ride ahead of
 * the operator's words, as visible text the model receives), and the live
 * transcript only ever showed the typed part. Entries written since the
 * operator text was persisted carry it directly; older entries drop the
 * leading reminder and skill-request scaffolding so a /fork or /resume redraw
 * does not attribute it to the operator (#81).
 */
function replayedUserText(entry: MessageEntry): string {
	const obj = payloadObject(entry.payload);
	if (typeof obj?.displayText === "string" && obj.displayText.length > 0) return obj.displayText;
	if (typeof obj?.operatorText === "string") return obj.operatorText;
	return stripInjectedPreamble(extractTurnText(entry.payload));
}

/** The expected-cold reasons an assistant entry's prompt-cache record carries. */
function persistedColdReasons(entry: MessageEntry): string[] {
	const promptCache = payloadObject(payloadObject(entry.payload)?.promptCache);
	const reasons = promptCache?.expectedColdReasons;
	return Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === "string") : [];
}

/**
 * Resolve a replayed offload pointer once, when the ledger row becomes a
 * display event. Terminal repaints consume the recorded fact and never touch
 * the filesystem.
 */
function replayResultSummary(result: ReplayToolResult): Record<string, unknown> | undefined {
	const summary = result.resultSummary ?? toolResultSummary(result.result);
	const offloadPath =
		typeof summary.offloadPath === "string" && summary.offloadPath.length > 0 ? summary.offloadPath : null;
	if (offloadPath === null) return result.resultSummary;
	return { ...summary, offloadFileMissing: !existsSync(offloadPath) };
}

/** A replayed system line (`[checkpoint]`, `[continuity]`, `system:`) as the info notice it is. */
function appendReplayNotice(chatPanel: ChatPanel, text: string): void {
	chatPanel.appendReplayBlock((width) => renderNoticeRow(truncateReplayText(text), "info", width));
}

/** Middleware reminder severities as notice marks: advice informs, a warning or a hard stop warns. */
function reminderMark(severity: unknown): NoticeMark {
	return severity === "warn" || severity === "hard-block" ? "warning" : "info";
}

function renderBashExecutionEntry(
	entry: BashExecutionEntry,
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded: boolean,
): string[] {
	const normalizedOutput = entry.output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/g, "");
	return renderBashTranscriptExecution(
		{
			command: entry.command,
			output: normalizedOutput,
			running: false,
			exitCode: entry.exitCode,
			cancelled: entry.cancelled,
			truncated: entry.truncated,
			fullOutputPath: entry.fullOutputPath,
			excludeFromContext: entry.excludeFromContext,
		},
		width,
		undefined,
		{ unbounded, diffStyle: "plain", detail },
	);
}

function renderRetryStatusEntry(
	entry: CustomEntry,
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded: boolean,
	terminalRows: number,
): string[] {
	const data = payloadObject(entry.data);
	if (!data) return renderNoticeRow("provider retry", "retry", width);
	const rawPhase = data.phase;
	if (
		rawPhase !== "scheduled" &&
		rawPhase !== "waiting" &&
		rawPhase !== "retrying" &&
		rawPhase !== "cancelled" &&
		rawPhase !== "exhausted" &&
		rawPhase !== "recovered"
	) {
		return renderNoticeRow("provider retry", "retry", width);
	}
	const attempt = typeof data.attempt === "number" ? data.attempt : null;
	const maxAttempts = typeof data.maxAttempts === "number" ? data.maxAttempts : null;
	if (attempt === null || maxAttempts === null) return renderNoticeRow("provider retry", "retry", width);
	const status: RetryStatusPayload = {
		phase: rawPhase,
		attempt,
		maxAttempts,
		...(typeof data.errorMessage === "string" && data.errorMessage.length > 0 ? { errorMessage: data.errorMessage } : {}),
		...(typeof data.delayMs === "number" ? { delayMs: data.delayMs } : {}),
		...(typeof data.seconds === "number" ? { seconds: data.seconds } : {}),
	};
	return renderRetryStatus(status, width, detail, unbounded, terminalRows);
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
	if (entry.customType === CONTEXT_OPERATION_CUSTOM_TYPE) {
		// The live card and the resumed one follow one policy, so a resume never shows a block the session did not.
		const operation = readContextOperation(entry.data);
		return operation !== null && showsContextResult(operation);
	}
	if (entry.display === false) return false;
	if (entry.customType === "retryStatus") return true;
	if (entry.customType === SKILL_SURFACE_ENTRY) return isSkillSurfaceChange(entry.data) && entry.data.state !== "loaded";
	if (entry.customType === OPERATOR_COMMAND_ENTRY) return operatorCommandText(entry.data) !== null;
	if (entry.customType === "finishContractAdvisory" || entry.customType === "middlewareReminder") return true;
	if (entry.customType === HANDOFF_SEED_CUSTOM_TYPE || entry.customType === HANDOFF_NOTE_CUSTOM_TYPE) return true;
	return entry.display === true;
}

function renderCustomEntry(
	entry: CustomEntry,
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded: boolean,
	terminalRows: number,
): string[] {
	if (entry.customType === CONTEXT_OPERATION_CUSTOM_TYPE) {
		const operation = readContextOperation(entry.data);
		return operation ? renderContextOperationResult(operation, width) : [];
	}
	if (entry.customType === "retryStatus") return renderRetryStatusEntry(entry, width, detail, unbounded, terminalRows);
	if (entry.customType === SKILL_SURFACE_ENTRY && isSkillSurfaceChange(entry.data)) {
		return renderSkillSurfaceRow(entry.data, width);
	}
	const command = entry.customType === OPERATOR_COMMAND_ENTRY ? operatorCommandText(entry.data) : null;
	if (command !== null) return renderOperatorCommandRows(command, width);
	if (entry.customType === HANDOFF_SEED_CUSTOM_TYPE && isHandoffSeedData(entry.data)) {
		return renderNoticeRow(`[handoff] carried from session ${entry.data.fromSessionId}`, "info", width);
	}
	if (entry.customType === HANDOFF_NOTE_CUSTOM_TYPE && isHandoffNoteData(entry.data)) {
		return renderNoticeRow(`[handoff] handed off to session ${entry.data.toSessionId}`, "info", width);
	}
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

/** The command line an `operatorCommand` entry recorded; null when it holds none. */
function operatorCommandText(data: unknown): string | null {
	const text = payloadObject(data)?.text;
	return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function renderReminderMessageEntry(entry: CustomEntry, width: number): string[] {
	const data = payloadObject(entry.data);
	const message = typeof data?.message === "string" && data.message.length > 0 ? data.message : "middleware reminder";
	// A reminder is an advisory. Entries written before the source was stored
	// have none, and a memory note among them still carries its `Memory:` prefix.
	const source: NoticeSource = isNoticeSource(data?.source)
		? data.source
		: message.startsWith("Memory:")
			? "memory"
			: "reminder";
	return renderNoticeRow(message, reminderMark(data?.severity), width, source);
}

function renderModelChangeEntry(entry: ModelChangeEntry, width: number): string[] {
	const target = entry.target ? `${entry.target}/` : "";
	return renderNoticeRow(`[model] ${target}${entry.provider}/${entry.modelId}`, "info", width);
}

function renderThinkingChangeEntry(entry: ThinkingLevelChangeEntry, width: number): string[] {
	return renderNoticeRow(`[thinking] ${entry.thinkingLevel}`, "info", width);
}

function renderFileEntry(entry: FileEntryEntry, width: number): string[] {
	const bytes = typeof entry.bytes === "number" ? `, ${entry.bytes} bytes` : "";
	return renderNoticeRow(`[file ${entry.operation}] ${entry.path}${bytes}`, "info", width);
}

function renderProtectedArtifactEntry(entry: ProtectedArtifactEntry, width: number): string[] {
	const validation =
		entry.artifact.validationCommand === undefined
			? ""
			: ` after ${entry.artifact.validationCommand}${entry.artifact.validationExitCode === undefined ? "" : ` exit ${entry.artifact.validationExitCode}`}`;
	return renderNoticeRow(`[protected] ${entry.artifact.path}${validation}: ${entry.artifact.reason}`, "info", width);
}

function renderSessionInfoEntry(entry: SessionInfoEntry, width: number): string[] {
	if (entry.name) return renderNoticeRow(`[session] ${entry.name}`, "info", width);
	if (entry.label && entry.targetTurnId) {
		return renderNoticeRow(`[label] ${entry.targetTurnId}: ${entry.label}`, "info", width);
	}
	return [];
}

/**
 * Rehydrate a chat panel from a persisted session's turn list. The
 * interactive layer calls this after /resume or /fork so the user sees the
 * prior transcript instead of a blank pane; without it, swapping the
 * session contract updated meta but left the visible chat untouched.
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
	try {
		replayEntries(chatPanel, turns, options);
	} finally {
		chatPanel.replayAt?.(undefined);
	}
}

function speculativeDispatchCounts(data: unknown): SpeculativeDispatchCounts | null {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
	const { held, adopted, discarded } = data as Record<string, unknown>;
	if (
		![held, adopted, discarded].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	) {
		return null;
	}
	return { held: held as number, adopted: adopted as number, discarded: discarded as number };
}

function replayEntries(
	chatPanel: ChatPanel,
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions,
): void {
	const pendingToolIds: string[] = [];
	let runAssistantMessages: AgentMessage[] = [];
	// What the live receipt measured, recovered from the ledger: the run's
	// duration from its prompt's timestamp to its last answer's, and the reasons
	// its first call recorded for an expected cold prompt cache.
	let runStartedAtMs: number | undefined;
	let runColdReasons: string[] = [];
	const selected = selectReplayEntries(turns, options);
	const runStarts = new Map<string, number>();
	let userStartedAt: number | undefined;
	for (const entry of filterEntriesToActivePath(turns, options.activeLeafTurnId ?? options.uptoTurnId)) {
		if (entry.kind !== "message") continue;
		if (entry.role === "user") {
			const at = Date.parse(entry.timestamp);
			userStartedAt = Number.isFinite(at) ? at : undefined;
		} else if (entry.role === "assistant" && userStartedAt !== undefined) {
			runStarts.set(entry.turnId, userStartedAt);
		}
	}

	// The transcript shows the ledger, never the projection: an evicted result
	// still renders its full body here, tagged with the reason it left the
	// model's working set. Folded once over the same active path the replay
	// uses, so a /tree switch cannot tag a row from an abandoned branch.
	const workingSet = foldWorkingSet(turns, options.activeLeafTurnId ?? options.uptoTurnId);
	// One block per assignment, drawn where its first attempt started. Later
	// attempts of the same assignment fold into that block as `↻` rail lines, so
	// a failover replays as the one run it was rather than as two.
	// What a settled run's live stream knew and its receipt does not.
	const settledRuns = new Map<string, WorkerSettledFields>();
	for (const entry of selected) {
		if (entry.kind !== "custom" || entry.customType !== WORKER_SETTLED_ENTRY) continue;
		const settled = workerSettledFromData(entry.data);
		if (settled !== null) settledRuns.set(settled.runId, settled);
	}
	const workerStates = workerEntriesFromRunEntries(
		selected.filter((entry): entry is WorkerRunEntry => entry.kind === "workerRun"),
		options.readWorkerReceipt ?? readWorkerReceiptFactsForReplay,
		settledRuns,
	);
	const placedAssignments = new Set<string>();
	// A run's settle waits for the next operator row or the end of the replay.
	let pendingSettle: (() => void) | null = null;
	const settleReplayedRun = (): void => {
		const settle = pendingSettle;
		pendingSettle = null;
		settle?.();
	};
	for (const entry of selected) {
		// What this entry appends carries the time the ledger recorded it.
		chatPanel.replayAt?.(timestampMillis(entry.timestamp));
		switch (entry.kind) {
			case "message": {
				if (entry.role === "user") {
					settleReplayedRun();
					runAssistantMessages = [];
					runColdReasons = [];
					const startedAt = Date.parse(entry.timestamp);
					runStartedAtMs = Number.isFinite(startedAt) ? startedAt : undefined;
					const text = replayedUserText(entry);
					if (text.length > 0) chatPanel.appendUser(text);
					// A turn another Clio submitted says so on replay, as it did live.
					const origin = payloadObject(entry.payload)?.origin;
					if (typeof origin === "string" && origin.length > 0) {
						chatPanel.appendReplayBlock((width) => wrapTextWithAnsi(`  ${origin}`, width));
					}
					break;
				}
				if (entry.role === "assistant") {
					// A split-turn checkpoint can hide the user row while retaining its
					// answer; its original timestamp still owns the duration (flywheel r4/5).
					runStartedAtMs = runStarts.get(entry.turnId) ?? runStartedAtMs;
					const text = chatMessageText(entry);
					const failure = messageFailure(entry);
					const richMessage = richMessageFromEntry(entry, Number.POSITIVE_INFINITY);
					if (richMessage || text.length > 0 || failure) {
						const message = richMessage ?? makeTextMessage("assistant", text, entry.timestamp);
						if (failure) {
							(message as { stopReason?: string; errorMessage?: string }).stopReason = failure.stopReason;
							(message as { stopReason?: string; errorMessage?: string }).errorMessage = failure.errorMessage;
						}
						const stopReason = (message as { stopReason?: string }).stopReason;
						const terminalFailure = stopReason === "error" || stopReason === "aborted" || stopReason === "length";
						const continues = !terminalFailure && (stopReason === "toolUse" || hasStructuredToolCall(message));
						// Every message starts before it ends, as it did live: the start marks
						// where this message's reasoning goes, ahead of its text rather than
						// lost behind the reasoning an earlier message of the run left. A
						// tool-use message continues the run, so its entry stays pending until
						// a terminal assistant arrives; settling before its tool rows exist
						// could attach a Done receipt to an earlier visible failure.
						chatPanel.applyEvent({ type: "message_start", message });
						chatPanel.applyEvent({ type: "message_end", message });
						runAssistantMessages.push(message);
						for (const reason of persistedColdReasons(entry)) {
							if (!runColdReasons.includes(reason)) runColdReasons.push(reason);
						}
						// Another assistant row before the next operator row means the run
						// went on through a middleware continuation, and live it settled
						// once, at its end.
						pendingSettle = null;
						if (!continues) {
							const endedAt = Date.parse(entry.timestamp);
							const elapsedMs =
								runStartedAtMs !== undefined && Number.isFinite(endedAt) && endedAt >= runStartedAtMs
									? endedAt - runStartedAtMs
									: undefined;
							const replayed: ReplayedRunFacts = {
								...(elapsedMs === undefined ? {} : { elapsedMs }),
								...(runColdReasons.length > 0 ? { coldReasons: [...runColdReasons] } : {}),
							};
							const messages = runAssistantMessages;
							pendingSettle = () => chatPanel.applyEvent({ type: "agent_end", messages, replayed } as ChatLoopEvent);
						}
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
					const resultSummary = replayResultSummary(result);
					const evictedReason = workingSet.evicted.get(entry.turnId)?.reason;
					const fallbackId = result.id ?? pendingToolIds.pop() ?? null;
					if (fallbackId) {
						const pendingIndex = pendingToolIds.indexOf(fallbackId);
						if (pendingIndex >= 0) pendingToolIds.splice(pendingIndex, 1);
						chatPanel.applyEvent({
							type: "tool_execution_end",
							toolCallId: fallbackId,
							toolName: result.name,
							result: displayReplayToolResult(result.result, true),
							isError: result.isError,
							...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
							...(resultSummary !== undefined ? { resultSummary } : {}),
							...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
							...(result.blockReason !== undefined ? { blockReason: result.blockReason } : {}),
							...(result.actionClass !== undefined ? { actionClass: result.actionClass } : {}),
							...(evictedReason !== undefined ? { evictedReason } : {}),
						} as ChatLoopEvent);
					} else {
						chatPanel.appendReplayBlock((width, detail, unbounded) =>
							renderToolResultOnly(
								{
									toolCallId: result.id ?? "",
									toolName: result.name,
									result: displayReplayToolResult(result.result, true),
									isError: result.isError,
									...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
									...(resultSummary !== undefined ? { resultSummary } : {}),
									...(result.outcome === "blocked" ? { outcome: "blocked" as const } : {}),
									...(result.blockReason !== undefined ? { blockReason: result.blockReason } : {}),
									...(result.actionClass !== undefined ? { actionClass: result.actionClass } : {}),
									...(evictedReason !== undefined ? { evictedReason } : {}),
								},
								width,
								{ unbounded: unbounded || options.unboundedToolBodies === true, detail },
							),
						);
					}
					break;
				}
				if (entry.role === "system") {
					const text = textBlockFromEntry(entry);
					if (text.length > 0) appendReplayNotice(chatPanel, `system: ${text}`);
					break;
				}
				if (entry.role === "checkpoint") {
					const text = textBlockFromEntry(entry);
					appendReplayNotice(chatPanel, text.length > 0 ? `[checkpoint] ${text}` : "[checkpoint]");
					break;
				}
				break;
			}
			case "bashExecution": {
				chatPanel.appendReplayBlock((width, detail, unbounded) =>
					renderBashExecutionEntry(entry, width, detail, unbounded || options.unboundedToolBodies === true),
				);
				break;
			}
			case "custom":
				if (entry.customType === "speculativeDispatch") {
					// Written after its turn settled, and it annotates that receipt.
					settleReplayedRun();
					const counts = speculativeDispatchCounts(entry.data);
					if (counts !== null) chatPanel.applyEvent({ type: "speculative_dispatch", counts });
					break;
				}
				if (rendersCustomEntry(entry))
					chatPanel.appendReplayBlock((width, detail, unbounded, terminalRows = 40) =>
						renderCustomEntry(entry, width, detail, unbounded === true || options.unboundedToolBodies === true, terminalRows),
					);
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
			// The load's own row states the skill and who asked for it; the
			// activation record is provenance, not a second transcript line.
			case "skillActivation":
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
			// One bounded provenance line each. The transcript says a handoff
			// happened and where it stands; the note itself is rendered once,
			// below, under its own label, rather than once per record.
			case "handoffTransaction":
				appendReplayNotice(
					chatPanel,
					`[continuity] ${entry.event.phase} handoff=${entry.identity.handoffId} seq=${entry.transition.sequence} attempt=${entry.transition.attempt}`,
				);
				break;
			case "continuityCommit":
				appendReplayNotice(
					chatPanel,
					`[continuity] commit handoff=${entry.continuity.identity.handoffId} outcome=${entry.continuity.commit.outcome} tokens=${entry.continuity.commit.tokensBefore}->${entry.continuity.commit.tokensAfter}`,
				);
				break;
			case "label":
			case "taskLedger":
			case "decisionLedger":
			case "contextEviction":
			case "contextRecall":
				break;
		}
	}
	settleReplayedRun();
	// The transcript shows the note as what it is: assistant-authored handoff
	// text, labelled, never rendered as an operator turn.
	//
	// This is a presentation view, not the durable text. The panel wraps to its
	// width and strips terminal control sequences, so a rendered line is not
	// byte-identical to the note; §12 permits an export transformation exactly
	// when it is labelled, and the exact bytes stay in the ledger and in the
	// model replay the same blocks feed.
	for (const block of options.continuityBlocks ?? []) {
		for (const line of block.split("\n"))
			chatPanel.appendReplayBlock((width) => wrapTextWithAnsi(truncateReplayText(line), width));
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
	// A rehydrated transcript starts from the transcript detail policy alone:
	// whatever the operator had opened or folded before the switch belonged to
	// the transcript they left. /export reaches the same policy with a verbose
	// panel, so nothing here is terminal-only.
}
