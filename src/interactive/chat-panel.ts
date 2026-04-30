import { type Component, Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import { formatRetryStatus } from "./renderers/retry-status.js";
import {
	previewResult,
	renderToolCallHeader,
	renderToolExecution,
	renderToolStreamingExecution,
	renderToolSubline,
	unwrapResultEnvelope,
} from "./renderers/tool-execution.js";
import type { StatusPhase, VerbRender } from "./status/index.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_ITALIC = "\u001b[3m";
const ANSI_UNDERLINE = "\u001b[4m";

/**
 * Markdown theme for the assistant stream. pi-tui's Markdown renderer calls
 * every theme function exactly once per matched span; identity functions are
 * valid but leave the output indistinguishable from the raw source (which is
 * what Row 43 of the TUI rubric flagged). The ANSI wrappers below keep the
 * chat pane visually minimal (bold headings + emphasis, dim inline code /
 * fences / quotes) and stay safe under Clio's ANSI-stripped test assertions:
 * the structural markers callers rely on (list bullets, fence markers, code
 * block indent) survive stripping.
 */
const CHAT_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => `${ANSI_BOLD}${text}${ANSI_RESET}`,
	link: (text) => text,
	linkUrl: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	code: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	quote: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	quoteBorder: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	hr: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	listBullet: (text) => text,
	bold: (text) => `${ANSI_BOLD}${text}${ANSI_RESET}`,
	italic: (text) => `${ANSI_ITALIC}${text}${ANSI_RESET}`,
	strikethrough: (text) => text,
	underline: (text) => `${ANSI_UNDERLINE}${text}${ANSI_RESET}`,
};

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
	/** True when the finished result was an error. Meaningful only after `finished`. */
	isError: boolean;
	/** When true, render the full structured block instead of the collapsed subline. */
	expanded: boolean;
	/**
	 * Latest cumulative partial output from `tool_execution_update`. Cleared
	 * back to `undefined` on `tool_execution_end` so the finished `result`
	 * takes over. Only consumed when `!finished && expanded`. The explicit
	 * `| undefined` is required under `exactOptionalPropertyTypes: true` so
	 * the clear path can re-assign `undefined` without a `delete`.
	 */
	partialOutput?: string | undefined;
};
type AssistantSegment = TextSegment | ToolSegment;
type ReplayBlockRenderer = (width: number) => string[];
type AssistantStatusLine = { phase: StatusPhase; verb: string; toneHint: VerbRender["toneHint"] };

type TranscriptEntry =
	| { role: "user"; text: string }
	| { role: "retryStatus"; status: RetryStatusPayload }
	| {
			role: "assistant";
			segments: AssistantSegment[];
			/**
			 * Raw thinking content from `thinking_delta` events plus any
			 * `thinking` blocks captured on `message_end`. Rendered as a dim
			 * one-line preview by default once the turn settles; expanded into
			 * a rail-prefixed body via `toggleLastThinking()` (Ctrl+T). Stays
			 * suppressed while `pending === true` so streaming chain-of-thought
			 * does not flicker into the visible stream before the turn
			 * finalizes (Row 47 of the TUI rubric).
			 */
			thinking: string;
			/**
			 * Whether the thinking block renders as the full body (true) or
			 * the one-line dim preview (false/undefined). Toggled by
			 * `toggleLastThinking()`. Default collapsed; new thinking does not
			 * auto-expand during streaming.
			 */
			expandedThinking?: boolean;
			pending: boolean;
			statusLine?: AssistantStatusLine | null | undefined;
			summaryLine?: string | null | undefined;
	  }
	| { role: "replayBlock"; renderBlock: ReplayBlockRenderer };

