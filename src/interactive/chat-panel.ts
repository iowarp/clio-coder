import { performance } from "node:perf_hooks";
import type { OutputStyle } from "../core/defaults.js";
import { SKILL_SUGGESTION_PREFIX } from "../core/skill-activation.js";
import { rawDurationMs } from "../core/timers.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import { settledPrefixLength } from "../engine/apis/diffusion-frames.js";
import {
	type Component,
	lexMarkdownBlocks,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import { extractText, isSelfExplainingAbort } from "./chat-loop-messages.js";
import type { ApprovalRequestView } from "./permission-overlay.js";
import { codeInk } from "./renderers/code-ink.js";
import { createMermaidMarkdownTransform } from "./renderers/mermaid.js";
import { styleTaggedNotice } from "./renderers/notice.js";
import { previewBudget, previewRows } from "./renderers/preview.js";
import { presentProviderError, providerErrorEvidence } from "./renderers/provider-error.js";
import { renderRetryStatus } from "./renderers/retry-status.js";
import {
	canGroupObservation,
	hasToolBody,
	observationTarget,
	renderObservationGroup,
	renderToolAwaitingApproval,
	renderToolExecution,
	renderToolPreview,
} from "./renderers/tool-execution.js";
import { renderWorkerEntryLines } from "./renderers/worker-entry.js";
import {
	compactReasoningTokens,
	emptyRunTally,
	foldMessageIntoRunTally,
	formatReasoningChip,
	formatReasoningLabel,
	type ReasoningTokenProvenance,
	type ReasoningUsageView,
	reasoningFromTally,
	UNMEASURED_REASONING,
} from "./status/index.js";
import {
	clioTheme,
	fgSequence,
	formatCompactMs,
	GLYPH,
	markdownTheme,
	SGR_BOLD,
	SGR_BOLD_OFF,
	SGR_DIM,
	SGR_ITALIC,
	SGR_RESET,
} from "./theme/index.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "./transcript-detail.js";
import type { ViewArtifact } from "./view/artifacts.js";
import type { WorkerEntryState } from "./worker-stream.js";

// Fenced code reaches the screen through pi-tui's Markdown component, which
// exposes the MarkdownTheme.highlightCode hook: it hands over the raw fence
// text plus its language tag before pi-tui draws the fence borders and indent.
// Wiring code ink through that hook colors only the ink, so the fence frame,
// indentation, and width behavior stay pi-tui's and nothing post-processes
// already-rendered output.
const CHAT_MARKDOWN_THEME = markdownTheme(clioTheme(), (code, lang) => codeInk(lang, code.split("\n")));
const CHAT_MARKDOWN_OPTIONS = {
	transform: createMermaidMarkdownTransform(clioTheme()),
	renderLatex: true,
} as const;
// TuiAltScreen uses Pi's OSC 133 prompt-start marker for semantic prompt
// navigation. The sequence is zero-width and stripped before terminal output.
const OSC133_PROMPT_START = "\x1b]133;A\x07";

// Prefix and rail SGR constants, previously re-exported by the deleted
// palette.ts. Composing them from fgSequence/GLYPH here yields byte-identical
// sequences to what palette.js produced, so the transcript renders unchanged.
const RESET = SGR_RESET;
const DIM = SGR_DIM;
const TEAL = fgSequence("accent");
const BLUE_REASON = fgSequence("reason");
const RED_CRIT = fgSequence("error");
const GREEN_OK = fgSequence("success");
const AMBER_WARN = fgSequence("warning");
const AGENT_GLYPH = GLYPH.agent;
const USER_BAR = GLYPH.userBar;

/**
 * An assistant turn is a sequence of text and tool segments interleaved in
 * pi-agent-core event order. A tool turn emits assistant `message_update`
 * events carrying `toolcall_*` formation, then `message_end`, then the
 * `tool_execution_*` lifecycle before the next assistant message. Tool calls
 * therefore sit BETWEEN the assistant's pre-tool narration and the post-tool summary. Storing a flat
 * `text` buffer + `tools[]` array (pre-refactor) collapsed that order: all
 * text across the turn concatenated into one line with every tool block
 * appended at the end. The segment list preserves the stream order instead.
 *
 * Each text segment tracks whether it has been finalized by a `message_end`.
 * Streaming deltas render as plain lines; only finalized text is piped
 * through the Markdown renderer. Partial markdown (unclosed fence, half-typed
 * bullet) would otherwise paint garbage at ~60 fps under streaming.
 */
export type { ReasoningTokenProvenance } from "./status/index.js";

export interface ChatPanelTurnUsage {
	elapsedMs?: number;
	outcome?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens?: number;
	reasoningTokenProvenance?: ReasoningTokenProvenance;
	/** Model calls the totals were summed over; absent when the count is unknown. */
	modelCalls?: number;
}

export interface ChatPanelRenderMetrics {
	durationMs: number;
	cacheHit: boolean;
	entriesRendered: number;
}

/**
 * One transcript frame in two parts. `prefix` holds the rows of the settled
 * leading entries and stays the same array from frame to frame until another
 * entry settles or the layout changes; `tail` holds every row after it,
 * rendered for this frame. A caller that keeps its own row buffer copies the
 * prefix only when its identity changes. Neither array is mutated after it is
 * returned, and a frame with nothing new returns the same object.
 */
export interface ChatPanelRegions {
	prefix: readonly string[];
	tail: readonly string[];
}

const NO_ROWS: readonly string[] = Object.freeze([]);

type TextSegment = {
	kind: "text";
	text: string;
	finalized: boolean;
	/**
	 * The segment's Markdown, block by block. Every top-level block the model
	 * has finished is a chunk with its own pi-tui Markdown instance, which
	 * caches by (text, width), so a stable block costs nothing per frame.
	 */
	blocks?: MarkdownBlocks;
	/**
	 * Wrapped output of the open tail block's source lines except the last,
	 * plus the width, the tail's start offset and the line count it was built
	 * at. The tail only grows while streaming: lines before its last one are
	 * newline-terminated and never change, yet every frame re-wrapped all of
	 * them. On a 16k-char answer that was 5-22 ms per frame to reproduce
	 * identical rows.
	 */
	wrapCache?: { width: number; start: number; completedLines: number; lines: string[] };
	/**
	 * Live denoising state while a diffusion model streams whole frames. The
	 * text before `settled` agreed between the last two frames and is shown as
	 * settled prose; the rest is still noise and renders dim. Cleared when the
	 * segment finalizes.
	 */
	diffusion?: { progress: number; settled: number };
	/**
	 * A protocol suggestion line and the answer prose beneath it, when the model
	 * opened its reply with both in one segment (which is what the skills prompt
	 * asks for). The answer half is a segment of its own so it keeps its own
	 * Markdown and wrap caches; it is cached here rather than rebuilt per frame.
	 */
	suggestionSplit?: { suggestion: string; answer: TextSegment };
};
type ToolSegment = {
	kind: "tool";
	id: string;
	name: string;
	args: unknown;
	/** Final result from `tool_execution_end`; undefined while the call is in flight. */
	result?: unknown;
	/** True once `tool_execution_end` has landed (success or error). */
	finished: boolean;
	/** Pi streamed the call row before execution and later starts this same row. */
	executionStarted: boolean;
	/** The assistant stream closed this call's argument block. */
	argsComplete: boolean;
	/**
	 * True when the segment was force-settled without its own end event
	 * (blocked at admission, aborted mid-batch, id reused). A late
	 * `tool_execution_end` may upgrade such a segment with the call's true
	 * result; a segment finished by its own end event is never overwritten.
	 * The explicit `| undefined` allows the upgrade path to clear the flag
	 * under `exactOptionalPropertyTypes: true`.
	 */
	settledWithoutResult?: boolean | undefined;
	/** True when the finished result was an error. Meaningful only after `finished`. */
	isError: boolean;
	/** Wall-clock start time captured by the chat panel for live duration display. */
	startedAtMs?: number;
	/** Completed call duration in milliseconds (event-supplied or measured locally). */
	durationMs?: number;
	/** Persisted result summary (bytes, truncated, offloadPath, observation) from the chat loop. */
	resultSummary?: Record<string, unknown> | undefined;
	/**
	 * Latest cumulative Pi result from `tool_execution_update`, including the
	 * display content and structured progress details. Cleared
	 * back to `undefined` on `tool_execution_end` so the finished `result`
	 * takes over. Only consumed while the call is in flight and its effective
	 * state is expanded. The explicit
	 * `| undefined` is required under `exactOptionalPropertyTypes: true` so
	 * the clear path can re-assign `undefined` without a `delete`.
	 */
	partialResult?: unknown;
	/**
	 * True while the call is parked at the permission gate. Set/cleared by
	 * `tool_approval_state` events and cleared by any settle so a denied or
	 * resumed call never keeps the awaiting-approval styling. Meaningful only
	 * while `!finished`.
	 */
	awaitingApproval?: boolean | undefined;
	/** Live, redacted approval facts. Never reconstructed during replay. */
	approvalView?: ApprovalRequestView | undefined;
	settlement?: "blocked" | "aborted" | "orphaned" | undefined;
	/**
	 * The admission verdict's short reason, present only on a settlement the
	 * registry actually rejected. A blocked row without it states that something
	 * was refused and leaves the operator no way to learn why.
	 */
	blockReason?: string | undefined;
	/**
	 * Working-set eviction reason for a replayed result whose body the
	 * projection has replaced. Set only on rehydrate, from the folded ledger;
	 * a live call is never evicted while it is still being rendered.
	 */
	evictedReason?: string | undefined;
	/** View-only marker: historical calls render mutation diffs without live color. */
	replayed?: true;
};
/**
 * A turn's terminal-error marker (`[error] ...`, `[aborted] ...`,
 * `[stopped: length] ...`) carried as its own segment so it renders in the
 * error token instead of being piped through Markdown as plain prose. Kept
 * distinct from streamed text: the error text is not model output, it is Clio
 * reporting why the turn ended.
 */
type ErrorSegment = {
	kind: "error";
	text: string;
};
/**
 * One stretch of reasoning, in stream order with the text and tool segments
 * around it. A turn used to hold one `thinking` string, so reasoning could only
 * ever render in one place (above everything or below everything) and a
 * turn that thought, wrote, thought again, called a tool, and thought once more
 * had its reasoning pinned at the tail while the prose streamed in above it.
 * Each stretch is its own segment now: it renders where it happened, and the
 * one still open at the tail is the live indicator.
 */
type ThinkingSegment = {
	kind: "thinking";
	text: string;
	/** Closed by the first text, tool, or message_end that follows it. */
	finalized: boolean;
	/** Panel clock when the first delta of this stretch arrived. */
	startedAtMs?: number;
};
type AssistantSegment = TextSegment | ToolSegment | ErrorSegment | ThinkingSegment;
/**
 * A caller-rendered block receives the frame's transcript detail policy so a
 * block such as the operator's `!` bash row follows the same preset as the panel. Blocks that ignore it are unaffected.
 */
type ReplayBlockRenderer = (
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded?: boolean,
	terminalRows?: number,
) => string[];

type TranscriptEntry =
	| { role: "user"; text: string; status?: () => UserTurnStatus }
	| { role: "retryStatus"; status: RetryStatusPayload }
	| {
			role: "assistant";
			segments: AssistantSegment[];
			/**
			 * `segments.length` when the current model call began, so `message_end`
			 * can tell which segments belong to the message it is settling. A
			 * provider that delivers thinking only in the final message (no
			 * `thinking_delta`) gets its thinking segment inserted here, ahead of
			 * the text the same message produced, rather than at the tail.
			 */
			messageStartSegmentIndex?: number | undefined;
			pending: boolean;
			isError: boolean;
			turnUsage?: ChatPanelTurnUsage;
	  }
	/**
	 * A dispatched worker's attributed block. `state` is the live object the worker-stream reducer mutates, so
	 * a streaming delta reaches the screen without copying the entry per frame.
	 * The panel is told when that happened through `applyWorkerState`.
	 */
	| { role: "worker"; state: WorkerEntryState }
	/**
	 * A block the caller renders itself. Most are settled the moment they are
	 * appended, but a few (the operator's `!` bash row) keep mutating the state
	 * their closure reads until the work behind them finishes. Such a block
	 * declares `isLive`, which keeps it out of the frozen prefix and keeps the
	 * panel's time-keyed tick running while it is unsettled.
	 */
	| {
			role: "replayBlock";
			renderBlock: ReplayBlockRenderer;
			isLive?: (() => boolean) | undefined;
	  };

type WorkerTranscriptEntry = Extract<TranscriptEntry, { role: "worker" }>;

/**
 * Whether a painted operator turn exists in the ledger yet. `pending` is the
 * window between the editor being consumed and admission; `refused` is a
 * submit that never reached the durable append.
 */
export type UserTurnStatus = "pending" | "committed" | "refused";

export interface ChatPanel extends Component {
	/**
	 * Paint an operator turn. `status`, when given, is read every frame while it
	 * reports anything but `committed`, so the row the transcript shows before
	 * admission is visibly not the durable turn it will become.
	 */
	appendUser(text: string, status?: () => UserTurnStatus): void;
	/**
	 * Append a caller-rendered block. Pass `isLive` when the closure reads state
	 * that keeps changing after the append, so the panel keeps re-rendering it
	 * instead of treating the first frame as final.
	 */
	appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void;
	applyEvent(event: ChatLoopEvent): void;
	/** Mark a just-rehydrated tool segment so its mutation diff remains plain. */
	markToolReplayed?(toolCallId: string): void;
	/**
	 * Place or refresh a worker's block. The first call for an assignment
	 * inserts the entry (agent origin nests under the tool segment named by
	 * `state.parentToolCallId`, everything else appends); later calls only
	 * invalidate the render, because the reducer mutates the same state object.
	 */
	applyWorkerState(state: WorkerEntryState): void;
	/**
	 * Every worker block on the transcript, oldest first, live or replayed.
	 * `/share` selects from this rather than from the reducer's routing table,
	 * so what the operator can share is exactly what the operator can see.
	 */
	workerStates(): ReadonlyArray<WorkerEntryState>;
	inspectionArtifacts(): ViewArtifact[];
	/** Whether the current preset shows supplied reasoning, for stream pacing. */
	isThinkingExpanded(): boolean;
	/** The frame `render` would return, split at the settled prefix. */
	renderRegions(width: number): ChatPanelRegions;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

export interface ChatPanelOptions {
	getTerminalRows?: () => number;
	/** Live transcript detail mode. Settings changes take effect on the next frame. */
	getOutputStyle?: () => OutputStyle;
	/** Receives measured panel render cost; no FPS claim is made by the panel. */
	onRenderMetrics?: (metrics: ChatPanelRenderMetrics) => void;
	/** Clock injection for deterministic duration tests. Defaults to Date.now. */
	now?: () => number;
	/**
	 * Render every expanded tool body in full, without the live view's
	 * middle-elision or character truncation. `/export` builds a throwaway panel
	 * with this set so the written transcript reproduces the complete tool output
	 * instead of the terminal's bounded view.
	 */
	unboundedToolBodies?: boolean;
}

/**
 * An abort reaches the registry as a rejection, so it arrives here as a block
 * whose reason names it (`run aborted before the operator decided`). Matching
 * that is safe in a way that matching the tool's own output is not: this string
 * is composed by Clio, never by the command that ran.
 */
const ABORTED_REASON_RE = /\babort(?:ed)?\b/i;

/**
 * Classify a finished tool call from the registry's admission verdict, which
 * the turn runtime stamps onto the event as `outcome`. Only a call the registry
 * refused settles as blocked; a call that executed and failed is an ordinary
 * error and carries no settlement. Events with no verdict (replayed history, a
 * surface that resolves tools without telemetry) settle as nothing rather than
 * guessing.
 */
function toolSettlement(event: {
	outcome?: unknown;
	blockReason?: unknown;
}): { settlement: "blocked" | "aborted"; reason?: string } | undefined {
	if (event.outcome !== "blocked") return undefined;
	const reason = typeof event.blockReason === "string" && event.blockReason.trim().length > 0 ? event.blockReason : null;
	const settlement = reason !== null && ABORTED_REASON_RE.test(reason) ? "aborted" : "blocked";
	return reason === null ? { settlement } : { settlement, reason };
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

function extractAssistantThinking(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(item): item is { type: "thinking"; thinking: string } =>
				item?.type === "thinking" && typeof item.thinking === "string",
		)
		.map((item) => item.thinking)
		.join("");
}

/**
 * The panel's view of one assistant message's spend, folded through the same
 * `foldMessageIntoRunTally` the status machine uses. The panel used to
 * re-derive reasoning here with its own provider-lookup-then-estimate rule, so
 * the transcript receipt and the footer could report the same turn differently.
 */
function assistantUsage(message: unknown): ChatPanelTurnUsage | undefined {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
	const tally = foldMessageIntoRunTally(emptyRunTally(), message as AgentMessage);
	const reasoning = reasoningFromTally(tally);
	if (
		tally.inputTokens + tally.outputTokens + tally.cacheReadTokens + tally.cacheWriteTokens === 0 &&
		reasoning.provenance === "unmeasured"
	) {
		return undefined;
	}
	const turnUsage: ChatPanelTurnUsage = {
		inputTokens: tally.inputTokens,
		outputTokens: tally.outputTokens,
		cacheReadTokens: tally.cacheReadTokens,
		cacheWriteTokens: tally.cacheWriteTokens,
		modelCalls: 1,
	};
	if (reasoning.provenance !== "unmeasured") {
		turnUsage.reasoningTokens = reasoning.tokens;
		turnUsage.reasoningTokenProvenance = reasoning.provenance;
	}
	return turnUsage;
}

/** Settled-turn adapter onto the shared projection; the panel's own summary shape. */
function reasoningFromTurnUsage(usage: ChatPanelTurnUsage | undefined): ReasoningUsageView {
	if (!usage || usage.reasoningTokenProvenance === undefined) return UNMEASURED_REASONING;
	return { tokens: Math.max(0, usage.reasoningTokens ?? 0), provenance: usage.reasoningTokenProvenance };
}

function aggregateAssistantUsage(messages: unknown): ChatPanelTurnUsage | undefined {
	if (!Array.isArray(messages)) return undefined;
	const total: ChatPanelTurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	let found = false;
	let provider = false;
	let estimated = false;
	for (const message of messages) {
		const usage = assistantUsage(message);
		if (!usage) continue;
		found = true;
		total.modelCalls = (total.modelCalls ?? 0) + (usage.modelCalls ?? 1);
		total.inputTokens += usage.inputTokens;
		total.outputTokens += usage.outputTokens;
		total.cacheReadTokens += usage.cacheReadTokens;
		total.cacheWriteTokens += usage.cacheWriteTokens;
		if (usage.reasoningTokens !== undefined) {
			total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens;
			if (usage.reasoningTokenProvenance === "provider") provider = true;
			else estimated = true;
		}
	}
	if (!found) return undefined;
	if (provider || estimated)
		total.reasoningTokenProvenance = provider && estimated ? "mixed" : provider ? "provider" : "estimated";
	return total;
}

function extractAssistantTerminalError(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted" && stopReason !== "length") return "";
	if (stopReason === "length") {
		return "[stopped: length] Model target hit its generation/output limit before a complete response. This is not a safety denial. Continue with a shorter answer or lower thinking; use /context compact if the context meter is also near full.";
	}
	const raw = (message as { errorMessage?: unknown }).errorMessage;
	if (isSelfExplainingAbort({ stopReason, errorMessage: raw, text: extractText(message as AgentMessage) })) return "";
	const reason = typeof raw === "string" && raw.length > 0 ? raw : "unknown error";
	return stopReason === "aborted" ? `[aborted] ${reason}` : `[error] ${reason}`;
}

function scopeTerminalErrorAfterSuccessfulTool(
	entry: Extract<TranscriptEntry, { role: "assistant" }>,
	terminalError: string,
): string {
	if (!terminalError.startsWith("[error] ")) return terminalError;
	const successfulTools = entry.segments.filter(
		(segment): segment is ToolSegment => segment.kind === "tool" && segment.finished && !segment.isError,
	);
	if (successfulTools.length === 0) return terminalError;

	const reason = terminalError.slice("[error] ".length);
	const timedOut = /\b(?:timed?\s*out|timeout)\b/i.test(reason);
	const modelFailure = timedOut
		? `main model response timed out after successful tool result: ${reason}`
		: `main model response failed after successful tool result: ${reason}`;
	const detachedDispatchSucceeded = successfulTools.some(
		(segment) =>
			segment.name === "dispatch" &&
			segment.args !== null &&
			typeof segment.args === "object" &&
			(segment.args as { detach?: unknown }).detach === true,
	);
	return `[error] ${modelFailure}${detachedDispatchSucceeded ? "; detached runs continue" : ""}`;
}

/** The thinking segment still receiving deltas, which is always the tail. */
function openThinkingSegment(entry: Extract<TranscriptEntry, { role: "assistant" }>): ThinkingSegment | null {
	const tail = entry.segments[entry.segments.length - 1];
	return tail?.kind === "thinking" && !tail.finalized ? tail : null;
}

/** Index of the last thinking segment, which is where a settled turn's count chip rides. */
function lastThinkingIndex(entry: Extract<TranscriptEntry, { role: "assistant" }>): number {
	for (let index = entry.segments.length - 1; index >= 0; index -= 1) {
		if (entry.segments[index]?.kind === "thinking") return index;
	}
	return -1;
}

function hasVisibleOutput(entry: Extract<TranscriptEntry, { role: "assistant" }>): boolean {
	for (const seg of entry.segments) {
		if (seg.kind === "tool") return true;
		if (seg.kind === "text" && seg.text.trim().length > 0) return true;
		if (seg.kind === "error" && seg.text.trim().length > 0) return true;
	}
	return false;
}

/** Index of the newest assistant entry, optionally restricted to ones that rendered something. */
function lastAssistantIndex(
	transcript: ReadonlyArray<TranscriptEntry>,
	options: { withOutput?: boolean } = {},
): number | null {
	for (let index = transcript.length - 1; index >= 0; index -= 1) {
		const entry = transcript[index];
		if (entry?.role !== "assistant") continue;
		if (options.withOutput === true && !hasVisibleOutput(entry)) continue;
		return index;
	}
	return null;
}

/**
 * Locate the skill-suggestion protocol line inside a reply.
 *
 * The prompt asks the model to begin its reply with the line, but a model
 * that narrates its work first puts the line at the end of the final message
 * about half the time (round-4 skill batches: 1/2 and 0/2 opened, 2/2 fired).
 * The line is recognized at the start of any line, provided it is complete
 * (a newline follows it, or the segment is finalized), so a partially
 * streamed line stays ordinary prose until it is whole. Returns the line's
 * byte range or null.
 */
function findSkillSuggestionLine(seg: TextSegment): { start: number; end: number } | null {
	const text = seg.text;
	let at = text.startsWith(SKILL_SUGGESTION_PREFIX) ? 0 : text.indexOf(`\n${SKILL_SUGGESTION_PREFIX}`);
	if (at < 0) return null;
	if (at > 0) at += 1;
	const lineEnd = text.indexOf("\n", at);
	if (lineEnd < 0) return seg.finalized ? { start: at, end: text.length } : null;
	return { start: at, end: lineEnd };
}

/**
 * Split a reply that carries the skill-suggestion protocol line into that
 * line and the answer around it.
 *
 * The usual shape is one segment holding both. Classifying that whole segment
 * as advisory left the turn with no voice glyph at all: the suggestion did not
 * claim it and the answer never got the chance. The suggestion renders first
 * wherever the model put it, and the answer is the rest of the segment with
 * that line removed. Returns null when the segment is only a suggestion,
 * which stays advisory in full.
 */
function skillSuggestionSplit(seg: TextSegment): { suggestion: string; answer: TextSegment } | null {
	const found = findSkillSuggestionLine(seg);
	if (!found) return null;
	const before = seg.text.slice(0, found.start).replace(/\n+$/, "");
	const after = seg.text.slice(found.end + 1).replace(/^\n+/, "");
	// A model that puts a blank line between the suggestion and the answer left
	// the remainder opening with a newline, so the first rendered row was empty
	// and took the glyph the answer's own text row was owed.
	const answerText = before.length > 0 && after.length > 0 ? `${before}\n${after}` : before + after;
	if (answerText.trim().length === 0) return null;
	const split = seg.suggestionSplit ?? {
		suggestion: "",
		answer: { kind: "text", text: answerText, finalized: seg.finalized } as TextSegment,
	};
	seg.suggestionSplit = split;
	split.suggestion = seg.text.slice(found.start, found.end).replace(/\r$/, "");
	const answer = split.answer;
	if (answer.text === answerText && answer.finalized === seg.finalized) return split;
	// The answer half follows the same cache rules as any other segment: the
	// streaming wrap cache assumes append-only text, so a rewrite or a
	// finalization drops it and a delta keeps it.
	const appendOnly = !seg.finalized && answer.finalized === seg.finalized && answerText.startsWith(answer.text);
	answer.text = answerText;
	answer.finalized = seg.finalized;
	if (!appendOnly) delete answer.wrapCache;
	return split;
}

/**
 * A denoising frame renders in two tones: settled text as it is, the unresolved
 * remainder dim. Frames are few (Mercury settles a block in two or three) and
 * each one rewrites arbitrary positions, so nothing here is cached.
 */
function renderDiffusionFrameLines(seg: TextSegment, settled: number, width: number): string[] {
	const head = seg.text.slice(0, settled);
	const tail = seg.text.slice(settled);
	const lines: string[] = [];
	const headLines = head.split("\n");
	const tailLines = tail.split("\n");
	// The line the boundary falls on carries both tones.
	const joinLine = `${headLines[headLines.length - 1] ?? ""}${tail.length > 0 ? `${DIM}${tailLines[0] ?? ""}${SGR_RESET}` : ""}`;
	for (let i = 0; i < headLines.length - 1; i += 1) {
		for (const line of wrapTextWithAnsi(headLines[i] ?? "", width)) lines.push(line);
	}
	for (const line of wrapTextWithAnsi(joinLine, width)) lines.push(line);
	for (let i = 1; i < tailLines.length; i += 1) {
		for (const line of wrapTextWithAnsi(`${DIM}${tailLines[i] ?? ""}${SGR_RESET}`, width)) lines.push(line);
	}
	return lines;
}

/**
 * One finished top-level Markdown block and the blank rows (`space` tokens)
 * that follow it. `firstType` and `lastType` are the block's first and last
 * token types, which decide the spacing Markdown puts between two blocks.
 */
interface MarkdownChunk {
	raw: string;
	firstType: string;
	lastType: string;
	md: Markdown;
}

interface MarkdownBlocks {
	/**
	 * Tab-expanded source the finished chunks cover, always a prefix of the
	 * segment's tab-expanded text. Tabs expand one for one, so a prefix of the
	 * text expands to a prefix of its expansion.
	 */
	covered: string;
	chunks: MarkdownChunk[];
	/** Markdown for an open growing block (fence, list, quote) at the tail, reused across frames. */
	openFence?: Markdown;
}

/**
 * Split tab-expanded Markdown into top-level chunks with pi-tui's own block
 * lexer: each non-space token opens a chunk and the blank-line tokens after it
 * stay with it. Concatenated, the chunks' `raw` reproduce the source, so a
 * caller can track how much of the text a run of chunks covers.
 */
function markdownChunks(source: string): Array<{ raw: string; firstType: string; lastType: string }> {
	const chunks: Array<{ raw: string; firstType: string; lastType: string }> = [];
	let leading = "";
	for (const token of lexMarkdownBlocks(source)) {
		const raw = token.raw;
		if (token.type === "space") {
			const last = chunks[chunks.length - 1];
			if (last === undefined) leading += raw;
			else {
				last.raw += raw;
				last.lastType = "space";
			}
			continue;
		}
		chunks.push({ raw: `${leading}${raw}`, firstType: token.type, lastType: token.type });
		leading = "";
	}
	if (leading.length > 0) chunks.push({ raw: leading, firstType: "space", lastType: "space" });
	return chunks;
}

/**
 * Whether Markdown puts a blank row between two adjacent blocks, per pi-tui's
 * renderer: after a heading, code, quote, rule, LaTeX block or table when a
 * non-space block follows, and after a paragraph unless a list follows. A
 * chunk that ends in blank-line tokens already renders its own blank row.
 */
function blankBetweenBlocks(previousLast: string, nextFirst: string): boolean {
	if (previousLast === "space" || nextFirst === "space") return false;
	if (previousLast === "paragraph") return nextFirst !== "list";
	return ["heading", "code", "blockquote", "hr", "latexBlock", "table"].includes(previousLast);
}

function chatMarkdown(text: string): Markdown {
	return new Markdown(text, 0, 0, CHAT_MARKDOWN_THEME, undefined, CHAT_MARKDOWN_OPTIONS);
}

/**
 * pi-tui Markdown right-pads lines to the render width. A streamed row is
 * unpadded, so the padding is trimmed to keep the two shapes identical.
 */
function markdownRows(md: Markdown, width: number): string[] {
	return md.render(width).map((line) => line.replace(/ +$/, ""));
}

/**
 * The open tail block while it streams, as plain wrapped source. Lines before
 * the last are newline-terminated and final, so their wrapped rows are cached.
 */
function plainTailRows(seg: TextSegment, text: string, start: number, width: number): string[] {
	const source = text.slice(start).split("\n");
	const completedCount = source.length - 1;
	const cache = seg.wrapCache;
	const reusable =
		cache !== undefined && cache.width === width && cache.start === start && cache.completedLines <= completedCount;
	const completed = reusable ? cache.lines.slice() : [];
	for (let i = reusable ? cache.completedLines : 0; i < completedCount; i += 1) {
		for (const line of wrapTextWithAnsi(source[i] ?? "", width)) completed.push(line);
	}
	seg.wrapCache = { width, start, completedLines: completedCount, lines: completed };
	const wrapped = completed.slice();
	for (const line of wrapTextWithAnsi(source[completedCount] ?? "", width)) wrapped.push(line);
	return wrapped;
}

/**
 * Open blocks whose Markdown rendering only grows at the end as text arrives:
 * a fence renders as a code block that gains rows, a list or quote gains items
 * and lines. They render through Markdown while open, so a tall one is never
 * restyled after its top has scrolled away. A paragraph or table stays plain
 * until it is finished, because a half-typed emphasis marker or a new column
 * width would restyle rows already shown.
 */
const GROWING_BLOCKS: ReadonlySet<string> = new Set(["code", "list", "blockquote"]);

/**
 * A text segment renders block by block, streaming or settled. Each finished
 * top-level block renders through Markdown as soon as a later block begins;
 * only the open block at the tail stays plain while it streams, unless it is
 * one whose rendering only grows (a fence, a list, a quote). A settled
 * answer renders from the same chunks, so finalizing rewrites at most the
 * tail block. Rendering the whole answer through Markdown only at the end
 * changed every row it had streamed, and on a regular-screen terminal a
 * changed row above the viewport costs a full redraw of the transcript.
 */
function renderTextSegmentLines(seg: TextSegment, width: number): string[] {
	if (!seg.finalized && seg.diffusion) {
		return renderDiffusionFrameLines(seg, seg.diffusion.settled, width);
	}
	const source = seg.text.includes("\t") ? seg.text.replace(/\t/g, "   ") : seg.text;
	let blocks = seg.blocks;
	if (blocks === undefined || !source.startsWith(blocks.covered)) {
		blocks = { covered: "", chunks: [] };
		seg.blocks = blocks;
		delete seg.wrapCache;
	}
	const pending = markdownChunks(source.slice(blocks.covered.length));
	// A block is finished once another block follows it; a settled segment has no open block.
	const finished = seg.finalized ? pending.length : Math.max(0, pending.length - 1);
	for (let index = 0; index < finished; index += 1) {
		const chunk = pending[index];
		if (chunk === undefined) continue;
		blocks.chunks.push({ ...chunk, md: chatMarkdown(chunk.raw) });
		blocks.covered += chunk.raw;
	}
	const lines: string[] = [];
	let previousLast: string | undefined;
	for (const chunk of blocks.chunks) {
		if (previousLast !== undefined && blankBetweenBlocks(previousLast, chunk.firstType)) lines.push("");
		for (const row of markdownRows(chunk.md, width)) lines.push(row);
		previousLast = chunk.lastType;
	}
	const open = seg.finalized ? undefined : pending[finished];
	if (open === undefined) {
		delete blocks.openFence;
		return withoutLeadingBlanks(lines);
	}
	if (previousLast !== undefined && blankBetweenBlocks(previousLast, open.firstType)) lines.push("");
	if (GROWING_BLOCKS.has(open.firstType)) {
		blocks.openFence ??= chatMarkdown(open.raw);
		blocks.openFence.setText(open.raw);
		for (const row of markdownRows(blocks.openFence, width)) lines.push(row);
		return withoutLeadingBlanks(lines);
	}
	delete blocks.openFence;
	for (const row of plainTailRows(seg, source, blocks.covered.length, width)) lines.push(row);
	return withoutLeadingBlanks(lines);
}

/**
 * Blank lines a model opens its reply with render as blank rows, and the
 * first row of a prose block carries the voice glyph: it landed on an empty
 * row above the answer.
 */
function withoutLeadingBlanks(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length - 1 && (lines[start] ?? "").length === 0) start += 1;
	return start === 0 ? lines : lines.slice(start);
}

/**
 * Render a terminal-error segment in the error token. Terminal markers such as
 * `[error] ...`, `[aborted] ...`, and `[stopped: length] ...` render as red
 * message text rather than plain markdown, so a failed turn is visibly a
 * failure. Each source line wraps to width and carries the error color.
 */
function renderErrorSegmentLines(seg: ErrorSegment, width: number, unbounded: boolean): string[] {
	const out: string[] = [];
	for (const line of (unbounded ? providerErrorEvidence(seg.text) : presentProviderError(seg.text)).split("\n")) {
		for (const wrapped of wrapTextWithAnsi(line, width)) {
			out.push(`${RED_CRIT}${wrapped}${RESET}`);
		}
	}
	return out;
}

const CLIO_PREFIX = `${TEAL}${AGENT_GLYPH}${RESET} `;
const CLIO_PREFIX_ERROR = `${RED_CRIT}${AGENT_GLYPH}${RESET} `;
/**
 * Operator prompts wear the accent bar on every row and bold text, so the
 * operator's words are never the same weight as the agent prose beneath them.
 */
const USER_PREFIX = `${TEAL}${USER_BAR}${RESET} `;
/**
 * A prompt Clio has taken but not yet committed. The bar is dim rather than
 * teal, the text is not bold, and the row says so, because the transcript used
 * to paint an uncommitted prompt exactly like a durable user turn while the
 * ledger still had no entry for it (issue #251).
 */
const USER_PREFIX_PENDING = `${DIM}${USER_BAR}${RESET} `;
/**
 * The uncommitted-row tails, stored as plain text so their width can be spent
 * against the row's budget before the dim codes go on. Both begin with the
 * separating space they carry when they ride on the end of a body line.
 */
const USER_PENDING_TAIL = " · preparing";
const USER_REFUSED_TAIL = " · not sent";
const PROSE_GUTTER = "  ";
const PROSE_GUTTER_WIDTH = 2;

/**
 * Give transcript prose a fixed two-cell ownership gutter. Callers render the
 * content at `width - 2`, then this function spends those reserved cells on
 * either the turn glyph or a hanging indent. Tool ledgers never pass through
 * here, so their existing full-width grammar remains untouched.
 */
function hangProseLines(lines: string[], firstPrefix?: string): string[] {
	return lines.map((line, index) => `${index === 0 && firstPrefix !== undefined ? firstPrefix : PROSE_GUTTER}${line}`);
}

/**
 * Put an uncommitted row's status tail on the row without letting it push a
 * line past the terminal. The tail used to be concatenated onto the last
 * rendered line unconditionally, so a body that had already folded near the
 * content width came out up to 12 cells past the terminal, and pi-tui's
 * `doRender` throws on an overlong line and kills the process. A `/share` of
 * a worker answer is the ordinary way to hit that: a `research-report` body is
 * JSON with no space to fold at, so an 80-column pane died on any shared body
 * over 58 columns (#257).
 *
 * The tail rides on the last body line when that line has room for it, and
 * drops to its own hanging row when it does not, so it stays whole either way
 * rather than breaking between `·` and the word.
 */
function appendUserRowTail(rendered: string[], tail: string, width: number): void {
	const last = rendered.length - 1;
	const lastLine = rendered[last];
	if (lastLine !== undefined && visibleWidth(lastLine) + tail.length <= width) {
		rendered[last] = `${lastLine}${DIM}${tail}${RESET}`;
		return;
	}
	rendered.push(`${USER_PREFIX_PENDING}${dimLine(tail.trimStart(), Math.max(1, width - PROSE_GUTTER_WIDTH))}`);
}

/**
 * An operator prompt: the bar on every row, the text bold once committed. The
 * bar is what separates the operator's words from the agent's, so it does not
 * stop at the first row the way a voice glyph does.
 */
const SKILL_INVOCATION = /^\/skill\s+\S+/u;

function renderUserLines(text: string, width: number, status: UserTurnStatus): string[] {
	const contentWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	const committed = status === "committed";
	const prefix = committed ? USER_PREFIX : USER_PREFIX_PENDING;
	const rendered: string[] = [];
	const sourceLines = text.split("\n");
	// A `/skill <name>` prompt leads with the command in the slash-command
	// accent, so an explicit skill invocation reads as one rather than as prose.
	const invocation = SKILL_INVOCATION.exec(sourceLines[0] ?? "");
	if (invocation?.[0] !== undefined) {
		sourceLines[0] = `${clioTheme().style("accent", invocation[0], { bold: committed })}${committed ? SGR_BOLD : ""}${(sourceLines[0] ?? "").slice(invocation[0].length)}`;
	}
	for (const sourceLine of sourceLines) {
		for (const row of wrapTextWithAnsi(sourceLine, contentWidth)) {
			rendered.push(`${prefix}${committed && row.length > 0 ? `${SGR_BOLD}${row}${SGR_BOLD_OFF}` : row}`);
		}
	}
	if (rendered[0] !== undefined) rendered[0] = `${OSC133_PROMPT_START}${rendered[0]}`;
	if (!committed) appendUserRowTail(rendered, status === "pending" ? USER_PENDING_TAIL : USER_REFUSED_TAIL, width);
	return rendered;
}

/**
 * Static marker used when thinking is folded. This matches pi-coding-agent's
 * hidden-thinking presentation and avoids previewing reasoning content.
 */
const THINKING_HIDDEN_LABEL = "Thinking · /view";
function dimLine(text: string, width: number): string {
	return `${DIM}${truncateToWidth(text, Math.max(1, width), GLYPH.ellipsis, false)}${RESET}`;
}

/**
 * Supplied reasoning owns the purple rail in the gutter, in every style: a
 * folded marker and an excerpt wear the same mark, and no other block uses a
 * gutter rail, so reasoning never reads as tool output. The excerpt is italic
 * as well as dim because it is the model thinking aloud, not its answer.
 */
const REASON_RAIL = `${BLUE_REASON}│${RESET} `;

/**
 * A closed thinking stretch's folded marker, in place in the segment order. The
 * turn's count chip rides on the last marker of a settled turn (`view` is
 * unmeasured everywhere else), and comes from the settled usage, never from
 * measuring the excerpt the panel happens to be holding.
 */
function renderSettledThinkingMarker(view: ReasoningUsageView, width: number): string {
	const chip = formatReasoningChip(view, compactReasoningTokens);
	return `${REASON_RAIL}${dimLine(
		chip === null ? THINKING_HIDDEN_LABEL : `${THINKING_HIDDEN_LABEL} · ${chip} ${formatReasoningLabel(view)}`,
		Math.max(1, width - PROSE_GUTTER_WIDTH),
	)}`;
}

/** Wrap first, then keep the same tail both while streaming and after settlement. */
function renderThinkingRail(thinking: string, width: number, limit: number, unbounded = false): string[] {
	// Reasoning often ends on a newline; wrapped, that became an empty rail row.
	const text = redactSecretString(thinking).replace(/^\s*\n|\s+$/gu, "");
	if (text.length === 0) return [];
	// A bounded excerpt spends no rows on paragraph breaks; /view keeps them.
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - PROSE_GUTTER_WIDTH));
	const rows = (unbounded ? wrapped : wrapped.filter((row) => row.trim().length > 0)).map(
		(row) => `${REASON_RAIL}${DIM}${SGR_ITALIC}${row}${RESET}`,
	);
	return unbounded ? rows : previewRows(rows, limit, width, true, REASON_RAIL, PROSE_GUTTER_WIDTH);
}

