import { performance } from "node:perf_hooks";
import type { OutputVerbosity } from "../core/defaults.js";
import { SKILL_SUGGESTION_PREFIX } from "../core/skill-activation.js";
import { rawDurationMs } from "../core/timers.js";
import { estimateReasoningTextTokens, extractReasoningTokens } from "../domains/session/context-accounting.js";
import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import { extractText, isSelfExplainingAbort } from "./chat-loop-messages.js";
import { codeInk } from "./renderers/code-ink.js";
import { styleTaggedNotice } from "./renderers/notice.js";
import { formatRetryStatus } from "./renderers/retry-status.js";
import {
	classifyResourceRead,
	previewResult,
	renderToolAwaitingApproval,
	renderToolCallHeader,
	renderToolExecution,
	renderToolRunningStatus,
	renderToolStreamingExecution,
	renderToolSubline,
	unwrapResultEnvelope,
} from "./renderers/tool-execution.js";
import { renderWorkerEntryLines } from "./renderers/worker-entry.js";
import { INLINE_STATUS_INDENT_COLS, type StatusPhase, type VerbRender } from "./status/index.js";
import { clioTheme, fgSequence, GLYPH, markdownTheme, SGR_DIM, SGR_RESET } from "./theme/index.js";
import type { WorkerEntryState } from "./worker-stream.js";

// Fenced code reaches the screen through pi-tui's Markdown component, which
// exposes the MarkdownTheme.highlightCode hook: it hands over the raw fence
// text plus its language tag before pi-tui draws the fence borders and indent.
// Wiring code ink through that hook colors only the ink, so the fence frame,
// indentation, and width behavior stay pi-tui's and nothing post-processes
// already-rendered output.
const CHAT_MARKDOWN_THEME = markdownTheme(clioTheme(), (code, lang) => codeInk(lang, code.split("\n")));

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
 * pi-agent-core event order. pi-agent-core emits: `message_start` →
 * `text_delta`+ → `message_end` → `tool_execution_*` → (next) `message_start`
 * → `text_delta`+ → `message_end`, so tool calls always sit BETWEEN the
 * assistant's pre-tool narration and the post-tool summary. Storing a flat
 * `text` buffer + `tools[]` array (pre-refactor) collapsed that order: all
 * text across the turn concatenated into one line with every tool block
 * appended at the end. The segment list preserves the stream order instead.
 *
 * Each text segment tracks whether it has been finalized by a `message_end`.
 * Streaming deltas render as plain lines; only finalized text is piped
 * through the Markdown renderer. Partial markdown (unclosed fence, half-typed
 * bullet) would otherwise paint garbage at ~60 fps under streaming.
 */
export type ReasoningTokenProvenance = "provider" | "estimated" | "mixed";

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
	/** When true, render the full structured block instead of the collapsed subline. */
	expanded: boolean;
	/** Wall-clock start time captured by the chat panel for live duration display. */
	startedAtMs?: number;
	/** Completed call duration in milliseconds (event-supplied or measured locally). */
	durationMs?: number;
	/** Persisted result summary (bytes, truncated, offloadPath, observation) from the chat loop. */
	resultSummary?: Record<string, unknown> | undefined;
	/**
	 * Latest cumulative partial output from `tool_execution_update`. Cleared
	 * back to `undefined` on `tool_execution_end` so the finished `result`
	 * takes over. Only consumed when `!finished && expanded`. The explicit
	 * `| undefined` is required under `exactOptionalPropertyTypes: true` so
	 * the clear path can re-assign `undefined` without a `delete`.
	 */
	partialOutput?: string | undefined;
	/**
	 * True while the call is parked at the permission gate. Set/cleared by
	 * `tool_approval_state` events and cleared by any settle so a denied or
	 * resumed call never keeps the awaiting-approval styling. Meaningful only
	 * while `!finished`.
	 */
	awaitingApproval?: boolean | undefined;
	settlement?: "blocked" | "aborted" | "orphaned" | undefined;
	/**
	 * The admission verdict's short reason, present only on a settlement the
	 * registry actually rejected. A blocked row without it states that something
	 * was refused and leaves the operator no way to learn why.
	 */
	blockReason?: string | undefined;
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
type AssistantSegment = TextSegment | ToolSegment | ErrorSegment;
type ReplayBlockRenderer = (width: number) => string[];
type AssistantStatusLine = { phase: StatusPhase; verb: string; toneHint: VerbRender["toneHint"] };

