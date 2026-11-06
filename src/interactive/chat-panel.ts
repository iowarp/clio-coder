import { performance } from "node:perf_hooks";
import { assistantModelLabel } from "../core/assistant-model.js";
import { AssistantProseProjection, sanitizeAssistantProse } from "../core/assistant-prose.js";
import type { OutputStyle } from "../core/defaults.js";
import { messageCallsForAccounting, messageUsageForAccounting } from "../core/message-accounting.js";
import { SKILL_SUGGESTION_PREFIX } from "../core/skill-activation.js";
import { renderCalls } from "../core/telemetry/render.js";
import { rawDurationMs } from "../core/timers.js";
import { ToolNames } from "../core/tool-names.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
import {
	holdCutOffText,
	holdUnresolvedStrings,
	holdUnresolvedUserinfo,
	messageStopCompleted,
	RedactedStringProjection,
	redactSecretString,
	redactStreamingSecretString,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
} from "../domains/safety/redaction.js";
import type { ViewArtifact } from "../domains/session/view-artifacts.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { settledPrefixLength } from "../engine/apis/diffusion-frames.js";
import {
	type Component,
	Markdown,
	Marked,
	stripTerminalSequences,
	type Tokens,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent, RetryStatusPayload } from "../session-control/chat-loop.js";
import {
	classifyTurnEnding,
	endedOnCancelledInterview,
	endedWithFailedChange,
	extractText,
	isSelfExplainingAbort,
	proseBeforeWrittenCalls,
	type TurnEnding,
	turnNoAnswerSentence,
	writtenCallsFact,
} from "../session-control/chat-loop-messages.js";
import { coldReasonList } from "../session-control/cold-reasons.js";
import type { WorkerEntryState } from "../session-control/worker-stream.js";
import { routeFirstOutput } from "./footer/silence-note.js";
import { editPreviewDiff } from "./mutation-preview.js";
import type { ApprovalRequestView } from "./permission-overlay.js";
import { codeInk } from "./renderers/code-ink.js";
import { holdInlineMath } from "./renderers/inline-math.js";
import { LiveToolView } from "./renderers/live-tool-view.js";
import { createMermaidMarkdownTransform } from "./renderers/mermaid.js";
import { renderNoticeRow } from "./renderers/notice.js";
import { previewBudget, previewRows } from "./renderers/preview.js";
import {
	type ProviderFailureRoute,
	presentProviderError,
	providerErrorEvidence,
	providerFailureAdvice,
	providerFailureEvidence,
	providerFailureHeadline,
	readProviderFailureRoute,
} from "./renderers/provider-error.js";
import { renderRetryStatus } from "./renderers/retry-status.js";
import { renderSkillSuggestionRow, renderSkillSurfaceRow } from "./renderers/skill-rows.js";
import {
	approvalAxisText,
	hasToolBody,
	renderFoldedGroup,
	renderToolAwaitingApproval,
	renderToolExecution,
	renderToolPreview,
	stopSentRow,
	type ToolExecutionFinished,
	type ToolFoldFamily,
	toolFoldFamily,
	toolRowTitle,
} from "./renderers/tool-execution.js";
import type { WorkerEntryRenderOptions } from "./renderers/worker-entry.js";
import { renderWorkerEntryLines, workerTelemetryDisplay } from "./renderers/worker-entry.js";
import { compactReasoningTokens, type ReasoningUsageView, UNMEASURED_REASONING } from "./status/index.js";
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
	SGR_ITALIC,
	SGR_RESET,
	wrapPaths,
} from "./theme/index.js";
import { modelNickname } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "./transcript-detail.js";
import { type TurnSpend, turnHoldsCalls, turnSpend } from "./turn-spend.js";

// Every fenced code block, top level or nested in a list or quote, reaches the
// screen through pi-tui's Markdown component, which exposes the
// MarkdownTheme.highlightCode hook: it hands over the raw fence text plus the
// fence's whole info string before pi-tui draws the fence borders and indent.
// Wiring code ink through that hook colors only the ink, and nothing
// post-processes already-rendered output. codeInk matches the language word
// only, so the hook drops the rest of an info string such as `ts title="a.ts"`.
// Pi wraps every rendered row at its spaces, so a long code line came back as
// pieces that dropped the space at each break and could not be rejoined
// exactly. Code ink leaves Pi with no space to break at: each space travels as
// CODE_SPACE, Pi can only cut a long line at full width without dropping
// anything, and `markdownRows` rejoins the pieces, restores the spaces and
// wraps the source line once under its continuation mark. The blank braille
// pattern is one column wide and is not whitespace to Pi's tokenizer.
// The block indent opens with CODE_LINE, a noncharacter that marks where each
// source line starts, so a piece Pi cut off is never mistaken for a new line.
const CODE_SPACE = "\u2800";
const CODE_LINE = "\uFDD1";
const CHAT_MARKDOWN_THEME = {
	...markdownTheme(clioTheme(), (code, lang) =>
		codeInk(lang?.trim().split(/\s+/u, 1)[0], code.split("\n")).map((line) => line.replaceAll(" ", CODE_SPACE)),
	),
	codeBlockIndent: `${CODE_LINE}${CODE_SPACE}`,
};
// /export writes plain text inside its own fence, so Pi's top-level fence rows
// are noise there and widen that outer fence. Pi gives no switch for them, so
// the export panel's theme tags every fence row it draws with a Unicode
// noncharacter, which valid text never carries, and `exportFenceRow` resolves
// the tags row by row.
const EXPORT_FENCE_MARK = "\uFDD0";
const EXPORT_MARKDOWN_THEME = {
	...CHAT_MARKDOWN_THEME,
	codeBlockBorder: (text: string) => `${EXPORT_FENCE_MARK}${CHAT_MARKDOWN_THEME.codeBlockBorder(text)}`,
};
const mermaidTransform = createMermaidMarkdownTransform(clioTheme());
const CHAT_MARKDOWN_OPTIONS = {
	transform: (source: string, width: number) => {
		const text = holdInlineMath(source, CODE_SPACE);
		// Both transforms need a lex of the whole answer, so each runs only when the text can use it.
		if (!mayNeedTableFit(text)) return /mermaid/iu.test(text) ? mermaidTransform(text, width) : text;
		const tokens = tableParser.lexer(text);
		const fitted = fitMarkdownTables(tokens, width);
		if (!/mermaid/iu.test(fitted.text)) return fitted.text;
		// A rewritten table can change how the text after it parses, so those tokens no longer describe it.
		return mermaidTransform(fitted.text, width, fitted.rewritten ? undefined : tokens);
	},
	renderLatex: true,
} as const;
// TuiAltScreen uses Pi's OSC 133 prompt-start marker for semantic prompt
// navigation. The sequence is zero-width and stripped before terminal output.
const OSC133_PROMPT_START = "\x1b]133;A\x07";

// Transcript ownership, reading hierarchy, and outcome sequences share the theme resolver.
const RESET = SGR_RESET;
const SECONDARY = () => fgSequence("annotation");
const TEAL = () => fgSequence("guidance");
const REASON_INK = () => fgSequence("gutter");
const RED_CRIT = () => fgSequence("error");
const GREEN_OK = () => fgSequence("success");
const AMBER_WARN = () => fgSequence("warning");
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
 * Streaming and settled text render through the same Markdown component, so
 * finalizing restyles at most the block that was still open and the rows
 * already streamed stay put.
 */
export type { ReasoningTokenProvenance } from "./status/index.js";

export interface ChatPanelTurnUsage {
	elapsedMs?: number;
	outcome?: string;
	/** The newest failed turn this run: its prompt is one ↑ away in the composer's history. */
	promptRecall?: boolean;
	/** The operator turn whose spend the receipt reads from the telemetry read model (#434 §11.3). */
	turnId?: string;
	/** The calls the run's own messages settled; the receipt reads the fold until it holds them all. */
	callIds?: ReadonlyArray<string>;
	/** The turn's spend and reasoning as the read model last worded them; absent until a view resolved the turn. */
	spend?: TurnSpend;
	/** Why the run's prompt cache was expected to be cold (`prompt_recompiled`, …). */
	coldReasons?: ReadonlyArray<string>;
	/** Provider attempts the run sent again after a failure. */
	retries?: number;
	/** Provider waits the run sat out, which no retry limit counts. */
	providerWaits?: number;
	/** The model the operator moved the waiting request to, which is the one the turn's answer came from. */
	movedTo?: string;
	/** Of `elapsedMs`, what the run spent waiting on the operator. */
	humanWaitMs?: number;
	/** How a normally stopped run closed when it wrote no answer. */
	ending?: TurnEnding;
}

/**
 * What a replayed run end knows that a live one measures: the duration from
 * the ledger's timestamps and the cold-cache reasons its first call recorded.
 */
export interface ReplayedRunFacts {
	elapsedMs?: number;
	coldReasons?: ReadonlyArray<string>;
	/** Of `elapsedMs`, what the live run recorded waiting on the operator. */
	humanWaitMs?: number;
}