/**
 * `in` is the sum of every model call the turn made, not the size of one
 * prompt. A long agentic turn makes dozens of calls that each resend a growing
 * context, so the total runs far past the model's context window and reads as
 * one impossible request unless the call count is beside it. One live turn
 * reported 717676 input tokens against a 500k window; it was 65 calls of about
 * 11k, which the preceding one-call turns had already shown.
 */
function renderTurnUsageLine(
	usage: ChatPanelTurnUsage,
	width: number,
	receipt: TranscriptDetailPolicy["receipt"],
): string[] {
	if (receipt === "none") return [];
	const outcome = usage.outcome ?? "Done";
	const settled = `${outcome}${usage.elapsedMs === undefined ? "" : ` · ${formatCompactMs(usage.elapsedMs)}`}`;
	const glyph = receiptGlyph(outcome);
	if (receipt === "compact") {
		return [`${glyph}${dimLine(settled, Math.max(1, width - PROSE_GUTTER_WIDTH))}`];
	}
	const calls = usage.modelCalls !== undefined && usage.modelCalls > 1 ? ` over ${usage.modelCalls} calls` : "";
	// The label stays separated from the count in both provenances. Deriving the
	// separator from the `≈` marker glued them together whenever the provider
	// reported a total, which is the common case, and rendered `reason0 provider`.
	// The field is named for reasoning tokens rather than `reason`, which the
	// memory step rows already use for a fixed decision vocabulary.
	//
	// A turn that spent no reasoning tokens states nothing by naming the
	// provenance of zero, and at narrow widths `reasoning 0 provider` orphaned
	// the word `provider` on its own line. Zero suppresses the whole suffix, the
	// same rule the caveat below already follows.
	const view = reasoningFromTurnUsage(usage);
	const reason =
		view.tokens > 0 && view.provenance !== "unmeasured"
			? ` · reasoning ${view.provenance === "provider" ? "" : "≈"}${view.tokens} ${formatReasoningLabel(view)}`
			: "";
	const cache =
		usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0
			? ` · cache ${usage.cacheReadTokens}/${usage.cacheWriteTokens}`
			: "";
	// The caveat is about reasoning text the panel displayed. A turn that spent
	// no reasoning tokens displayed none, so appending it there warned about
	// something absent and cost a wrapped line per turn at narrow widths.
	const caveat = view.tokens > 0 ? " · reasoning text is a UI excerpt, not a verification" : "";
	return hangProseLines(
		wrapTextWithAnsi(
			`${DIM}${settled} · turn · in ${usage.inputTokens}${calls} · out ${usage.outputTokens}${cache}${reason}${caveat}${RESET}`,
			Math.max(1, width - PROSE_GUTTER_WIDTH),
		),
		glyph,
	);
}