export interface ChatPanel extends Component {
	appendUser(text: string): void;
	appendReplayBlock(renderBlock: ReplayBlockRenderer): void;
	applyEvent(event: ChatLoopEvent): void;
	setStatusLine(line: AssistantStatusLine | null): void;
	setSummaryLine(line: string | null): void;
	toggleLastToolExpanded(): boolean;
	/**
	 * Flip thinking-bearing assistant turns between the one-line dim preview
	 * and the full rail-prefixed body. The target visibility is derived from
	 * the most recent thinking block, then applied to prior thinking history
	 * so Ctrl+T behaves like a transcript-level thinking visibility toggle.
	 */
	toggleLastThinking(): boolean;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

export interface ChatPanelOptions {
	/**
	 * Resolves the user-visible key string for the `clio.tool.expand`
	 * action. Returning a non-empty string surfaces a dim ` (<key>)` hint on
	 * the first wrapped line of every finished, collapsed tool subline so the
	 * Ctrl+O toggle is discoverable. Returning undefined or an empty string
	 * suppresses the hint (e.g. action unbound, or display intentionally
	 * minimal). Called per render so live keybinding changes flow through.
	 */
	getToolExpandKey?: () => string | undefined;
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

function extractAssistantTerminalError(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return "";
	const raw = (message as { errorMessage?: unknown }).errorMessage;
	const reason = typeof raw === "string" && raw.length > 0 ? raw : "unknown error";
	return stopReason === "aborted" ? `[aborted] ${reason}` : `[error] ${reason}`;
}

function hasVisibleOutput(entry: Extract<TranscriptEntry, { role: "assistant" }>): boolean {
	for (const seg of entry.segments) {
		if (seg.kind === "tool") return true;
		if (seg.kind === "text" && seg.text.trim().length > 0) return true;
	}
	return false;
}

function hasStreamingText(entry: Extract<TranscriptEntry, { role: "assistant" }>): boolean {
	const tail = entry.segments[entry.segments.length - 1];
	return tail?.kind === "text" && !tail.finalized && tail.text.trim().length > 0;
}

function renderTextSegmentLines(seg: TextSegment, width: number): string[] {
	if (!seg.finalized) {
		const wrapped: string[] = [];
		for (const line of seg.text.split("\n")) {
			wrapped.push(...wrapTextWithAnsi(line, width));
		}
		return wrapped;
	}
	if (!seg.md) {
		seg.md = new Markdown(seg.text, 0, 0, CHAT_MARKDOWN_THEME);
	}
	return seg.md.render(width);
}

const CLIO_PREFIX = "Clio Coder: ";

/**
 * Prefix the first rendered line of the active assistant entry with "Clio Coder: ".
 * pi-tui's Markdown renderer right-pads every line to the requested width so
 * background colors extend edge-to-edge (markdown.js:104-107), so a line
 * returned at width=N already has visible width N. Prepending the assistant
 * label without stripping the pad would push the line past N, which
 * trips pi-tui's `Rendered line i exceeds terminal width` invariant inside
 * doRender() and crashes the TUI before the caller's output ever reaches the
 * user (regression seen on /compact without a current session at width=120).
 * Trim the trailing pad before prefixing, then re-wrap in case the content
 * itself was already close to `width` and the prefix pushes it past.
 */
function prefixClioLabel(lines: string[], width: number): string[] {
	if (lines.length === 0) return lines;
	const first = lines[0]?.replace(/ +$/, "") ?? "";
	const prefixed = `${CLIO_PREFIX}${first}`;
	const wrappedFirst = wrapTextWithAnsi(prefixed, width);
	return [...wrappedFirst, ...lines.slice(1)];
}

/**
 * Total visible width budget for the collapsed `thinking: <preview>...` line.
 * Includes the `thinking: ` label so the truncation hugs ~60 columns total.
 */
const THINKING_PREVIEW_WIDTH = 60;
const THINKING_PREVIEW_LABEL = "thinking: ";
const THINKING_LINE_LIMIT = 12;

/**
 * Render the assistant turn's thinking block. Collapsed (default) returns a
 * single dim line `thinking: <preview>...` with the preview clipped to
 * `THINKING_PREVIEW_WIDTH` visible columns. Expanded returns the full body
 * dimmed and prefixed with a dim `│ ` rail, capped at `THINKING_LINE_LIMIT`
 * lines with a tail `... N more lines hidden` overflow message. Mirrors the
 * tool toggle's lab-notebook minimalism: no colored glyphs, no boxes.
 */
function renderThinkingLines(thinking: string, expanded: boolean, width: number): string[] {
	if (thinking.length === 0) return [];
	const dimWrap = (s: string): string => `${ANSI_DIM}${s}${ANSI_RESET}`;
	if (!expanded) {
		const collapsed = thinking.replace(/\s+/g, " ").trim();
		const contentBudget = Math.max(1, THINKING_PREVIEW_WIDTH - THINKING_PREVIEW_LABEL.length);
		const preview = truncateToWidth(collapsed, contentBudget, "...", false);
		// Clip the composed line to the actual terminal width so very narrow
		// terminals (e.g. 33 cols) do not overflow pi-tui's render check. The
		// inner preview budget hugs the ~60-col target on wide terminals; the
		// outer truncate is a safety net for the narrow case.
		const composed = `${THINKING_PREVIEW_LABEL}${preview}`;
		const lineBudget = Math.max(1, width);
		return [dimWrap(truncateToWidth(composed, lineBudget, "...", false))];
	}
	const splitLines = thinking.split("\n");
	const visible: string[] =
		splitLines.length > THINKING_LINE_LIMIT
			? [...splitLines.slice(0, THINKING_LINE_LIMIT), `... ${splitLines.length - THINKING_LINE_LIMIT} more lines hidden`]
			: splitLines;
	const out: string[] = [];
	const bodyWidth = Math.max(1, width - 2);
	for (const raw of visible) {
		const wrappedLines = raw.length === 0 ? [""] : wrapTextWithAnsi(raw, bodyWidth);
		for (const wrapped of wrappedLines) {
			out.push(`${dimWrap("│ ")}${dimWrap(wrapped)}`);
		}
	}
	return out;
}

function renderToolSegmentLines(seg: ToolSegment, width: number, expandKey: string | undefined): string[] {
	if (!seg.expanded) {
		return renderToolSubline(
			seg.finished
				? {
						toolCallId: seg.id,
						toolName: seg.name,
						args: seg.args,
						result: seg.result,
						isError: seg.isError,
					}
				: { toolCallId: seg.id, toolName: seg.name, args: seg.args },
			width,
			expandKey,
		);
	}
	if (!seg.finished) {
		if (seg.partialOutput !== undefined) {
			return renderToolStreamingExecution(
				{ toolCallId: seg.id, toolName: seg.name, args: seg.args },
				width,
				seg.partialOutput,
			);
		}
		return renderToolCallHeader({ toolCallId: seg.id, toolName: seg.name, args: seg.args }, width);
	}
	return renderToolExecution(
		{
			toolCallId: seg.id,
			toolName: seg.name,
			args: seg.args,
			result: seg.result,
			isError: seg.isError,
		},
		width,
	);
}

function renderEntryLines(entry: TranscriptEntry, width: number, expandKey: string | undefined): string[] {
	if (entry.role === "replayBlock") {
		return entry.renderBlock(width);
	}
	if (entry.role === "user") {
		return wrapTextWithAnsi(`you: ${entry.text}`, width);
	}
	if (entry.role === "retryStatus") {
		return wrapTextWithAnsi(formatRetryStatus(entry.status), width);
	}
	const lines: string[] = [];
	// Thinking renders BEFORE assistant text/tool segments so the dim preview
	// or expanded rail sits above the response, matching the order the
	// pi-coding-agent reference uses. Suppressed while `pending === true` so
	// streaming `thinking_delta` events do not flicker into the visible
	// stream before the turn finalizes (see Row 47 of the TUI rubric and the
	// existing "filters thinking_delta out of the visible chat stream" test).
	if (entry.thinking.length > 0 && entry.pending === false) {
		lines.push(...renderThinkingLines(entry.thinking, entry.expandedThinking === true, width));
	}
	let labeled = false;
	for (const seg of entry.segments) {
		if (seg.kind === "text") {
			if (seg.text.length === 0) continue;
			const rendered = renderTextSegmentLines(seg, width);
			if (rendered.length === 0) continue;
			if (!labeled) {
				lines.push(...prefixClioLabel(rendered, width));
				labeled = true;
			} else {
				lines.push(...rendered);
			}
			continue;
		}
		lines.push(...renderToolSegmentLines(seg, width, expandKey));
	}
	const shouldRenderStatus =
		entry.pending &&
		entry.statusLine !== null &&
		entry.statusLine !== undefined &&
		!(entry.statusLine.phase === "writing" && hasStreamingText(entry));
	if (!labeled && !hasVisibleOutput(entry)) {
		lines.push(CLIO_PREFIX);
		if (shouldRenderStatus) {
			lines.push(`  ${ANSI_DIM}${entry.statusLine?.verb ?? ""}${ANSI_RESET}`);
		}
	} else if (shouldRenderStatus) {
		lines.push(`  ${ANSI_DIM}${entry.statusLine?.verb ?? ""}${ANSI_RESET}`);
	}
	if (entry.summaryLine && !entry.pending) {
		lines.push(`  ${ANSI_DIM}· ${entry.summaryLine}${ANSI_RESET}`);
	}
	return lines;
}

export function createChatPanel(options: ChatPanelOptions = {}): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	let dirty = true;
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];
	let cachedExpandKey: string | undefined;