type TranscriptEntry =
	| { role: "user"; text: string }
	| { role: "retryStatus"; status: RetryStatusPayload }
	| {
			role: "assistant";
			segments: AssistantSegment[];
			/**
			 * Raw thinking content from `thinking_delta` events plus
			 * `thinking` blocks captured on `message_end`. Renders live while
			 * the turn is pending: a folded `Thinking (N tokens)…` marker by
			 * default, or the tail of the reasoning down a dim `│ ` rail if
			 * expanded via `toggleLastThinking()` (Ctrl+T). Once the turn
			 * settles it collapses to a static `Thinking...` marker (folded) or
			 * a head-anchored rail (expanded), mirroring the pi-coding-agent
			 * reference which streams thinking from the partial message.
			 */
			thinking: string;
			/**
			 * Whether the thinking block renders as the full body (true) or
			 * the one-line dim marker (false/undefined). Toggled by
			 * `toggleLastThinking()`. New thinking inherits the panel-level
			 * visibility mode until Ctrl+T toggles it again.
			 */
			expandedThinking?: boolean;
			pending: boolean;
			statusLine?: AssistantStatusLine | null | undefined;
			isError: boolean;
			turnUsage?: ChatPanelTurnUsage;
	  }
	/**
	 * A dispatched worker's attributed block. The panel owns only the fold
	 * state; `state` is the live object the worker-stream reducer mutates, so a
	 * streaming delta reaches the screen without copying the entry per frame.
	 * The panel is told when that happened through `applyWorkerState`.
	 */
	| { role: "worker"; state: WorkerEntryState; folded: boolean }
	| { role: "replayBlock"; renderBlock: ReplayBlockRenderer };

