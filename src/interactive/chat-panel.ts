import { performance } from "node:perf_hooks";
import type { OutputStyle } from "../core/defaults.js";
import { SKILL_SUGGESTION_PREFIX } from "../core/skill-activation.js";
import { rawDurationMs } from "../core/timers.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
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
import type { ChatLoopEvent, RetryStatusPayload, SpeculativeDispatchCounts } from "./chat-loop.js";
import { extractText, isSelfExplainingAbort } from "./chat-loop-messages.js";
import { coldReasonText } from "./cold-reasons.js";
import type { ApprovalRequestView } from "./permission-overlay.js";
import { codeInk } from "./renderers/code-ink.js";
import { createMermaidMarkdownTransform } from "./renderers/mermaid.js";
import { renderNoticeRow } from "./renderers/notice.js";
import { previewBudget, previewRows } from "./renderers/preview.js";
import { presentProviderError, providerErrorEvidence } from "./renderers/provider-error.js";
import { renderRetryStatus } from "./renderers/retry-status.js";
import { renderSkillSuggestionRow, renderSkillSurfaceRow } from "./renderers/skill-rows.js";
import {
	approvalAxisText,
	hasToolBody,
	renderFoldedGroup,
	renderToolAwaitingApproval,
	renderToolExecution,
	renderToolPreview,
	type ToolExecutionFinished,
	type ToolFoldFamily,
	toolFoldFamily,
	toolRowTitle,
} from "./renderers/tool-execution.js";
import { renderWorkerEntryLines } from "./renderers/worker-entry.js";
import {
	compactReasoningTokens,
	emptyRunTally,
	foldMessageIntoRunTally,
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
	joinFacts,
	markdownTheme,
	releaseSpaces,
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
	/** Why the run's prompt cache was expected to be cold (`prompt_recompiled`, …). */
	coldReasons?: ReadonlyArray<string>;
	/** Settled speculative workers, shown only on the Detailed receipt. */
	prewarm?: SpeculativeDispatchCounts;
}

/**
 * What a replayed run end knows that a live one measures: the duration from
 * the ledger's timestamps and the cold-cache reasons its first call recorded.
 */