	const markDirty = (): void => {
		dirty = true;
	};

	const resolveExpandKey = (): string | undefined => {
		const key = options.getToolExpandKey?.();
		if (typeof key !== "string" || key.length === 0) return undefined;
		return key;
	};

	const ensureAssistant = (): Extract<TranscriptEntry, { role: "assistant" }> => {
		const last = transcript[transcript.length - 1];
		if (last && last.role === "assistant") return last;
		const entry: Extract<TranscriptEntry, { role: "assistant" }> = {
			role: "assistant",
			segments: [],
			thinking: "",
			pending: false,
		};
		transcript.push(entry);
		return entry;
	};

	const appendTextDelta = (entry: Extract<TranscriptEntry, { role: "assistant" }>, delta: string): void => {
		if (delta.length === 0) return;
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
	 * have landed in this turn already.
	 */
	const canonicalizeMessageText = (entry: Extract<TranscriptEntry, { role: "assistant" }>, text: string): void => {
		if (text.length === 0) return;
		const tail = entry.segments[entry.segments.length - 1];
		if (tail?.kind === "text" && !tail.finalized && text.startsWith(tail.text)) {
			tail.text = text;
			tail.finalized = true;
			if (tail.md) tail.md.setText(text);
			return;
		}
		entry.segments.push({ kind: "text", text, finalized: true });
	};

	const render = (width: number): string[] => {
		const expandKey = resolveExpandKey();
		if (!dirty && cachedWidth === width && cachedExpandKey === expandKey) return cachedLines;
		const out: string[] = [];
		for (let i = 0; i < transcript.length; i += 1) {
			const entry = transcript[i];
			if (!entry) continue;
			if (i > 0) out.push("");
			out.push(...renderEntryLines(entry, width, expandKey));
		}
		cachedLines = out;
		cachedWidth = width;
		cachedExpandKey = expandKey;
		dirty = false;
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
		toggleLastToolExpanded(): boolean {
			for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
				const entry = transcript[entryIndex];
				if (entry?.role !== "assistant") continue;
				for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
					const seg = entry.segments[segIndex];
					if (seg?.kind !== "tool") continue;
					seg.expanded = !seg.expanded;
					markDirty();
					return true;
				}
			}
			return false;
		},
		toggleLastThinking(): boolean {
			let nextExpanded: boolean | null = null;
			let found = false;
			for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
				const entry = transcript[entryIndex];
				if (entry?.role !== "assistant") continue;
				if (entry.thinking.length === 0) continue;
				nextExpanded = entry.expandedThinking !== true;
				break;
			}
			if (nextExpanded === null) return false;
			for (const entry of transcript) {
				if (entry.role !== "assistant" || entry.thinking.length === 0) continue;
				entry.expandedThinking = nextExpanded;
				found = true;
			}
			if (found) markDirty();
			return found;
		},
		reset(): void {
			transcript.length = 0;
			markDirty();
		},
		applyEvent(event: ChatLoopEvent): void {
			if (event.type === "agent_status") {
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
				markDirty();
				return;
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				ensureAssistant().pending = true;
				markDirty();
				return;
			}
			if (event.type === "tool_execution_start") {
				const assistant = ensureAssistant();
				const expanded = assistant.pending === false;
				assistant.pending = true;
				assistant.segments.push({
					kind: "tool",
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					finished: false,
					isError: false,
					expanded,
				});
				markDirty();
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
				const assistant = transcript[transcript.length - 1];
				if (!assistant || assistant.role !== "assistant") {
					markDirty();
					return;
				}
				const tool = assistant.segments.find(
					(seg): seg is ToolSegment => seg.kind === "tool" && seg.id === event.toolCallId,
				);
				if (tool) {
					const unwrapped = unwrapResultEnvelope(event.partialResult);
					tool.partialOutput = typeof unwrapped === "string" ? unwrapped : previewResult(unwrapped);
				}
				markDirty();
				return;
			}
			if (event.type === "tool_execution_end") {
				const assistant = ensureAssistant();
				const tool = assistant.segments.find(
					(seg): seg is ToolSegment => seg.kind === "tool" && seg.id === event.toolCallId,
				);
				if (tool) {
					tool.result = event.result;
					tool.isError = event.isError;
					tool.finished = true;
					// Drop the streaming buffer once the final result has landed; the
					// expanded render switches to `renderToolExecution` and stays
					// stable instead of churning through partial-frame layout.
					tool.partialOutput = undefined;
				}
				markDirty();
				return;
			}
			if (event.type === "message_end") {
				const text = extractAssistantText(event.message);
				const thinking = extractAssistantThinking(event.message);
				const terminalError = extractAssistantTerminalError(event.message);
				if (text.length === 0 && thinking.length === 0 && terminalError.length === 0) return;
				const assistant = ensureAssistant();
				if (thinking.length > 0) assistant.thinking = thinking;
				if (text.length > 0) canonicalizeMessageText(assistant, text);
				if (terminalError.length > 0) canonicalizeMessageText(assistant, terminalError);
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
				const assistant = transcript[transcript.length - 1];
				if (assistant && assistant.role === "assistant" && assistant.pending) {
					assistant.pending = false;
					assistant.statusLine = null;
					markDirty();
				}
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
				last.statusLine = null;
				markDirty();
			}
		},
		setSummaryLine(line): void {
			if (line) {
				const assistant = ensureAssistant();
				assistant.pending = false;
				assistant.summaryLine = line;
				markDirty();
				return;
			}
			const last = transcript[transcript.length - 1];
			if (last && last.role === "assistant") {
				last.summaryLine = null;
				markDirty();
			}
		},
		render,
		invalidate(): void {
			markDirty();
		},
	};
}