/**
 * The receipt closes a turn with its outcome glyph in the gutter, like every
 * other block's mark, so where each turn ended and how is scannable down the
 * left edge. Only the glyph carries color; the facts stay dim.
 */
function receiptGlyph(outcome: string): string {
	if (outcome === "Done") return `${GREEN_OK}${GLYPH.ok}${RESET} `;
	if (outcome === "Failed") return `${RED_CRIT}${GLYPH.error}${RESET} `;
	if (outcome === "Cancelled") return `${DIM}${GLYPH.cancelled}${RESET} `;
	return `${AMBER_WARN}${GLYPH.warn}${RESET} `;
}

function renderToolSegmentLines(
	seg: ToolSegment,
	width: number,
	nowMs: number,
	unbounded: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
): string[] {
	const call = {
		toolCallId: seg.id,
		toolName: seg.name,
		args: seg.args,
		elapsedMs: seg.startedAtMs === undefined ? undefined : Math.max(0, rawDurationMs(seg.startedAtMs, nowMs)),
		phase: seg.executionStarted ? ("running" as const) : seg.argsComplete ? ("ready" as const) : ("forming" as const),
	};
	if (!seg.finished && seg.awaitingApproval) return renderToolAwaitingApproval(call, width, seg.approvalView);
	// Argument fragments are not separate actions. Reveal the row once the call is formed.
	if (!seg.finished && !seg.argsComplete && !seg.executionStarted) return [];
	const finished = {
		...call,
		result: seg.result,
		isError: seg.isError,
		durationMs: seg.durationMs,
		resultSummary: seg.resultSummary,
		outcome: seg.settlement,
		blockReason: seg.blockReason,
		evictedReason: seg.evictedReason,
	};
	const options = { unbounded, diffStyle: seg.replayed ? ("plain" as const) : ("color" as const) };
	if (unbounded && seg.finished) return renderToolExecution(finished, width, options);
	return renderToolPreview(seg.finished ? finished : call, width, detail, {
		...options,
		terminalRows,
		partialResult: seg.partialResult,
	});
}