/** What one Markdown layout of the open reply cost and how long the reply was then. */
export interface LiveTextRender {
	durationMs: number;
	codeUnits: number;
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

type RowMemo = { width: number; bareFences: boolean; epoch: number; rows: Map<string, string[]> };

type TextSegment = {
	kind: "text";
	text: string;
	finalized: boolean;
	/** Cached prose policy for live, replayed and rewritten model output. */
	prose?: AssistantProseProjection;
	/** URL credentials stay off screen; the segment's own text stays whole for the ledger and the next turn (#446). */
	secrets?: RedactedStringProjection;
	/** The segment's stock Markdown component and the source it last rendered. */
	markdown?: { view: Markdown; source: string; epoch: number };
	/** Reuse wrapped rows while another entry streams or its clock advances (#428). */
	rendered?: { source: string; finalized: boolean; epoch: number; layouts: Map<string, string[]> };
	/** Fitted rows by Markdown row, so an unchanged row is not measured again on the next delta. Streaming only. */
	rowMemo?: RowMemo | undefined;
	/** Read by the stream renderer to price the next repaint; a new segment starts unpriced. */
	liveRender?: LiveTextRender;
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
	 * Markdown component; it is cached here rather than rebuilt per frame.
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
	/** The model whose request put this call on the harness. */
	requestedBy?: string | undefined;
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
	 * Incremental state of the call's streamed arguments and output while it is
	 * in flight, so a frame paints only the rows in view. Dropped at settlement.
	 */
	live?: LiveToolView | undefined;
	/** An edit's diff computed from the file once its arguments closed; live only, dropped at settlement. */
	previewDiff?: string | undefined;
	/** The edit preview was started for this call, so a later event does not read the file again. */
	previewRequested?: true;
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
	 * Settled without a result before execution started, or while it still
	 * waited for approval, so the row says the call did not run instead of
	 * claiming a past-tense edit. Cleared when a late end event brings a result.
	 */
	notRun?: boolean | undefined;
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
	/**
	 * Every worker card under this call settled cancelled, so the call was stopped rather than failed: the dispatch
	 * tool reports a cancelled run as an error, and its row read ✗ above a card that read ⊘.
	 */
	cardsCancelled?: true;
	/**
	 * What a finished call rendered to, so a long live turn pays only for its running calls: every settled row
	 * re-rendered on each update cost about 5 MB per frame at 320 calls. A finished call has no clock in its rows.
	 * `changeSettledCall` drops all of this, and the fold over this call sees its revision move.
	 */
	settledRows?: SettledToolRows | undefined;
	/** The fold this finished call heads, valid while its calls and their revisions are the same. */
	settledFold?: (SettledToolRows & { calls: number; revisions: number }) | undefined;
	/** The Compact fold this finished call joins; undefined until asked. */
	settledFamily?: ToolFoldFamily | null | undefined;
	settledRevision?: number;
};
type SettledToolRows = { key: string; lines: string[]; body: boolean };
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
	/** Where the failure happened, when a provider route did it. */
	route?: ProviderFailureRoute | undefined;
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
	/** The stretch was streamed live and its target's history did not keep the text, so only the fact can be shown. */
	notRetained?: true;
};
type ThinkingRender = { source: string; open: boolean; epoch: number; layouts: Map<string, string[]> };
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
	| { role: "user"; text: string; at: number; status?: () => UserTurnStatus; origin?: string }
	| { role: "retryStatus"; status: RetryStatusPayload; at: number }
	| {
			role: "assistant";
			models?: string[];
			/** The turn's first model is the one the turn before it ended on, so its row would repeat it. */
			sameModelAsBefore?: boolean;
			segments: AssistantSegment[];
			reasoningRenders?: Map<number, ThinkingRender>;
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
	| { role: "worker"; state: WorkerEntryState; at: number; telemetryShown: string }
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
	appendUser(text: string, status?: () => UserTurnStatus, origin?: string): void;
	/**
	 * Append a caller-rendered block. Pass `isLive` when the closure reads state
	 * that keeps changing after the append, so the panel keeps re-rendering it
	 * instead of treating the first frame as final.
	 */
	appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void;
	applyEvent(event: ChatLoopEvent): void;
	/** The target a replay's next messages ran on, from the ledger's own route changes. */
	replayRoute?(targetId: string | null): void;
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
	/** The newest layout of the reply's open text segment; null once it settles or before its first frame. */
	liveTextRender(): LiveTextRender | null;
	/** The frame `render` would return, split at the settled prefix. */
	renderRegions(width: number): ChatPanelRegions;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

export interface ChatPanelOptions {
	getTerminalRows?: () => number;
	/** When the operator asked the running turn to stop, on the panel's clock; null while no stop is pending. */
	getStopRequestedAt?: () => number | null;
	/** The target the running turn was sent to, which the wire protocol on its messages does not say. */
	getRunTarget?: () => string | null;
	/** What the current turn has spent on an operator-owned wait, which its receipt keeps apart from work. */
	getHumanWaitMs?: () => number;
	/** Keeps a settled run's operator wait in the session, so its resumed receipt can split the same way. */
	recordTurnHumanWait?: (fields: { turnId: string; humanWaitMs: number }) => void;
	/** The telemetry read model's live view, whose turn quantities each turn's receipt reads (#434 §11.3). */
	getTelemetry?: () => TelemetryView | null;
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
	 * Draw a top-level fenced code block as its language word over its code rows,
	 * without the literal fence rows Pi's Markdown adds, which the live transcript
	 * keeps. `/export` sets it so the written file carries no fence rows of its own
	 * to close its outer fence early or show as border characters in HTML.
	 */
	bareCodeFences?: boolean;
	/**
	 * Run `step` when the process is otherwise idle, again after each call that
	 * returns true. The panel uses it to render settled entries in the two
	 * output styles it is not showing, a few milliseconds at a time, so the
	 * first Alt+O into a style is as cheap as a return to one. Omitted, nothing
	 * is rendered ahead.
	 */
	scheduleIdle?: (step: () => boolean) => void;
	/** Ask for a frame when the panel changes outside an event, as when an edit's diff finishes computing. */
	requestRender?: () => void;
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
 * Whether an assistant message settled a call its turn's receipt reports: one with recorded usage, one that never
 * left, or one whose usage went unreported. The receipt's figures are the read model's, not this message's.
 */
function reportsCall(message: unknown): boolean {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return false;
	if ((messageCallsForAccounting(message)?.length ?? 0) > 0) return true;
	return (message as { callInvoked?: boolean }).callInvoked === false || messageUsageForAccounting(message) !== null;
}

/** The call ids a run's own messages settled, which the read model must hold before the receipt stops reading it. */
function runCallIds(messages: ReadonlyArray<unknown>): string[] {
	return [
		...new Set(messages.flatMap((message) => (messageCallsForAccounting(message) ?? []).map((call) => call.callId))),
	];
}

/** The reasoning the turn's journaled calls hold, unmeasured until a view resolved the turn. */
function reasoningFromTurnUsage(usage: ChatPanelTurnUsage | undefined): ReasoningUsageView {
	return usage?.spend?.reasoning ?? UNMEASURED_REASONING;
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
		// A round that only reasoned still drew rows, and the receipt closes the turn beneath them.
		if (seg.kind === "thinking" && (seg.text.trim().length > 0 || seg.notRetained === true)) return true;
	}
	return false;
}

/** Index of the newest assistant entry, optionally restricted to ones that rendered something. */
function lastAssistantIndex(
	transcript: ReadonlyArray<TranscriptEntry>,
	options: { withOutput?: boolean; from?: number } = {},
): number | null {
	for (let index = transcript.length - 1; index >= (options.from ?? 0); index -= 1) {
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

/** Text with no letter or digit and at most three visible marks: punctuation a model left between actions. */
function isStrayFragment(text: string): boolean {
	const visible = text.trim();
	return visible.length > 0 && visible.length <= 3 && !/[\p{L}\p{N}]/u.test(visible);
}

/** Another segment of the turn that shows the operator something: an action, an error, or words. */
function carriesOutput(other: AssistantSegment, self: AssistantSegment): boolean {
	if (other === self) return false;
	if (other.kind === "tool" || other.kind === "error") return true;
	return other.kind === "text" && other.text.trim().length > 0 && !isStrayFragment(other.text);
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
	answer.text = answerText;
	answer.finalized = seg.finalized;
	return split;
}

/**
 * A denoising frame renders in two tones: settled text as it is, the unresolved
 * remainder dim. Frames are few (Mercury settles a block in two or three) and
 * each one rewrites arbitrary positions, so nothing here is cached.
 */
function renderDiffusionFrameLines(seg: TextSegment, settled: number, width: number): string[] {
	// A frame rewrites arbitrary positions, so redaction can move what follows the settled mark. The two tones split where the
	// redacted texts stop agreeing (#446).
	const source = redactStreamingUrlCredentials(sanitizeAssistantProse(seg.text));
	const settledText = redactStreamingUrlCredentials(sanitizeAssistantProse(seg.text.slice(0, settled)));
	let shared = 0;
	while (shared < settledText.length && source.charCodeAt(shared) === settledText.charCodeAt(shared)) shared += 1;
	const head = source.slice(0, shared);
	const tail = source.slice(shared);
	const lines: string[] = [];
	const headLines = head.split("\n");
	const tailLines = tail.split("\n");
	// The line the boundary falls on carries both tones.
	const joinLine = `${headLines[headLines.length - 1] ?? ""}${tail.length > 0 ? `${SECONDARY()}${tailLines[0] ?? ""}${SGR_RESET}` : ""}`;
	for (let i = 0; i < headLines.length - 1; i += 1) {
		for (const line of wrapTextWithAnsi(headLines[i] ?? "", width)) lines.push(line);
	}
	for (const line of wrapTextWithAnsi(joinLine, width)) lines.push(line);
	for (let i = 1; i < tailLines.length; i += 1) {
		for (const line of wrapTextWithAnsi(`${SECONDARY()}${tailLines[i] ?? ""}${SGR_RESET}`, width)) lines.push(line);
	}
	return lines.map((line) => clioTheme().base("assistantProse", line));
}

// Lexer for fitMarkdownTables, which runs inside Markdown's transform hook.
const tableParser = new Marked();

// Marked's GFM delimiter row. A table has exactly as many columns as this row, so it alone decides the width test.
const TABLE_DELIMITER_ROW = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/gmu;

/** Keep Pi's wrapped cells unless borders leave fewer than 12 columns per field. */
function tableFitsWidth(columns: number, width: number): boolean {
	return width >= columns * 15 + 1;
}

/**
 * Whether the grid still reads at this width: every field keeps 12 columns, and the cells' natural widths come
 * to under 1.75 times the room the borders leave. Past that the long fields wrap into tall columns of two or three
 * words a row (an 80-column summary drew a six-row cell per record), and records read better.
 */
function tableGridReads(table: Tokens.Table, width: number): boolean {
	const columns = table.header.length;
	if (!tableFitsWidth(columns, width)) return false;
	const room = width - (columns * 3 + 1);
	let natural = 0;
	for (let index = 0; index < columns; index += 1) {
		let widest = visibleWidth(table.header[index]?.text ?? "");
		for (const row of table.rows) widest = Math.max(widest, visibleWidth(row[index]?.text ?? ""));
		natural += widest;
	}
	return natural <= room * 1.75;
}

/** Whether a lex could find a table to rewrite. A false positive costs one lex; a false negative would keep a table. */
function mayNeedTableFit(text: string): boolean {
	if (!text.includes("|")) return false;
	// A lex also removes a repeated link definition, which closes up the blank rows around it, so keep it for those.
	const definition = text.indexOf("]:");
	if (definition >= 0 && text.includes("]:", definition + 2)) return true;
	for (const match of text.matchAll(TABLE_DELIMITER_ROW)) {
		const row = match[1] ?? "";
		// Any table may need records once its cells are measured, so the width alone no longer rules one out.
		if (/[:|]/u.test(row)) return true;
	}
	return false;
}

function fitMarkdownTables(tokens: readonly Tokens.Generic[], width: number): { text: string; rewritten: boolean } {
	let rewritten = false;
	const text = tokens
		.map((token) => {
			if (token.type !== "table") return token.raw;
			const table = token as Tokens.Table;
			if (tableGridReads(table, width) || table.rows.length === 0) {
				return token.raw;
			}
			rewritten = true;
			// Each row becomes one compact record: its first field in bold names it,
			// the other fields follow on hard line breaks, and a blank line parts records.
			return `${table.rows
				.map((row) =>
					row
						.map((cell, index) => {
							const label = table.header[index]?.text.trim() ?? "";
							if (index === 0) return label ? `**${label}: ${cell.text}**` : `**${cell.text}**`;
							return label ? `**${label}:** ${cell.text}` : cell.text;
						})
						.join("\\\n"),
				)
				.join("\n\n")}\n\n`;
		})
		.join("");
	return { text, rewritten };
}

function chatMarkdown(text: string, bareFences: boolean): Markdown {
	return new Markdown(
		text,
		0,
		0,
		bareFences ? EXPORT_MARKDOWN_THEME : CHAT_MARKDOWN_THEME,
		undefined,
		CHAT_MARKDOWN_OPTIONS,
	);
}

/**
 * One row of an export panel's Markdown, with its fence tags resolved. A fence
 * at the top level starts its row with the tag: the opening row becomes the
 * language word as a quiet label and every other fence row is dropped, which is
 * how the export drew a code block before Pi's fence rows reached the transcript.
 * A fence nested in a list or quote carries that block's indent ahead of the
 * tag and keeps Pi's literal row, as it always did.
 */
function exportFenceRow(row: string): string | null {
	const tagAt = row.indexOf(EXPORT_FENCE_MARK);
	if (tagAt < 0) return row;
	if (tagAt > 0) return row.replace(EXPORT_FENCE_MARK, "");
	const lang = stripTerminalSequences(row)
		.slice(EXPORT_FENCE_MARK.length + 3)
		.trim()
		.split(/\s+/u, 1)[0];
	return lang ? clioTheme().fg("annotation", lang) : null;
}

/**
 * pi-tui Markdown right-pads every row to the render width, while transcript
 * rows are unpadded for hangProseLines. The padding is trimmed before the
 * width check because wrapping or truncating a padded row costs far more per
 * frame than the same row trimmed first. The regex keeps a trailing no-break
 * space, which Mermaid rows use.
 */
function fitMarkdownRow(padded: string, width: number, bareFences: boolean): string[] {
	// A fence nested in a quote is not rejoined, so its code row still carries CODE_SPACE.
	const trimmed = padded.replace(/ +$/u, "").replace(CODE_LINE, " ").replaceAll(CODE_SPACE, " ");
	const line = bareFences ? exportFenceRow(trimmed) : trimmed;
	if (line === null) return [];
	const parts = visibleWidth(line) > width ? wrapTextWithAnsi(line, width) : [line];
	return parts.map((part) =>
		clioTheme().base("assistantProse", visibleWidth(part) > width ? truncateToWidth(part, width, "") : part),
	);
}

/**
 * A paragraph wrapped just before ` - ` or ` + ` starts its next row with what reads as a list bullet
 * (`- μ)² and the block…`). The operator moves to the end of the row above when it fits there, the way
 * typesetting breaks after a binary operator. A row above that is itself a list item at the same indent
 * is a list, not a wrapped paragraph, and is left alone.
 */
function liftLeadingOperator(above: string, row: string, width: number): [string, string] | null {
	const lead = /^( *)([-+]) (?=\S)/u.exec(stripTerminalSequences(row));
	if (lead === null) return null;
	const indent = lead[1] ?? "";
	// Styling may open before the marker, so the marker is found past any escape sequences.
	const at = row.indexOf(`${lead[2]} `, indent.length);
	if (at < 0 || stripTerminalSequences(row.slice(0, at)) !== indent) return null;
	const plainAbove = stripTerminalSequences(above).replace(/ +$/u, "");
	if (!plainAbove.startsWith(indent) || plainAbove.charAt(indent.length) === " ") return null;
	if (/^ *(?:[-+*]|\d+[.)]) /u.test(plainAbove)) return null;
	const raised = `${above.replace(/ +$/u, "")} ${lead[2]}`;
	if (visibleWidth(raised) > width) return null;
	return [raised, `${row.slice(0, at)}${row.slice(at + 2)}`];
}

/** A fence row as Pi draws it, export-tagged or not; a list or a quote nests it behind its own indent. */
const FENCE_ROW = /^( *)\uFDD0?```/u;

/** The opening fence as the block's language, or `code` when it names none, at the fence's own indent. */
function fenceLabelRow(row: string, fenceEnd: number, indent: string): string {
	const lang = stripTerminalSequences(row).slice(fenceEnd).trim().split(/\s+/u, 1)[0];
	return `${indent}${clioTheme().fg("annotation", lang || "code")}`;
}

/**
 * One source line of a fenced code block, rejoined from the pieces Pi cut it
 * into. A line that fits prints as it is; a longer one wraps once at its spaces,
 * and each wrapped piece keeps the block's indent behind a mark that says it
 * continues the line above, so it never reads as prose or a separate statement.
 */
function fitCodeLine(line: string, fenceIndent: string, width: number, bareFences: boolean): string[] {
	const theme = clioTheme();
	const text = line.replace(CODE_LINE, " ").replaceAll(CODE_SPACE, " ").replace(/ +$/u, "");
	if (visibleWidth(text) <= width) return [theme.base("assistantProse", text)];
	const lead = `${fenceIndent}  `;
	const body = text.startsWith(lead) ? text.slice(lead.length) : text.replace(/^ +/u, "");
	const mark = bareFences ? lead : `${lead}${theme.fg("annotation", GLYPH.codeWrap)} `;
	const room = Math.max(1, width - visibleWidth(mark));
	return wrapPaths(body, room).map((part, index) => theme.base("assistantProse", `${index === 0 ? lead : mark}${part}`));
}

function markdownRows(md: Markdown, width: number, bareFences: boolean, memo?: RowMemo): string[] {
	const padded = md.render(width);
	const rows: string[] = [];
	let fenceIndent: string | null = null;
	// The code line being rejoined: its first row from Pi, then each piece Pi cut off it.
	let code: string | null = null;
	// The prose row last drawn and where its parts sit, so a wrap that left an operator leading the next row can move it back.
	let prose: { raw: string; at: number; count: number } | null = null;
	const codeKeys: string[] = [];
	const flushCode = (): void => {
		if (code === null) return;
		const key = `\0code\0${code}`;
		codeKeys.push(key);
		let parts = memo?.rows.get(key);
		if (parts === undefined) {
			parts = fitCodeLine(code, fenceIndent ?? "", width, bareFences);
			memo?.rows.set(key, parts);
		}
		for (const part of parts) rows.push(part);
		code = null;
	};
	for (const row of padded) {
		const fence = row.includes("```") ? FENCE_ROW.exec(stripTerminalSequences(row)) : null;
		if (fence !== null) {
			prose = null;
			flushCode();
			fenceIndent = fenceIndent === null ? (fence[1] ?? "") : null;
			if (!bareFences) {
				// The reader needs where code starts and what language it is, not the Markdown that said so: the
				// opening fence becomes the language as a quiet label and the closing fence draws nothing.
				if (fenceIndent !== null) rows.push(fenceLabelRow(row, fence[0].length, fenceIndent));
				continue;
			}
		} else if (fenceIndent !== null) {
			const trimmed = row.replace(/ +$/u, "");
			if (stripTerminalSequences(trimmed).startsWith(`${fenceIndent}${CODE_LINE}`) || code === null) {
				flushCode();
				code = trimmed;
			} else {
				code += trimmed.replace(/^ +/u, "");
			}
			continue;
		}
		let current = row;
		const lifted = prose === null ? null : liftLeadingOperator(prose.raw, row, width);
		if (prose !== null && lifted !== null) {
			rows.splice(prose.at, prose.count, ...fitMarkdownRow(lifted[0], width, bareFences));
			current = lifted[1];
		}
		let parts = memo?.rows.get(current);
		if (parts === undefined) {
			parts = fitMarkdownRow(current, width, bareFences);
			memo?.rows.set(current, parts);
		}
		prose = stripTerminalSequences(current).trim() === "" ? null : { raw: current, at: rows.length, count: parts.length };
		for (const part of parts) rows.push(part);
	}
	flushCode();
	// Each delta strands the old tail rows. Keep the live ones, so eviction never costs a re-measure.
	if (memo !== undefined && memo.rows.size > padded.length * 2 + 256) {
		const live = new Map<string, string[]>();
		for (const key of [...padded, ...codeKeys]) {
			const parts = memo.rows.get(key);
			if (parts !== undefined) live.set(key, parts);
		}
		memo.rows = live;
	}
	return rows;
}