export interface ReplayedRunFacts {
	elapsedMs?: number;
	coldReasons?: ReadonlyArray<string>;
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
	/** When the call formed or started: the event's time live, the ledger's on replay. */
	at: number;
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
	/** The axis an operator grant answered, kept past settlement (BT-003). Live only, like `approvalView`. */
	operatorGrant?: string | undefined;
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
	/**
	 * Admission's action class, from the end event (live) or the persisted
	 * result (replay). An unknown dynamic tool is classified by it.
	 */
	actionClass?: string | undefined;
	/**
	 * A worker card spawned by this call sits in the transcript. The card
	 * states the run's task and outcome, so the call's row does not repeat them.
	 */
	cardAttached?: true;
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
	at: number;
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
	/** When the stretch began: the first delta's time live, the ledger's on replay. */
	at: number;
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

/**
 * Every entry and action carries the time it happened (`at`): the event's time
 * live, the ledger entry's on replay. `/view` states each one's age from it.
 */
type TranscriptEntry =
	| { role: "user"; text: string; at: number; status?: () => UserTurnStatus }
	| { role: "retryStatus"; status: RetryStatusPayload; at: number }
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
	| { role: "worker"; state: WorkerEntryState; at: number }
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
			at: number;
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
	 * Stamp what a replay appends with the time of the ledger entry it replays;
	 * undefined returns to the live clock. `/view` states each act's age from it.
	 */
	replayAt?(timestampMs: number | undefined): void;
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
	/**
	 * Run `step` when the process is otherwise idle, again after each call that
	 * returns true. The panel uses it to render settled entries in the two
	 * output styles it is not showing, a few milliseconds at a time, so the
	 * first Alt+O into a style is as cheap as a return to one. Omitted, nothing
	 * is rendered ahead.
	 */
	scheduleIdle?: (step: () => boolean) => void;
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
	// The count says how much reasoning the fold holds, `≈` when Clio estimated it.
	const count =
		view.provenance === "unmeasured" || view.tokens <= 0
			? null
			: `${view.provenance === "provider" ? "" : "≈"}${compactReasoningTokens(view.tokens)} tokens`;
	return `${REASON_RAIL}${dimLine(
		count === null ? THINKING_HIDDEN_LABEL : `${THINKING_HIDDEN_LABEL} · ${count}`,
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
	// Detailed states what the run spent, one fact per field: the calls it made,
	// input and output tokens in the compact token format, what the provider
	// served from its prompt cache, the reasoning it reported (`≈` when Clio
	// estimated it), and why the cache was expected to be cold when nothing was
	// reused. A field with nothing to say is left out.
	const tokens = compactReasoningTokens;
	const facts: string[] = [settled];
	if (usage.modelCalls !== undefined && usage.modelCalls > 1) facts.push(`${usage.modelCalls} calls`);
	facts.push(`in ${tokens(usage.inputTokens)}`, `out ${tokens(usage.outputTokens)}`);
	if (usage.cacheReadTokens > 0) facts.push(`cached ${tokens(usage.cacheReadTokens)}`);
	if (usage.cacheWriteTokens > 0) facts.push(`cache write ${tokens(usage.cacheWriteTokens)}`);
	const view = reasoningFromTurnUsage(usage);
	if (view.tokens > 0 && view.provenance !== "unmeasured") {
		facts.push(`reasoning ${view.provenance === "provider" ? "" : "≈"}${tokens(view.tokens)}`);
	}
	if (usage.cacheReadTokens === 0 && usage.coldReasons !== undefined && usage.coldReasons.length > 0) {
		facts.push(`cold: ${usage.coldReasons.map(coldReasonText).join(", ")}`);
	}
	if (usage.prewarm !== undefined) {
		const prewarm = [
			...(usage.prewarm.adopted > 0 ? [`${usage.prewarm.adopted} adopted`] : []),
			...(usage.prewarm.discarded > 0 ? [`${usage.prewarm.discarded} unused`] : []),
		];
		if (prewarm.length === 0 && usage.prewarm.held > 0) prewarm.push(`${usage.prewarm.held} held`);
		if (prewarm.length > 0) facts.push(`prewarm ${prewarm.join(", ")}`);
	}
	return hangProseLines(
		wrapTextWithAnsi(`${DIM}${joinFacts(facts)}${RESET}`, Math.max(1, width - PROSE_GUTTER_WIDTH)).map(releaseSpaces),
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
		actionClass: seg.actionClass,
		cardAttached: seg.cardAttached,
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
		operatorGrant: seg.operatorGrant,
	};
	const options = { unbounded, diffStyle: seg.replayed ? ("plain" as const) : ("color" as const) };
	if (unbounded && seg.finished) return renderToolExecution(finished, width, options);
	return renderToolPreview(seg.finished ? finished : call, width, detail, {
		...options,
		terminalRows,
		partialResult: seg.partialResult,
	});
}

/** A settled tool segment as the renderers read a finished call. */
function finishedCall(seg: ToolSegment): ToolExecutionFinished {
	return {
		toolCallId: seg.id,
		toolName: seg.name,
		args: seg.args,
		result: seg.result,
		isError: seg.isError,
		durationMs: seg.durationMs,
		outcome: seg.settlement,
		blockReason: seg.blockReason,
		evictedReason: seg.evictedReason,
		resultSummary: seg.resultSummary,
		actionClass: seg.actionClass,
		cardAttached: seg.cardAttached,
		operatorGrant: seg.operatorGrant,
	};
}

/** The Compact fold a settled tool segment joins, or null when it keeps its own row. */
function foldFamily(seg: AssistantSegment | undefined): ToolFoldFamily | null {
	if (seg?.kind !== "tool" || !seg.finished) return null;
	// A fold row cannot say which of its calls the operator allowed.
	if (seg.operatorGrant !== undefined) return null;
	return toolFoldFamily(finishedCall(seg));
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

/**
 * Where a worker card sits in a group of cards: `continues` when it follows a
 * card of the same council round, so the council header is not repeated.
 */
function workerGroupPosition(
	entry: WorkerTranscriptEntry,
	previous: TranscriptEntry | undefined,
): "leads" | "continues" {
	const council = entry.state.council;
	if (council === undefined || previous?.role !== "worker") return "leads";
	const before = previous.state.council;
	return before !== undefined && before.group === council.group && before.round === council.round
		? "continues"
		: "leads";
}

/**
 * Whether a worker card stacks directly under the entry before it, with no
 * blank row: a card of the same council round, a sibling from the same
 * fan-out, a helper row after a helper row, and any card after a card in
 * Compact, where cards are a list.
 */
function stacksUnder(
	entry: TranscriptEntry,
	previous: TranscriptEntry | undefined,
	detail: TranscriptDetailPolicy,
): boolean {
	if (entry.role !== "worker" || previous?.role !== "worker") return false;
	if (detail.style === "compact") return true;
	if (workerGroupPosition(entry, previous) === "continues") return true;
	const parent = entry.state.parentToolCallId;
	if (parent !== undefined && parent === previous.state.parentToolCallId) return true;
	return detail.style !== "detailed" && entry.state.helper === true && previous.state.helper === true;
}

function renderEntryLines(
	entry: TranscriptEntry,
	width: number,
	nowMs: number,
	unboundedToolBodies: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
	previous?: TranscriptEntry,
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
		return renderWorkerEntryLines(entry.state, width, {
			detail,
			terminalRows,
			unbounded: unboundedToolBodies,
			nowMs,
			group: workerGroupPosition(entry, previous),
		});
	}
	// A settled assistant entry that rendered nothing at all contributes nothing.
	// A mid-turn notice splits the transcript, so the events after it open a
	// fresh entry that a stopped turn never fills; that entry used to reach the
	// tail below and print a lone agent bubble under the notice.
	if (!entry.pending && entry.turnUsage === undefined && !hasVisibleOutput(entry) && entry.segments.length === 0) {
		return [];
	}
	const blocks: TurnBlock[] = [];
	const proseWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	// Reasoning stays between the prose and actions that surround it, one block
	// per run of it: stretches that nothing visible separates read as one. A run
	// is held until the block after it is known, because what follows decides
	// its shape: Standard shows the bounded tail of the reasoning behind Clio's
	// words, and the marker for the reasoning behind an action.
	let reasoning = "";
	let lastMarker: TurnBlock | undefined;
	const flushReasoning = (next: "action" | "words"): void => {
		const text = reasoning;
		reasoning = "";
		if (text.trim().length === 0) return;
		const rows = next === "action" ? detail.reasoningBeforeActionRows : detail.reasoningRows;
		if (rows > 0 || unboundedToolBodies) {
			const lines = renderThinkingRail(text, width, previewBudget(rows, terminalRows), unboundedToolBodies);
			blocks.push({ kind: "thinking", lines });
			return;
		}
		lastMarker = { kind: "thinking", lines: [renderSettledThinkingMarker(UNMEASURED_REASONING, width)] };
		blocks.push(lastMarker);
	};
	for (let segIndex = 0; segIndex < entry.segments.length; segIndex += 1) {
		const seg = entry.segments[segIndex];
		if (seg === undefined) continue;
		if (seg.kind === "thinking") {
			reasoning = joinReasoning(reasoning, seg.text);
			continue;
		}
		if (seg.kind === "tool") {
			// Compact folds a run of one fold family (explorations, knowledge
			// lookups, changes) into one row; every other act keeps its own. A
			// thinking model reasons before nearly every call, so the fold spans
			// that reasoning, and the reasoning inside the fold joins the marker
			// ahead of it rather than splitting the run into one-call folds.
			const family = detail.style === "compact" && !unboundedToolBodies ? foldFamily(seg) : null;
			const grouped: ToolSegment[] = [seg];
			let end = segIndex;
			let absorbed = "";
			if (family) {
				let between = "";
				for (let next = segIndex + 1; next < entry.segments.length; next += 1) {
					const candidate = entry.segments[next];
					if (candidate?.kind === "thinking") {
						between = joinReasoning(between, candidate.text);
						continue;
					}
					if (candidate?.kind === "text" && candidate.text.length === 0) continue;
					if (candidate?.kind !== "tool" || foldFamily(candidate) !== family) break;
					grouped.push(candidate);
					end = next;
					absorbed = joinReasoning(absorbed, between);
					between = "";
				}
			}
			if (family && grouped.length > 1) {
				reasoning = joinReasoning(reasoning, absorbed);
				flushReasoning("action");
				const lines = renderFoldedGroup(
					family,
					grouped.map(finishedCall),
					width,
					previewBudget(detail.invocationRows, terminalRows),
				);
				blocks.push({ kind: "tool", lines, body: hasToolBody(lines) });
				segIndex = end;
			} else {
				flushReasoning("action");
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
		// A skill suggestion is advice for the operator, not the answer: it reads
		// `§ suggests /skill <name>` as its own row, ahead of the answer wherever
		// the model put it.
		const split = seg.kind === "text" ? skillSuggestionSplit(seg) : null;
		if (split) {
			flushReasoning("words");
			blocks.push({ kind: "tool", lines: renderSkillSuggestionRow(split.suggestion, width), body: false });
			const answerLines = renderTextSegmentLines(split.answer, proseWidth);
			if (answerLines.length > 0) blocks.push({ kind: "prose", lines: hangProseLines(answerLines, CLIO_PREFIX) });
			continue;
		}
		const suggestionOnly = seg.kind === "text" ? findSkillSuggestionLine(seg) : null;
		if (seg.kind === "text" && suggestionOnly !== null) {
			flushReasoning("words");
			blocks.push({
				kind: "tool",
				lines: renderSkillSuggestionRow(seg.text.slice(suggestionOnly.start, suggestionOnly.end), width),
				body: false,
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
		flushReasoning("words");
		if (seg.kind === "error") {
			blocks.push({ kind: "error", lines: hangProseLines(rendered, CLIO_PREFIX_ERROR) });
			continue;
		}
		blocks.push({ kind: "prose", lines: hangProseLines(rendered, CLIO_PREFIX) });
	}
	// Reasoning at the tail is either still streaming or the turn's last word.
	flushReasoning("words");
	// A settled turn's last marker states how much reasoning its folds hold.
	if (lastMarker !== undefined && !entry.pending && detail.reasoningRows === 0) {
		lastMarker.lines = [renderSettledThinkingMarker(reasoningFromTurnUsage(entry.turnUsage), width)];
	}
	if (entry.turnUsage && !entry.pending) {
		blocks.push({ kind: "receipt", lines: renderTurnUsageLine(entry.turnUsage, width, detail.receipt) });
	}
	return joinTurnBlocks(blocks);
}

/** Two stretches of one run of reasoning, as one text. */
function joinReasoning(before: string, next: string): string {
	if (next.length === 0) return before;
	return before.length === 0 ? next : `${before}\n${next}`;
}

const OUTPUT_STYLE_CYCLE: readonly OutputStyle[] = ["compact", "standard", "detailed"];

const WARM_ANSWER = [
	"## Warm",
	"",
	"A paragraph with **bold**, `code`, a [link](https://example.com) and $x^2$.",
	"",
	"- one item",
	"- another item",
	"",
	"```ts",
	'export const answer = 42; // "warm"',
	"```",
].join("\n");