function observation(seg: AssistantSegment | undefined): string | null {
	if (seg?.kind !== "tool" || !seg.finished) return null;
	return canGroupObservation({
		toolCallId: seg.id,
		toolName: seg.name,
		result: seg.result,
		isError: seg.isError,
		outcome: seg.settlement,
		evictedReason: seg.evictedReason,
		resultSummary: seg.resultSummary,
	})
		? seg.name
		: null;
}

/**
 * One visual unit of an assistant turn: a stretch of reasoning, a prose
 * paragraph run, one action (or a Compact group of observations), or the
 * terminal error. Segments render into blocks first so spacing is decided in
 * one place, by what sits on either side, instead of by each renderer.
 */
interface TurnBlock {
	kind: "thinking" | "prose" | "tool" | "error" | "receipt";
	lines: string[];
	/** An action with nested rows under its action row. */
	body?: boolean;
}

/**
 * Blocks of different kinds are separated by one blank row, so the agent's
 * words, its reasoning, and the actions between them never run together.
 * Consecutive body-less actions stack as a single run, the way a list of reads
 * reads as one step, even when a narrow terminal wraps one of their rows; an
 * action with a body (arguments, output, a diff) opens a gap on both sides so
 * its body cannot be mistaken for its neighbor's.
 */
function joinTurnBlocks(blocks: readonly TurnBlock[]): string[] {
	const out: string[] = [];
	let previous: TurnBlock | undefined;
	for (const raw of blocks) {
		// Markdown can open or close a block on an empty row; the gap between
		// blocks is decided here, so a block's own blank edges would double it.
		const block = { ...raw, lines: trimBlankEdges(raw.lines) };
		if (block.lines.length === 0) continue;
		if (previous !== undefined) {
			const stacked = previous.kind === "tool" && block.kind === "tool" && !previous.body && !block.body;
			if (!stacked) out.push("");
		}
		for (const line of block.lines) out.push(line);
		previous = block;
	}
	return out;
}

