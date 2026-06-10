import type { PendingSkillRequest, SkillActivation } from "../../core/skill-activation.js";
import { CLIO_SAMPLING_OVERRIDES_ENV } from "../../engine/apis/sampling-overrides.js";
import type { AgentMessage, ImageContent } from "../../engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../interactive/chat-loop.js";
import { flushRawStdout, writeRawStdout } from "../output-guard.js";
import { serializeJsonLine } from "./jsonl.js";

export interface HeadlessSamplingOverrides {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

export interface HeadlessMainAgentOptions {
	prompt: string;
	images?: ReadonlyArray<ImageContent>;
	sampling?: HeadlessSamplingOverrides;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	skillActivations?: ReadonlyArray<SkillActivation>;
	mode?: "text" | "json";
	getSessionHeader?: () => unknown | null;
}

interface HeadlessMainAgentResult {
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

function resultFromEvent(event: ChatLoopEvent, current: HeadlessMainAgentResult): HeadlessMainAgentResult {
	if (event.type !== "message_end") return current;
	const message = event.message;
	const error = assistantError(message);
	if (error) return { text: "", error };
	const text = assistantText(message).trimEnd();
	if (text.length === 0) return current;
	if (isDiagnosticAssistantText(text) && current.text.length > 0 && !isDiagnosticAssistantText(current.text)) {
		return current;
	}
	return { text, error: null };
}

function isDiagnosticAssistantText(text: string): boolean {
	return text.startsWith("[Clio Coder]") || text.startsWith("[/");
}

export async function runHeadlessMainAgent(chat: ChatLoop, options: HeadlessMainAgentOptions): Promise<number> {
	const mode = options.mode ?? "text";
	let result: HeadlessMainAgentResult = { text: "", error: null };
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

	const previousSamplingOverride = process.env[CLIO_SAMPLING_OVERRIDES_ENV];
	if (options.sampling && Object.keys(options.sampling).length > 0) {
		process.env[CLIO_SAMPLING_OVERRIDES_ENV] = JSON.stringify(options.sampling);
	}
	try {
		const submitOptions = {
			...(options.images && options.images.length > 0 ? { images: options.images } : {}),
			...(options.pendingSkillRequests && options.pendingSkillRequests.length > 0
				? { pendingSkillRequests: options.pendingSkillRequests }
				: {}),
			...(options.skillActivations && options.skillActivations.length > 0
				? { skillActivations: options.skillActivations }
				: {}),
		};
		await chat.submit(options.prompt, Object.keys(submitOptions).length > 0 ? submitOptions : undefined);
	} finally {
		if (previousSamplingOverride === undefined) delete process.env[CLIO_SAMPLING_OVERRIDES_ENV];
		else process.env[CLIO_SAMPLING_OVERRIDES_ENV] = previousSamplingOverride;
		unsubscribe();
	}

	if (result.error) {
		process.stderr.write(`${result.error}\n`);
		return 1;
	}
	if (result.text.length === 0) {
		process.stderr.write("clio run: no assistant response\n");
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

export const runPrintMode = runHeadlessMainAgent;