/**
 * A text segment renders through one stock Markdown component, streaming or
 * settled. Markdown renders each top-level block independently and caches by
 * (text, width), so the rows above the open block stay byte-stable while text
 * arrives, and a regular-screen terminal does not redraw the transcript when
 * the answer finalizes. setText always invalidates that cache, so it runs only
 * when the projected text changed.
 */
function renderTextSegmentLines(seg: TextSegment, width: number, bareFences: boolean): string[] {
	if (!seg.finalized && seg.diffusion) {
		return renderDiffusionFrameLines(seg, seg.diffusion.settled, width);
	}
	const epoch = skinEpoch();
	if (seg.rendered?.source !== seg.text || seg.rendered.finalized !== seg.finalized || seg.rendered.epoch !== epoch) {
		seg.rendered = { source: seg.text, finalized: seg.finalized, epoch, layouts: new Map() };
	}
	const key = `${width}|${bareFences}`;
	const cached = seg.rendered.layouts.get(key);
	if (cached !== undefined) return cached;
	const startedAt = seg.finalized ? 0 : performance.now();
	seg.prose ??= new AssistantProseProjection();
	seg.secrets ??= new RedactedStringProjection(redactUrlCredentials);
	const prose = seg.secrets.project(seg.prose.project(seg.text, seg.finalized), seg.finalized);
	if (seg.markdown === undefined || seg.markdown.epoch !== skinEpoch())
		seg.markdown = { view: chatMarkdown(prose, bareFences), source: prose, epoch: skinEpoch() };
	else if (seg.markdown.source !== prose) {
		seg.markdown.view.setText(prose);
		seg.markdown.source = prose;
	}
	let memo = seg.rowMemo;
	if (memo?.width !== width || memo.bareFences !== bareFences || memo.epoch !== epoch)
		memo = seg.finalized ? undefined : { width, bareFences, epoch, rows: new Map() };
	// A settled segment can last the whole session, so it keeps only its layouts.
	seg.rowMemo = seg.finalized ? undefined : memo;
	const lines = withoutLeadingBlanks(markdownRows(seg.markdown.view, width, bareFences, memo));
	if (!seg.finalized) seg.liveRender = { durationMs: performance.now() - startedAt, codeUnits: seg.text.length };
	seg.rendered.layouts.set(key, lines);
	if (seg.rendered.layouts.size > 3) {
		const oldest = seg.rendered.layouts.keys().next().value;
		if (oldest !== undefined) seg.rendered.layouts.delete(oldest);
	}
	return lines;
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
	const headline = !unbounded && seg.route ? providerFailureHeadline(seg.route) : null;
	if (seg.route && headline !== null) {
		// The plain sentence and the way out read first; the row fold takes what the provider said before either.
		for (const wrapped of wrapTextWithAnsi(headline, width)) out.push(`${RED_CRIT()}${wrapped}${RESET}`);
		for (const row of [providerFailureAdvice(seg.route), providerFailureEvidence(seg.route, seg.text)])
			for (const wrapped of wrapTextWithAnsi(row, width)) out.push(`${SECONDARY()}${wrapped}${RESET}`);
		return out;
	}
	// The row's ✗ already says it failed; `✗ [error] cannot load…` said it twice in the store's own marker. /view keeps it.
	const shown = unbounded
		? providerErrorEvidence(seg.text)
		: presentProviderError(seg.text, { remedyStated: seg.route !== undefined && seg.route !== null }).replace(
				/^\[error\] /u,
				"",
			);
	for (const line of shown.split("\n")) {
		for (const wrapped of wrapTextWithAnsi(line, width)) {
			out.push(`${RED_CRIT()}${wrapped}${RESET}`);
		}
	}
	if (seg.route) {
		for (const wrapped of wrapTextWithAnsi(providerFailureAdvice(seg.route), width))
			out.push(`${SECONDARY()}${wrapped}${RESET}`);
	}
	return out;
}

const CLIO_PREFIX = () => `${TEAL()}${AGENT_GLYPH}${RESET} `;
/** Clio wrote this about a failure, so it never wears the mark of something the model said. */
const CLIO_PREFIX_ERROR = () => `${RED_CRIT()}${GLYPH.error}${RESET} `;
/**
 * Operator prompts wear the accent bar on every row and bold text, so the
 * operator's words are never the same weight as the agent prose beneath them.
 */
const USER_PREFIX = () => `${TEAL()}${USER_BAR}${RESET} `;
/**
 * A prompt Clio has taken but not yet committed. The bar is dim rather than
 * teal, the text is not bold, and the row says so, because the transcript used
 * to paint an uncommitted prompt exactly like a durable user turn while the
 * ledger still had no entry for it (issue #251).
 */
const USER_PREFIX_PENDING = () => `${SECONDARY()}${USER_BAR}${RESET} `;
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
		rendered[last] = `${lastLine}${SECONDARY()}${tail}${RESET}`;
		return;
	}
	rendered.push(`${USER_PREFIX_PENDING()}${dimLine(tail.trimStart(), Math.max(1, width - PROSE_GUTTER_WIDTH))}`);
}

/**
 * An operator prompt: the bar on every row, the text bold once committed. The
 * bar is what separates the operator's words from the agent's, so it does not
 * stop at the first row the way a voice glyph does.
 */
const SKILL_INVOCATION = /^\/skill\s+\S+/u;
const LOOP_LABEL_CHARS = 32;