function isBlankRow(line: string): boolean {
	return stripTerminalSequences(line).trim().length === 0;
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRow(lines[start] ?? "")) start += 1;
	while (end > start && isBlankRow(lines[end - 1] ?? "")) end -= 1;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

function renderEntryLines(
	entry: TranscriptEntry,
	width: number,
	nowMs: number,
	unboundedToolBodies: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
): string[] {
	if (entry.role === "replayBlock") {
		return entry.renderBlock(width, detail, unboundedToolBodies, terminalRows);
	}
	if (entry.role === "user") {
		return renderUserLines(entry.text, width, entry.status?.() ?? "committed");
	}
	if (entry.role === "retryStatus") {
		return renderRetryStatus(entry.status, width, detail, unboundedToolBodies, terminalRows);
	}
	if (entry.role === "worker") {
		return renderWorkerEntryLines(entry.state, width, { detail, terminalRows, unbounded: unboundedToolBodies, nowMs });
	}
	// A settled assistant entry that rendered nothing at all contributes nothing.
	// A mid-turn notice splits the transcript, so the events after it open a
	// fresh entry that a stopped turn never fills; that entry used to reach the
	// tail below and print a lone agent bubble under the notice.
	if (!entry.pending && entry.turnUsage === undefined && !hasVisibleOutput(entry) && entry.segments.length === 0) {
		return [];
	}
	const blocks: TurnBlock[] = [];
	// Reasoning stays between the prose and actions that surround it.
	const chipIndex = entry.pending ? -1 : lastThinkingIndex(entry);
	const proseWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	for (let segIndex = 0; segIndex < entry.segments.length; segIndex += 1) {
		const seg = entry.segments[segIndex];
		if (seg === undefined) continue;
		if (seg.kind === "thinking") {
			if (seg.text.length === 0) continue;
			if (detail.reasoningRows > 0 || unboundedToolBodies) {
				blocks.push({
					kind: "thinking",
					lines: renderThinkingRail(seg.text, width, previewBudget(detail.reasoningRows, terminalRows), unboundedToolBodies),
				});
			} else {
				const view = segIndex === chipIndex ? reasoningFromTurnUsage(entry.turnUsage) : UNMEASURED_REASONING;
				blocks.push({ kind: "thinking", lines: [renderSettledThinkingMarker(view, width)] });
			}
			continue;
		}
		if (seg.kind === "tool") {
			const kind = detail.style === "compact" && !unboundedToolBodies ? observation(seg) : null;
			let count = 1;
			if (kind) {
				while (entry.segments[segIndex + count] && observation(entry.segments[segIndex + count]) === kind) count++;
			}
			if (kind && count > 1) {
				const targets: string[] = [];
				for (let offset = 0; offset < count; offset++) {
					const grouped = entry.segments[segIndex + offset];
					if (grouped?.kind === "tool") targets.push(observationTarget(grouped.name, grouped.args));
				}
				const lines = renderObservationGroup(kind, targets, width, previewBudget(detail.invocationRows, terminalRows));
				blocks.push({ kind: "tool", lines, body: hasToolBody(lines) });
				segIndex += count - 1;
			} else {
				const lines = renderToolSegmentLines(seg, width, nowMs, unboundedToolBodies, detail, terminalRows);
				blocks.push({ kind: "tool", lines, body: hasToolBody(lines) });
			}
			continue;
		}
		// Every prose block carries the agent glyph on its first row, so narration
		// that resumes after a run of actions reads as the agent speaking again
		// rather than as a caption of the action above it. A skill-suggestion
		// protocol line is advisory rather than the answer: it renders in place
		// without claiming the glyph.
		if (seg.kind === "text" && seg.text.length === 0) continue;
		const split = seg.kind === "text" ? skillSuggestionSplit(seg) : null;
		if (split) {
			const suggestion = hangProseLines(wrapTextWithAnsi(split.suggestion, proseWidth));
			const answerLines = renderTextSegmentLines(split.answer, proseWidth);
			blocks.push({
				kind: "prose",
				lines: answerLines.length === 0 ? suggestion : [...suggestion, ...hangProseLines(answerLines, CLIO_PREFIX)],
			});
			continue;
		}
		let rendered =
			seg.kind === "text"
				? renderTextSegmentLines(seg, proseWidth)
				: renderErrorSegmentLines(seg, proseWidth, unboundedToolBodies);
		if (seg.kind === "error" && !unboundedToolBodies) {
			rendered = previewRows(rendered, previewBudget(detail.errorRows, terminalRows), proseWidth);
		}
		if (rendered.length === 0) continue;
		if (seg.kind === "error") {
			blocks.push({ kind: "error", lines: hangProseLines(rendered, CLIO_PREFIX_ERROR) });
			continue;
		}
		const isSkillSuggestion = findSkillSuggestionLine(seg) !== null;
		blocks.push({ kind: "prose", lines: hangProseLines(rendered, isSkillSuggestion ? undefined : CLIO_PREFIX) });
	}
	if (entry.turnUsage && !entry.pending) {
		blocks.push({ kind: "receipt", lines: renderTurnUsageLine(entry.turnUsage, width, detail.receipt) });
	}
	return joinTurnBlocks(blocks);
}

