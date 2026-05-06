import type { AgentMessage, ImageContent } from "../../engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../interactive/chat-loop.js";
import { flushRawStdout, writeRawStdout } from "../output-guard.js";
import { serializeJsonLine } from "./jsonl.js";

export interface PrintModeOptions {
	prompt: string;
	images?: ReadonlyArray<ImageContent>;
	mode?: "text" | "json";
	getSessionHeader?: () => unknown | null;
}

interface PrintResult {
	text: string;
	error: string | null;
}

function assistantText(message: AgentMessage | undefined): string {
	if (!message || typeof message !== "object" || message.role !== "assistant") return "";
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

function assistantError(message: AgentMessage | undefined): string | null {
	if (!message || typeof message !== "object" || message.role !== "assistant") return null;
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const raw = (message as { errorMessage?: unknown }).errorMessage;
	if (typeof raw === "string" && raw.length > 0) return raw;
	return stopReason === "aborted" ? "request aborted" : "provider returned an error";
}

function resultFromEvent(event: ChatLoopEvent, current: PrintResult): PrintResult {
	if (event.type !== "message_end") return current;
	const message = event.message;
	const error = assistantError(message);
	if (error) return { text: "", error };
	const text = assistantText(message).trimEnd();
	if (text.length === 0) return current;
	return { text, error: null };
}

function isDiagnosticAssistantText(text: string): boolean {
	return text.startsWith("[Clio Coder]") || text.startsWith("[/");
}

export async function runPrintMode(chat: ChatLoop, options: PrintModeOptions): Promise<number> {
	const mode = options.mode ?? "text";
	let result: PrintResult = { text: "", error: null };
	let jsonHeaderWritten = false;
	const writeJsonHeader = (): void => {
		if (jsonHeaderWritten) return;
		jsonHeaderWritten = true;
		const header = options.getSessionHeader?.();
		if (header !== undefined && header !== null) writeRawStdout(serializeJsonLine(header));
	};
	const unsubscribe = chat.onEvent((event) => {
		if (mode === "json") {
			writeJsonHeader();
			writeRawStdout(serializeJsonLine(event));
		}
		result = resultFromEvent(event, result);
	});

	try {
		await chat.submit(
			options.prompt,
			options.images && options.images.length > 0 ? { images: options.images } : undefined,
		);
	} finally {
		unsubscribe();
	}

	if (result.error) {
		process.stderr.write(`${result.error}\n`);
		return 1;
	}
	if (result.text.length === 0) {
		process.stderr.write("clio print: no assistant response\n");
		return 1;
	}
	if (isDiagnosticAssistantText(result.text)) {
		process.stderr.write(`${result.text}\n`);
		return 1;
	}

	if (mode === "text") writeRawStdout(`${result.text}\n`);
	await flushRawStdout();
	return 0;
}
