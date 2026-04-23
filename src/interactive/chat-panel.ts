import { type Component, Markdown, type MarkdownTheme, wrapTextWithAnsi } from "../engine/tui.js";
import type { ChatLoopEvent } from "./chat-loop.js";

const TOOL_PREVIEW_LIMIT = 96;

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
	preview: string;
};
type AssistantSegment = TextSegment | ToolSegment;

type TranscriptEntry =
	| { role: "user"; text: string }
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
	  };

export interface ChatPanel extends Component {
	appendUser(text: string): void;
	applyEvent(event: ChatLoopEvent): void;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

function shorten(value: string, limit: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function previewValue(value: unknown, limit = TOOL_PREVIEW_LIMIT): string {
	if (value === undefined) return "running";
	if (typeof value === "string") return shorten(value, limit);
	if (Array.isArray(value)) return shorten(JSON.stringify(value), limit);
	if (value && typeof value === "object") {
		const asContent =
			"content" in value && Array.isArray((value as { content?: unknown[] }).content)
				? ((value as { content: unknown[] }).content ?? [])
						.map((item) => {
							if (!item || typeof item !== "object") return "";
							if ("text" in item && typeof item.text === "string") return item.text;
							if ("thinking" in item && typeof item.thinking === "string") return item.thinking;
							return "";
						})
						.filter(Boolean)
						.join(" ")
				: "";
		if (asContent.length > 0) return shorten(asContent, limit);
		return shorten(JSON.stringify(value), limit);
	}
	return shorten(String(value), limit);
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

function renderEntryLines(entry: TranscriptEntry, width: number): string[] {
	if (entry.role === "user") {
		return wrapTextWithAnsi(`you: ${entry.text}`, width);
	}
	const lines: string[] = [];
	let labeled = false;
	for (const seg of entry.segments) {
		if (seg.kind === "text") {
			if (seg.text.length === 0) continue;
			const rendered = renderTextSegmentLines(seg, width);
			if (rendered.length === 0) continue;
			if (!labeled) {
				rendered[0] = `clio: ${rendered[0]}`;
				labeled = true;
			}
			lines.push(...rendered);
			continue;
		}
		const toolLine = `  tool: ${seg.name}(${previewValue(seg.args, 48)}) → ${seg.preview}`;
		lines.push(...wrapTextWithAnsi(toolLine, width));
	}
	if (!labeled && !hasVisibleOutput(entry)) {
		lines.push(entry.pending ? "clio: [working]" : "clio: ");
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
					preview: "running",
				});
				markDirty();
				return;
			}
			if (event.type === "tool_execution_update") {
				const assistant = ensureAssistant();
				const tool = assistant.segments.find(
					(seg): seg is ToolSegment => seg.kind === "tool" && seg.id === event.toolCallId,
				);
				if (tool) tool.preview = previewValue(event.partialResult);
				markDirty();
				return;
			}
			if (event.type === "tool_execution_end") {
				const assistant = ensureAssistant();
				const tool = assistant.segments.find(
					(seg): seg is ToolSegment => seg.kind === "tool" && seg.id === event.toolCallId,
				);
				if (tool) tool.preview = previewValue(event.result);
				markDirty();
				return;
			}
			if (event.type === "message_end") {
				const text = extractAssistantText(event.message);
				const thinking = extractAssistantThinking(event.message);
				if (text.length === 0 && thinking.length === 0) return;
				const assistant = ensureAssistant();
				if (thinking.length > 0) assistant.thinking = thinking;
				canonicalizeMessageText(assistant, text);
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