/**
 * Render one representative answer and one action row of each common kind
 * through the transcript's own renderers, in every output style, and throw the
 * rows away. The first Markdown render in a process pays for the lexer, the
 * LaTeX extension, code ink and the compiler: 13 to 17 ms measured in a fresh
 * process, against 0.06 ms warm. Paid mid-stream, that was a stall in the
 * first paragraph of the first answer, and the p99 streamed frame of a short
 * session. Call once after the first hydrated frame, never while streaming.
 */
export function warmTranscriptRender(width: number): void {
	const safeWidth = Math.max(20, Math.floor(width));
	renderUserLines("Warm the transcript.", safeWidth, "committed");
	renderTextSegmentLines({ kind: "text", text: WARM_ANSWER, finalized: true }, safeWidth - PROSE_GUTTER_WIDTH);
	const calls: ToolExecutionFinished[] = [
		{
			toolCallId: "warm-read",
			toolName: "read",
			args: { path: "src/index.ts" },
			result: { content: [{ type: "text", text: "1  export const a = 1;" }], details: {} },
			isError: false,
			durationMs: 4,
		},
		{
			toolCallId: "warm-bash",
			toolName: "bash",
			args: { command: "pnpm test" },
			result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } },
			isError: false,
			durationMs: 900,
		},
		{
			toolCallId: "warm-edit",
			toolName: "edit",
			args: { path: "src/index.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] },
			result: {
				content: [{ type: "text", text: "Edited src/index.ts" }],
				details: { diff: "-1 export const a = 1;\n+1 export const a = 2;" },
			},
			isError: false,
			durationMs: 6,
		},
	];
	for (const style of ["standard", "compact", "detailed"] as const) {
		const detail = transcriptDetail(style);
		for (const call of calls) renderToolPreview(call, safeWidth, detail);
	}
}