function renderUserLines(text: string, width: number, status: UserTurnStatus, origin?: string): string[] {
	const contentWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	const scheduled = /^job (\S+) (\S+)$/u.exec(origin ?? "");
	if (scheduled !== null) {
		const task = sanitizeMultilineDisplayText(text).text;
		const flat = task.replace(/\s+/gu, " ").trim();
		const label =
			flat.length <= LOOP_LABEL_CHARS ? flat : `${flat.slice(0, LOOP_LABEL_CHARS - 1).trimEnd()}${GLYPH.ellipsis}`;
		// Two loops can run at once, so the row says which one fired. A task the label holds whole needs no second row.
		const header = `${GLYPH.scheduled} Scheduled loop "${label}" · /loop status`;
		return [
			...wrapTextWithAnsi(clioTheme().fg("annotation", header), width),
			...(label === flat ? [] : hangProseLines(wrapTextWithAnsi(clioTheme().fg("annotation", task), contentWidth))),
		];
	}
	const committed = status === "committed";
	const prefix = committed ? USER_PREFIX() : USER_PREFIX_PENDING();
	const rendered: string[] = [];
	const sourceLines = text.split("\n");
	// A `/skill <name>` prompt leads with the command in the slash-command
	// accent, so an explicit skill invocation reads as one rather than as prose.
	const invocation = SKILL_INVOCATION.exec(sourceLines[0] ?? "");
	if (invocation?.[0] !== undefined) {
		sourceLines[0] = `${clioTheme().style("guidance", invocation[0], { bold: committed })}${committed ? SGR_BOLD : ""}${(sourceLines[0] ?? "").slice(invocation[0].length)}`;
	}
	for (const sourceLine of sourceLines) {
		for (const row of wrapTextWithAnsi(sourceLine, contentWidth)) {
			rendered.push(
				`${prefix}${clioTheme().base("userProse", committed && row.length > 0 ? `${SGR_BOLD}${row}${SGR_BOLD_OFF}` : row)}`,
			);
		}
	}
	if (rendered[0] !== undefined) rendered[0] = `${OSC133_PROMPT_START}${rendered[0]}`;
	if (!committed) appendUserRowTail(rendered, status === "pending" ? USER_PENDING_TAIL : USER_REFUSED_TAIL, width);
	if (origin) rendered.push(...wrapTextWithAnsi(`  ${sanitizeCallTargetText(origin)}`, width));
	return rendered;
}

/**
 * Static marker used when thinking is folded. This matches pi-coding-agent's
 * hidden-thinking presentation and avoids previewing reasoning content.
 */
const THINKING_HIDDEN_LABEL = "Thinking · /view";
/** Replayed reasoning the target's history dropped: `/view` has nothing to open, so the row offers nothing. */
const THINKING_NOT_RETAINED_LABEL = "Thinking · streamed live, not kept";
function dimLine(text: string, width: number): string {
	return `${SECONDARY()}${truncateToWidth(text, Math.max(1, width), GLYPH.ellipsis, false)}${RESET}`;
}

/**
 * Supplied reasoning owns a quiet structural rail in the gutter, in every style: a
 * folded marker and an excerpt wear the same mark, and no other block uses a
 * gutter rail, so reasoning never reads as tool output. Readable secondary
 * text and italics distinguish the excerpt from the answer.
 */
const REASON_RAIL = () => `${REASON_INK()}│${RESET} `;

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
	return `${REASON_RAIL()}${dimLine(
		count === null ? THINKING_HIDDEN_LABEL : `${THINKING_HIDDEN_LABEL} · ${count}`,
		Math.max(1, width - PROSE_GUTTER_WIDTH),
	)}`;
}

/**
 * Reasoning is markdown (`**Outlining parsing assumptions**` headings), but the
 * rail is already one italic excerpt style, so the markers are dropped rather
 * than rendered (p9/D4). Code spans and glob-like runs (`src/**\/*.ts`) keep
 * their asterisks, and an opener still streaming without its closer is dropped
 * at a line start so the heading does not flicker as the delta lands.
 */
const THINKING_EMPHASIS = /(?<![\p{L}\p{N}_*/\\.])(\*{1,2})(?=[^\s*])([^\n]*?[^\s*\\])\1(?![\p{L}\p{N}*])/gu;
const THINKING_OPEN_BOLD = /^(\s*)\*\*(?=[^\s*])/gmu;

