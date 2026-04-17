import { type Component, Text } from "../engine/tui.js";
import type { ChatLoopEvent } from "./chat-loop.js";

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const THINKING_PREVIEW_LIMIT = 240;
const TOOL_PREVIEW_LIMIT = 96;

type TranscriptEntry =
	| { role: "user"; text: string }
	| {
			role: "assistant";
			text: string;
			thinking: string;
			tools: ToolLine[];
	  };

type ToolLine = {
	id: string;
	name: string;
	args: unknown;
	preview: string;
};

export interface ChatPanelTheme {
	dim?: (text: string) => string;
}

export interface ChatPanel extends Component {
	appendUser(text: string): void;
	applyEvent(event: ChatLoopEvent): void;
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

export function createChatPanel(theme?: ChatPanelTheme): ChatPanel {
	const dim = theme?.dim ?? ((text: string) => `${ANSI_DIM}${text}${ANSI_RESET}`);
	const view = new Text("", 0, 0);
	const transcript: TranscriptEntry[] = [];

	const sync = (): void => {
		const lines: string[] = [];
		for (const entry of transcript) {
			if (lines.length > 0) lines.push("");
			if (entry.role === "user") {
				lines.push(`you: ${entry.text}`);
				continue;
			}
			const thinking = shorten(entry.thinking, THINKING_PREVIEW_LIMIT);
			if (thinking.length > 0) {
				lines.push(dim(`  thinking: ${thinking}`));
			}
			lines.push(`clio: ${entry.text.trim().length > 0 ? entry.text : ""}`);
			for (const tool of entry.tools) {
				lines.push(`  tool: ${tool.name}(${previewValue(tool.args, 48)}) → ${tool.preview}`);
			}
		}
		view.setText(lines.join("\n"));
		view.invalidate();
	};

	const ensureAssistant = (): Extract<TranscriptEntry, { role: "assistant" }> => {
		const last = transcript[transcript.length - 1];
		if (last && last.role === "assistant") return last;
		const entry: Extract<TranscriptEntry, { role: "assistant" }> = {
			role: "assistant",
			text: "",
			thinking: "",
			tools: [],
		};
		transcript.push(entry);
		return entry;
	};

	return {
		appendUser(text: string): void {
			transcript.push({ role: "user", text });
			sync();
		},
		applyEvent(event: ChatLoopEvent): void {
			if (event.type === "text_delta") {
				ensureAssistant().text += event.delta;
				sync();
				return;
			}
			if (event.type === "thinking_delta") {
				ensureAssistant().thinking += event.delta;
				sync();
				return;
			}
			if (event.type === "tool_execution_start") {
				ensureAssistant().tools.push({
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
				const tool = assistant.tools.find((item) => item.id === event.toolCallId);
				if (tool) tool.preview = previewValue(event.partialResult);
				sync();
				return;
			}
			if (event.type === "tool_execution_end") {
				const assistant = ensureAssistant();
				const tool = assistant.tools.find((item) => item.id === event.toolCallId);
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
				if (text.length > 0) assistant.text = text;
				sync();
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
