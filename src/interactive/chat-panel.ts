import { type Component, Text } from "../engine/tui.js";
import type { ChatLoopEvent } from "./chat-loop.js";

const TOOL_PREVIEW_LIMIT = 96;

/**
 * An assistant turn is a sequence of text and tool segments interleaved in
 * pi-agent-core event order. pi-agent-core emits: `message_start` →
 * `text_delta`+ → `message_end` → `tool_execution_*` → (next) `message_start`
 * → `text_delta`+ → `message_end`, so tool calls always sit BETWEEN the
 * assistant's pre-tool narration and the post-tool summary. Storing a flat
 * `text` buffer + `tools[]` array (pre-refactor) collapsed that order: all
 * text across the turn concatenated into one line with every tool block
 * appended at the end. The segment list preserves the stream order instead.
 */
type TextSegment = { kind: "text"; text: string };
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

function renderEntryLines(entry: TranscriptEntry): string[] {
	if (entry.role === "user") {
		return [`you: ${entry.text}`];
	}
	const lines: string[] = [];
	let labeled = false;
	for (const seg of entry.segments) {
		if (seg.kind === "text") {
			const body = seg.text;
			if (body.length === 0) continue;
			if (!labeled) {
				lines.push(`clio: ${body}`);
				labeled = true;
			} else {
				lines.push(body);
			}
			continue;
		}
		lines.push(`  tool: ${seg.name}(${previewValue(seg.args, 48)}) → ${seg.preview}`);
	}
	if (!labeled && !hasVisibleOutput(entry)) {
		lines.push(entry.pending ? "clio: [working]" : "clio: ");
	}
	return lines;
}

export function createChatPanel(): ChatPanel {
	const view = new Text("", 0, 0);
	const transcript: TranscriptEntry[] = [];
	// Pre-rendered text segments for every entry except the active (last) one.
	// Streaming deltas only mutate the active entry, so caching the prior
	// segments keeps sync()'s per-delta cost bounded by the active entry's
	// size rather than the whole transcript.
	const frozenSegments: string[] = [];

	const freezePriorEntries = (): void => {
		while (frozenSegments.length < transcript.length - 1) {
			const entry = transcript[frozenSegments.length];
			if (!entry) break;
			frozenSegments.push(renderEntryLines(entry).join("\n"));
		}
	};

	const sync = (): void => {
		freezePriorEntries();
		const segments: string[] = [...frozenSegments];
		const active = transcript[transcript.length - 1];
		if (active) {
			segments.push(renderEntryLines(active).join("\n"));
		}
		view.setText(segments.join("\n\n"));
		view.invalidate();
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
		if (tail && tail.kind === "text") {
			tail.text += delta;
			return;
		}
		entry.segments.push({ kind: "text", text: delta });
	};

	/**
	 * Canonicalize a streamed text segment from a completed assistant message.
	 * When streaming produced a prefix of the final text (the common case),
	 * the tail segment is overwritten. When the message arrived fully formed
	 * with no deltas (non-streaming test path, synthetic notices), a fresh
	 * text segment is appended after any tool segments that may have landed
	 * in this turn already.
	 */
	const canonicalizeMessageText = (entry: Extract<TranscriptEntry, { role: "assistant" }>, text: string): void => {
		if (text.length === 0) return;
		const tail = entry.segments[entry.segments.length - 1];
		if (tail?.kind === "text" && text.startsWith(tail.text)) {
			tail.text = text;
			return;
		}
		entry.segments.push({ kind: "text", text });
	};

	return {
		appendUser(text: string): void {
			transcript.push({ role: "user", text });
			sync();
		},
		reset(): void {
			transcript.length = 0;
			frozenSegments.length = 0;
			sync();
		},
		applyEvent(event: ChatLoopEvent): void {
			if (event.type === "text_delta") {
				const assistant = ensureAssistant();
				assistant.pending = true;
				appendTextDelta(assistant, event.delta);
				sync();
				return;
			}
			if (event.type === "thinking_delta") {
				// Capture for downstream consumers but never render inline.
				const assistant = ensureAssistant();
				assistant.pending = true;
				assistant.thinking += event.delta;
				sync();
				return;
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				ensureAssistant().pending = true;
				sync();
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
				sync();
				return;
			}
			if (event.type === "tool_execution_update") {
				const assistant = ensureAssistant();
				const tool = assistant.segments.find(
					(seg): seg is ToolSegment => seg.kind === "tool" && seg.id === event.toolCallId,
				);
				if (tool) tool.preview = previewValue(event.partialResult);
				sync();
				return;
			}
			if (event.type === "tool_execution_end") {
				const assistant = ensureAssistant();
				const tool = assistant.segments.find(
					(seg): seg is ToolSegment => seg.kind === "tool" && seg.id === event.toolCallId,
				);
				if (tool) tool.preview = previewValue(event.result);
				sync();
				return;
			}
			if (event.type === "message_end") {
				const text = extractAssistantText(event.message);
				const thinking = extractAssistantThinking(event.message);
				if (text.length === 0 && thinking.length === 0) return;
				const assistant = ensureAssistant();
				if (thinking.length > 0) assistant.thinking = thinking;
				canonicalizeMessageText(assistant, text);
				sync();
				return;
			}
			if (event.type === "agent_end") {
				const assistant = transcript[transcript.length - 1];
				if (assistant && assistant.role === "assistant" && assistant.pending) {
					assistant.pending = false;
					sync();
				}
			}
		},
		render(width: number): string[] {
			return view.render(width);
		},
		invalidate(): void {
			view.invalidate();
		},
	};
}