function stripThinkingEmphasis(text: string): string {
	return text
		.split(/(`[^`\n]*`)/u)
		.map((part, index) =>
			index % 2 === 1 ? part : part.replace(THINKING_EMPHASIS, "$2").replace(THINKING_OPEN_BOLD, "$1"),
		)
		.join("");
}

/**
 * A settled excerpt opens on a line of the reasoning, not on the end of one, so it never starts with `remain.)`. A live
 * one keeps its rows, because a stream that has not reached a line start yet would otherwise show less of itself.
 */
function settledExcerptLimit(rows: ReadonlyArray<string>, text: string, limit: number): number {
	const lineStarts = new Set(text.split("\n").map((line) => line.trimStart().slice(0, 12)));
	// A paragraph with no line start in reach opens mid-line whatever the cut, so it keeps the rows it streamed with.
	for (let fitted = limit; fitted > 2 && rows.length > fitted; fitted -= 1) {
		const opening = (rows[rows.length - fitted + 1] ?? "").trimStart().slice(0, 12);
		if (lineStarts.has(opening)) return fitted;
	}
	return limit;
}

const THINKING_LEAD = "thinking · ";

/** Wrap first, then keep the same tail both while streaming and after settlement. */
function renderThinkingRail(
	thinking: string,
	width: number,
	limit: number,
	unbounded: boolean,
	open: boolean,
): string[] {
	// Reasoning often ends on a newline; wrapped, that became an empty rail row.
	// Presentation only: the provider's signed reasoning stays untouched.
	const text = stripThinkingEmphasis(redactStreamingSecretString(sanitizeAssistantProse(thinking), !open)).replace(
		/^\s*\n|\s+$/gu,
		"",
	);
	if (text.length === 0) return [];
	// A bounded excerpt spends no rows on paragraph breaks; /view keeps them. The excerpt opens with the word
	// that says what it is, because the rail alone is the same mark a tool's output wears.
	const wrapped = wrapTextWithAnsi(`${THINKING_LEAD}${text}`, Math.max(1, width - PROSE_GUTTER_WIDTH));
	const kept = unbounded ? wrapped : wrapped.filter((row) => row.trim().length > 0);
	const rows = kept.map((row, index) => {
		const lead = index === 0 && row.startsWith(THINKING_LEAD) ? THINKING_LEAD : "";
		const body = row.slice(lead.length);
		return `${REASON_RAIL()}${lead ? clioTheme().fg("annotation", lead) : ""}${SGR_ITALIC}${clioTheme().fg("reasoningExcerpt", body)}${RESET}`;
	});
	if (unbounded) return rows;
	return previewRows(
		rows,
		open ? limit : settledExcerptLimit(kept, text, limit),
		width,
		true,
		REASON_RAIL(),
		PROSE_GUTTER_WIDTH,
	);
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
	const outcome = usage.outcome ?? "Done";
	const glyph = receiptGlyph(outcome);
	const room = Math.max(1, width - PROSE_GUTTER_WIDTH);
	const quiet =
		usage.ending?.kind === "quiet"
			? "no closing message"
			: usage.ending?.kind === "call_not_run"
				? writtenCallsFact(usage.ending.writtenTools)
				: null;
	// A turn with no answer states why in every style: Brief drops receipts, not this.
	const noAnswer =
		usage.ending?.kind === "no_answer"
			? hangProseLines(
					wrapTextWithAnsi(
						`${SECONDARY()}${turnNoAnswerSentence(usage.ending)} Ask again, or /model switches route.${RESET}`,
						room,
					).map(releaseSpaces),
				)
			: [];
	if (receipt === "none") {
		// A written call that did not run is news in every style too, and Brief has no receipt row to carry it otherwise.
		if (usage.ending?.kind === "call_not_run")
			return [
				`${glyph}${dimLine(joinFacts([`${outcome}${receiptDuration(usage)}`, writtenCallsFact(usage.ending.writtenTools)]), room)}`,
			];
		return noAnswer.length === 0 ? [] : [`${glyph}${dimLine(`${outcome}${receiptDuration(usage)}`, room)}`, ...noAnswer];
	}
	const spend = usage.spend;
	// A wait the provider asked for spends no retry, so the receipt keeps it apart: a count of them approached no limit.
	const retries =
		[
			usage.providerWaits ? `${usage.providerWaits} provider wait${usage.providerWaits === 1 ? "" : "s"}` : null,
			usage.retries ? `${usage.retries} ${usage.retries === 1 ? "retry" : "retries"}` : null,
		]
			.filter(Boolean)
			.join(", ") || null;
	const moved = usage.movedTo ? `moved to ${modelNickname(usage.movedTo)}` : null;
	if (receipt === "compact") {
		// The outcome, then how long and how many calls; a call count of one says nothing unless retries explain it.
		const calls =
			spend?.calls != null && (spend.calls > 1 || retries !== null || moved !== null)
				? renderCalls(String(spend.calls), "call")
				: null;
		// A call moved away from has no amounts of its own. The row states the answering call beside the move, and
		// Detailed keeps the sum.
		const stated = moved !== null ? spend?.answer : spend;
		// A narrow row loses the least useful facts whole, so it never ends on half an amount.
		const rowFacts = [
			`${outcome}${receiptDuration(usage)}`,
			...(quiet === null ? [] : [quiet]),
			...(usage.promptRecall === true ? [PROMPT_RECALL_FACT] : []),
		];
		for (const fact of [
			calls !== null || retries !== null || moved !== null ? [calls, retries, moved].filter(Boolean).join(", ") : null,
			spend?.coverageNote ?? null,
			stated?.tokens ?? null,
			// A route that reports no cache would end every row on the same unknown; Detailed and /usage keep that.
			stated?.cached != null ? `cached ${stated.cached}` : null,
		]) {
			if (fact !== null && visibleWidth(joinFacts([...rowFacts, fact])) <= room) rowFacts.push(fact);
		}
		return [`${glyph}${dimLine(releaseSpaces(joinFacts(rowFacts)), room)}`, ...noAnswer];
	}
	const settled = `${outcome}${quiet === null ? "" : ` · ${quiet}`}${retries === null ? "" : ` · ${retries}`}${moved === null ? "" : ` · ${moved}`}${receiptDuration(usage)}`;
	// Detailed states what the turn spent, one fact per field, as the read model
	// folds the turn with its workers, so the line and the footer agree: the
	// calls it made, input and output tokens in the compact token format, what
	// the provider served from its prompt cache, the reasoning it reported (`≈`
	// when Clio estimated it), and why the cache was expected to be cold when
	// nothing was reused. A field with nothing to say is left out, and with no
	// read model the line keeps only what the run itself knows.
	const facts: string[] = [settled];
	if (usage.promptRecall === true) facts.push(PROMPT_RECALL_FACT);
	if (spend) {
		if (spend.calls !== null && spend.calls > 1) facts.push(`${spend.calls} calls`);
		facts.push(`in ${spend.input}`, `out ${spend.output}`);
		if (spend.cacheRead !== null) facts.push(`cached ${spend.cacheRead}`);
		if (spend.cacheWrite !== null) facts.push(`cache write ${spend.cacheWrite}`);
	}
	const reasoning = reasoningFromTurnUsage(usage);
	if (reasoning.tokens > 0 && reasoning.provenance !== "unmeasured") {
		facts.push(`reasoning ${reasoning.provenance === "provider" ? "" : "≈"}${compactReasoningTokens(reasoning.tokens)}`);
	}
	if (spend?.cost != null) facts.push(spend.cost);
	if (spend?.cacheRead == null && usage.coldReasons !== undefined && usage.coldReasons.length > 0) {
		facts.push(`prompt read again after ${coldReasonList(usage.coldReasons)}`);
	}
	// How many calls had no usage data closes the line once, after the figures it qualifies (F4).
	if (spend?.coverage) facts.push(spend.coverage);
	return [
		...hangProseLines(wrapTextWithAnsi(`${SECONDARY()}${joinFacts(facts)}${RESET}`, room).map(releaseSpaces), glyph),
		...noAnswer,
	];
}

/**
 * The receipt closes a turn with its outcome glyph in the gutter, like every
 * other block's mark, so where each turn ended and how is scannable down the
 * left edge. Only the glyph carries color; the facts stay dim.
 */
/** A turn that waited on the operator states its work and that wait apart: the sum describes neither. */
function receiptDuration(usage: ChatPanelTurnUsage): string {
	if (usage.elapsedMs === undefined) return "";
	const waited = usage.humanWaitMs ?? 0;
	if (waited < 1000) return ` · ${formatCompactMs(usage.elapsedMs)}`;
	return ` · ${formatCompactMs(Math.max(0, usage.elapsedMs - waited))} work · ${formatCompactMs(waited)} waiting on you`;
}

const PROMPT_RECALL_FACT = `${GLYPH.up} recalls your prompt`;

function receiptGlyph(outcome: string): string {
	if (outcome === "Done") return `${GREEN_OK()}${GLYPH.ok}${RESET} `;
	if (outcome === "Failed") return `${RED_CRIT()}${GLYPH.error}${RESET} `;
	if (outcome === "Cancelled") return `${SECONDARY()}${GLYPH.cancelled}${RESET} `;
	return `${AMBER_WARN()}${GLYPH.warn}${RESET} `;
}

function renderToolSegmentLines(
	seg: ToolSegment,
	width: number,
	nowMs: number,
	unbounded: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
	stopRequestedAt: number | null = null,
): string[] {
	const call = {
		toolCallId: seg.id,
		toolName: seg.name,
		args: shownArgs(seg),
		actionClass: seg.actionClass,
		cardAttached: seg.cardAttached,
		elapsedMs: seg.startedAtMs === undefined ? undefined : Math.max(0, rawDurationMs(seg.startedAtMs, nowMs)),
		phase: seg.executionStarted ? ("running" as const) : seg.argsComplete ? ("ready" as const) : ("forming" as const),
	};
	if (!seg.finished && seg.awaitingApproval)
		return renderToolAwaitingApproval(call, width, detail.style === "compact" ? undefined : seg.approvalView);
	const finished = {
		...call,
		result: seg.result,
		isError: seg.isError,
		durationMs: seg.durationMs,
		resultSummary: seg.resultSummary,
		outcome: seg.settlement,
		notRun: seg.notRun,
		blockReason: seg.blockReason,
		evictedReason: seg.evictedReason,
		...(seg.cardsCancelled === true ? { cardsCancelled: true } : {}),
		operatorGrant: seg.operatorGrant,
		...shellActor(seg),
	};
	const options = { unbounded, diffStyle: seg.replayed ? ("plain" as const) : ("color" as const) };
	if (unbounded && seg.finished) return renderToolExecution(finished, width, options);
	if (seg.finished) return renderToolPreview(finished, width, detail, { ...options, terminalRows });
	seg.live ??= new LiveToolView();
	// A command the model asked for keeps running until its process exits, so a stop that went out is its own row.
	const stopRow =
		stopRequestedAt !== null && seg.executionStarted && shellActor(seg).actor !== undefined
			? [stopSentRow(Math.max(0, nowMs - stopRequestedAt), width)]
			: [];
	// A started process names who runs it while it runs, as its settled row does, so a stop reads `Clio is stopping`.
	const running = seg.executionStarted ? { ...call, ...shellActor(seg) } : call;
	const rows = renderToolPreview(stopRow.length > 0 ? { ...running, stopping: true } : running, width, detail, {
		...options,
		terminalRows,
		partialResult: seg.partialResult,
		live: seg.live,
		...(seg.previewDiff !== undefined ? { previewDiff: seg.previewDiff } : {}),
	});
	return [...rows, ...stopRow];
}

/** Shell-class calls say who started the process. Anything else already reads as a named action. */
function shellActor(seg: ToolSegment): { actor?: "harness"; requestedBy?: string } {
	if (seg.name !== ToolNames.Bash && seg.name !== ToolNames.RunScript) return {};
	return { actor: "harness", ...(seg.requestedBy !== undefined ? { requestedBy: seg.requestedBy } : {}) };
}

/** A finished call changes only when a late result upgrades it or a worker card attaches to it. */
function changeSettledCall(seg: ToolSegment): void {
	seg.settledRows = undefined;
	seg.settledFold = undefined;
	seg.settledFamily = undefined;
	seg.settledRevision = (seg.settledRevision ?? 0) + 1;
}

/** Arguments still forming can stop anywhere inside a URL, so they show only what cannot become its userinfo (#446). */
function shownArgs(seg: ToolSegment): unknown {
	return seg.argsComplete ? seg.args : holdUnresolvedStrings(seg.args);
}

/** A settled tool segment as the renderers read a finished call. */
function finishedCall(seg: ToolSegment): ToolExecutionFinished {
	return {
		toolCallId: seg.id,
		toolName: seg.name,
		args: shownArgs(seg),
		result: seg.result,
		isError: seg.isError,
		durationMs: seg.durationMs,
		outcome: seg.settlement,
		notRun: seg.notRun,
		blockReason: seg.blockReason,
		evictedReason: seg.evictedReason,
		resultSummary: seg.resultSummary,
		actionClass: seg.actionClass,
		cardAttached: seg.cardAttached,
		...(seg.cardsCancelled === true ? { cardsCancelled: true } : {}),
		operatorGrant: seg.operatorGrant,
		...shellActor(seg),
	};
}

/** The Compact fold a settled tool segment joins, or null when it keeps its own row. */
function foldFamily(seg: AssistantSegment | undefined): ToolFoldFamily | null {
	if (seg?.kind !== "tool" || !seg.finished) return null;
	// A fold row cannot say which of its calls the operator allowed.
	if (seg.operatorGrant !== undefined) return null;
	if (seg.settledFamily === undefined) seg.settledFamily = toolFoldFamily(finishedCall(seg));
	return seg.settledFamily;
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
	bareFences: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
	previous?: TranscriptEntry,
	workerOptions?: Pick<WorkerEntryRenderOptions, "siblings" | "showGroupHeader" | "telemetry">,
	stopRequestedAt: number | null = null,
): string[] {
	if (entry.role === "replayBlock") {
		return entry.renderBlock(width, detail, unboundedToolBodies, terminalRows);
	}
	if (entry.role === "user") {
		return renderUserLines(entry.text, width, entry.status?.() ?? "committed", entry.origin);
	}
	if (entry.role === "retryStatus") {
		return renderRetryStatus(entry.status, width, detail, unboundedToolBodies, terminalRows);
	}
	if (entry.role === "worker") {
		return renderWorkerEntryLines(entry.state, width, {
			...workerOptions,
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
	// The model row says which model answered when that changed: the first turn,
	// a switch, or a failover inside the turn. Repeating it on every turn cost a
	// row per answer and said nothing new.
	if (entry.models?.length && !(entry.models.length === 1 && entry.sameModelAsBefore === true))
		blocks.push({ kind: "prose", lines: renderNoticeRow(`Model ${entry.models.join(" → ")}`, "info", width) });
	const proseWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	const settledKey = `${width}|${terminalRows}|${detail.style}|${unboundedToolBodies}|${skinEpoch()}`;
	// Reasoning stays between the prose and actions that surround it, one block
	// per run of it: stretches that nothing visible separates read as one. A run
	// is held until the block after it is known, because what follows decides
	// its shape: Standard shows the bounded tail of the reasoning behind Clio's
	// words, and the marker for the reasoning behind an action.
	let reasoning = "";
	let reasoningOpen = false;
	let reasoningIndex = 0;
	let lastMarker: TurnBlock | undefined;
	const flushReasoning = (next: "action" | "words"): void => {
		const text = reasoning;
		reasoning = "";
		if (text.trim().length === 0) return;
		const index = reasoningIndex++;
		const rows = next === "action" ? detail.reasoningBeforeActionRows : detail.reasoningRows;
		if (rows > 0 || unboundedToolBodies) {
			// A running tool's clock must not re-filter or re-wrap earlier reasoning (#428).
			entry.reasoningRenders ??= new Map();
			let cached = entry.reasoningRenders.get(index);
			if (cached?.source !== text || cached.open !== reasoningOpen || cached.epoch !== skinEpoch()) {
				cached = { source: text, open: reasoningOpen, epoch: skinEpoch(), layouts: new Map() };
				entry.reasoningRenders.set(index, cached);
			}
			const limit = previewBudget(rows, terminalRows);
			const key = `${width}|${limit}|${unboundedToolBodies}`;
			let lines = cached.layouts.get(key);
			if (lines === undefined) {
				lines = renderThinkingRail(text, width, limit, unboundedToolBodies, reasoningOpen);
				cached.layouts.set(key, lines);
				if (cached.layouts.size > 3) {
					const oldest = cached.layouts.keys().next().value;
					if (oldest !== undefined) cached.layouts.delete(oldest);
				}
			}
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
			if (seg.notRetained === true) {
				flushReasoning("words");
				blocks.push({
					kind: "thinking",
					lines: [`${REASON_RAIL()}${dimLine(THINKING_NOT_RETAINED_LABEL, Math.max(1, width - PROSE_GUTTER_WIDTH))}`],
				});
				continue;
			}
			reasoning = joinReasoning(reasoning, seg.text);
			reasoningOpen = !seg.finalized;
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
				let revisions = 0;
				for (const call of grouped) revisions += call.settledRevision ?? 0;
				let fold = seg.settledFold;
				if (
					fold === undefined ||
					fold.key !== settledKey ||
					fold.calls !== grouped.length ||
					fold.revisions !== revisions
				) {
					const lines = renderFoldedGroup(
						family,
						grouped.map(finishedCall),
						width,
						previewBudget(detail.invocationRows, terminalRows),
					);
					fold = { key: settledKey, lines, body: hasToolBody(lines), calls: grouped.length, revisions };
					seg.settledFold = fold;
				}
				blocks.push({ kind: "tool", lines: fold.lines, body: fold.body });
				segIndex = end;
			} else {
				flushReasoning("action");
				let rows = seg.finished && seg.settledRows?.key === settledKey ? seg.settledRows : undefined;
				if (rows === undefined) {
					const lines = renderToolSegmentLines(
						seg,
						width,
						nowMs,
						unboundedToolBodies,
						detail,
						terminalRows,
						seg.finished ? null : stopRequestedAt,
					);
					rows = { key: settledKey, lines, body: hasToolBody(lines) };
					if (seg.finished) seg.settledRows = rows;
				}
				blocks.push({ kind: "tool", lines: rows.lines, body: rows.body });
			}
			continue;
		}
		// Every prose block carries the agent glyph on its first row, so narration
		// that resumes after a run of actions reads as the agent speaking again
		// rather than as a caption of the action above it. A skill-suggestion
		// protocol line is advisory rather than the answer: it renders in place
		// without claiming the glyph.
		if (seg.kind === "text" && seg.text.length === 0) continue;
		// A stray mark between actions (`.` or `)` left over when a model ends its
		// words in a tool call) carries nothing to read, and as its own bubble it
		// looked like a reply. A turn whose only output is that mark keeps it.
		if (seg.kind === "text" && isStrayFragment(seg.text) && entry.segments.some((other) => carriesOutput(other, seg)))
			continue;
		// A skill suggestion is advice for the operator, not the answer: it reads
		// `§ suggests /skill <name>` as its own row, ahead of the answer wherever
		// the model put it.
		const split = seg.kind === "text" ? skillSuggestionSplit(seg) : null;
		if (split) {
			flushReasoning("words");
			blocks.push({ kind: "tool", lines: renderSkillSuggestionRow(split.suggestion, width), body: false });
			const answerLines = renderTextSegmentLines(split.answer, proseWidth, bareFences);
			if (answerLines.length > 0) blocks.push({ kind: "prose", lines: hangProseLines(answerLines, CLIO_PREFIX()) });
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
				? renderTextSegmentLines(seg, proseWidth, bareFences)
				: renderErrorSegmentLines(seg, proseWidth, unboundedToolBodies);
		if (seg.kind === "error" && !unboundedToolBodies) {
			rendered = previewRows(rendered, previewBudget(detail.errorRows, terminalRows), proseWidth);
		}
		if (rendered.length === 0) continue;
		flushReasoning("words");
		if (seg.kind === "error") {
			blocks.push({ kind: "error", lines: hangProseLines(rendered, CLIO_PREFIX_ERROR()) });
			continue;
		}
		blocks.push({ kind: "prose", lines: hangProseLines(rendered, CLIO_PREFIX()) });
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
	renderTextSegmentLines({ kind: "text", text: WARM_ANSWER, finalized: true }, safeWidth - PROSE_GUTTER_WIDTH, false);
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
	/** A retry rebinds a card to a new run on the same state object, so the run id is part of what it shows. */
	const telemetryShown = (state: WorkerEntryState, view: TelemetryView | null): string =>
		`${state.runId}\0${workerTelemetryDisplay(view?.run(state.runId) ?? null)}`;
	const dispatchGroups = new Map<string, WorkerTranscriptEntry[]>();
	/** A dispatch call whose every card settled cancelled reads as stopped on its own row too. */
	const markCancelledDispatch = (toolCallId: string | undefined): void => {
		if (toolCallId === undefined) return;
		const cards = dispatchGroups.get(toolCallId) ?? [];
		if (cards.length === 0 || !cards.every((card) => card.state.result?.outcome === "canceled")) return;
		const parent = findSpawningCall(toolCallId);
		if (parent === undefined || parent.segment.cardsCancelled === true) return;
		parent.segment.cardsCancelled = true;
		changeSettledCall(parent.segment);
		invalidateEntryCache(parent.entry);
	};
	const workerRenderOptions = (
		entry: TranscriptEntry,
	): Pick<WorkerEntryRenderOptions, "siblings" | "showGroupHeader" | "telemetry" | "routeFirstOutput"> => {
		if (entry.role !== "worker") return {};
		const view = options.getTelemetry?.() ?? null;
		const telemetry = view?.run(entry.state.runId) ?? null;
		const siblings =
			entry.state.parentToolCallId === undefined ? undefined : dispatchGroups.get(entry.state.parentToolCallId);
		const route = entry.state.runtime;
		return {
			telemetry,
			...(entry.state.pending
				? { routeFirstOutput: routeFirstOutput(view, route.targetId, route.wireModelId, "worker") }
				: {}),
			...(siblings ? { siblings: siblings.map((sibling) => sibling.state), showGroupHeader: siblings[0] === entry } : {}),
		};
	};
	let dirty = true;
	let renderedSkinEpoch = skinEpoch();
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
	/** The run's last attempt failed and recovery will send another, so nothing has settled yet. */
	let runAwaitingRetry = false;
	/** Provider attempts this run sent again, kept until its receipt can state them. */
	let runRetries = 0;
	let runProviderWaits = 0;
	let runMovedTo: string | undefined;
	/** The model the newest assistant message came from: the requester of the calls that follow it. */
	let requestingModel: string | undefined;
	/** The operator turn the current run's calls journal under, from its start event or a replayed run end. */
	let runTurnId: string | undefined;
	/**
	 * Receipts still reading the read model. A run can end before the writer's batch holding its last call is folded,
	 * and a worker it started can settle later, so a receipt rereads its turn on every new view until the view holds
	 * the run's own calls and no run of the turn is still going (#434 §11.3).
	 */
	const liveReceipts = new Set<Extract<TranscriptEntry, { role: "assistant" }>>();
	let receiptView: TelemetryView | null = null;
	/** The latest settled receipt eligible for the turn's post-settlement prewarm record. */
	let lastSettledReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null = null;
	let promptRecallReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null = null;
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
	const bareFences = options.bareCodeFences === true;
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
	/**
	 * An edit whose arguments have closed shows the diff it will make before its
	 * result lands. The file is read off the event path; the frame that shows
	 * the diff is requested when it is ready. Replay never reads files: its
	 * calls are settled and carry the tool's own diff.
	 */
	const startEditPreview = (seg: ToolSegment): void => {
		if (seg.previewRequested || seg.finished || seg.name !== ToolNames.Edit || replayStampMs !== undefined) return;
		seg.previewRequested = true;
		void editPreviewDiff(seg.args).then((diff) => {
			if (diff === null || seg.finished) return;
			seg.previewDiff = diff;
			const owner = findToolSegmentOwner(seg.id);
			if (owner?.segment === seg) invalidateEntryCache(owner.entry);
			markDirty();
			options.requestRender?.();
		});
	};
	const invalidateEntryCache = (entry: TranscriptEntry): void => {
		entryRenderCache.delete(entry);
		if (frozen === null && prerender === null) return;
		// From the end: what changes is nearly always the live tail, and this runs per streamed delta.
		const index = transcript.lastIndexOf(entry);
		if (frozen !== null && index < frozen.through) frozen = null;
		if (prerender !== null && index >= 0 && index < prerender.next) prerender.next = index;
	};
	/** Read one receipt's turn from the view; it stays live until the view holds all of the turn's spend. */
	const readReceipt = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		view: TelemetryView,
		runningTurns: ReadonlySet<string>,
	): void => {
		const usage = entry.turnUsage;
		if (usage?.turnId === undefined) {
			liveReceipts.delete(entry);
			return;
		}
		// The answer closes the run, so the moved turn's answering call is the run's last.
		const spend = turnSpend(view, usage.turnId, usage.movedTo === undefined ? undefined : usage.callIds?.at(-1));
		if (spend === null) return;
		if (JSON.stringify(spend) !== JSON.stringify(usage.spend)) {
			invalidateEntryCache(entry);
			entry.turnUsage = { ...usage, spend };
			markDirty();
		}
		if (!runningTurns.has(usage.turnId) && turnHoldsCalls(view, usage.turnId, usage.callIds ?? []))
			liveReceipts.delete(entry);
	};
	/** The turns with a referenced run still going, read once per view. */
	const runningTurns = (view: TelemetryView): Set<string> =>
		new Set(view.runs().flatMap((run) => (run.terminalReason === null && run.turnId !== null ? [run.turnId] : [])));
	const refreshReceipts = (): void => {
		const view = options.getTelemetry?.() ?? null;
		if (view === receiptView) return;
		receiptView = view;
		for (const entry of workerEntries.values()) {
			const shown = telemetryShown(entry.state, view);
			if (shown === entry.telemetryShown) continue;
			entry.telemetryShown = shown;
			invalidateEntryCache(entry);
			dirty = true;
		}
		// A view still merging its cold read holds a partial session; its turns are read once it has merged.
		if (view === null || view.seeding) return;
		const running = runningTurns(view);
		for (const entry of liveReceipts) readReceipt(entry, view, running);
	};
	/** A receipt the run just gave a turn: read now, and again on each new view while it is live. */
	const trackReceipt = (entry: Extract<TranscriptEntry, { role: "assistant" }>): void => {
		liveReceipts.add(entry);
		const view = options.getTelemetry?.() ?? null;
		if (view !== null && !view.seeding) readReceipt(entry, view, runningTurns(view));
	};
	/** Full drop of both render caches; used by the toggle paths that touch many entries. */
	const clearRenderCaches = (): void => {
		entryRenderCache.clear();
		frozen = null;
		if (prerender !== null) prerender.next = 0;
	};
	const syncSkin = (): void => {
		if (renderedSkinEpoch === skinEpoch()) return;
		renderedSkinEpoch = skinEpoch();
		clearRenderCaches();
		dirty = true;
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
	let replayTarget: string | null = null;
	const messageTarget = (): string | null =>
		replayStampMs !== undefined ? replayTarget : (options.getRunTarget?.() ?? null);
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
		seg.notRun = !seg.executionStarted || seg.awaitingApproval === true ? true : undefined;
		seg.partialResult = undefined;
		seg.live = undefined;
		seg.previewDiff = undefined;
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

	/** The retry row of the turn on screen: attempts after the newest prompt share it. */
	const turnRetryRow = (): Extract<TranscriptEntry, { role: "retryStatus" }> | null => {
		for (let index = transcript.length - 1; index >= 0; index -= 1) {
			const entry = transcript[index];
			// A move closed that row: the attempts on the new route open their own.
			if (entry?.role === "retryStatus") return entry.status.phase === "moved" ? null : entry;
			if (entry?.role === "user") return null;
		}
		return null;
	};

	/** The attempts a retry status says went out again. A live run hears of its recovery after its receipt, a replay before. */
	const noteRunRetries = (status: RetryStatusPayload): void => {
		const whole = status.phase === "retrying" || status.phase === "recovered" || status.phase === "exhausted";
		if (whole || status.phase === "cancelled") {
			// A cancel stopped one attempt before it went out, and that attempt is a wait or a retry by what it answered.
			const waits = status.providerWaits ?? 0;
			const unsentWait = status.phase === "cancelled" && status.onProviderWait === true ? 1 : 0;
			const unsentRetry = status.phase === "cancelled" && status.onProviderWait !== true ? 1 : 0;
			runProviderWaits = Math.max(runProviderWaits, waits - unsentWait);
			runRetries = Math.max(runRetries, status.attempt - waits - unsentRetry);
		}
		const receipt = lastSettledReceipt;
		const usage = receipt?.turnUsage;
		if (receipt && usage && (runRetries > (usage.retries ?? 0) || runProviderWaits > (usage.providerWaits ?? 0))) {
			invalidateEntryCache(receipt);
			receipt.turnUsage = {
				...usage,
				...(runRetries > 0 ? { retries: runRetries } : {}),
				...(runProviderWaits > 0 ? { providerWaits: runProviderWaits } : {}),
			};
		}
	};

	/**
	 * Nothing the run left open keeps counting: no tool can still be executing anywhere in the transcript, not just in
	 * the tail entry (a mid-turn notice splits entries). Settle any tool segment whose `tool_execution_end` never arrived
	 * (blocked at admission, or cut off by an abort) so the ledger never leaves a running line counting past the turn's
	 * end, and clear `pending` everywhere so no earlier entry keeps rendering live thinking or status.
	 */
	const closeRunEntries = (aborted: boolean): void => {
		for (const entry of transcript) {
			if (entry.role !== "assistant") continue;
			for (const seg of entry.segments) {
				if (seg.kind === "tool" && !seg.finished) {
					invalidateEntryCache(entry);
					settleUnfinishedToolSegment(seg, aborted ? "aborted" : "orphaned");
				}
			}
			if (entry.pending) {
				invalidateEntryCache(entry);
				// A message that settled closed its own reasoning, so this one never got a stop reason.
				closeOpenThinking(entry, false);
				entry.pending = false;
				entry.messageStartSegmentIndex = undefined;
			}
		}
		// An entry opened for a message that never showed anything renders no rows, yet it would still draw a separator.
		for (let tail = transcript.at(-1); tail?.role === "assistant"; tail = transcript.at(-1)) {
			if (tail.turnUsage !== undefined || tail.models?.length) break;
			if (tail.segments.some((segment) => segment.kind !== "text" || segment.text.trim().length > 0)) break;
			transcript.pop();
			entryRenderCache.delete(tail);
			if (frozen !== null && frozen.through > transcript.length) frozen = null;
		}
	};

	/**
	 * Give the run its one receipt and close it. It touches many entries, but it names every one it touches: the usage
	 * caption's target, the later entries whose caption it removes, and any entry it settles or un-pends. Each is
	 * invalidated at the point of mutation instead of dropping the whole cache and re-rendering settled history.
	 */
	const settleRun = (run: {
		messages: ReadonlyArray<unknown>;
		turnId: string | undefined;
		replayed?: ReplayedRunFacts | undefined;
		/** The outcome when no message states it: the ladder ended between attempts. */
		outcome?: string;
		always?: boolean;
	}): void => {
		lastSettledReceipt = null;
		runAwaitingRetry = false;
		const { messages, turnId, replayed } = run;
		const ending = run.outcome === undefined ? classifyTurnEnding(messages as ReadonlyArray<AgentMessage>) : null;
		// A provider that reports no usage still owes the operator the news that nothing answered.
		if (
			run.always === true ||
			messages.some(reportsCall) ||
			ending?.kind === "no_answer" ||
			ending?.kind === "call_not_run"
		) {
			// The usage line is a caption on rendered output, so it goes on the
			// last entry that rendered any. A mid-turn notice splits entries, and
			// a turn that stops after one leaves an empty tail entry behind: the
			// run total landed there while the entry above kept its own
			// message_end line, so one turn printed the identical line twice, once
			// on each side of the notice. Entries after the caption rendered
			// nothing and must not carry a second copy.
			// Only this run's rows can carry its receipt. A run cut off before any output has none, and the previous
			// turn's receipt is not this turn's to overwrite: it closes under its own prompt, after any retry row.
			const row = turnRetryRow();
			const from = Math.max(
				runStartIndex ?? runStartFallback(transcript.length),
				row === null ? 0 : transcript.lastIndexOf(row) + 1,
			);
			const found = lastAssistantIndex(transcript, { withOutput: true, from }) ?? lastAssistantIndex(transcript, { from });
			if (found === null) {
				transcript.push({ role: "assistant", segments: [], pending: false, isError: false });
			}
			const index = found ?? transcript.length - 1;
			const target = transcript[index];
			if (target?.role === "assistant") {
				invalidateEntryCache(target);
				lastSettledReceipt = target;
				const stop = messages.filter((message) => (message as { role?: unknown }).role === "assistant").at(-1) as
					| { stopReason?: string; clioCoderAbortReason?: string }
					| undefined;
				// A replayed run end brings the duration and cold reasons the
				// ledger recorded; a live one measures its own.
				const elapsedMs =
					replayed !== undefined
						? replayed.elapsedMs
						: runStartedAt === undefined
							? undefined
							: Math.max(0, now() - runStartedAt);
				const coldReasons = replayed !== undefined ? (replayed.coldReasons ?? []) : runColdReasons;
				const callIds = runCallIds(messages);
				const humanWaitMs = replayed === undefined ? (options.getHumanWaitMs?.() ?? 0) : (replayed.humanWaitMs ?? 0);
				if (replayed === undefined && humanWaitMs > 0 && turnId !== undefined) {
					options.recordTurnHumanWait?.({ turnId, humanWaitMs });
				}
				target.turnUsage = {
					...(turnId === undefined ? {} : { turnId }),
					...(callIds.length > 0 ? { callIds } : {}),
					...(elapsedMs === undefined ? {} : { elapsedMs }),
					...(humanWaitMs > 0 ? { humanWaitMs } : {}),
					...(coldReasons.length > 0 ? { coldReasons: [...coldReasons] } : {}),
					...(runRetries > 0 ? { retries: runRetries } : {}),
					...(runProviderWaits > 0 ? { providerWaits: runProviderWaits } : {}),
					...(runMovedTo !== undefined ? { movedTo: runMovedTo } : {}),
					...(ending === null ? {} : { ending }),
					outcome:
						run.outcome ??
						(stop?.stopReason === "error"
							? "Failed"
							: stop?.stopReason === "aborted"
								? stop.clioCoderAbortReason === "tool_argument_generation"
									? "Generation stopped"
									: "Cancelled"
								: stop?.stopReason === "length"
									? "Output limit"
									: ending?.kind === "no_answer"
										? "No answer"
										: endedOnCancelledInterview(messages)
											? "Cancelled"
											: endedWithFailedChange(messages)
												? "Done, last change failed"
												: "Done"),
				};
				// Only the newest failure is one ↑ away; a later turn's prompt sits in front of an older one.
				if (promptRecallReceipt?.turnUsage) {
					delete promptRecallReceipt.turnUsage.promptRecall;
					invalidateEntryCache(promptRecallReceipt);
				}
				promptRecallReceipt = null;
				if (replayed === undefined && target.turnUsage.outcome === "Failed") {
					target.turnUsage.promptRecall = true;
					promptRecallReceipt = target;
				}
				trackReceipt(target);
			}
			const firstRunEntry = runStartIndex ?? runStartFallback(index);
			for (let other = firstRunEntry; other < transcript.length; other += 1) {
				if (other === index) continue;
				const sibling = transcript[other];
				if (sibling?.role !== "assistant") continue;
				if (sibling.turnUsage !== undefined) invalidateEntryCache(sibling);
				delete sibling.turnUsage;
				liveReceipts.delete(sibling);
			}
		}
		runStartIndex = undefined;
		runColdReasons = [];
		runTurnId = undefined;
		runRetries = 0;
		runProviderWaits = 0;
		runMovedTo = undefined;
		const runWasAborted = messages.some(
			(message) =>
				message && typeof message === "object" && (message as { stopReason?: unknown }).stopReason === "aborted",
		);
		closeRunEntries(runWasAborted);
		// An attempt cut off by the cancel leaves its row reading as still underway.
		const row = turnRetryRow();
		if (row && (row.status.phase === "scheduled" || row.status.phase === "waiting" || row.status.phase === "retrying")) {
			if (runWasAborted) {
				invalidateEntryCache(row);
				row.status = { ...row.status, phase: "cancelled" };
			}
		}
	};

	const insertEntryAt = (at: number, entry: TranscriptEntry): void => {
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
	};

	/**
	 * Add a row that is not part of the reply being written. The next delta lands
	 * on the transcript's tail, so a row pushed under an open message cut the reply
	 * in two and the settling message printed it a third time, whole. That took a
	 * `/run`, a worker's card or any notice arriving during a main stream. The row
	 * goes above the open message instead, which keeps the reply in one piece.
	 */
	const appendRow = (entry: TranscriptEntry): void => {
		const tail = transcript[transcript.length - 1];
		if (tail?.role === "assistant" && tail.pending && tail.messageStartSegmentIndex !== undefined) {
			insertEntryAt(transcript.length - 1, entry);
			return;
		}
		transcript.push(entry);
	};

	const attachModel = (assistant: Extract<TranscriptEntry, { role: "assistant" }>, model: string | null): void => {
		if (model === null || assistant.models?.includes(model)) return;
		if (assistant.models === undefined) {
			const at = transcript.lastIndexOf(assistant);
			let before: string | undefined;
			for (let index = (at < 0 ? transcript.length : at) - 1; index >= 0 && before === undefined; index -= 1) {
				const prior = transcript[index];
				if (prior?.role === "assistant") before = prior.models?.at(-1);
			}
			assistant.sameModelAsBefore = before === model;
		}
		assistant.models ??= [];
		assistant.models.push(model);
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
	const closeOpenThinking = (entry: Extract<TranscriptEntry, { role: "assistant" }>, completed = true): void => {
		const open = openThinkingSegment(entry);
		if (open === null) return;
		open.finalized = true;
		// Display copy only. No later text can resolve what a cut-off stream was holding (#446).
		if (!completed) open.text = holdCutOffText(open.text);
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
	 * A frame rewrites anywhere in the text; the settled prefix is what the
	 * previous frame and this one agree on.
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
		if (text.length === 0 && !replaceTail) return;
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
		};
		if (replaceTail && streamed.length > 0) {
			const [first, ...rest] = text.length > 0 ? streamed : [undefined, ...streamed];
			if (first) finalize(first, text);
			for (const dead of rest) if (dead) entry.segments.splice(entry.segments.indexOf(dead), 1);
			return;
		}
		if (text.length === 0) return;
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
	const appendErrorSegment = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		route: ProviderFailureRoute | null = null,
	): void => {
		const tail = entry.segments[entry.segments.length - 1];
		if (tail?.kind === "error" && tail.text === text) return;
		entry.segments.push({ kind: "error", text, at: stamp(), ...(route !== null ? { route } : {}) });
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
		syncSkin();
		refreshReceipts();
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
			const separated = i > 0 && !stacksUnder(entry, previous, detail);
			if (separated) out.push("");
			const entryStart = out.length;
			const renders = entryRenderCache.get(entry);
			const renderKey = entry.role === "worker" && entryHasRunningTool(entry) ? `${baseKey}|${tick}` : baseKey;
			const cached = renders?.get(renderKey);
			// A replay block that is not live is a pure function of the render key,
			// so it caches like any settled entry. Excluding every replay block made
			// a long session's notices and `!` commands re-render on each rebuild:
			// 1,400 of them turned a 0.7 ms warm Alt+O revisit into 45 ms.
			// Worker mutations invalidate their own entry; only elapsed time needs a tick (#428).
			const cacheable = i >= transcript.length - capacity && (entryIsStable(entry) || entry.role === "worker");
			if (cacheable && cached !== undefined) {
				// A spread here is slower than a loop for large arrays and blows the
				// stack outright for a single entry that renders enough lines.
				for (const line of cached) out.push(line);
			} else {
				entriesRendered += 1;
				const renderedEntry = renderEntryLines(
					entry,
					width,
					nowMs,
					unboundedToolBodies,
					bareFences,
					detail,
					terminalRows,
					previous,
					workerRenderOptions(entry),
					options.getStopRequestedAt?.() ?? null,
				);
				for (const line of renderedEntry) out.push(line);
				if (cacheable) {
					const byKey = renders ?? new Map<string, string[]>();
					byKey.set(renderKey, renderedEntry);
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
			// An entry with nothing to show draws no gap either.
			if (separated && out.length === entryStart) out.pop();
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
		syncSkin();
		// A card rendered ahead must read the view its cached siblings were checked against.
		refreshReceipts();
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
					bareFences,
					transcriptDetail(style),
					job.terminalRows,
					transcript[index - 1],
					workerRenderOptions(entry),
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
		appendUser(text: string, status?: () => UserTurnStatus, origin?: string): void {
			// A prompt opens the next turn, whose retries are not the last receipt's.
			lastSettledReceipt = null;
			lastSettledReceipt = null;
			appendRow({
				role: "user",
				text,
				at: stamp(),
				...(status ? { status } : {}),
				...(origin !== undefined ? { origin } : {}),
			});
			markDirty();
		},
		appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void {
			appendRow({ role: "replayBlock", renderBlock, at: stamp(), isLive });
			markDirty();
		},
		applyWorkerState(state: WorkerEntryState): void {
			const existing = workerEntries.get(state.assignmentId);
			if (existing !== undefined) {
				// The reducer mutated the same state object this entry already holds,
				// so nothing is re-linked; only the cached render is now stale.
				invalidateEntryCache(existing);
				const lead = state.parentToolCallId === undefined ? undefined : dispatchGroups.get(state.parentToolCallId)?.[0];
				if (lead !== undefined && lead !== existing) invalidateEntryCache(lead);
				markCancelledDispatch(state.parentToolCallId);
				markDirty();
				return;
			}
			const entry: WorkerTranscriptEntry = {
				role: "worker",
				state,
				at: stamp(),
				telemetryShown: telemetryShown(state, options.getTelemetry?.() ?? null),
			};
			workerEntries.set(state.assignmentId, entry);
			if (state.parentToolCallId !== undefined) {
				const siblings = dispatchGroups.get(state.parentToolCallId) ?? [];
				for (const sibling of siblings) invalidateEntryCache(sibling);
				siblings.push(entry);
				dispatchGroups.set(state.parentToolCallId, siblings);
			}
			// The card is the run's row from here on: the call that spawned it drops
			// the task and outcome it would otherwise state. A helper's `↳` row is
			// the run's row too when a dispatch started it (the model's shadow
			// scout); under any other call it stays beside that call's own output.
			const parent = state.parentToolCallId === undefined ? undefined : findSpawningCall(state.parentToolCallId);
			const attaches = state.helper !== true || parent?.segment.name === "dispatch";
			if (parent !== undefined && attaches && parent.segment.cardAttached !== true) {
				parent.segment.cardAttached = true;
				changeSettledCall(parent.segment);
				invalidateEntryCache(parent.entry);
			}
			const at = workerInsertionIndex(state);
			if (at === null) appendRow(entry);
			else insertEntryAt(at, entry);
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
			// A fitted row's marker can outgrow what it replaced, and the TUI throws on a row past the terminal's width.
			const redactFittedRow = (row: string, width: number): string => {
				const redacted = redactInspectionRow(row);
				return redacted === row ? row : truncateToWidth(redacted, width, GLYPH.ellipsis, false);
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
						...(render === undefined
							? {}
							: { render: (width: number) => render(width).map((row) => redactFittedRow(row, width)) }),
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
							// Whole, because these rows redact one at a time and `--token` can end the line before its value.
							const prose = redactSecretString(
								sanitizeAssistantProse(seg.finalized ? seg.text : holdUnresolvedUserinfo(seg.text)),
							);
							const opening = prose.trim().split("\n", 1)[0] ?? "";
							add(`Thinking · ${opening}`, seg.at, () => sanitizeMultilineDisplayText(prose).text.split("\n"));
						}
						if (seg.kind === "tool") {
							// Titled by its row as the transcript states it; inspected in full,
							// every argument included, whatever card sits under it.
							const call: ToolExecutionFinished = {
								...finishedCall(seg),
								result: seg.result ?? holdUnresolvedStrings(seg.partialResult),
								cardAttached: undefined,
							};
							add(
								toolRowTitle(
									seg.finished
										? finishedCall(seg)
										: { toolCallId: seg.id, toolName: seg.name, args: shownArgs(seg), cardAttached: seg.cardAttached },
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
					const header = firstRow(
						renderWorkerEntryLines(state, 120, {
							detail: standard,
							group: "continues",
							telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
						}),
					);
					add(
						header,
						entry.at,
						() =>
							renderWorkerEntryLines(state, 120, {
								unbounded: true,
								telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
							}),
						(width) =>
							renderWorkerEntryLines(state, width, {
								unbounded: true,
								telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
							}),
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
		liveTextRender(): LiveTextRender | null {
			for (let index = transcript.length - 1; index >= 0; index -= 1) {
				const entry = transcript[index];
				if (entry?.role !== "assistant") continue;
				const tail = entry.segments[entry.segments.length - 1];
				return tail?.kind === "text" && !tail.finalized ? (tail.liveRender ?? null) : null;
			}
			return null;
		},
		reset(): void {
			transcript.length = 0;
			lastSettledReceipt = null;
			liveReceipts.clear();
			receiptView = null;
			runTurnId = undefined;
			runStartedAt = undefined;
			runStartIndex = undefined;
			runAwaitingRetry = false;
			runRetries = 0;
			runProviderWaits = 0;
			runMovedTo = undefined;
			runColdReasons = [];
			workerEntries.clear();
			dispatchGroups.clear();
			clearRenderCaches();
			markDirty();
		},
		replayRoute(targetId: string | null): void {
			replayTarget = targetId;
		},
		replayAt(timestampMs: number | undefined): void {
			if (timestampMs === undefined) replayTarget = null;
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
				// A retry's attempt continues the run it retries: same receipt, same clock.
				if (runAwaitingRetry) {
					runAwaitingRetry = false;
					return;
				}
				runRetries = 0;
				runProviderWaits = 0;
				runMovedTo = undefined;
				// The run's cold-cache reasons arrive just before it starts, as the
				// chat loop consumes them ahead of the prompt, so they are kept here
				// and cleared once the run's receipt has stated them.
				runStartedAt = now();
				runStartIndex = transcript.length;
				runTurnId = (event as { turnId?: string }).turnId;
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
					appendRow({
						role: "replayBlock",
						renderBlock: (width) => renderSkillSurfaceRow(skillSurface, width),
						at: stamp(),
					});
					markDirty();
					return;
				}
				// The Esc cancel is reported once. A settled run that already carries the
				// Cancelled outcome has said so; the row below is only for a hollow abort
				// that left no receipt to carry it.
				if (event.operatorCancel === true && lastSettledReceipt?.turnUsage?.outcome === "Cancelled") return;
				const text = event.text;
				const mark = event.operatorCancel === true ? "cancelled" : event.level;
				const source = event.source;
				appendRow({
					role: "replayBlock",
					renderBlock: (width, _detail, unbounded) => renderNoticeRow(text, mark, width, source, unbounded === true),
					at: stamp(),
				});
				markDirty();
				return;
			}
			if (event.type === "queued_user_turn") {
				// A queued steer or follow-up the engine just injected. Rendering it
				// here, at injection time, keeps the transcript in the order the
				// model saw: enqueue time shows the text only in the queue panel.
				transcript.push({
					role: "user",
					text: event.display?.text ?? event.text,
					at: stamp(),
					...(event.origin !== undefined ? { origin: event.origin } : {}),
				});
				const note = event.display?.note;
				if (note !== undefined && note !== event.origin) {
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
					if (existing.argsComplete) startEditPreview(existing);
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
				const respondedModel = (event.message as { model?: unknown }).model;
				if (typeof respondedModel === "string" && respondedModel.length > 0)
					requestingModel = modelNickname(respondedModel);
				const model = assistantModelLabel(event.message, messageTarget());
				attachModel(assistant, model);
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
					streamed.requestedBy = requestingModel;
					streamed.startedAtMs = now();
					startEditPreview(streamed);
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
					requestedBy: requestingModel,
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
					// Time on the card is not time running: an allowed command starts its clock now.
					if (event.state === "resumed") tool.startedAtMs = now();
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
					changeSettledCall(tool);
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
					tool.notRun = undefined;
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
					tool.live = undefined;
					tool.previewDiff = undefined;
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
						if (!messageStopCompleted((event.message as { stopReason?: unknown }).stopReason)) {
							segment.args = holdUnresolvedStrings(segment.args);
						}
						segment.argsComplete = true;
						completedStreamedArgs = true;
					}
					if (completedStreamedArgs) invalidateEntryCache(current);
				}
				const text = extractAssistantText(event.message);
				const thinking = extractAssistantThinking(event.message);
				// A failure recovery will retry is stated once, on the retry row; only the turn's real outcome reads as one.
				const willRetry = event.retryPending !== undefined;
				if (willRetry) runAwaitingRetry = true;
				const extractedTerminalError = willRetry ? "" : extractAssistantTerminalError(event.message);
				const terminalError =
					current?.role === "assistant"
						? scopeTerminalErrorAfterSuccessfulTool(current, extractedTerminalError)
						: extractedTerminalError;
				const reports = !willRetry && reportsCall(event.message);
				const notRetained =
					(event.message as { clioCoderReasoningNotRetained?: unknown }).clioCoderReasoningNotRetained === true;
				if (text.length === 0 && thinking.length === 0 && !notRetained && terminalError.length === 0 && !reports) {
					if (completedStreamedArgs) markDirty();
					return;
				}
				const assistant = ensureAssistant();
				// message_end rewrites exactly one entry: the assistant it lands on.
				invalidateEntryCache(assistant);
				const model = assistantModelLabel(event.message, messageTarget());
				attachModel(assistant, model);
				// Until its run ends, an entry's receipt reads the turn so far.
				if (reports) {
					assistant.turnUsage = runTurnId === undefined ? {} : { turnId: runTurnId };
					trackReceipt(assistant);
				}
				if (terminalError.length > 0) assistant.isError = true;
				// The message is settled, so whatever reasoning it streamed is closed.
				// A message that carried thinking the panel never saw as deltas (a
				// non-streaming provider, a replayed message) gets one segment at the
				// point this message began, ahead of the text the same message
				// produced, rather than a marker dangling after the answer.
				const messageCompleted = messageStopCompleted((event.message as { stopReason?: unknown }).stopReason);
				closeOpenThinking(assistant, messageCompleted);
				if (thinking.length > 0 || notRetained) {
					const messageStart = Math.min(assistant.messageStartSegmentIndex ?? 0, assistant.segments.length);
					const streamedThisMessage = assistant.segments
						.slice(messageStart)
						.some((segment) => segment.kind === "thinking" && segment.text.length > 0);
					if (!streamedThisMessage) {
						assistant.segments.splice(messageStart, 0, {
							kind: "thinking",
							// A replay reaches here too, so an aborted message hides what its live view hid (#446).
							text: messageCompleted ? thinking : holdCutOffText(thinking),
							at: stamp(),
							finalized: true,
							...(thinking.length === 0 ? { notRetained: true as const } : {}),
						});
					}
				}
				assistant.messageStartSegmentIndex = undefined;
				// The chat loop marks messages it sanitized after streaming (dead
				// tool-call markup on a synthesis-locked turn); the streamed tail
				// must be replaced, not kept alongside a duplicate segment.
				const sanitized = (event as { lockedSynthesisSanitized?: unknown }).lockedSynthesisSanitized === true;
				// A call the reply only wrote out leaves the prose, and the receipt or the re-prompt notice says it did not run.
				const prose = proseBeforeWrittenCalls(event.message, text);
				if (text.length > 0) canonicalizeMessageText(assistant, prose, sanitized || prose !== text);
				if (!messageCompleted) {
					// Display copy only. No later text can resolve what a cut-off stream was holding (#446).
					const messageStart = Math.min(assistant.messageStartSegmentIndex ?? 0, assistant.segments.length);
					for (const segment of assistant.segments.slice(messageStart))
						if (segment.kind === "text") segment.text = holdCutOffText(segment.text);
					invalidateEntryCache(assistant);
				}
				if (terminalError.length > 0) {
					// An operator's cancel is not a route failure, and no route change fixes it.
					const failed = (event.message as { stopReason?: unknown }).stopReason === "error";
					const route = failed ? readProviderFailureRoute((event.message as { failureRoute?: unknown }).failureRoute) : null;
					appendErrorSegment(assistant, terminalError, route);
				}
				markDirty();
				return;
			}
			if (event.type === "retry_status") {
				const status = event.status;
				const row = turnRetryRow();
				if (status.phase === "moved") {
					runMovedTo = status.movedTo?.modelId;
					// The run goes on, and its next start continues this receipt and clock.
					runAwaitingRetry = true;
					if (row) {
						// An open countdown ends here, so the row that promised the retry becomes the one that says it did not happen.
						invalidateEntryCache(row);
						row.status = status;
					} else {
						transcript.push({ role: "retryStatus", status, at: stamp() });
					}
					markDirty();
					return;
				}
				if (row) {
					// One turn's attempts share one row. A retry row is stable, so it caches and can
					// freeze; a new phase or countdown must drop that render first.
					invalidateEntryCache(row);
					const reason = status.errorMessage ?? row.status.errorMessage;
					// The last attempt's own error block already states why the ladder ran out.
					const tail = transcript[transcript.length - 1];
					const stated =
						status.phase === "exhausted" &&
						tail?.role === "assistant" &&
						tail.segments.some((segment) => segment.kind === "error");
					const { errorMessage: _reason, ...rest } = status;
					row.status = { ...rest, ...(reason !== undefined && !stated ? { errorMessage: reason } : {}) };
				} else {
					transcript.push({ role: "retryStatus", status, at: stamp() });
				}
				noteRunRetries(status);
				if ((status.phase === "cancelled" || status.phase === "exhausted") && runAwaitingRetry) {
					// The ladder ended between attempts, so no agent_end is coming to close the turn.
					settleRun({
						messages: [],
						turnId: runTurnId,
						outcome: status.phase === "cancelled" ? "Cancelled" : "Failed",
						always: true,
					});
				}
				markDirty();
				return;
			}
			if (event.type === "agent_end") {
				if (event.retryPending !== undefined) {
					runAwaitingRetry = true;
					// Closing an earlier round's entry would show its interim receipt as a Done the turn has not reached.
					for (const entry of transcript) {
						if (entry.role !== "assistant" || entry.turnUsage === undefined || entry.turnUsage.outcome !== undefined)
							continue;
						invalidateEntryCache(entry);
						delete entry.turnUsage;
						liveReceipts.delete(entry);
					}
					closeRunEntries(false);
					markDirty();
					return;
				}
				settleRun({
					messages: Array.isArray(event.messages) ? event.messages : [],
					turnId: (event as { turnId?: string }).turnId ?? runTurnId,
					replayed: (event as { replayed?: ReplayedRunFacts }).replayed,
				});
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
