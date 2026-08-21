import { performance } from "node:perf_hooks";
import type { OutputVerbosity } from "../core/defaults.js";
import { SKILL_SUGGESTION_PREFIX } from "../core/skill-activation.js";
import { rawDurationMs } from "../core/timers.js";
import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import { toolPresentationPolicy } from "../tools/presentation.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import { extractText, isSelfExplainingAbort } from "./chat-loop-messages.js";
import type { ApprovalRequestView } from "./permission-overlay.js";
import { codeInk } from "./renderers/code-ink.js";
import { createMermaidMarkdownTransform } from "./renderers/mermaid.js";
import { styleTaggedNotice } from "./renderers/notice.js";
import { formatRetryStatus } from "./renderers/retry-status.js";
import {
	renderToolAwaitingApproval,
	renderToolCallHeader,
	renderToolExecution,
	renderToolRunningStatus,
	renderToolStreamingExecution,
	renderToolSubline,
} from "./renderers/tool-execution.js";
import { renderWorkerEntryLines } from "./renderers/worker-entry.js";
import {
	compactReasoningTokens,
	emptyRunTally,
	foldMessageIntoRunTally,
	formatReasoningChip,
	formatReasoningLabel,
	INLINE_STATUS_INDENT_COLS,
	type ReasoningTokenProvenance,
	type ReasoningUsageView,
	reasoningFromTally,
	type StatusPhase,
	UNMEASURED_REASONING,
	type VerbRender,
} from "./status/index.js";
import { clioTheme, fgSequence, GLYPH, markdownTheme, SGR_DIM, SGR_RESET } from "./theme/index.js";
import {
	type Fold,
	type FoldOverride,
	policyRunningToolFold,
	policyThinkingFold,
	policyToolFold,
	policyWorkerFold,
	resolveFold,
	type TranscriptDetailPolicy,
	toggledFold,
	transcriptDetail,
} from "./transcript-detail.js";
import { type WorkerEntryState, workerAskedByModel } from "./worker-stream.js";

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
const GREEN_OK = fgSequence("success");
const AMBER = fgSequence("warning");
const RED_CRIT = fgSequence("error");
const AGENT_GLYPH = GLYPH.agent;
const USER_GLYPH = GLYPH.user;

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