export function createChatPanel(options: ChatPanelOptions = {}): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	/** Assignment to its placed block, in placement order, so a streaming delta is O(1) to route. */
	const workerEntries = new Map<string, WorkerTranscriptEntry>();
	let dirty = true;
	let runStartedAt: number | undefined;
	/**
	 * Transcript index where the current run's entries begin. A worker block or
	 * a mid-turn notice splits one run across several assistant entries, and
	 * each entry keeps the per-message receipt its last `message_end` gave it;
	 * `agent_end` clears every one of them except the entry that carries the run
	 * total, so a receipt never lands in the middle of a turn.
	 */
	let runStartIndex: number | undefined;
	let cachedWidth: number | undefined;
	let cachedRegions: { prefix: readonly string[]; tail: string[] } = { prefix: NO_ROWS, tail: [] };
	/** The last frame concatenated, built on first request; null until someone asks for it. */
	let cachedLines: string[] | null = [];
	let cachedDetail: TranscriptDetailPolicy | undefined;
	let cachedTick = 0;
	let cachedTerminalRows = 0;
	/**
	 * Did the last executed render put a counting elapsed line on screen? It is
	 * what decides whether the render key carries a time tick at all, so a
	 * transcript with nothing running keeps the old mutation-only invalidation.
	 */
	let renderedRunningTool = false;
	/**
	 * Each stable entry keeps its render for the last few layout keys (width,
	 * height budget, style). Alt+O cycles three styles, and holding one render
	 * per entry made every switch re-render the whole transcript, including a
	 * switch back to the style shown a moment earlier.
	 */
	const entryRenderCache = new Map<TranscriptEntry, Map<string, string[]>>();
	const RENDERS_PER_ENTRY = 3;
	/**
	 * The cache follows the transcript instead of stopping at a fixed 256
	 * entries, which re-rendered everything past the cap on every dirty frame
	 * (10 ms/frame at 800 entries). The ceiling bounds worst-case memory at
	 * roughly 4096 rendered entries; past it, the excess only re-renders on
	 * full-rebuild events (width or style change), which the frozen prefix
	 * below makes rare rather than per-frame.
	 */
	const MIN_ENTRY_RENDER_CACHE = 256;
	const MAX_ENTRY_RENDER_CACHE = 4096;
	const entryCacheCapacity = (): number =>
		Math.max(MIN_ENTRY_RENDER_CACHE, Math.min(MAX_ENTRY_RENDER_CACHE, transcript.length));
	/**
	 * Regular-screen windowed-tail build: the lines of every settled
	 * leading entry are baked into one frozen prefix, so a dirty frame re-renders
	 * only the live tail and re-emits the prefix by reference. TuiMainScreen still
	 * receives the full line array, deliberately: the renderer keeps every
	 * line in `previousLines` and full-redraws (clearing scrollback) when the
	 * head shrinks. Fullscreen mode instead gives the transcript its own pi-tui
	 * ScrollView. The freeze is dropped whenever a frozen entry is invalidated or
	 * the render key changes.
	 */
	let frozen: { lines: string[]; through: number; key: string } | null = null;
	const unboundedToolBodies = options.unboundedToolBodies === true;

	const markDirty = (): void => {
		dirty = true;
	};
	const invalidateEntryCache = (entry: TranscriptEntry): void => {
		entryRenderCache.delete(entry);
		if (frozen !== null && transcript.indexOf(entry) < frozen.through) frozen = null;
	};
	/** Full drop of both render caches; used by the toggle paths that touch many entries. */
	const clearRenderCaches = (): void => {
		entryRenderCache.clear();
		frozen = null;
	};
	/**
	 * A mutation is about to land on the tail entry without an explicit
	 * invalidation. If the freeze extends over the whole transcript, that tail
	 * entry is frozen and the freeze must go.
	 */
	const unfreezeTail = (): void => {
		if (frozen !== null && frozen.through >= transcript.length) frozen = null;
	};

	const now = (): number => options.now?.() ?? Date.now();
	const currentDetail = (): TranscriptDetailPolicy => transcriptDetail(options.getOutputStyle?.());

	/**
	 * Force an in-flight tool segment to a settled error line. A call blocked at
	 * admission (loop guard, safety) or one whose `tool_execution_end` never
	 * arrives (aborted mid-batch, a model that reuses a tool-call id) would
	 * otherwise stay a counting `· N.Ns` running line forever. Settling it with
	 * its OWN elapsed gives it the same visual grammar as any other error
	 * (`✗ · <ms>`), so a blocked call reads like the failure it is.
	 */
	const settleUnfinishedToolSegment = (seg: ToolSegment, settlement: "aborted" | "orphaned" = "orphaned"): void => {
		if (seg.finished) return;
		seg.finished = true;
		seg.isError = true;
		seg.settledWithoutResult = true;
		if (seg.durationMs === undefined && seg.startedAtMs !== undefined) {
			seg.durationMs = Math.max(1, now() - seg.startedAtMs);
		}
		if (seg.result === undefined)
			seg.result = "(no result: the call did not complete; execution was aborted, blocked, or orphaned)";
		seg.settlement = settlement;
		seg.partialResult = undefined;
		seg.awaitingApproval = undefined;
		seg.approvalView = undefined;
	};

	/**
	 * Locate the most recent tool segment with this call id anywhere in the
	 * transcript. A mid-turn notice entry (safety-net block, approval parked,
	 * context-engine notice) splits the transcript, so an in-flight call's
	 * segment can live in an earlier assistant entry than the tail. Unfinished
	 * segments win over finished ones so an id the model reuses binds to the
	 * live call, not the settled one. Among finished segments only a
	 * force-settled one (no end event of its own) is returned: a late true
	 * result may upgrade the synthetic settle, but a segment that finished
	 * with its own result is never rewritten after the fact.
	 */
	/**
	 * First entry of the run that owns `target` when no `agent_start` marked it
	 * (a replayed turn): the entry after the operator prompt that opened it.
	 */
	const runStartFallback = (target: number | null): number => {
		if (target === null) return 0;
		for (let index = target - 1; index >= 0; index -= 1) {
			if (transcript[index]?.role === "user") return index + 1;
		}
		return 0;
	};

	const findToolSegmentOwner = (toolCallId: string): { segment: ToolSegment; entry: TranscriptEntry } | undefined => {
		let settledMatch: { segment: ToolSegment; entry: TranscriptEntry } | undefined;
		for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
			const entry = transcript[entryIndex];
			if (entry?.role !== "assistant") continue;
			for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
				const seg = entry.segments[segIndex];
				if (seg?.kind !== "tool" || seg.id !== toolCallId) continue;
				if (!seg.finished) return { segment: seg, entry };
				if (seg.settledWithoutResult === true) settledMatch ??= { segment: seg, entry };
			}
		}
		return settledMatch;
	};

	const ensureAssistant = (): Extract<TranscriptEntry, { role: "assistant" }> => {
		const last = transcript[transcript.length - 1];
		if (last && last.role === "assistant") {
			// Callers mutate the returned entry (pending, thinking, segments)
			// without always invalidating; a fully-frozen transcript would keep
			// serving the settled render of this tail entry.
			unfreezeTail();
			return last;
		}
		const entry: Extract<TranscriptEntry, { role: "assistant" }> = {
			role: "assistant",
			segments: [],
			pending: false,
			isError: false,
		};
		transcript.push(entry);
		return entry;
	};

	/**
	 * Close the thinking stretch at the tail, if one is open. Anything that
	 * follows reasoning in the stream (text, a tool call, the message settling)
	 * ends that stretch; a later `thinking_delta` opens a new segment after it,
	 * so the transcript keeps the order the model actually worked in.
	 */
	const closeOpenThinking = (entry: Extract<TranscriptEntry, { role: "assistant" }>): void => {
		const open = openThinkingSegment(entry);
		if (open === null) return;
		open.finalized = true;
		invalidateEntryCache(entry);
	};

	const appendThinkingDelta = (entry: Extract<TranscriptEntry, { role: "assistant" }>, delta: string): void => {
		if (delta.length === 0) return;
		invalidateEntryCache(entry);
		const open = openThinkingSegment(entry);
		if (open !== null) {
			open.text += delta;
			return;
		}
		entry.segments.push({ kind: "thinking", text: delta, finalized: false, startedAtMs: now() });
	};

	const appendTextDelta = (entry: Extract<TranscriptEntry, { role: "assistant" }>, delta: string): void => {
		if (delta.length === 0) return;
		invalidateEntryCache(entry);
		closeOpenThinking(entry);
		const tail = entry.segments[entry.segments.length - 1];
		if (tail && tail.kind === "text" && !tail.finalized) {
			tail.text += delta;
			return;
		}
		entry.segments.push({ kind: "text", text: delta, finalized: false });
	};

	/**
	 * Replace this message's live text segment with one whole diffusion frame.
	 * The wrap cache assumes append-only text and a frame rewrites anywhere, so
	 * it is dropped; the settled prefix is what the previous frame and this one
	 * agree on.
	 *
	 * The frame targets the message's frame segment wherever it sits, not the
	 * tail. Mercury repeats the whole frame on every chunk that carries a
	 * tool-call delta and sends the resolved text last, after the tool call has
	 * begun, so a preamble's frames keep arriving while a tool segment is the
	 * tail. Replacing only the tail left a noise frame above the tool line and
	 * the resolved text in a second segment below it.
	 */
	const replaceTextFrame = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		progress: number,
	): void => {
		invalidateEntryCache(entry);
		closeOpenThinking(entry);
		const messageStart = Math.min(entry.messageStartSegmentIndex ?? 0, entry.segments.length);
		let live: TextSegment | undefined;
		for (let index = entry.segments.length - 1; index >= messageStart; index -= 1) {
			const segment = entry.segments[index];
			if (segment?.kind === "text" && !segment.finalized && segment.diffusion) {
				live = segment;
				break;
			}
		}
		const tail = entry.segments[entry.segments.length - 1];
		if (!live && tail && tail.kind === "text" && !tail.finalized) live = tail;
		if (live) {
			const settled = progress >= 1 ? text.length : settledPrefixLength(live.text, text);
			live.text = text;
			delete live.wrapCache;
			live.diffusion = { progress, settled };
			return;
		}
		entry.segments.push({
			kind: "text",
			text,
			finalized: false,
			diffusion: { progress, settled: progress >= 1 ? text.length : 0 },
		});
	};

	/**
	 * Canonicalize the streamed text of a completed assistant message.
	 *
	 * The streamed text is wherever this message put it, not necessarily at the
	 * tail: a message that thinks, writes, and thinks again leaves its text
	 * behind a thinking segment. Looking only at the tail appended the message
	 * text a second time under the reasoning marker, so the answer read twice.
	 *
	 * One streamed segment that is a prefix of the final text (the common case)
	 * is overwritten in place and flipped to finalized so the next render pipes
	 * it through Markdown. Several streamed segments (text split by reasoning)
	 * are each finalized where they stand; the deltas already are the text.
	 * When the message arrived fully formed with no deltas (non-streaming
	 * path, synthetic notices, replay), a fresh finalized segment is appended.
	 * `replaceTail` forces the overwrite for messages the chat loop rewrote
	 * after streaming (locked-turn markup sanitation): the streamed text is dead
	 * there, not a prefix.
	 */
	const canonicalizeMessageText = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		replaceTail = false,
	): void => {
		if (text.length === 0) return;
		closeOpenThinking(entry);
		const messageStart = Math.min(entry.messageStartSegmentIndex ?? 0, entry.segments.length);
		const streamed: TextSegment[] = [];
		for (let index = messageStart; index < entry.segments.length; index += 1) {
			const segment = entry.segments[index];
			if (segment?.kind === "text" && !segment.finalized) streamed.push(segment);
		}
		const finalize = (segment: TextSegment, value: string): void => {
			segment.text = value;
			segment.finalized = true;
			delete segment.diffusion;
			// The plain-tail wrap cache is dead once nothing is open. The finished
			// blocks stay: they cover a prefix of the settled text, and a rewrite
			// that breaks that prefix resets them on the next render.
			delete segment.wrapCache;
		};
		if (replaceTail && streamed.length > 0) {
			const [first, ...rest] = streamed;
			if (first) finalize(first, text);
			for (const dead of rest) entry.segments.splice(entry.segments.indexOf(dead), 1);
			return;
		}
		if (streamed.length === 1 && streamed[0] !== undefined) {
			const only = streamed[0];
			// A diffusion frame is the whole text so far, never a slice of it, so
			// the settled message replaces it even when the last frame was noise.
			if (only.diffusion || text.startsWith(only.text)) {
				finalize(only, text);
				return;
			}
		} else if (streamed.length > 1) {
			for (const segment of streamed) finalize(segment, segment.text);
			return;
		}
		entry.segments.push({ kind: "text", text, finalized: true });
	};

	/**
	 * Append the turn's terminal-error marker as its own error segment so the
	 * render path styles it in the error token rather than piping it through
	 * Markdown as prose. Guards against a duplicate when the same marker arrives
	 * twice for one settled turn.
	 */
	const appendErrorSegment = (entry: Extract<TranscriptEntry, { role: "assistant" }>, text: string): void => {
		const tail = entry.segments[entry.segments.length - 1];
		if (tail?.kind === "error" && tail.text === text) return;
		entry.segments.push({ kind: "error", text });
	};

	/**
	 * Where a newly seen worker block belongs. An agent-origin run nests under
	 * the assistant entry holding the tool call that spawned it, behind any
	 * sibling blocks the same call already placed, so a fan-out reads top to
	 * bottom in spawn order. Everything else, including a run whose parent call
	 * is no longer in the transcript (a detached collect landing turns later),
	 * appends at the tail. null means "append".
	 */
	const workerInsertionIndex = (state: WorkerEntryState): number | null => {
		const parentToolCallId = state.parentToolCallId;
		if (parentToolCallId === undefined) return null;
		const owner = findToolSegmentOwner(parentToolCallId);
		if (owner === undefined) return null;
		const parentIndex = transcript.indexOf(owner.entry);
		if (parentIndex < 0) return null;
		let index = parentIndex + 1;
		while (transcript[index]?.role === "worker") index += 1;
		return index >= transcript.length ? null : index;
	};

	/** True when the entry renders at least one counting elapsed line this frame. */
	const entryHasRunningTool = (entry: TranscriptEntry): boolean =>
		(entry.role === "assistant" &&
			(entry.segments.some(
				(segment) => segment.kind === "tool" && !segment.finished && segment.startedAtMs !== undefined,
				// The live reasoning line counts its own elapsed, so a turn that is
				// only thinking still needs the time-keyed render key.
			) ||
				(entry.pending && openThinkingSegment(entry)?.startedAtMs !== undefined))) ||
		(entry.role === "worker" && entry.state.pending && entry.state.startedAtMs !== undefined) ||
		(entry.role === "replayBlock" && entry.isLive?.() === true) ||
		(entry.role === "user" && (entry.status?.() ?? "committed") !== "committed");

	/**
	 * Settled entries whose render is a pure function of the base key. A live
	 * worker block is excluded for the same reason a running tool is: the
	 * reducer mutates its state object in place, so a cached render would keep
	 * serving the answer as it looked several deltas ago. A replay block that
	 * declares itself live is excluded on the same grounds.
	 */
	const entryIsStable = (entry: TranscriptEntry): boolean =>
		(entry.role === "user" && (entry.status?.() ?? "committed") === "committed") ||
		(entry.role === "replayBlock" && entry.isLive?.() !== true) ||
		(entry.role === "worker" && !entry.state.pending) ||
		(entry.role === "assistant" &&
			!entry.pending &&
			!entry.segments.some((segment) => segment.kind === "tool" && !segment.finished));

	/**
	 * One frame: every row the transcript shows, as the settled prefix the frame
	 * reused and the rows it rendered after it. The prefix is the frozen array
	 * itself, so a streamed token copies no settled row until a consumer asks
	 * for the whole frame.
	 */
	const renderFrame = (width: number): { prefix: readonly string[]; tail: string[] } => {
		const startedAt = performance.now();
		const detail = currentDetail();
		const terminalRows = options.getTerminalRows?.() ?? 40;
		const nowMs = now();
		// `dirty` is set on mutation and never on a tick, so without time in the
		// key a running tool's elapsed counter advanced only when something
		// unrelated invalidated the panel. The tick is the same 100 ms bucket
		// dispatch-board.ts uses for running rows, taken off the injectable
		// clock so a fixed clock still produces byte-stable output, and it is
		// pinned to 0 whenever nothing is counting so a settled transcript
		// re-renders no more often than it did before.
		const tick = renderedRunningTool ? Math.floor(nowMs / 100) : 0;
		if (
			!dirty &&
			cachedWidth === width &&
			cachedTerminalRows === terminalRows &&
			cachedDetail === detail &&
			cachedTick === tick
		) {
			options.onRenderMetrics?.({ durationMs: performance.now() - startedAt, cacheHit: true, entriesRendered: 0 });
			return cachedRegions;
		}
		// Stable entries cache by width, height budget, and preset.
		const baseKey = `${width}|${terminalRows}|${detail.style}`;
		const capacity = entryCacheCapacity();
		if (frozen !== null && frozen.key !== baseKey) frozen = null;
		const prefix = frozen === null ? NO_ROWS : frozen.lines;
		const out: string[] = [];
		const startIndex = frozen === null ? 0 : frozen.through;
		// The freeze extends over the contiguous run of stable leading
		// entries; it grows after the loop by the rows this frame rendered for
		// the entries that joined it.
		let freezeThrough = startIndex;
		let freezeTailRows = 0;
		let freezeOpen = true;
		let entriesRendered = 0;
		// Only entries at or past `startIndex` can hold a running tool: the frozen
		// prefix is by construction a run of stable entries, and stable means no
		// unfinished tool segment.
		let sawRunningTool = false;
		for (let i = startIndex; i < transcript.length; i += 1) {
			const entry = transcript[i];
			if (!entry) continue;
			if (!sawRunningTool && entryHasRunningTool(entry)) sawRunningTool = true;
			// Folded worker cards are a list, not a series of blocks: a fan-out of
			// five scouts costs five rows, which is what makes the folded default
			// worth having. Anything else keeps the blank line between entries.
			const previous = i > 0 ? transcript[i - 1] : undefined;
			const stacksOnPrevious = entry.role === "worker" && previous?.role === "worker" && detail.style === "compact";
			if (i > 0 && !stacksOnPrevious) out.push("");
			const renders = entryRenderCache.get(entry);
			const cached = renders?.get(baseKey);
			const cacheable = i >= transcript.length - capacity && entry.role !== "replayBlock" && entryIsStable(entry);
			if (cacheable && cached !== undefined) {
				// A spread here is slower than a loop for large arrays and blows the
				// stack outright for a single entry that renders enough lines.
				for (const line of cached) out.push(line);
			} else {
				entriesRendered += 1;
				const renderedEntry = renderEntryLines(entry, width, nowMs, unboundedToolBodies, detail, terminalRows);
				for (const line of renderedEntry) out.push(line);
				if (cacheable) {
					const byKey = renders ?? new Map<string, string[]>();
					byKey.set(baseKey, renderedEntry);
					if (byKey.size > RENDERS_PER_ENTRY) {
						const oldestKey = byKey.keys().next().value;
						if (oldestKey !== undefined) byKey.delete(oldestKey);
					}
					if (renders === undefined) entryRenderCache.set(entry, byKey);
					while (entryRenderCache.size > capacity) {
						const oldest = entryRenderCache.keys().next().value;
						if (oldest === undefined) break;
						entryRenderCache.delete(oldest);
					}
				}
			}
			if (freezeOpen && i === freezeThrough && entryIsStable(entry)) {
				freezeThrough = i + 1;
				freezeTailRows = out.length;
			} else {
				freezeOpen = false;
			}
		}
		// The freeze only grows when an entry settles. An unchanged freeze keeps
		// its array, which is what lets a root that holds the prefix skip it.
		if (freezeThrough > startIndex) {
			frozen = {
				lines: prefix.concat(freezeTailRows === out.length ? out : out.slice(0, freezeTailRows)),
				through: freezeThrough,
				key: baseKey,
			};
		}
		cachedRegions = { prefix, tail: out };
		cachedLines = null;
		cachedWidth = width;
		cachedDetail = detail;
		cachedTerminalRows = terminalRows;
		cachedTick = tick;
		renderedRunningTool = sawRunningTool;
		dirty = false;
		options.onRenderMetrics?.({ durationMs: performance.now() - startedAt, cacheHit: false, entriesRendered });
		return cachedRegions;
	};

	/**
	 * The whole frame as one array, built once per changed frame with a single
	 * exact-size copy. A cache hit returns the same array, which callers use as
	 * the signal that nothing moved.
	 */
	const render = (width: number): string[] => {
		const regions = renderFrame(width);
		cachedLines ??= regions.prefix.length === 0 ? regions.tail : regions.prefix.concat(regions.tail);
		return cachedLines;
	};

	return {
		appendUser(text: string, status?: () => UserTurnStatus): void {
			transcript.push({ role: "user", text, ...(status ? { status } : {}) });
			markDirty();
		},
		appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void {
			transcript.push({ role: "replayBlock", renderBlock, isLive });
			markDirty();
		},
		applyWorkerState(state: WorkerEntryState): void {
			const existing = workerEntries.get(state.assignmentId);
			if (existing !== undefined) {
				// The reducer mutated the same state object this entry already holds,
				// so nothing is re-linked; only the cached render is now stale.
				invalidateEntryCache(existing);
				markDirty();
				return;
			}
			const entry: WorkerTranscriptEntry = { role: "worker", state };
			workerEntries.set(state.assignmentId, entry);
			const at = workerInsertionIndex(state);
			if (at === null) {
				transcript.push(entry);
			} else {
				transcript.splice(at, 0, entry);
				if (runStartIndex !== undefined && at <= runStartIndex) runStartIndex += 1;
				// A frozen prefix is a run of indices. Inserting inside it renumbers
				// every entry behind the cut, so the freeze has to go.
				if (frozen !== null && at < frozen.through) frozen = null;
			}
			markDirty();
		},
		workerStates(): ReadonlyArray<WorkerEntryState> {
			return [...workerEntries.values()].map((entry) => entry.state);
		},
		inspectionArtifacts(): ViewArtifact[] {
			const artifacts: ViewArtifact[] = [];
			const add = (title: string, render: () => string[]) => {
				const index = artifacts.length;
				artifacts.push({
					id: `transcript:${index + 1}`,
					category: "transcript",
					title,
					timestamp: now() + index,
					searchText: [title],
					load: async () => ({ format: "text", lines: render().map(redactSecretString) }),
				});
			};
			for (const entry of transcript) {
				if (entry.role === "assistant") {
					for (const seg of entry.segments) {
						if (seg.kind === "error") add("Provider or terminal error", () => providerErrorEvidence(seg.text).split("\n"));
						if (seg.kind === "thinking" && seg.text) add("Thinking · supplied reasoning", () => seg.text.split("\n"));
						if (seg.kind === "tool")
							add(`${seg.name} · ${seg.id}`, () =>
								renderToolExecution(
									{
										toolCallId: seg.id,
										toolName: seg.name,
										args: seg.args,
										result: seg.result ?? seg.partialResult,
										isError: seg.isError,
										outcome: seg.settlement,
										blockReason: seg.blockReason,
										resultSummary: seg.resultSummary,
									},
									120,
									{ unbounded: true, diffStyle: "plain" },
								),
							);
					}
				} else if (entry.role === "retryStatus" && entry.status.errorMessage) {
					add("Provider retry diagnostic", () => providerErrorEvidence(entry.status.errorMessage ?? "").split("\n"));
				} else if (entry.role === "worker") {
					add(`${entry.state.agentId} · worker ${entry.state.runId}`, () =>
						renderWorkerEntryLines(entry.state, 120, { unbounded: true }),
					);
				} else if (entry.role === "replayBlock") {
					add("Session action", () => entry.renderBlock(120, transcriptDetail("detailed"), true));
				}
			}
			return artifacts;
		},
		isThinkingExpanded(): boolean {
			return currentDetail().reasoningRows > 0;
		},
		reset(): void {
			transcript.length = 0;
			runStartedAt = undefined;
			runStartIndex = undefined;
			workerEntries.clear();
			clearRenderCaches();
			markDirty();
		},
		markToolReplayed(toolCallId: string): void {
			const owner = findToolSegmentOwner(toolCallId);
			if (!owner || owner.segment.finished) return;
			invalidateEntryCache(owner.entry);
			owner.segment.replayed = true;
			markDirty();
		},
		applyEvent(event: ChatLoopEvent): void {
			if (event.type === "agent_start") {
				runStartedAt = now();
				runStartIndex = transcript.length;
				return;
			}
			if (event.type === "agent_status") {
				return;
			}
			if (event.type === "notice") {
				// Transcript notices are first-class advisory lines, not assistant
				// messages: render with the bracketed-tag treatment replay lines get.
				if (event.surface !== "transcript") return;
				const text = event.text;
				transcript.push({
					role: "replayBlock",
					renderBlock: (width) => wrapTextWithAnsi(styleTaggedNotice(text), width),
				});
				markDirty();
				return;
			}
			if (event.type === "queued_user_turn") {
				// A queued steer or follow-up the engine just injected. Rendering it
				// here, at injection time, keeps the transcript in the order the
				// model saw: enqueue time shows the text only in the queue panel.
				transcript.push({ role: "user", text: event.display?.text ?? event.text });
				if (event.display) {
					const note = event.display.note;
					transcript.push({ role: "replayBlock", renderBlock: (width) => wrapTextWithAnsi(`  ${note}`, width) });
				}
				markDirty();
				return;
			}
			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent as {
					type?: unknown;
					contentIndex?: unknown;
					partial?: { content?: unknown };
				};
				if (
					assistantEvent.type !== "toolcall_start" &&
					assistantEvent.type !== "toolcall_delta" &&
					assistantEvent.type !== "toolcall_end"
				) {
					return;
				}
				const index = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : -1;
				const content = Array.isArray(assistantEvent.partial?.content) ? assistantEvent.partial.content : [];
				const block = content[index];
				if (block === null || typeof block !== "object" || Array.isArray(block)) return;
				const streamed = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
				if (streamed.type !== "toolCall" || typeof streamed.id !== "string" || streamed.id.length === 0) return;
				const owner = findToolSegmentOwner(streamed.id);
				const existing = owner?.segment;
				if (existing && !existing.finished && !existing.executionStarted) {
					if (owner) invalidateEntryCache(owner.entry);
					existing.name = typeof streamed.name === "string" && streamed.name.length > 0 ? streamed.name : existing.name;
					existing.args = streamed.arguments ?? existing.args;
					existing.argsComplete = assistantEvent.type === "toolcall_end";
				} else if (existing === undefined) {
					const assistant = ensureAssistant();
					assistant.pending = true;
					closeOpenThinking(assistant);
					assistant.segments.push({
						kind: "tool",
						id: streamed.id,
						name: typeof streamed.name === "string" && streamed.name.length > 0 ? streamed.name : "tool",
						args: streamed.arguments ?? {},
						finished: false,
						executionStarted: false,
						argsComplete: assistantEvent.type === "toolcall_end",
						isError: false,
					});
				}
				markDirty();
				return;
			}
			if (event.type === "text_delta") {
				const assistant = ensureAssistant();
				assistant.pending = true;
				appendTextDelta(assistant, event.delta);
				markDirty();
				return;
			}
			if (event.type === "text_frame") {
				const assistant = ensureAssistant();
				assistant.pending = true;
				replaceTextFrame(assistant, event.text, event.progress);
				markDirty();
				return;
			}
			if (event.type === "thinking_delta") {
				// The text itself is never rendered unless the operator expands it;
				// the segment is what keeps reasoning in its place in the stream.
				const assistant = ensureAssistant();
				assistant.pending = true;
				appendThinkingDelta(assistant, event.delta);
				markDirty();
				return;
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				const assistant = ensureAssistant();
				assistant.pending = true;
				assistant.messageStartSegmentIndex = assistant.segments.length;
				markDirty();
				return;
			}
			if (event.type === "tool_execution_start") {
				const streamedOwner = findToolSegmentOwner(event.toolCallId);
				if (streamedOwner !== undefined && !streamedOwner.segment.finished && !streamedOwner.segment.executionStarted) {
					invalidateEntryCache(streamedOwner.entry);
					const streamed = streamedOwner.segment;
					streamed.name = event.toolName;
					streamed.args = event.args;
					streamed.executionStarted = true;
					streamed.argsComplete = true;
					streamed.startedAtMs = now();
					markDirty();
					return;
				}
				// A model that reuses a tool-call id across calls would leave the
				// prior same-id segment unsettled (its end matches the first segment
				// on lookup). Settle any such orphan now, wherever it lives, so it
				// does not linger as a counting running line while this call runs.
				for (const entry of transcript) {
					if (entry.role !== "assistant") continue;
					for (const seg of entry.segments) {
						if (seg.kind === "tool" && seg.id === event.toolCallId && !seg.finished) settleUnfinishedToolSegment(seg);
					}
				}
				const assistant = ensureAssistant();
				// No fold is stored here: the segment's effective state is resolved
				// per frame from the transcript detail policy and the tool's
				// registered presentation, with the operator's override on top.
				assistant.pending = true;
				closeOpenThinking(assistant);
				assistant.segments.push({
					kind: "tool",
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					finished: false,
					executionStarted: true,
					argsComplete: true,
					isError: false,
					startedAtMs: now(),
				});
				markDirty();
				return;
			}
			if (event.type === "tool_approval_state") {
				// Only the entry that owns the segment can change. Clearing the whole
				// 256-entry cache re-rendered every settled turn in the transcript;
				// on a 400-turn session that was 26.7 ms per event, and
				// tool_execution_update fires on every output tick of a running command.
				const owner = findToolSegmentOwner(event.toolCallId);
				if (owner) invalidateEntryCache(owner.entry);
				const tool = owner?.segment;
				if (tool && !tool.finished) {
					tool.awaitingApproval = event.state === "awaiting-approval" ? true : undefined;
					tool.approvalView = event.state === "awaiting-approval" ? event.view : undefined;
					markDirty();
				}
				return;
			}
			if (event.type === "tool_execution_update") {
				// pi-agent emits `partialResult` as a cumulative AgentToolResult.
				// Preserve that full envelope so the renderer can use structured
				// progress details as well as content. Replace rather than append:
				// Pi's update semantics are cumulative, and appending would duplicate
				// every earlier snapshot.
				const owner = findToolSegmentOwner(event.toolCallId);
				if (owner) invalidateEntryCache(owner.entry);
				const tool = owner?.segment;
				if (tool && !tool.finished) {
					tool.partialResult = event.partialResult;
				}
				markDirty();
				return;
			}
			if (event.type === "tool_execution_end") {
				const owner = findToolSegmentOwner(event.toolCallId);
				if (owner) invalidateEntryCache(owner.entry);
				const tool = owner?.segment;
				if (tool) {
					tool.result = event.result;
					tool.isError = event.isError;
					// The chat loop enriches tool_execution_end with durationMs, the
					// persisted resultSummary (bytes, truncated, offloadPath,
					// observation counts), and the registry's admission verdict;
					// carry them so the ledger line and replay render identical facts.
					const enriched = event as {
						durationMs?: unknown;
						resultSummary?: unknown;
						outcome?: unknown;
						blockReason?: unknown;
						evictedReason?: unknown;
					};
					// Replay-only: the rehydrator reads the working-set fold and tags
					// the rows whose bodies the projection has replaced for the model.
					tool.evictedReason =
						typeof enriched.evictedReason === "string" && enriched.evictedReason.length > 0
							? enriched.evictedReason
							: undefined;
					// Settlement is that verdict, never an inference from result text.
					// The text of a tool result is the tool's own output: `node --test`
					// prints `cancelled 0` on every run and a linter can print
					// "blocked" for its own reasons, so matching those words there
					// labelled ordinary command failures as permission blocks and
					// suppressed the output that would have explained them.
					const settled = toolSettlement(enriched);
					tool.settlement = settled?.settlement;
					tool.blockReason = settled?.reason;
					tool.finished = true;
					// The true result replaces a synthetic settle; from here on the
					// segment is model-finished and immutable to later end events.
					tool.settledWithoutResult = undefined;
					if (typeof enriched.durationMs === "number" && Number.isFinite(enriched.durationMs)) {
						tool.durationMs = enriched.durationMs;
					} else if (tool.startedAtMs !== undefined) {
						const elapsed = Math.max(0, now() - tool.startedAtMs);
						if (elapsed > 0) tool.durationMs = elapsed;
					}
					if (
						enriched.resultSummary !== null &&
						typeof enriched.resultSummary === "object" &&
						!Array.isArray(enriched.resultSummary)
					) {
						tool.resultSummary = enriched.resultSummary as Record<string, unknown>;
					}
					// Drop the streaming buffer once the final result has landed; the
					// expanded render switches to `renderToolExecution` and stays
					// stable instead of churning through partial-frame layout. A
					// denied park settles here too, so the awaiting styling must go.
					tool.partialResult = undefined;
					tool.awaitingApproval = undefined;
					tool.approvalView = undefined;
				}
				markDirty();
				return;
			}
			if (event.type === "message_end") {
				const current = transcript[transcript.length - 1];
				let completedStreamedArgs = false;
				if (current?.role === "assistant") {
					for (const segment of current.segments) {
						if (segment.kind !== "tool" || segment.finished || segment.executionStarted || segment.argsComplete) continue;
						segment.argsComplete = true;
						completedStreamedArgs = true;
					}
					if (completedStreamedArgs) invalidateEntryCache(current);
				}
				const text = extractAssistantText(event.message);
				const thinking = extractAssistantThinking(event.message);
				const extractedTerminalError = extractAssistantTerminalError(event.message);
				const terminalError =
					current?.role === "assistant"
						? scopeTerminalErrorAfterSuccessfulTool(current, extractedTerminalError)
						: extractedTerminalError;
				const usage = assistantUsage(event.message);
				if (text.length === 0 && thinking.length === 0 && terminalError.length === 0 && usage === undefined) {
					if (completedStreamedArgs) markDirty();
					return;
				}
				const assistant = ensureAssistant();
				// message_end rewrites exactly one entry: the assistant it lands on.
				invalidateEntryCache(assistant);
				if (usage !== undefined) assistant.turnUsage = usage;
				if (terminalError.length > 0) assistant.isError = true;
				// The message is settled, so whatever reasoning it streamed is closed.
				// A message that carried thinking the panel never saw as deltas (a
				// non-streaming provider, a replayed message) gets one segment at the
				// point this message began, ahead of the text the same message
				// produced, rather than a marker dangling after the answer.
				closeOpenThinking(assistant);
				if (thinking.length > 0) {
					const messageStart = Math.min(assistant.messageStartSegmentIndex ?? 0, assistant.segments.length);
					const streamedThisMessage = assistant.segments
						.slice(messageStart)
						.some((segment) => segment.kind === "thinking" && segment.text.length > 0);
					if (!streamedThisMessage) {
						assistant.segments.splice(messageStart, 0, { kind: "thinking", text: thinking, finalized: true });
					}
				}
				assistant.messageStartSegmentIndex = undefined;
				// The chat loop marks messages it sanitized after streaming (dead
				// tool-call markup on a synthesis-locked turn); the streamed tail
				// must be replaced, not kept alongside a duplicate segment.
				const sanitized = (event as { lockedSynthesisSanitized?: unknown }).lockedSynthesisSanitized === true;
				if (text.length > 0) canonicalizeMessageText(assistant, text, sanitized);
				if (terminalError.length > 0) appendErrorSegment(assistant, terminalError);
				markDirty();
				return;
			}
			if (event.type === "retry_status") {
				const last = transcript[transcript.length - 1];
				if (last?.role === "retryStatus" && last.status.attempt === event.status.attempt) {
					last.status = event.status;
				} else {
					transcript.push({ role: "retryStatus", status: event.status });
				}
				markDirty();
				return;
			}
			if (event.type === "agent_end") {
				// agent_end can touch many entries, but it names every one it touches:
				// the usage caption's target, the later entries whose caption it
				// removes, and any entry it settles or un-pends below. Each is
				// invalidated at the point of mutation instead of dropping the whole
				// cache and re-rendering settled history.
				const runUsage = aggregateAssistantUsage(event.messages);
				if (runUsage !== undefined) {
					// The usage line is a caption on rendered output, so it goes on the
					// last entry that rendered any. A mid-turn notice splits entries, and
					// a turn that stops after one leaves an empty tail entry behind: the
					// run total landed there while the entry above kept its own
					// message_end line, so one turn printed the identical line twice, once
					// on each side of the notice. Entries after the caption rendered
					// nothing and must not carry a second copy.
					const index = lastAssistantIndex(transcript, { withOutput: true }) ?? lastAssistantIndex(transcript);
					const target = index === null ? undefined : transcript[index];
					if (target?.role === "assistant") {
						invalidateEntryCache(target);
						const stop = event.messages.filter((message) => message.role === "assistant").at(-1) as
							| { stopReason?: string }
							| undefined;
						target.turnUsage = {
							...runUsage,
							...(runStartedAt === undefined ? {} : { elapsedMs: Math.max(0, now() - runStartedAt) }),
							outcome:
								stop?.stopReason === "error"
									? "Failed"
									: stop?.stopReason === "aborted"
										? "Cancelled"
										: stop?.stopReason === "length"
											? "Output limit"
											: "Done",
						};
					}
					const firstRunEntry = runStartIndex ?? runStartFallback(index);
					for (let other = firstRunEntry; other < transcript.length; other += 1) {
						if (other === index) continue;
						const sibling = transcript[other];
						if (sibling?.role !== "assistant") continue;
						if (sibling.turnUsage !== undefined) invalidateEntryCache(sibling);
						delete sibling.turnUsage;
					}
				}
				runStartIndex = undefined;
				// The run is over: no tool can still be executing anywhere in the
				// transcript, not just in the tail entry (a mid-turn notice splits
				// entries). Settle any tool segment whose `tool_execution_end` never
				// arrived (blocked at admission, or cut off by an abort) so the
				// ledger never leaves a running line counting past the turn's end,
				// and clear `pending` everywhere so no earlier entry keeps rendering
				// live thinking or status.
				const runWasAborted =
					Array.isArray(event.messages) &&
					event.messages.some(
						(message) =>
							message && typeof message === "object" && (message as { stopReason?: unknown }).stopReason === "aborted",
					);
				for (const entry of transcript) {
					if (entry.role !== "assistant") continue;
					for (const seg of entry.segments) {
						if (seg.kind === "tool" && !seg.finished) {
							invalidateEntryCache(entry);
							settleUnfinishedToolSegment(seg, runWasAborted ? "aborted" : "orphaned");
						}
					}
					if (entry.pending) {
						invalidateEntryCache(entry);
						closeOpenThinking(entry);
						entry.pending = false;
						entry.messageStartSegmentIndex = undefined;
					}
				}
				markDirty();
			}
		},
		render,
		renderRegions: renderFrame,
		invalidate(): void {
			markDirty();
		},
	};
}