export function createChatPanel(options: ChatPanelOptions = {}): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	/** Assignment to its placed block, in placement order, so a streaming delta is O(1) to route. */
	const workerEntries = new Map<string, WorkerTranscriptEntry>();
	let dirty = true;
	let runStartedAt: number | undefined;
	/** Why the current run's prompt cache may be cold, from the chat loop's cache notice. */
	let runColdReasons: ReadonlyArray<string> = [];
	/**
	 * Transcript index where the current run's entries begin. A worker block or
	 * a mid-turn notice splits one run across several assistant entries, and
	 * each entry keeps the per-message receipt its last `message_end` gave it;
	 * `agent_end` clears every one of them except the entry that carries the run
	 * total, so a receipt never lands in the middle of a turn.
	 */
	let runStartIndex: number | undefined;
	/** The latest settled receipt eligible for the turn's post-settlement prewarm record. */
	let lastSettledReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null = null;
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
	/**
	 * Settled entries are rendered ahead, in idle time, in the styles Alt+O
	 * cycles to, into the same per-entry cache a revisit reads. A first visit to
	 * a style used to render every entry on the keystroke: 195 ms at 2,000
	 * entries, against about 1 ms for a style already shown. `next` is the first
	 * entry not yet rendered ahead; an invalidation or an insertion behind it
	 * moves it back. Each step spends at most a few milliseconds, and the
	 * scheduler runs steps only while nothing streams.
	 */
	let prerender: { width: number; terminalRows: number; style: OutputStyle; next: number } | null = null;
	let prerenderScheduled = false;
	const PRERENDER_STEP_MS = 3;

	const markDirty = (): void => {
		dirty = true;
	};
	const invalidateEntryCache = (entry: TranscriptEntry): void => {
		entryRenderCache.delete(entry);
		if (frozen === null && prerender === null) return;
		const index = transcript.indexOf(entry);
		if (frozen !== null && index < frozen.through) frozen = null;
		if (prerender !== null && index >= 0 && index < prerender.next) prerender.next = index;
	};
	/** Full drop of both render caches; used by the toggle paths that touch many entries. */
	const clearRenderCaches = (): void => {
		entryRenderCache.clear();
		frozen = null;
		if (prerender !== null) prerender.next = 0;
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
	/**
	 * When an entry or action happened. Live, that is now; a replay pins it to
	 * the ledger entry being replayed, so `/view` states the age of the act and
	 * not of the resume.
	 */
	let replayStampMs: number | undefined;
	const stamp = (): number => replayStampMs ?? now();
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

	/**
	 * The call a worker card belongs under: the one that spawned it, running or
	 * settled. A dispatch that returns before its worker's first event (a
	 * detached batch) has settled by the time the card arrives, and the card is
	 * still that call's run, so a settled call of the current run takes it too.
	 * A call from an earlier turn keeps its own row, and the card appends at
	 * the tail.
	 */
	const findSpawningCall = (toolCallId: string): { segment: ToolSegment; entry: TranscriptEntry } | undefined => {
		const live = findToolSegmentOwner(toolCallId);
		if (live !== undefined) return live;
		const runStart = runStartIndex ?? runStartFallback(transcript.length);
		for (let entryIndex = transcript.length - 1; entryIndex >= runStart; entryIndex -= 1) {
			const entry = transcript[entryIndex];
			if (entry?.role !== "assistant") continue;
			for (const segment of entry.segments) {
				if (segment.kind === "tool" && segment.id === toolCallId) return { segment, entry };
			}
		}
		return undefined;
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
		entry.segments.push({ kind: "thinking", text: delta, at: stamp(), finalized: false, startedAtMs: now() });
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
		entry.segments.push({ kind: "error", text, at: stamp() });
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
		const owner = findSpawningCall(parentToolCallId);
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
		entry.role === "retryStatus" ||
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
			// Cards of one council round, of one fan-out, and helper rows are a
			// list, not a series of blocks, and so is every run of cards in
			// Compact. Anything else keeps the blank line between entries.
			const previous = i > 0 ? transcript[i - 1] : undefined;
			if (i > 0 && !stacksUnder(entry, previous, detail)) out.push("");
			const renders = entryRenderCache.get(entry);
			const cached = renders?.get(baseKey);
			// A replay block that is not live is a pure function of the render key,
			// so it caches like any settled entry. Excluding every replay block made
			// a long session's notices and `!` commands re-render on each rebuild:
			// 1,400 of them turned a 0.7 ms warm Alt+O revisit into 45 ms.
			const cacheable = i >= transcript.length - capacity && entryIsStable(entry);
			if (cacheable && cached !== undefined) {
				// A spread here is slower than a loop for large arrays and blows the
				// stack outright for a single entry that renders enough lines.
				for (const line of cached) out.push(line);
			} else {
				entriesRendered += 1;
				const renderedEntry = renderEntryLines(entry, width, nowMs, unboundedToolBodies, detail, terminalRows, previous);
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
		schedulePrerender(width, terminalRows, detail.style);
		return cachedRegions;
	};

	const prerenderStep = (): boolean => {
		const job = prerender;
		if (job === null) {
			prerenderScheduled = false;
			return false;
		}
		const deadline = performance.now() + PRERENDER_STEP_MS;
		let index = Math.max(job.next, transcript.length - entryCacheCapacity());
		let blocked = false;
		for (; index < transcript.length; index += 1) {
			if (performance.now() >= deadline) break;
			const entry = transcript[index];
			if (entry === undefined) continue;
			// Resume here once the entry settles; stepping past it would leave
			// every streamed answer out of the styles rendered ahead.
			if (!entryIsStable(entry)) {
				blocked = true;
				break;
			}
			for (const style of OUTPUT_STYLE_CYCLE) {
				if (style === job.style) continue;
				const key = `${job.width}|${job.terminalRows}|${style}`;
				const renders = entryRenderCache.get(entry);
				if (renders?.has(key)) continue;
				const lines = renderEntryLines(
					entry,
					job.width,
					now(),
					unboundedToolBodies,
					transcriptDetail(style),
					job.terminalRows,
					transcript[index - 1],
				);
				const byKey = renders ?? new Map<string, string[]>();
				byKey.set(key, lines);
				if (byKey.size > RENDERS_PER_ENTRY) {
					const oldestKey = byKey.keys().next().value;
					if (oldestKey !== undefined) byKey.delete(oldestKey);
				}
				if (renders === undefined) entryRenderCache.set(entry, byKey);
			}
		}
		job.next = index;
		const more = !blocked && index < transcript.length;
		if (!more) prerenderScheduled = false;
		return more;
	};
	const schedulePrerender = (width: number, terminalRows: number, style: OutputStyle): void => {
		if (options.scheduleIdle === undefined || unboundedToolBodies) return;
		if (
			prerender === null ||
			prerender.width !== width ||
			prerender.terminalRows !== terminalRows ||
			prerender.style !== style
		) {
			prerender = { width, terminalRows, style, next: 0 };
		} else if (prerender.next >= transcript.length) {
			return;
		}
		if (prerenderScheduled) return;
		prerenderScheduled = true;
		options.scheduleIdle(prerenderStep);
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
			lastSettledReceipt = null;
			transcript.push({ role: "user", text, at: stamp(), ...(status ? { status } : {}) });
			markDirty();
		},
		appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void {
			transcript.push({ role: "replayBlock", renderBlock, at: stamp(), isLive });
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
			const entry: WorkerTranscriptEntry = { role: "worker", state, at: stamp() };
			workerEntries.set(state.assignmentId, entry);
			// The card is the run's row from here on: the call that spawned it drops
			// the task and outcome it would otherwise state. A helper's `↳` row is
			// the run's row too when a dispatch started it (the model's shadow
			// scout); under any other call it stays beside that call's own output.
			const parent = state.parentToolCallId === undefined ? undefined : findSpawningCall(state.parentToolCallId);
			const attaches = state.helper !== true || parent?.segment.name === "dispatch";
			if (parent !== undefined && attaches && parent.segment.cardAttached !== true) {
				parent.segment.cardAttached = true;
				invalidateEntryCache(parent.entry);
			}
			const at = workerInsertionIndex(state);
			if (at === null) {
				transcript.push(entry);
			} else {
				transcript.splice(at, 0, entry);
				if (runStartIndex !== undefined && at <= runStartIndex) runStartIndex += 1;
				// A frozen prefix is a run of indices. Inserting inside it renumbers
				// every entry behind the cut, so the freeze has to go.
				if (frozen !== null && at < frozen.through) frozen = null;
				if (prerender !== null && at < prerender.next) prerender.next = at;
				// The entry behind the new card has a new predecessor, which decides
				// whether it stacks or opens a council group.
				const behind = transcript[at + 1];
				if (behind !== undefined) invalidateEntryCache(behind);
			}
			markDirty();
		},
		workerStates(): ReadonlyArray<WorkerEntryState> {
			return [...workerEntries.values()].map((entry) => entry.state);
		},
		inspectionArtifacts(): ViewArtifact[] {
			const artifacts: ViewArtifact[] = [];
			// Secret patterns can consume the start of an ANSI SGR sequence when
			// applied to an already styled row, leaving its `;2;...m` tail visible.
			// Redact the plain row when it contains a secret; keep styling otherwise.
			const redactInspectionRow = (row: string): string => {
				const plain = stripTerminalSequences(row);
				const redacted = redactSecretString(plain);
				return redacted === plain ? row : redacted;
			};
			// Newest first by the time each act happened; acts stamped in the same
			// millisecond keep their transcript order.
			let previousAt = Number.NEGATIVE_INFINITY;
			const add = (
				title: string,
				at: number,
				lines: () => string[],
				render?: (width: number) => string[],
				extra: Partial<Pick<ViewArtifact, "toolName" | "searchText">> = {},
			) => {
				const index = artifacts.length;
				const timestamp = Math.max(at, previousAt + 1);
				previousAt = timestamp;
				const clean = redactSecretString(sanitizeCallTargetText(title));
				artifacts.push({
					id: `transcript:${index + 1}`,
					category: "transcript",
					title: clean,
					timestamp,
					searchText: [clean, ...(extra.searchText ?? []).map((value) => redactSecretString(sanitizeCallTargetText(value)))],
					...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
					load: async () => ({
						format: "text",
						lines: lines().map(redactInspectionRow),
						...(render === undefined ? {} : { render: (width: number) => render(width).map(redactInspectionRow) }),
					}),
				});
			};
			/** A block's first row, plain: how the transcript states it. */
			const firstRow = (rows: readonly string[]): string =>
				rows.map((row) => stripTerminalSequences(row).trim()).find((row) => row.length > 0) ?? "";
			const standard = transcriptDetail("standard");
			for (const entry of transcript) {
				if (entry.role === "assistant") {
					for (const seg of entry.segments) {
						if (seg.kind === "error")
							add("Provider or terminal error", seg.at, () => providerErrorEvidence(seg.text).split("\n"));
						if (seg.kind === "thinking" && seg.text.trim().length > 0) {
							const opening = seg.text.trim().split("\n", 1)[0] ?? "";
							add(`Thinking · ${opening}`, seg.at, () => sanitizeMultilineDisplayText(seg.text).text.split("\n"));
						}
						if (seg.kind === "tool") {
							// Titled by its row as the transcript states it; inspected in full,
							// every argument included, whatever card sits under it.
							const call: ToolExecutionFinished = {
								...finishedCall(seg),
								result: seg.result ?? seg.partialResult,
								cardAttached: undefined,
							};
							add(
								toolRowTitle(
									seg.finished
										? finishedCall(seg)
										: { toolCallId: seg.id, toolName: seg.name, args: seg.args, cardAttached: seg.cardAttached },
								),
								seg.at,
								() => renderToolExecution(call, 120, { unbounded: true, diffStyle: "plain" }),
								(width) => renderToolExecution(call, width, { unbounded: true, diffStyle: "plain" }),
								{ toolName: seg.name, searchText: [seg.name, seg.id] },
							);
						}
					}
				} else if (entry.role === "retryStatus" && entry.status.errorMessage) {
					const status = entry.status;
					add(firstRow(renderRetryStatus(status, 120, standard)), entry.at, () =>
						providerErrorEvidence(status.errorMessage ?? "").split("\n"),
					);
				} else if (entry.role === "worker") {
					const state = entry.state;
					// A council member is titled by its own row, not the round's header.
					const header = firstRow(renderWorkerEntryLines(state, 120, { detail: standard, group: "continues" }));
					add(
						header,
						entry.at,
						() => renderWorkerEntryLines(state, 120, { unbounded: true }),
						(width) => renderWorkerEntryLines(state, width, { unbounded: true }),
						{ searchText: [state.agentId, state.runId] },
					);
				} else if (entry.role === "replayBlock") {
					const detailed = transcriptDetail("detailed");
					const title = firstRow(entry.renderBlock(120, standard, false));
					if (title.length === 0) continue;
					add(
						title,
						entry.at,
						() => entry.renderBlock(120, detailed, true),
						(width) => entry.renderBlock(width, detailed, true),
					);
				}
			}
			return artifacts;
		},
		isThinkingExpanded(): boolean {
			return currentDetail().reasoningRows > 0;
		},
		reset(): void {
			transcript.length = 0;
			lastSettledReceipt = null;
			runStartedAt = undefined;
			runStartIndex = undefined;
			runColdReasons = [];
			workerEntries.clear();
			clearRenderCaches();
			markDirty();
		},
		replayAt(timestampMs: number | undefined): void {
			replayStampMs =
				timestampMs !== undefined && Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : undefined;
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
				lastSettledReceipt = null;
				// The run's cold-cache reasons arrive just before it starts, as the
				// chat loop consumes them ahead of the prompt, so they are kept here
				// and cleared once the run's receipt has stated them.
				runStartedAt = now();
				runStartIndex = transcript.length;
				return;
			}
			if (event.type === "agent_status") {
				return;
			}
			if (event.type === "notice") {
				// The cache notice lives in the footer; the run keeps its reasons
				// for the Detailed receipt.
				if (event.coldReasons !== undefined) runColdReasons = [...event.coldReasons];
				// Transcript notices are first-class advisory blocks, not assistant
				// messages: a level mark in the gutter, the text hanging beside it,
				// exactly as replay renders the persisted ones.
				if (event.surface !== "transcript") return;
				// A change to the armed skill surface is a `§` state row; a load that
				// narrowed nothing already has its own row and adds none.
				const skillSurface = event.skillSurface;
				if (skillSurface !== undefined) {
					if (skillSurface.state === "loaded") return;
					transcript.push({
						role: "replayBlock",
						renderBlock: (width) => renderSkillSurfaceRow(skillSurface, width),
						at: stamp(),
					});
					markDirty();
					return;
				}
				const { text, level } = event;
				transcript.push({
					role: "replayBlock",
					renderBlock: (width) => renderNoticeRow(text, level, width),
					at: stamp(),
				});
				markDirty();
				return;
			}
			if (event.type === "queued_user_turn") {
				// A queued steer or follow-up the engine just injected. Rendering it
				// here, at injection time, keeps the transcript in the order the
				// model saw: enqueue time shows the text only in the queue panel.
				transcript.push({ role: "user", text: event.display?.text ?? event.text, at: stamp() });
				const note = event.display?.note;
				if (note !== undefined) {
					transcript.push({
						role: "replayBlock",
						renderBlock: (width) => wrapTextWithAnsi(`  ${note}`, width),
						at: stamp(),
					});
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
						at: stamp(),
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
					at: stamp(),
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
					// Only the grant path resumes a parked call; a denial settles it blocked.
					if (event.state === "resumed" && tool.approvalView !== undefined)
						tool.operatorGrant = approvalAxisText(tool.approvalView);
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
						actionClass?: unknown;
					};
					if (typeof enriched.actionClass === "string" && enriched.actionClass.length > 0) {
						tool.actionClass = enriched.actionClass;
					}
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
					} else if (tool.startedAtMs !== undefined && replayStampMs === undefined) {
						// A replay has only the ledger's duration; wall-clock elapsed here
						// would measure rehydration, not the tool.
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
						assistant.segments.splice(messageStart, 0, { kind: "thinking", text: thinking, at: stamp(), finalized: true });
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
					// A retry row is stable, so it caches and can freeze; a new phase
					// or countdown for the same attempt must drop that render first.
					invalidateEntryCache(last);
					last.status = event.status;
				} else {
					transcript.push({ role: "retryStatus", status: event.status, at: stamp() });
				}
				markDirty();
				return;
			}
			if (event.type === "speculative_dispatch") {
				if (lastSettledReceipt?.turnUsage !== undefined) {
					invalidateEntryCache(lastSettledReceipt);
					lastSettledReceipt.turnUsage = { ...lastSettledReceipt.turnUsage, prewarm: event.counts };
					markDirty();
				}
				return;
			}
			if (event.type === "agent_end") {
				lastSettledReceipt = null;
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
						lastSettledReceipt = target;
						const stop = event.messages.filter((message) => message.role === "assistant").at(-1) as
							| { stopReason?: string }
							| undefined;
						// A replayed run end brings the duration and cold reasons the
						// ledger recorded; a live one measures its own.
						const replayed = (event as { replayed?: ReplayedRunFacts }).replayed;
						const elapsedMs =
							replayed !== undefined
								? replayed.elapsedMs
								: runStartedAt === undefined
									? undefined
									: Math.max(0, now() - runStartedAt);
						const coldReasons = replayed !== undefined ? (replayed.coldReasons ?? []) : runColdReasons;
						target.turnUsage = {
							...runUsage,
							...(elapsedMs === undefined ? {} : { elapsedMs }),
							...(coldReasons.length > 0 ? { coldReasons: [...coldReasons] } : {}),
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
				runColdReasons = [];
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