type TextSegment = {
	kind: "text";
	text: string;
	finalized: boolean;
	/**
	 * Lazy pi-tui Markdown instance owned by the segment. Markdown caches its
	 * output by (text, width) internally, so reusing the instance keeps the
	 * per-frame cost O(1) for stable segments and lets the active entry
	 * invalidate only the tail segment's cache on re-canonicalization.
	 */
	md?: Markdown;
	/**
	 * Wrapped output for every source line except the last, plus the width and
	 * source-line count it was built at. A streaming segment only ever grows at
	 * its tail: source lines before the last one are terminated by a newline and
	 * can never change, yet every frame re-wrapped all of them. On a 16k-char
	 * answer that was 5-22 ms per frame to reproduce identical rows.
	 */
	wrapCache?: { width: number; completedLines: number; lines: string[] };
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
	/**
	 * The operator's explicit fold for this block, or none. The effective state
	 * is this override when set, else what the transcript detail policy gives
	 * the call (through the tool's presentation once it has finished). Cleared
	 * when `/output` changes and when a session is switched in.
	 */
	fold?: FoldOverride;
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
 * block that owns fold state (the operator's `!` bash row) resolves it the same
 * way the panel resolves a model call. Blocks that ignore it are unaffected.
 */
type ReplayBlockRenderer = (width: number, detail: TranscriptDetailPolicy) => string[];
type AssistantStatusLine = { phase: StatusPhase; verb: string; toneHint: VerbRender["toneHint"] };

type TranscriptEntry =
	| { role: "user"; text: string }
	| { role: "retryStatus"; status: RetryStatusPayload }
	| {
			role: "assistant";
			segments: AssistantSegment[];
			/**
			 * The operator's explicit fold for this turn's thinking stretches, or
			 * none. Effective state is this override when set, else the transcript
			 * detail policy. A new turn carries no override: it inherits the
			 * policy, not the last keypress.
			 */
			thinkingFold?: FoldOverride;
			/**
			 * `segments.length` when the current model call began, so `message_end`
			 * can tell which segments belong to the message it is settling. A
			 * provider that delivers thinking only in the final message (no
			 * `thinking_delta`) gets its thinking segment inserted here, ahead of
			 * the text the same message produced, rather than at the tail.
			 */
			messageStartSegmentIndex?: number | undefined;
			pending: boolean;
			statusLine?: AssistantStatusLine | null | undefined;
			isError: boolean;
			turnUsage?: ChatPanelTurnUsage;
	  }
	/**
	 * A dispatched worker's attributed block. The panel owns only the fold
	 * override; `state` is the live object the worker-stream reducer mutates, so
	 * a streaming delta reaches the screen without copying the entry per frame.
	 * The panel is told when that happened through `applyWorkerState`.
	 */
	| { role: "worker"; state: WorkerEntryState; fold?: FoldOverride }
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
			fold?: ReplayBlockFoldControl | undefined;
	  };

type WorkerTranscriptEntry = Extract<TranscriptEntry, { role: "worker" }>;

/**
 * Fold state a caller-rendered block owns. The panel never stores it: the
 * block's closure reads it when rendering, so the panel only needs to resolve
 * and flip it when the operator uses an expand/collapse key, and to clear it
 * when `/output` changes. Same tri-state as a tool segment: an override, or
 * none, over the fold the policy gives the block.
 */
export interface ReplayBlockFoldControl {
	/** The fold the policy gives this block when no override is set. */
	policyFold(detail: TranscriptDetailPolicy): Fold;
	/** The operator's override, or none. */
	fold(): FoldOverride;
	setFold(fold: FoldOverride): void;
}

export interface ChatPanel extends Component {
	appendUser(text: string): void;
	/**
	 * Append a caller-rendered block. Pass `isLive` when the closure reads state
	 * that keeps changing after the append, so the panel keeps re-rendering it
	 * instead of treating the first frame as final.
	 */
	appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean, fold?: ReplayBlockFoldControl): void;
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
	setStatusLine(line: AssistantStatusLine | null): void;
	/**
	 * Publish the live run tally's reasoning projection. The pending entry's
	 * tail line reads this; passing null returns it to unmeasured, which is what
	 * an idle or just-started turn is.
	 */
	setLiveReasoning(view: ReasoningUsageView | null): void;
	/**
	 * Flip the newest foldable block (tool call, worker card, or fold-owning
	 * replay block) away from its effective state. The flip is an override
	 * over the transcript detail policy: under `/output verbose` it folds an
	 * open block, under `/output minimal` it opens a folded one.
	 */
	toggleLastToolExpanded(): boolean;
	/** Set an explicit override on every tool, worker, and fold-owning block at once. */
	toggleAllToolsExpanded(): boolean;
	/**
	 * Drop every operator override so each block returns to what the transcript
	 * detail policy gives it. `/output` changes and session switches do this:
	 * the operator asked for a new baseline, and what they had opened belonged
	 * to the transcript they left. Idempotent.
	 */
	clearFoldOverrides(): void;
	/**
	 * Flip the newest thinking-bearing turn between the one-line dim marker
	 * and the full rail-prefixed body, as an override over the policy. A turn
	 * with no thinking yet is left alone; a new stretch inherits the policy.
	 */
	toggleLastThinking(): boolean;
	toggleAllThinking(): boolean;
	/** Whether live thinking would render open this frame, which presentation pacing consults. */
	isThinkingExpanded(): boolean;
	/** Toggle whether expanded live tool bodies include cumulative partial output. */
	toggleLiveToolOutput(): boolean;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

export interface ChatPanelOptions {
	/**
	 * Resolves the user-visible key string for the `clio.tool.expand`
	 * action, which folds and unfolds the newest tool call or worker block.
	 * Returning a non-empty string surfaces a dim ` (<key>)` hint on the one
	 * surface the key would act on: the latest finished collapsed tool subline,
	 * or the newest folded worker card. Returning undefined or an empty string
	 * suppresses the hint. Called per render so live keybinding changes flow
	 * through.
	 */
	getToolExpandKey?: () => string | undefined;
	/** Live transcript detail mode. Settings changes take effect on the next frame. */
	getOutputVerbosity?: () => OutputVerbosity;
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
		? "main model response timed out after successful tool result"
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

function hasThinking(entry: Extract<TranscriptEntry, { role: "assistant" }>): boolean {
	return entry.segments.some((seg) => seg.kind === "thinking" && seg.text.length > 0);
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

function hasStreamingText(entry: Extract<TranscriptEntry, { role: "assistant" }>): boolean {
	const tail = entry.segments[entry.segments.length - 1];
	return tail?.kind === "text" && !tail.finalized && tail.text.trim().length > 0;
}

/**
 * Split a reply that opens with the skill-suggestion protocol line into that
 * line and the answer beneath it.
 *
 * The prompt asks the model to *begin its reply* with the suggestion, so the
 * usual shape is one segment holding both. Classifying that whole segment as
 * advisory left the turn with no voice glyph at all: the suggestion did not
 * claim it and the answer never got the chance. Returns null when the segment
 * is only a suggestion, which stays advisory in full.
 */
function skillSuggestionSplit(seg: TextSegment): { suggestion: string; answer: TextSegment } | null {
	if (!seg.text.startsWith(SKILL_SUGGESTION_PREFIX)) return null;
	const breakIndex = seg.text.indexOf("\n");
	if (breakIndex < 0) return null;
	// A model that puts a blank line between the suggestion and the answer left
	// the remainder opening with a newline, so the first rendered row was empty
	// and took the glyph the answer's own text row was owed.
	const answerText = seg.text.slice(breakIndex + 1).replace(/^\n+/, "");
	if (answerText.trim().length === 0) return null;
	const split = seg.suggestionSplit ?? {
		suggestion: "",
		answer: { kind: "text", text: answerText, finalized: seg.finalized } as TextSegment,
	};
	seg.suggestionSplit = split;
	split.suggestion = seg.text.slice(0, breakIndex);
	const answer = split.answer;
	if (answer.text === answerText && answer.finalized === seg.finalized) return split;
	// The answer half follows the same cache rules as any other segment: the
	// streaming wrap cache assumes append-only text, so a rewrite or a
	// finalization drops it and a delta keeps it.
	const appendOnly = !seg.finalized && answer.finalized === seg.finalized && answerText.startsWith(answer.text);
	answer.text = answerText;
	answer.finalized = seg.finalized;
	if (!appendOnly) delete answer.wrapCache;
	if (answer.md) answer.md.setText(answerText);
	return split;
}

function renderTextSegmentLines(seg: TextSegment, width: number): string[] {
	if (!seg.finalized) {
		const source = seg.text.split("\n");
		// The final element is the live tail; everything before it is newline-
		// terminated and frozen.
		const completedCount = source.length - 1;
		const cache = seg.wrapCache;
		const reusable = cache !== undefined && cache.width === width && cache.completedLines <= completedCount;
		const completed = reusable ? cache.lines.slice() : [];
		for (let i = reusable ? cache.completedLines : 0; i < completedCount; i += 1) {
			for (const line of wrapTextWithAnsi(source[i] ?? "", width)) completed.push(line);
		}
		seg.wrapCache = { width, completedLines: completedCount, lines: completed };
		const wrapped = completed.slice();
		for (const line of wrapTextWithAnsi(source[completedCount] ?? "", width)) wrapped.push(line);
		return wrapped;
	}
	if (!seg.md) {
		seg.md = new Markdown(seg.text, 0, 0, CHAT_MARKDOWN_THEME, undefined, CHAT_MARKDOWN_OPTIONS);
	}
	// pi-tui Markdown right-pads lines to the render width. If a long streaming
	// reply has already scrolled, flipping the finalized segment from unpadded
	// plain text to padded Markdown changes historical rows and forces a full
	// redraw on terminals that cannot clear scrollback. Trim only that render
	// padding so finalized prose remains byte-stable with the streamed shape.
	return seg.md.render(width).map((line) => line.replace(/ +$/, ""));
}

/**
 * Render a terminal-error segment in the error token. Terminal markers such as
 * `[error] ...`, `[aborted] ...`, and `[stopped: length] ...` render as red
 * message text rather than plain markdown, so a failed turn is visibly a
 * failure. Each source line wraps to width and carries the error color.
 */
function renderErrorSegmentLines(seg: ErrorSegment, width: number): string[] {
	const out: string[] = [];
	for (const line of seg.text.split("\n")) {
		for (const wrapped of wrapTextWithAnsi(line, width)) {
			out.push(`${RED_CRIT}${wrapped}${RESET}`);
		}
	}
	return out;
}

const CLIO_PREFIX = `${TEAL}${AGENT_GLYPH}${RESET} `;
const CLIO_PREFIX_ERROR = `${RED_CRIT}${AGENT_GLYPH}${RESET} `;
const USER_PREFIX = `${TEAL}${USER_GLYPH}${RESET} `;
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
 * Static marker used when thinking is folded. This matches pi-coding-agent's
 * hidden-thinking presentation and avoids previewing reasoning content.
 */
const THINKING_HIDDEN_LABEL = `Thinking${GLYPH.ellipsis}`;
const THINKING_LINE_LIMIT = 12;

function dimLine(text: string, width: number): string {
	return `${DIM}${truncateToWidth(text, Math.max(1, width), GLYPH.ellipsis, false)}${RESET}`;
}

/**
 * A closed thinking stretch's folded marker, in place in the segment order. The
 * turn's count chip rides on the last marker of a settled turn (`view` is
 * unmeasured everywhere else), and comes from the settled usage, never from
 * measuring the excerpt the panel happens to be holding.
 */
function renderSettledThinkingMarker(view: ReasoningUsageView, width: number): string {
	const chip = formatReasoningChip(view, compactReasoningTokens);
	return dimLine(
		chip === null ? THINKING_HIDDEN_LABEL : `${THINKING_HIDDEN_LABEL} · ${chip} ${formatReasoningLabel(view)}`,
		width,
	);
}

/**
 * The live turn's one reasoning line, rendered where the open thinking segment
 * sits, which is the tail of the entry by construction: the first text, tool,
 * or message_end closes it. Anchoring reasoning at the head put it above every
 * streamed segment, so on a long turn the only progress indicator scrolled off
 * the top; pinning one line at the tail put it below prose that streamed in
 * after the model had already moved on, so the transcript read out of order.
 *
 * The count is whatever the run tally has folded so far, so between model calls
 * the line states elapsed and nothing else. Visible thinking text is never
 * counted: that number moved with how much reasoning the provider chose to
 * display, not with what the turn spent.
 */
function renderLiveReasoningLine(view: ReasoningUsageView, elapsedMs: number | undefined, width: number): string {
	const chip = formatReasoningChip(view, compactReasoningTokens);
	const head = chip === null ? THINKING_HIDDEN_LABEL : `Thinking · ${chip} ${formatReasoningLabel(view)}`;
	const seconds = elapsedMs === undefined ? 0 : Math.floor(Math.max(0, elapsedMs) / 1000);
	return dimLine(seconds > 0 ? `${head} · ${seconds}s` : head, width);
}

/**
 * Render the expanded thinking body: the text dimmed behind a dim `│ ` rail,
 * capped at `THINKING_LINE_LIMIT` lines. A streaming turn keeps the tail (the
 * reasoning still arriving); a settled one keeps the head with a
 * `... N more lines hidden` overflow message. Mirrors the tool toggle's
 * lab-notebook minimalism: no colored glyphs, no boxes.
 */
function renderThinkingRail(thinking: string, width: number, streaming: boolean, unbounded = false): string[] {
	if (thinking.length === 0) return [];
	const splitLines = thinking.split("\n");
	let visible: string[];
	if (unbounded) {
		// /export reproduces the whole transcript; the live cap is a screen budget.
		visible = splitLines;
	} else if (streaming) {
		if (splitLines.length > THINKING_LINE_LIMIT) {
			const hiddenCount = splitLines.length - THINKING_LINE_LIMIT;
			visible = [`… ${hiddenCount} earlier lines hidden`, ...splitLines.slice(-THINKING_LINE_LIMIT)];
		} else {
			visible = splitLines;
		}
	} else {
		visible =
			splitLines.length > THINKING_LINE_LIMIT
				? [...splitLines.slice(0, THINKING_LINE_LIMIT), `... ${splitLines.length - THINKING_LINE_LIMIT} more lines hidden`]
				: splitLines;
	}
	const out: string[] = [];
	const bodyWidth = Math.max(1, width - 2);
	for (const raw of visible) {
		const wrappedLines = raw.length === 0 ? [""] : wrapTextWithAnsi(raw, bodyWidth);
		for (const wrapped of wrappedLines) {
			out.push(`${BLUE_REASON}│ ${RESET}${DIM}${wrapped}${RESET}`);
		}
	}
	return out;
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
	if (receipt === "compact") {
		const receipt = truncateToWidth(
			`  turn · in ${usage.inputTokens} · out ${usage.outputTokens}`,
			width,
			GLYPH.ellipsis,
			false,
		);
		return [`${DIM}${receipt}${RESET}`];
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
			? ` reasoning ${view.provenance === "provider" ? "" : "≈"}${view.tokens} ${formatReasoningLabel(view)}`
			: "";
	const cache =
		usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0
			? ` cache ${usage.cacheReadTokens}/${usage.cacheWriteTokens}`
			: "";
	// The caveat is about reasoning text the panel displayed. A turn that spent
	// no reasoning tokens displayed none, so appending it there warned about
	// something absent and cost a wrapped line per turn at narrow widths.
	const caveat = view.tokens > 0 ? " · reasoning text is a UI excerpt, not a verification" : "";
	return wrapTextWithAnsi(
		`${DIM}  turn · in ${usage.inputTokens}${calls} · out ${usage.outputTokens}${cache}${reason}${caveat}${RESET}`,
		width,
	);
}

/** The indent resolveInlineVerb budgets against when it fits the verb to the terminal. */
const STATUS_INDENT = " ".repeat(INLINE_STATUS_INDENT_COLS);

function styleStatusVerb(text: string, toneHint: VerbRender["toneHint"]): string {
	if (toneHint === "error") return `${RED_CRIT}${text}${RESET}`;
	if (toneHint === "warn") return `${AMBER}${text}${RESET}`;
	if (toneHint === "ok") return `${GREEN_OK}${text}${RESET}`;
	return `${DIM}${text}${RESET}`;
}

/**
 * The fold the policy gives a tool segment this frame: the running-tool rule
 * while in flight, the tool body rule (through the tool's own presentation)
 * once finished, and the error rule for a finished failure.
 */
function policySegmentFold(seg: ToolSegment, detail: TranscriptDetailPolicy): Fold {
	if (!seg.finished) return policyRunningToolFold(detail);
	if (seg.isError && detail.errors === "body") return "expanded";
	return policyToolFold(detail, toolPresentationPolicy(seg.name, seg.args));
}

/** Effective state of a tool segment: the operator's override, else the policy. */
function toolSegmentExpanded(seg: ToolSegment, detail: TranscriptDetailPolicy): boolean {
	return resolveFold(seg.fold, policySegmentFold(seg, detail)) === "expanded";
}

function renderToolSegmentLines(
	seg: ToolSegment,
	width: number,
	expandKey: string | undefined,
	latestHintToolId: string | null,
	nowMs: number,
	unboundedToolBodies: boolean,
	detail: TranscriptDetailPolicy,
	liveToolOutput: boolean,
): string[] {
	const hintKey = seg.id === latestHintToolId ? expandKey : undefined;
	const expanded = toolSegmentExpanded(seg, detail);
	const elapsedMs = seg.startedAtMs !== undefined ? Math.max(0, rawDurationMs(seg.startedAtMs, nowMs)) : undefined;
	const phase: "forming" | "ready" | "running" = seg.executionStarted
		? "running"
		: seg.argsComplete
			? "ready"
			: "forming";
	// A parked call is not executing: the awaiting-approval line replaces the
	// counting elapsed spinner in both collapsed and expanded form (there is no
	// body or partial output to expand while the call sits at the gate).
	if (!seg.finished && seg.awaitingApproval === true) {
		return renderToolAwaitingApproval(
			{ toolCallId: seg.id, toolName: seg.name, args: seg.args },
			width,
			seg.approvalView,
		);
	}
	if (!expanded) {
		return renderToolSubline(
			seg.finished
				? {
						toolCallId: seg.id,
						toolName: seg.name,
						args: seg.args,
						result: seg.result,
						isError: seg.isError,
						durationMs: seg.durationMs,
						resultSummary: seg.resultSummary,
						outcome: seg.settlement,
						blockReason: seg.blockReason,
					}
				: { toolCallId: seg.id, toolName: seg.name, args: seg.args, elapsedMs, phase },
			width,
			hintKey,
			{
				diffStyle: seg.replayed === true ? "plain" : "color",
				foldedExtras: detail.toolBody === "folded" ? "none" : "per-tool",
			},
		);
	}
	if (!seg.finished) {
		if (liveToolOutput && seg.partialResult !== undefined) {
			return renderToolStreamingExecution(
				{ toolCallId: seg.id, toolName: seg.name, args: seg.args, elapsedMs, phase },
				width,
				seg.partialResult,
			);
		}
		const call = { toolCallId: seg.id, toolName: seg.name, args: seg.args, elapsedMs, phase };
		return liveToolOutput ? renderToolCallHeader(call, width) : renderToolRunningStatus(call, width);
	}
	return renderToolExecution(
		{
			toolCallId: seg.id,
			toolName: seg.name,
			args: seg.args,
			result: seg.result,
			isError: seg.isError,
			durationMs: seg.durationMs,
			resultSummary: seg.resultSummary,
			outcome: seg.settlement,
			blockReason: seg.blockReason,
		},
		width,
		{ unbounded: unboundedToolBodies, diffStyle: seg.replayed === true ? "plain" : "color" },
	);
}

/**
 * Whether a worker block draws its one-line card this frame: the operator's
 * override when set, else the policy's worker rule, which under the balanced
 * level is the origin default (a run the model asked for folds).
 */
function workerEntryFolded(entry: WorkerTranscriptEntry, detail: TranscriptDetailPolicy): boolean {
	return resolveFold(entry.fold, policyWorkerFold(detail, workerAskedByModel(entry.state))) === "folded";
}

/** Effective state of a turn's thinking stretches: the operator's override, else the policy. */
function thinkingExpanded(
	entry: Extract<TranscriptEntry, { role: "assistant" }>,
	detail: TranscriptDetailPolicy,
): boolean {
	return resolveFold(entry.thinkingFold, policyThinkingFold(detail)) === "expanded";
}

function renderEntryLines(
	entry: TranscriptEntry,
	width: number,
	expandKey: string | undefined,
	latestHintToolId: string | null,
	latestFoldedWorkerId: string | null,
	nowMs: number,
	unboundedToolBodies: boolean,
	detail: TranscriptDetailPolicy,
	liveToolOutput: boolean,
	liveReasoning: ReasoningUsageView,
): string[] {
	if (entry.role === "replayBlock") {
		return entry.renderBlock(width, detail);
	}
	if (entry.role === "user") {
		const contentWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
		const lines: string[] = [];
		for (const sourceLine of entry.text.split("\n")) lines.push(...wrapTextWithAnsi(sourceLine, contentWidth));
		const rendered = hangProseLines(lines, USER_PREFIX);
		if (rendered[0] !== undefined) rendered[0] = `${OSC133_PROMPT_START}${rendered[0]}`;
		return rendered;
	}
	if (entry.role === "retryStatus") {
		return wrapTextWithAnsi(formatRetryStatus(entry.status), width);
	}
	if (entry.role === "worker") {
		return renderWorkerEntryLines(entry.state, width, {
			folded: workerEntryFolded(entry, detail),
			...(expandKey !== undefined && entry.state.assignmentId === latestFoldedWorkerId ? { expandKey } : {}),
			unbounded: unboundedToolBodies,
		});
	}
	// A settled assistant entry that rendered nothing at all contributes nothing.
	// A mid-turn notice splits the transcript, so the events after it open a
	// fresh entry that a stopped turn never fills; that entry used to reach the
	// tail below and print a lone agent bubble under the notice.
	if (!entry.pending && entry.turnUsage === undefined && !hasVisibleOutput(entry) && entry.segments.length === 0) {
		return [];
	}
	const lines: string[] = [];
	const thinkingExpandedNow = thinkingExpanded(entry, detail);
	// Reasoning renders in stream order, between the text and tool segments it
	// came between. A closed stretch is a folded marker (or a head-anchored rail
	// when expanded); the stretch still open while the turn is pending is the
	// live indicator, with the tally's count and its own elapsed. The turn's
	// settled count chip rides on the last marker once the turn has settled.
	const chipIndex = entry.pending ? -1 : lastThinkingIndex(entry);
	const clioPrefix = entry.isError ? CLIO_PREFIX_ERROR : CLIO_PREFIX;
	const proseWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	let labeled = false;
	let liveIndicatorShown = false;
	for (let segIndex = 0; segIndex < entry.segments.length; segIndex += 1) {
		const seg = entry.segments[segIndex];
		if (seg === undefined) continue;
		if (seg.kind === "thinking") {
			if (seg.text.length === 0) continue;
			const live = entry.pending && !seg.finalized;
			if (thinkingExpandedNow) lines.push(...renderThinkingRail(seg.text, width, live, unboundedToolBodies));
			if (live) {
				liveIndicatorShown = true;
				// The bare marker level states that the model is thinking and
				// nothing else: no count, no elapsed. An operator who opened the
				// stretch anyway gets the progress line under the rail.
				lines.push(
					detail.thinking === "marker" && !thinkingExpandedNow
						? dimLine(THINKING_HIDDEN_LABEL, width)
						: renderLiveReasoningLine(
								liveReasoning,
								seg.startedAtMs === undefined ? undefined : Math.max(0, nowMs - seg.startedAtMs),
								width,
							),
				);
			} else if (!thinkingExpandedNow) {
				const view = segIndex === chipIndex ? reasoningFromTurnUsage(entry.turnUsage) : UNMEASURED_REASONING;
				lines.push(renderSettledThinkingMarker(view, width));
			}
			continue;
		}
		if (seg.kind === "tool") {
			lines.push(
				...renderToolSegmentLines(
					seg,
					width,
					expandKey,
					latestHintToolId,
					nowMs,
					unboundedToolBodies,
					detail,
					liveToolOutput,
				),
			);
			continue;
		}
		// Text and error segments share the reply-prefix bookkeeping: the first
		// substantive one carries the agent glyph and every later one hangs plain.
		// A leading skill-suggestion protocol line is advisory rather than the
		// answer, so it renders in place without claiming the turn's voice glyph.
		if (seg.kind === "text" && seg.text.length === 0) continue;
		const split = seg.kind === "text" ? skillSuggestionSplit(seg) : null;
		if (split) {
			// The suggestion line hangs plain and the answer beneath it is ordinary
			// prose, so it claims the glyph when nothing else has.
			lines.push(...hangProseLines(wrapTextWithAnsi(split.suggestion, proseWidth)));
			const answerLines = renderTextSegmentLines(split.answer, proseWidth);
			if (answerLines.length === 0) continue;
			lines.push(...(labeled ? hangProseLines(answerLines) : hangProseLines(answerLines, clioPrefix)));
			labeled = true;
			continue;
		}
		const rendered =
			seg.kind === "text" ? renderTextSegmentLines(seg, proseWidth) : renderErrorSegmentLines(seg, proseWidth);
		if (rendered.length === 0) continue;
		const isSkillSuggestion = seg.kind === "text" && seg.text.startsWith(SKILL_SUGGESTION_PREFIX);
		if (!labeled && !isSkillSuggestion) {
			lines.push(...hangProseLines(rendered, clioPrefix));
			labeled = true;
		} else {
			lines.push(...hangProseLines(rendered));
		}
	}
	if (entry.turnUsage && !entry.pending) lines.push(...renderTurnUsageLine(entry.turnUsage, width, detail.receipt));
	// The open thinking segment's line is the one that speaks for reasoning while
	// the turn runs. The generic thinking verb is suppressed while it shows so
	// the entry never carries two indicators for the same thing.
	const shouldRenderStatus =
		entry.pending &&
		entry.statusLine !== null &&
		entry.statusLine !== undefined &&
		!(entry.statusLine.phase === "writing" && hasStreamingText(entry)) &&
		!(entry.statusLine.phase === "thinking" && liveIndicatorShown);
	if (!labeled && !hasVisibleOutput(entry)) lines.push(clioPrefix.trimEnd());
	if (shouldRenderStatus) {
		lines.push(`${STATUS_INDENT}${styleStatusVerb(entry.statusLine?.verb ?? "", entry.statusLine?.toneHint ?? "muted")}`);
	}
	return lines;
}

export function createChatPanel(options: ChatPanelOptions = {}): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	/** Assignment to its placed block, in placement order, so a streaming delta is O(1) to route. */
	const workerEntries = new Map<string, WorkerTranscriptEntry>();
	let dirty = true;
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];
	let cachedExpandKey: string | undefined;
	let cachedDetail: TranscriptDetailPolicy | undefined;
	let cachedLiveToolOutput: boolean | undefined;
	/**
	 * The verbosity the last frame rendered under, or null before any frame.
	 * A change between frames is the operator asking for a new baseline
	 * (`/output`, or Settings → Terminal), and every override goes with it.
	 */
	let lastVerbosity: OutputVerbosity | undefined | null = null;
	let cachedTick = 0;
	/**
	 * Did the last executed render put a counting elapsed line on screen? It is
	 * what decides whether the render key carries a time tick at all, so a
	 * transcript with nothing running keeps the old mutation-only invalidation.
	 */
	let renderedRunningTool = false;
	const entryRenderCache = new Map<TranscriptEntry, { key: string; lines: string[] }>();
	/**
	 * The cache follows the transcript instead of stopping at a fixed 256
	 * entries, which re-rendered everything past the cap on every dirty frame
	 * (10 ms/frame at 800 entries). The ceiling bounds worst-case memory at
	 * roughly 4096 rendered entries; past it, the excess only re-renders on
	 * full-rebuild events (width change, expand-all), which the frozen prefix
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
	let liveToolOutput = true;
	/**
	 * The run tally's reasoning, projected. It is panel-level rather than
	 * per-entry because only the pending tail entry ever renders it, and that
	 * entry is by definition unfrozen and uncached.
	 */
	let liveReasoning: ReasoningUsageView = UNMEASURED_REASONING;
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

	const resolveExpandKey = (): string | undefined => {
		const key = options.getToolExpandKey?.();
		if (typeof key !== "string" || key.length === 0) return undefined;
		return key;
	};

	const now = (): number => options.now?.() ?? Date.now();

	/** The policy for a frame or a keypress, from whatever the settings say right now. */
	const currentDetail = (): TranscriptDetailPolicy => transcriptDetail(options.getOutputVerbosity?.());

	/**
	 * Drop every operator override. Shared by the panel method and the
	 * verbosity-change path in render, so both leave the same state behind.
	 */
	const dropFoldOverrides = (): void => {
		for (const entry of transcript) {
			if (entry.role === "replayBlock") {
				entry.fold?.setFold(undefined);
				continue;
			}
			if (entry.role === "worker") {
				entry.fold = undefined;
				continue;
			}
			if (entry.role !== "assistant") continue;
			entry.thinkingFold = undefined;
			for (const seg of entry.segments) {
				if (seg.kind === "tool") seg.fold = undefined;
			}
		}
		clearRenderCaches();
		markDirty();
	};

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
			// The streaming wrap cache assumes append-only text. This is the one
			// path that rewrites it wholesale, and finalized segments render through
			// Markdown instead, so the cache is dead here either way.
			delete segment.wrapCache;
			if (segment.md) segment.md.setText(value);
		};
		if (replaceTail && streamed.length > 0) {
			const [first, ...rest] = streamed;
			if (first) finalize(first, text);
			for (const dead of rest) entry.segments.splice(entry.segments.indexOf(dead), 1);
			return;
		}
		if (streamed.length === 1 && streamed[0] !== undefined) {
			const only = streamed[0];
			if (text.startsWith(only.text)) {
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
	 * Who advertises the fold key this frame: the newest worker card whose
	 * effective state is folded, or the newest finished tool subline whose
	 * effective state is folded with no worker card behind it. Effective means
	 * override-or-policy, so the hint follows the block whatever the verbosity.
	 * One surface at most, because the key reaches the newest foldable thing of
	 * either kind, and a chord shown anywhere else would open something the
	 * operator was not looking at. An already-open newest card advertises
	 * nothing, since folding it again needs no invitation.
	 */
	const expandHintOwner = (detail: TranscriptDetailPolicy): { toolId: string | null; workerId: string | null } => {
		let workerMayOwn = true;
		for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
			const entry = transcript[entryIndex];
			if (entry?.role === "worker") {
				return {
					toolId: null,
					workerId: workerMayOwn && workerEntryFolded(entry, detail) ? entry.state.assignmentId : null,
				};
			}
			if (entry?.role !== "assistant") continue;
			for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
				const seg = entry.segments[segIndex];
				if (seg?.kind !== "tool") continue;
				if (seg.finished && !toolSegmentExpanded(seg, detail)) return { toolId: seg.id, workerId: null };
				workerMayOwn = false;
			}
		}
		return { toolId: null, workerId: null };
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

	/** True when the entry owns the tool the expand hint currently points at. */
	const entryContainsHint = (entry: TranscriptEntry, latestHintToolId: string | null): boolean =>
		latestHintToolId !== null &&
		entry.role === "assistant" &&
		entry.segments.some((segment) => segment.kind === "tool" && segment.id === latestHintToolId);

	/** True when the entry renders at least one counting elapsed line this frame. */
	const entryHasRunningTool = (entry: TranscriptEntry): boolean =>
		(entry.role === "assistant" &&
			(entry.segments.some(
				(segment) => segment.kind === "tool" && !segment.finished && segment.startedAtMs !== undefined,
				// The live reasoning line counts its own elapsed, so a turn that is
				// only thinking still needs the time-keyed render key.
			) ||
				(entry.pending && openThinkingSegment(entry)?.startedAtMs !== undefined))) ||
		(entry.role === "replayBlock" && entry.isLive?.() === true);

	/**
	 * Settled entries whose render is a pure function of the base key. A live
	 * worker block is excluded for the same reason a running tool is: the
	 * reducer mutates its state object in place, so a cached render would keep
	 * serving the answer as it looked several deltas ago. A replay block that
	 * declares itself live is excluded on the same grounds.
	 */
	const entryIsStable = (entry: TranscriptEntry): boolean =>
		entry.role === "user" ||
		(entry.role === "replayBlock" && entry.isLive?.() !== true) ||
		(entry.role === "worker" && !entry.state.pending) ||
		(entry.role === "assistant" &&
			!entry.pending &&
			!entry.segments.some((segment) => segment.kind === "tool" && !segment.finished));

	const render = (width: number): string[] => {
		const startedAt = performance.now();
		const expandKey = resolveExpandKey();
		const verbosity = options.getOutputVerbosity?.();
		// A new verbosity is a new baseline: the operator's per-block overrides
		// were answers to the old one, so they go before the frame is built.
		if (lastVerbosity !== null && verbosity !== lastVerbosity) dropFoldOverrides();
		lastVerbosity = verbosity;
		const detail = transcriptDetail(verbosity);
		const nowMs = now();
		// `dirty` is set on mutation and never on a tick, so without time in the
		// key a running tool's elapsed counter advanced only when something
		// unrelated invalidated the panel. The tick is the same 100 ms bucket
		// dispatch-board.ts uses for running rows, taken off the injectable
		// clock so a fixed clock still produces byte-stable output, and it is
		// pinned to 0 whenever nothing is counting so a settled transcript
		// re-renders no more often than it did before.
		const tick = renderedRunningTool ? Math.floor(nowMs / 100) : 0;
		// The hit guard runs before any transcript scan. expandHintOwner
		// walks the whole transcript when the newest tool is expanded or absent, and
		// it is not part of the panel-level key, so computing it above the guard cost
		// a full scan per frame for a value the early return discards.
		if (
			!dirty &&
			cachedWidth === width &&
			cachedExpandKey === expandKey &&
			cachedDetail === detail &&
			cachedLiveToolOutput === liveToolOutput &&
			cachedTick === tick
		) {
			options.onRenderMetrics?.({ durationMs: performance.now() - startedAt, cacheHit: true, entriesRendered: 0 });
			return cachedLines;
		}
		const { toolId: latestHintToolId, workerId: latestFoldedWorkerId } = expandHintOwner(detail);
		// The hint id is deliberately NOT part of the shared key: it changes on
		// every finished collapsed tool, and keying every entry on it re-rendered
		// the entire transcript per tool completion. Only the entry that contains
		// the hint tool renders differently, so only that entry's key carries it.
		// The tick stays out of the entry key: a settled entry renders the same
		// bytes at every tick, and keying it on time would drop the entry cache
		// and the frozen prefix ten times a second. Only the panel-level guard
		// above is time-keyed, so a tick re-renders the live tail and nothing else.
		const baseKey = `${width}|${expandKey ?? ""}|${detail.toolBody}:${detail.runningTool}:${detail.thinking}:${detail.worker}:${detail.receipt}:${detail.errors}|${liveToolOutput}`;
		const capacity = entryCacheCapacity();
		if (frozen !== null && frozen.key !== baseKey) frozen = null;
		const out: string[] = frozen === null ? [] : frozen.lines.slice();
		const startIndex = frozen === null ? 0 : frozen.through;
		// The freeze extends over the contiguous run of stable, hint-free leading
		// entries; it is captured after the loop from what this frame rendered.
		let freezeThrough = startIndex;
		let freezeLineCount = out.length;
		let freezeOpen = frozen !== null || startIndex === 0;
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
			const stacksOnPrevious =
				entry.role === "worker" &&
				previous?.role === "worker" &&
				workerEntryFolded(entry, detail) &&
				workerEntryFolded(previous, detail);
			if (i > 0 && !stacksOnPrevious) out.push("");
			const containsHint =
				entryContainsHint(entry, latestHintToolId) ||
				(entry.role === "worker" && entry.state.assignmentId === latestFoldedWorkerId);
			const entryKey = containsHint ? `${baseKey}|hint:${latestHintToolId}|${latestFoldedWorkerId}` : baseKey;
			const cached = entryRenderCache.get(entry);
			const cacheable = i >= transcript.length - capacity && entry.role !== "replayBlock" && entryIsStable(entry);
			if (cacheable && cached?.key === entryKey) {
				// A spread here is slower than a loop for large arrays and blows the
				// stack outright for a single entry that renders enough lines.
				for (const line of cached.lines) out.push(line);
			} else {
				entriesRendered += 1;
				const renderedEntry = renderEntryLines(
					entry,
					width,
					expandKey,
					latestHintToolId,
					latestFoldedWorkerId,
					nowMs,
					unboundedToolBodies,
					detail,
					liveToolOutput,
					liveReasoning,
				);
				for (const line of renderedEntry) out.push(line);
				if (cacheable) {
					entryRenderCache.set(entry, { key: entryKey, lines: renderedEntry });
					while (entryRenderCache.size > capacity) {
						const oldest = entryRenderCache.keys().next().value;
						if (oldest === undefined) break;
						entryRenderCache.delete(oldest);
					}
				}
			}
			if (freezeOpen && i === freezeThrough && entryIsStable(entry) && !containsHint) {
				freezeThrough = i + 1;
				freezeLineCount = out.length;
			} else {
				freezeOpen = false;
			}
		}
		frozen = freezeThrough > 0 ? { lines: out.slice(0, freezeLineCount), through: freezeThrough, key: baseKey } : null;
		cachedLines = out;
		cachedWidth = width;
		cachedExpandKey = expandKey;
		cachedDetail = detail;
		cachedLiveToolOutput = liveToolOutput;
		cachedTick = tick;
		renderedRunningTool = sawRunningTool;
		dirty = false;
		options.onRenderMetrics?.({ durationMs: performance.now() - startedAt, cacheHit: false, entriesRendered });
		return out;
	};

	return {
		appendUser(text: string): void {
			transcript.push({ role: "user", text });
			markDirty();
		},
		appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean, fold?: ReplayBlockFoldControl): void {
			transcript.push({ role: "replayBlock", renderBlock, isLive, fold });
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
				// A frozen prefix is a run of indices. Inserting inside it renumbers
				// every entry behind the cut, so the freeze has to go.
				if (frozen !== null && at < frozen.through) frozen = null;
			}
			markDirty();
		},
		workerStates(): ReadonlyArray<WorkerEntryState> {
			return [...workerEntries.values()].map((entry) => entry.state);
		},
		toggleLastToolExpanded(): boolean {
			// The key owns the newest foldable thing, whichever kind it is. A worker
			// block the operator just watched land is what they mean by "expand
			// that", not the tool call two screens up that spawned it. Every flip
			// is an override away from the block's effective state, so the same
			// key opens a folded block under minimal and folds an open one under
			// verbose.
			const detail = currentDetail();
			for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
				const entry = transcript[entryIndex];
				// A caller-rendered block that owns fold state (the operator's own
				// `!` bash row) is foldable too, and it is usually the newest thing
				// on screen when the key is pressed.
				if (entry?.role === "replayBlock" && entry.fold !== undefined) {
					entry.fold.setFold(toggledFold(resolveFold(entry.fold.fold(), entry.fold.policyFold(detail))));
					clearRenderCaches();
					markDirty();
					return true;
				}
				if (entry?.role === "worker") {
					entry.fold = workerEntryFolded(entry, detail) ? "expanded" : "folded";
					clearRenderCaches();
					markDirty();
					return true;
				}
				if (entry?.role !== "assistant") continue;
				for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
					const seg = entry.segments[segIndex];
					if (seg?.kind !== "tool") continue;
					seg.fold = toolSegmentExpanded(seg, detail) ? "folded" : "expanded";
					clearRenderCaches();
					markDirty();
					return true;
				}
			}
			return false;
		},
		toggleAllToolsExpanded(): boolean {
			const detail = currentDetail();
			const tools: ToolSegment[] = [];
			const workers: WorkerTranscriptEntry[] = [];
			const blocks: ReplayBlockFoldControl[] = [];
			for (const entry of transcript) {
				if (entry.role === "replayBlock") {
					if (entry.fold !== undefined) blocks.push(entry.fold);
					continue;
				}
				if (entry.role === "worker") {
					workers.push(entry);
					continue;
				}
				if (entry.role !== "assistant") continue;
				for (const seg of entry.segments) {
					if (seg.kind === "tool") tools.push(seg);
				}
			}
			if (tools.length === 0 && workers.length === 0 && blocks.length === 0) return false;
			// One folded block anywhere means "open everything"; otherwise fold
			// everything. Either way every block gets an explicit override.
			const expand =
				tools.some((seg) => !toolSegmentExpanded(seg, detail)) ||
				workers.some((entry) => workerEntryFolded(entry, detail)) ||
				blocks.some((fold) => resolveFold(fold.fold(), fold.policyFold(detail)) === "folded");
			const next: Fold = expand ? "expanded" : "folded";
			for (const seg of tools) seg.fold = next;
			for (const entry of workers) entry.fold = next;
			for (const fold of blocks) fold.setFold(next);
			clearRenderCaches();
			markDirty();
			return true;
		},
		clearFoldOverrides(): void {
			dropFoldOverrides();
		},
		toggleLastThinking(): boolean {
			const detail = currentDetail();
			for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
				const entry = transcript[entryIndex];
				if (entry?.role !== "assistant") continue;
				if (!hasThinking(entry)) continue;
				entry.thinkingFold = thinkingExpanded(entry, detail) ? "folded" : "expanded";
				clearRenderCaches();
				markDirty();
				return true;
			}
			return false;
		},
		toggleAllThinking(): boolean {
			const detail = currentDetail();
			const entries: Array<Extract<TranscriptEntry, { role: "assistant" }>> = [];
			for (const entry of transcript) {
				if (entry.role === "assistant" && hasThinking(entry)) entries.push(entry);
			}
			if (entries.length === 0) return false;
			const expand = entries.some((entry) => !thinkingExpanded(entry, detail));
			for (const entry of entries) entry.thinkingFold = expand ? "expanded" : "folded";
			clearRenderCaches();
			markDirty();
			return true;
		},
		isThinkingExpanded(): boolean {
			// The live stretch lives on the newest assistant entry; its override,
			// if any, is the one that applies. Absent that, the policy answers.
			const detail = currentDetail();
			const index = lastAssistantIndex(transcript);
			const entry = index === null ? undefined : transcript[index];
			return entry?.role === "assistant" ? thinkingExpanded(entry, detail) : policyThinkingFold(detail) === "expanded";
		},
		toggleLiveToolOutput(): boolean {
			liveToolOutput = !liveToolOutput;
			markDirty();
			return liveToolOutput;
		},
		reset(): void {
			transcript.length = 0;
			workerEntries.clear();
			liveReasoning = UNMEASURED_REASONING;
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
				transcript.push({ role: "user", text: event.text });
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
					};
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
						target.turnUsage = runUsage;
					}
					for (let after = (index ?? -1) + 1; after < transcript.length; after += 1) {
						const later = transcript[after];
						if (later?.role !== "assistant") continue;
						if (later.turnUsage !== undefined) invalidateEntryCache(later);
						delete later.turnUsage;
					}
				}
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
						entry.statusLine = null;
						entry.messageStartSegmentIndex = undefined;
					}
				}
				markDirty();
			}
		},
		setLiveReasoning(view: ReasoningUsageView | null): void {
			const next = view ?? UNMEASURED_REASONING;
			if (next.tokens === liveReasoning.tokens && next.provenance === liveReasoning.provenance) return;
			liveReasoning = next;
			// The line lives on the pending tail entry, which the freeze may already
			// cover if nothing has mutated since the last settle.
			unfreezeTail();
			const last = transcript[transcript.length - 1];
			if (last !== undefined) invalidateEntryCache(last);
			markDirty();
		},
		setStatusLine(line): void {
			if (line) {
				const assistant = ensureAssistant();
				assistant.pending = true;
				assistant.statusLine = line;
				markDirty();
				return;
			}
			const last = transcript[transcript.length - 1];
			if (last && last.role === "assistant") {
				unfreezeTail();
				last.statusLine = null;
				markDirty();
			}
		},
		render,
		invalidate(): void {
			markDirty();
		},
	};
}