export interface ChatPanel extends Component {
	appendUser(text: string): void;
	appendReplayBlock(renderBlock: ReplayBlockRenderer): void;
	applyEvent(event: ChatLoopEvent): void;
	/**
	 * Place or refresh a worker's block. The first call for an assignment
	 * inserts the entry (agent origin nests under the tool segment named by
	 * `state.parentToolCallId`, everything else appends); later calls only
	 * invalidate the render, because the reducer mutates the same state object.
	 */
	applyWorkerState(state: WorkerEntryState): void;
	setStatusLine(line: AssistantStatusLine | null): void;
	toggleLastToolExpanded(): boolean;
	toggleAllToolsExpanded(): boolean;
	/**
	 * Force every tool segment into its collapsed one-line form. Replay
	 * (`rehydrateChatPanelFromTurns`) calls this so a resumed or forked
	 * transcript reproduces the settled live view, where tools are collapsed to
	 * their ledger summary rather than the expanded body. Idempotent.
	 */
	collapseAllTools(): void;
	/**
	 * Flip thinking-bearing assistant turns between the one-line dim marker
	 * and the full rail-prefixed body. The target visibility is panel-level
	 * sticky state, then applied to current thinking history so Ctrl+T behaves
	 * like a transcript-level thinking visibility toggle.
	 */
	toggleLastThinking(): boolean;
	toggleAllThinking(): boolean;
	/** Toggle whether expanded live tool bodies include cumulative partial output. */
	toggleLiveToolOutput(): boolean;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

export interface ChatPanelOptions {
	/**
	 * Resolves the user-visible key string for the `clio.tool.expand`
	 * action. Returning a non-empty string surfaces a dim ` (<key>)` hint on
	 * the first wrapped line of the latest finished collapsed tool subline so
	 * the Ctrl+O toggle is discoverable without repeating on every historical
	 * row. Returning undefined or an empty string suppresses the hint. Called
	 * per render so live keybinding changes flow through.
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

function finiteToken(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function assistantUsage(message: unknown): ChatPanelTurnUsage | undefined {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
	const record = message as Record<string, unknown>;
	const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : undefined;
	const thinking = extractAssistantThinking(message);
	const reportedReasoning = usage ? extractReasoningTokens(usage) : null;
	const estimatedReasoning = reportedReasoning === null ? estimateReasoningTextTokens(thinking) : null;
	const inputTokens = finiteToken(usage?.input);
	const outputTokens = finiteToken(usage?.output);
	const cacheReadTokens = finiteToken(usage?.cacheRead);
	const cacheWriteTokens = finiteToken(usage?.cacheWrite);
	if (
		inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0 &&
		reportedReasoning === null &&
		estimatedReasoning === null
	) {
		return undefined;
	}
	const turnUsage: ChatPanelTurnUsage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, modelCalls: 1 };
	if (reportedReasoning !== null) {
		turnUsage.reasoningTokens = reportedReasoning;
		turnUsage.reasoningTokenProvenance = "provider";
	} else if (estimatedReasoning !== null) {
		turnUsage.reasoningTokens = estimatedReasoning;
		turnUsage.reasoningTokenProvenance = "estimated";
	}
	return turnUsage;
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
		seg.md = new Markdown(seg.text, 0, 0, CHAT_MARKDOWN_THEME);
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
const REASONING_CHARS_PER_TOKEN = 4;

function estimateThinkingTokens(thinking: string): number {
	return estimateReasoningTextTokens(thinking) ?? Math.max(1, Math.round(thinking.length / REASONING_CHARS_PER_TOKEN));
}

function reasoningDisplay(usage: ChatPanelTurnUsage | undefined, thinking: string): { tokens: number; marker: string } {
	if (usage?.reasoningTokens !== undefined) {
		return {
			tokens: usage.reasoningTokens,
			marker: usage.reasoningTokenProvenance === "provider" ? "provider-reported" : "mixed/estimated",
		};
	}
	return { tokens: estimateThinkingTokens(thinking), marker: "estimated" };
}

/**
 * Render the assistant turn's thinking block. Collapsed (default) returns a
 * single dim `Thinking...` marker. Expanded returns the full body dimmed and
 * prefixed with a dim `│ ` rail, capped at `THINKING_LINE_LIMIT` lines with a
 * tail `... N more lines hidden` overflow message. Mirrors the tool toggle's
 * lab-notebook minimalism: no colored glyphs, no boxes.
 */
function renderThinkingLines(
	thinking: string,
	expanded: boolean,
	width: number,
	streaming: boolean,
	usage?: ChatPanelTurnUsage,
): string[] {
	if (thinking.length === 0) return [];
	const dimWrap = (s: string): string => `${DIM}${s}${RESET}`;
	if (!expanded) {
		const lineBudget = Math.max(1, width);
		const display = reasoningDisplay(usage, thinking);
		const label = streaming
			? `Thinking (${display.tokens} tokens)${display.marker === "provider-reported" ? "" : " ≈ estimated"}…`
			: THINKING_HIDDEN_LABEL;
		return [dimWrap(truncateToWidth(label, lineBudget, GLYPH.ellipsis, false))];
	}
	const splitLines = thinking.split("\n");
	let visible: string[];
	if (streaming) {
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
function renderTurnUsageLine(usage: ChatPanelTurnUsage, width: number, verbosity: OutputVerbosity): string[] {
	if (verbosity === "minimal") return [];
	if (verbosity === "default") {
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
	const reason =
		usage.reasoningTokens !== undefined && usage.reasoningTokens > 0
			? ` reasoning ${usage.reasoningTokenProvenance === "provider" ? `${usage.reasoningTokens} provider` : `≈${usage.reasoningTokens} estimated`}`
			: "";
	const cache =
		usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0
			? ` cache ${usage.cacheReadTokens}/${usage.cacheWriteTokens}`
			: "";
	// The caveat is about reasoning text the panel displayed. A turn that spent
	// no reasoning tokens displayed none, so appending it there warned about
	// something absent and cost a wrapped line per turn at narrow widths.
	const caveat =
		usage.reasoningTokens !== undefined && usage.reasoningTokens > 0
			? " · reasoning text is a UI excerpt, not a verification"
			: "";
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

function renderToolSegmentLines(
	seg: ToolSegment,
	width: number,
	expandKey: string | undefined,
	latestHintToolId: string | null,
	nowMs: number,
	unboundedToolBodies: boolean,
	verbosity: OutputVerbosity,
	liveToolOutput: boolean,
): string[] {
	const hintKey = seg.id === latestHintToolId ? expandKey : undefined;
	const expanded = verbosity === "verbose" || (verbosity !== "minimal" && seg.expanded);
	const elapsedMs = seg.startedAtMs !== undefined ? Math.max(0, rawDurationMs(seg.startedAtMs, nowMs)) : undefined;
	// A parked call is not executing: the awaiting-approval line replaces the
	// counting elapsed spinner in both collapsed and expanded form (there is no
	// body or partial output to expand while the call sits at the gate).
	if (!seg.finished && seg.awaitingApproval === true) {
		return renderToolAwaitingApproval({ toolCallId: seg.id, toolName: seg.name, args: seg.args }, width);
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
				: { toolCallId: seg.id, toolName: seg.name, args: seg.args, elapsedMs },
			width,
			hintKey,
		);
	}
	if (!seg.finished) {
		if (liveToolOutput && seg.partialOutput !== undefined) {
			return renderToolStreamingExecution(
				{ toolCallId: seg.id, toolName: seg.name, args: seg.args, elapsedMs },
				width,
				seg.partialOutput,
			);
		}
		const call = { toolCallId: seg.id, toolName: seg.name, args: seg.args, elapsedMs };
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
		{ unbounded: unboundedToolBodies },
	);
}

/**
 * Whether a worker block draws its one-line card this frame. `/output verbose`
 * opens every block and `/output minimal` folds every block, so the entry's own
 * fold decides only in between.
 */
function workerEntryFolded(entry: Extract<TranscriptEntry, { role: "worker" }>, verbosity: OutputVerbosity): boolean {
	if (verbosity === "verbose") return false;
	if (verbosity === "minimal") return true;
	return entry.folded;
}

function renderEntryLines(
	entry: TranscriptEntry,
	width: number,
	expandKey: string | undefined,
	latestHintToolId: string | null,
	latestFoldedWorkerId: string | null,
	nowMs: number,
	unboundedToolBodies: boolean,
	verbosity: OutputVerbosity,
	liveToolOutput: boolean,
): string[] {
	if (entry.role === "replayBlock") {
		return entry.renderBlock(width);
	}
	if (entry.role === "user") {
		const contentWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
		const lines: string[] = [];
		for (const sourceLine of entry.text.split("\n")) lines.push(...wrapTextWithAnsi(sourceLine, contentWidth));
		return hangProseLines(lines, USER_PREFIX);
	}
	if (entry.role === "retryStatus") {
		return wrapTextWithAnsi(formatRetryStatus(entry.status), width);
	}
	if (entry.role === "worker") {
		return renderWorkerEntryLines(entry.state, width, {
			folded: workerEntryFolded(entry, verbosity),
			...(expandKey !== undefined && entry.state.assignmentId === latestFoldedWorkerId ? { expandKey } : {}),
			unbounded: unboundedToolBodies,
		});
	}
	// A settled assistant entry that rendered nothing at all contributes nothing.
	// A mid-turn notice splits the transcript, so the events after it open a
	// fresh entry that a stopped turn never fills; that entry used to reach the
	// tail below and print a lone agent bubble under the notice.
	if (
		!entry.pending &&
		entry.thinking.length === 0 &&
		entry.turnUsage === undefined &&
		!hasVisibleOutput(entry) &&
		entry.segments.length === 0
	) {
		return [];
	}
	const lines: string[] = [];
	// Thinking renders BEFORE assistant text/tool segments so the folded marker
	// or expanded rail sits above the response, matching the order the
	// pi-coding-agent reference uses. It streams live while `pending === true`
	// (folded shows a dynamic token count; expanded tail-anchors the tail) and
	// collapses to a static marker / head-anchored rail once the turn settles.
	// The generic "thinking" status verb is suppressed while this marker is
	// active so only one indicator shows (see `shouldRenderStatus` below).
	if (entry.thinking.length > 0) {
		lines.push(
			...renderThinkingLines(
				entry.thinking,
				verbosity === "verbose" || (verbosity !== "minimal" && entry.expandedThinking === true),
				width,
				entry.pending,
				entry.turnUsage,
			),
		);
	}
	const clioPrefix = entry.isError ? CLIO_PREFIX_ERROR : CLIO_PREFIX;
	const proseWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	let labeled = false;
	for (const seg of entry.segments) {
		if (seg.kind === "tool") {
			lines.push(
				...renderToolSegmentLines(
					seg,
					width,
					expandKey,
					latestHintToolId,
					nowMs,
					unboundedToolBodies,
					verbosity,
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
	if (entry.turnUsage && !entry.pending) lines.push(...renderTurnUsageLine(entry.turnUsage, width, verbosity));
	const shouldRenderStatus =
		entry.pending &&
		entry.statusLine !== null &&
		entry.statusLine !== undefined &&
		!(entry.statusLine.phase === "writing" && hasStreamingText(entry)) &&
		!(entry.statusLine.phase === "thinking" && entry.thinking.length > 0);
	if (!labeled && !hasVisibleOutput(entry)) {
		lines.push(clioPrefix.trimEnd());
		if (shouldRenderStatus) {
			lines.push(
				`${STATUS_INDENT}${styleStatusVerb(entry.statusLine?.verb ?? "", entry.statusLine?.toneHint ?? "muted")}`,
			);
		}
	} else if (shouldRenderStatus) {
		lines.push(`${STATUS_INDENT}${styleStatusVerb(entry.statusLine?.verb ?? "", entry.statusLine?.toneHint ?? "muted")}`);
	}
	return lines;
}

export function createChatPanel(options: ChatPanelOptions = {}): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	/** Assignment to its placed block, so a streaming delta is O(1) to route. */
	const workerEntries = new Map<string, TranscriptEntry>();
	let dirty = true;
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];
	let cachedExpandKey: string | undefined;
	let cachedVerbosity: OutputVerbosity | undefined;
	let cachedLiveToolOutput: boolean | undefined;
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
	 * Windowed-tail build (F19 on pi-tui 0.83 terms): the lines of every settled
	 * leading entry are baked into one frozen prefix, so a dirty frame re-renders
	 * only the live tail and re-emits the prefix by reference. pi-tui still
	 * receives the full line array, deliberately: the 0.83 renderer keeps every
	 * line in `previousLines` and full-redraws (clearing scrollback) when the
	 * head shrinks, so a real shrinking window needs the 0.84 ScrollView
	 * architecture. The freeze is dropped whenever a frozen entry is invalidated
	 * or the render key changes.
	 */
	let frozen: { lines: string[]; through: number; key: string } | null = null;
	let thinkingExpanded = false;
	let liveToolOutput = true;
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
		seg.partialOutput = undefined;
		seg.awaitingApproval = undefined;
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
			thinking: "",
			expandedThinking: thinkingExpanded,
			pending: false,
			isError: false,
		};
		transcript.push(entry);
		return entry;
	};

	const appendTextDelta = (entry: Extract<TranscriptEntry, { role: "assistant" }>, delta: string): void => {
		if (delta.length === 0) return;
		invalidateEntryCache(entry);
		const tail = entry.segments[entry.segments.length - 1];
		if (tail && tail.kind === "text" && !tail.finalized) {
			tail.text += delta;
			return;
		}
		entry.segments.push({ kind: "text", text: delta, finalized: false });
	};

	/**
	 * Canonicalize a streamed text segment from a completed assistant message.
	 * When streaming produced a prefix of the final text (the common case),
	 * the tail segment is overwritten and flipped to finalized so the next
	 * render pipes it through Markdown. When the message arrived fully formed
	 * with no deltas (non-streaming test path, synthetic notices), a fresh
	 * finalized text segment is appended after any tool segments that may
	 * have landed in this turn already. `replaceTail` forces the overwrite for
	 * messages the chat loop rewrote after streaming (locked-turn markup
	 * sanitation): the streamed tail is dead text there, not a prefix.
	 */
	const canonicalizeMessageText = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		replaceTail = false,
	): void => {
		if (text.length === 0) return;
		const tail = entry.segments[entry.segments.length - 1];
		if (tail?.kind === "text" && !tail.finalized && (replaceTail || text.startsWith(tail.text))) {
			tail.text = text;
			tail.finalized = true;
			// The streaming wrap cache assumes append-only text. This is the one
			// path that rewrites it wholesale, and finalized segments render through
			// Markdown instead, so the cache is dead here either way.
			delete tail.wrapCache;
			if (tail.md) tail.md.setText(text);
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

	const latestCollapsedFinishedToolId = (): string | null => {
		for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
			const entry = transcript[entryIndex];
			// The expand key takes the newest foldable thing of either kind, so a
			// worker block behind this point already owns it. A tool in front of it
			// must not advertise a chord that would no longer reach it.
			if (entry?.role === "worker") return null;
			if (entry?.role !== "assistant") continue;
			for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
				const seg = entry.segments[segIndex];
				if (seg?.kind !== "tool") continue;
				if (seg.finished && !seg.expanded) return seg.id;
			}
		}
		return null;
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

	/**
	 * Assignment of the newest folded worker block. Only that block advertises
	 * the expand key: a fan-out of five scouts repeating the same chord five
	 * times is noise, and the newest one is what the chord would open anyway.
	 * The scan stops at a tool segment for the same reason the tool hint stops
	 * at a worker block, so exactly one surface ever shows the chord.
	 */
	const latestFoldedWorkerAssignmentId = (): string | null => {
		for (let index = transcript.length - 1; index >= 0; index -= 1) {
			const entry = transcript[index];
			if (entry?.role === "assistant" && entry.segments.some((segment) => segment.kind === "tool")) return null;
			if (entry?.role !== "worker") continue;
			// The newest block is the one the chord reaches. When it is already
			// open the chord folds it again, which needs no advertising.
			return entry.folded ? entry.state.assignmentId : null;
		}
		return null;
	};

	/** True when the entry owns the tool the expand hint currently points at. */
	const entryContainsHint = (entry: TranscriptEntry, latestHintToolId: string | null): boolean =>
		latestHintToolId !== null &&
		entry.role === "assistant" &&
		entry.segments.some((segment) => segment.kind === "tool" && segment.id === latestHintToolId);

	/** True when the entry renders at least one counting elapsed line this frame. */
	const entryHasRunningTool = (entry: TranscriptEntry): boolean =>
		entry.role === "assistant" &&
		entry.segments.some((segment) => segment.kind === "tool" && !segment.finished && segment.startedAtMs !== undefined);

	/**
	 * Settled entries whose render is a pure function of the base key. A live
	 * worker block is excluded for the same reason a running tool is: the
	 * reducer mutates its state object in place, so a cached render would keep
	 * serving the answer as it looked several deltas ago.
	 */
	const entryIsStable = (entry: TranscriptEntry): boolean =>
		entry.role === "user" ||
		entry.role === "replayBlock" ||
		(entry.role === "worker" && !entry.state.pending) ||
		(entry.role === "assistant" &&
			!entry.pending &&
			!entry.segments.some((segment) => segment.kind === "tool" && !segment.finished));

	const render = (width: number): string[] => {
		const startedAt = performance.now();
		const expandKey = resolveExpandKey();
		const verbosity = options.getOutputVerbosity?.() ?? "default";
		const nowMs = now();
		// `dirty` is set on mutation and never on a tick, so without time in the
		// key a running tool's elapsed counter advanced only when something
		// unrelated invalidated the panel. The tick is the same 100 ms bucket
		// dispatch-board.ts uses for running rows, taken off the injectable
		// clock so a fixed clock still produces byte-stable output, and it is
		// pinned to 0 whenever nothing is counting so a settled transcript
		// re-renders no more often than it did before.
		const tick = renderedRunningTool ? Math.floor(nowMs / 100) : 0;
		// The hit guard runs before any transcript scan. latestCollapsedFinishedToolId
		// walks the whole transcript when the newest tool is expanded or absent, and
		// it is not part of the panel-level key, so computing it above the guard cost
		// a full scan per frame for a value the early return discards.
		if (
			!dirty &&
			cachedWidth === width &&
			cachedExpandKey === expandKey &&
			cachedVerbosity === verbosity &&
			cachedLiveToolOutput === liveToolOutput &&
			cachedTick === tick
		) {
			options.onRenderMetrics?.({ durationMs: performance.now() - startedAt, cacheHit: true, entriesRendered: 0 });
			return cachedLines;
		}
		const latestHintToolId = latestCollapsedFinishedToolId();
		const latestFoldedWorkerId = latestFoldedWorkerAssignmentId();
		// The hint id is deliberately NOT part of the shared key: it changes on
		// every finished collapsed tool, and keying every entry on it re-rendered
		// the entire transcript per tool completion. Only the entry that contains
		// the hint tool renders differently, so only that entry's key carries it.
		// The tick stays out of the entry key: a settled entry renders the same
		// bytes at every tick, and keying it on time would drop the entry cache
		// and the frozen prefix ten times a second. Only the panel-level guard
		// above is time-keyed, so a tick re-renders the live tail and nothing else.
		const baseKey = `${width}|${expandKey ?? ""}|${verbosity}|${liveToolOutput}`;
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
				workerEntryFolded(entry, verbosity) &&
				workerEntryFolded(previous, verbosity);
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
					verbosity,
					liveToolOutput,
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
		cachedVerbosity = verbosity;
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
		appendReplayBlock(renderBlock: ReplayBlockRenderer): void {
			transcript.push({ role: "replayBlock", renderBlock });
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
			const entry: TranscriptEntry = { role: "worker", state, folded: state.origin === "agent" };
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
		toggleLastToolExpanded(): boolean {
			// Ctrl+O owns the newest foldable thing, whichever kind it is. A worker
			// block the operator just watched land is what they mean by "expand
			// that", not the tool call two screens up that spawned it.
			for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
				const entry = transcript[entryIndex];
				if (entry?.role === "worker") {
					entry.folded = !entry.folded;
					clearRenderCaches();
					markDirty();
					return true;
				}
				if (entry?.role !== "assistant") continue;
				for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
					const seg = entry.segments[segIndex];
					if (seg?.kind !== "tool") continue;
					seg.expanded = !seg.expanded;
					clearRenderCaches();
					markDirty();
					return true;
				}
			}
			return false;
		},
		toggleAllToolsExpanded(): boolean {
			const tools: ToolSegment[] = [];
			const workers: Array<Extract<TranscriptEntry, { role: "worker" }>> = [];
			for (const entry of transcript) {
				if (entry.role === "worker") {
					workers.push(entry);
					continue;
				}
				if (entry.role !== "assistant") continue;
				for (const seg of entry.segments) {
					if (seg.kind === "tool") tools.push(seg);
				}
			}
			if (tools.length === 0 && workers.length === 0) return false;
			const expand = tools.some((seg) => !seg.expanded) || workers.some((entry) => entry.folded);
			for (const seg of tools) seg.expanded = expand;
			for (const entry of workers) entry.folded = !expand;
			clearRenderCaches();
			markDirty();
			return true;
		},
		collapseAllTools(): void {
			for (const entry of transcript) {
				if (entry.role === "worker") {
					// The settled view for a worker is its origin default, not
					// universally folded: the operator's own run is the one block
					// /run exists to show them.
					entry.folded = entry.state.origin === "agent";
					continue;
				}
				if (entry.role !== "assistant") continue;
				for (const seg of entry.segments) {
					if (seg.kind === "tool") seg.expanded = false;
				}
			}
			clearRenderCaches();
			markDirty();
		},
		toggleLastThinking(): boolean {
			for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
				const entry = transcript[entryIndex];
				if (entry?.role !== "assistant") continue;
				if (entry.thinking.length === 0) continue;
				entry.expandedThinking = entry.expandedThinking !== true;
				thinkingExpanded = entry.expandedThinking === true;
				clearRenderCaches();
				markDirty();
				return true;
			}
			thinkingExpanded = !thinkingExpanded;
			return true;
		},
		toggleAllThinking(): boolean {
			const entries: Array<Extract<TranscriptEntry, { role: "assistant" }>> = [];
			for (const entry of transcript) {
				if (entry.role === "assistant" && entry.thinking.length > 0) entries.push(entry);
			}
			if (entries.length === 0) {
				thinkingExpanded = !thinkingExpanded;
				return true;
			}
			const expand = entries.some((entry) => entry.expandedThinking !== true);
			for (const entry of entries) entry.expandedThinking = expand;
			thinkingExpanded = expand;
			clearRenderCaches();
			markDirty();
			return true;
		},
		toggleLiveToolOutput(): boolean {
			liveToolOutput = !liveToolOutput;
			markDirty();
			return liveToolOutput;
		},
		reset(): void {
			transcript.length = 0;
			workerEntries.clear();
			clearRenderCaches();
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
			if (event.type === "text_delta") {
				const assistant = ensureAssistant();
				assistant.pending = true;
				appendTextDelta(assistant, event.delta);
				markDirty();
				return;
			}
			if (event.type === "thinking_delta") {
				// Capture for downstream consumers but never render inline.
				const assistant = ensureAssistant();
				assistant.pending = true;
				assistant.thinking += event.delta;
				assistant.expandedThinking = thinkingExpanded;
				markDirty();
				return;
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				ensureAssistant().pending = true;
				markDirty();
				return;
			}
			if (event.type === "tool_execution_start") {
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
				// Compact resource reads (SKILL.md, CLIO-CODER.md, AGENTS.md, docs/) stay
				// collapsed to one labeled line until explicitly expanded.
				const expanded = assistant.pending === false && classifyResourceRead(event.toolName, event.args) === null;
				assistant.pending = true;
				assistant.segments.push({
					kind: "tool",
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					finished: false,
					isError: false,
					expanded,
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
					markDirty();
				}
				return;
			}
			if (event.type === "tool_execution_update") {
				// pi-agent emits `partialResult` as a cumulative tool-result envelope
				// (the bash tool concatenates its rolling tail buffer on every tick).
				// Unwrap with the same helper the finished-result path uses, then
				// REPLACE `partialOutput` rather than appending: the upstream
				// semantics are cumulative, so appending would double-print every
				// snapshot. Render dispatch picks up the new buffer on the next
				// frame via `renderToolSegmentLines`.
				const owner = findToolSegmentOwner(event.toolCallId);
				if (owner) invalidateEntryCache(owner.entry);
				const tool = owner?.segment;
				if (tool && !tool.finished) {
					const unwrapped = unwrapResultEnvelope(event.partialResult);
					tool.partialOutput = typeof unwrapped === "string" ? unwrapped : previewResult(unwrapped);
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
					tool.partialOutput = undefined;
					tool.awaitingApproval = undefined;
				}
				markDirty();
				return;
			}
			if (event.type === "message_end") {
				const text = extractAssistantText(event.message);
				const thinking = extractAssistantThinking(event.message);
				const extractedTerminalError = extractAssistantTerminalError(event.message);
				const current = transcript[transcript.length - 1];
				const terminalError =
					current?.role === "assistant"
						? scopeTerminalErrorAfterSuccessfulTool(current, extractedTerminalError)
						: extractedTerminalError;
				const usage = assistantUsage(event.message);
				if (text.length === 0 && thinking.length === 0 && terminalError.length === 0 && usage === undefined) return;
				const assistant = ensureAssistant();
				// message_end rewrites exactly one entry: the assistant it lands on.
				invalidateEntryCache(assistant);
				if (usage !== undefined) assistant.turnUsage = usage;
				if (terminalError.length > 0) assistant.isError = true;
				if (thinking.length > 0) {
					assistant.thinking = thinking;
					assistant.expandedThinking = thinkingExpanded;
				}
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
						entry.pending = false;
						entry.statusLine = null;
					}
				}
				markDirty();
			}
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
