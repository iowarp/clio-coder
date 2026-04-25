import { type Component, Markdown, type MarkdownTheme, wrapTextWithAnsi } from "../engine/tui.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import { formatRetryStatus } from "./renderers/retry-status.js";
import { renderToolCallHeader, renderToolExecution } from "./renderers/tool-execution.js";

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
};
type AssistantSegment = TextSegment | ToolSegment;
type ReplayBlockRenderer = (width: number) => string[];

type TranscriptEntry =
	| { role: "user"; text: string }
	| { role: "retryStatus"; status: RetryStatusPayload }
	| {
			role: "assistant";
			segments: AssistantSegment[];
			/**
			 * Raw thinking content from `thinking_delta` events. Intentionally
			 * NOT rendered into the visible chat stream: leaking the model's
			 * chain-of-thought alongside the real response disorients users and
			 * was flagged in Row 47 of the TUI rubric. Kept on the entry so
			 * downstream surfaces (future `/think` viewer, session replay) can
			 * still recover it.
			 */
			thinking: string;
			pending: boolean;
	  }
	| { role: "replayBlock"; renderBlock: ReplayBlockRenderer };

export interface ChatPanel extends Component {
	appendUser(text: string): void;
	appendReplayBlock(renderBlock: ReplayBlockRenderer): void;
	applyEvent(event: ChatLoopEvent): void;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
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

function renderToolSegmentLines(seg: ToolSegment, width: number): string[] {
	if (!seg.finished) {
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

function renderEntryLines(entry: TranscriptEntry, width: number): string[] {
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
		lines.push(...renderToolSegmentLines(seg, width));
	}
	if (!labeled && !hasVisibleOutput(entry)) {
		lines.push(entry.pending ? `${CLIO_PREFIX}[working]` : CLIO_PREFIX);
	}
	return lines;
}

export function createChatPanel(): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	let dirty = true;
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];

	const markDirty = (): void => {
		dirty = true;
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
		if (!dirty && cachedWidth === width) return cachedLines;
		const out: string[] = [];
		for (let i = 0; i < transcript.length; i += 1) {
			const entry = transcript[i];
			if (!entry) continue;
			if (i > 0) out.push("");
			out.push(...renderEntryLines(entry, width));
		}
		cachedLines = out;
		cachedWidth = width;
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
		reset(): void {
			transcript.length = 0;
			markDirty();
		},
		applyEvent(event: ChatLoopEvent): void {
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
				assistant.pending = true;
				assistant.segments.push({
					kind: "tool",
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					finished: false,
					isError: false,
				});
				markDirty();
				return;
			}
			if (event.type === "tool_execution_update") {
				// Partial results no longer surface in the rendered tool block; the
				// structured renderer shows the final result on `tool_execution_end`
				// instead. Still mark dirty so a future renderer revision can pick
				// up partial output without changing the event wiring.
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
					markDirty();
				}
			}
		},
		render,
		invalidate(): void {
			markDirty();
		},
	};
}
