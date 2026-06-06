import type { ModeName } from "../../domains/modes/matrix.js";
import type { AgentEvent, AgentMessage } from "../types.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import type { AcpPromptResponse, AcpSessionUpdateParams, AcpToolCallUpdate } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (isRecord(value.content)) return textFromContent(value.content);
	return "";
}

function toolContentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(toolContentText).filter(Boolean).join("\n");
	if (!isRecord(value)) return "";
	const direct = textFromContent(value);
	if (direct.length > 0) return direct;
	return "";
}

function stopReasonForAgent(reason: string): string {
	if (reason === "cancelled") return "aborted";
	if (reason === "refusal" || reason === "max_tokens" || reason === "max_turn_requests") return "error";
	return "stop";
}

function errorMessageForStopReason(reason: string): string | undefined {
	if (reason === "refusal") return "ACP agent refused to continue";
	if (reason === "max_tokens") return "ACP agent stopped at max_tokens";
	if (reason === "max_turn_requests") return "ACP agent stopped at max_turn_requests";
	return undefined;
}

export class AcpEventMapper {
	private messageStarted = false;
	private assistantText = "";
	private assistantThinking = "";
	private readonly toolStarts = new Map<string, number>();

	constructor(private readonly mode: ModeName) {}

	mapUpdate(params: unknown): Array<AgentEvent | ClioWorkerEvent> {
		const record = isRecord(params) ? (params as AcpSessionUpdateParams) : {};
		const update = isRecord(record.update) ? record.update : {};
		const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
		if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
			const text = textFromContent(update.content);
			if (kind !== "agent_message_chunk" || text.length === 0) return [];
			this.assistantText += text;
			const events: AgentEvent[] = [];
			if (!this.messageStarted) {
				this.messageStarted = true;
				events.push({
					type: "message_start",
					message: { role: "assistant", content: [], timestamp: Date.now() } as unknown as AgentMessage,
				} as AgentEvent);
			}
			events.push({ type: "text_delta", text } as unknown as AgentEvent);
			return events;
		}
		if (kind === "thought_message_chunk" || kind === "agent_thought_chunk") {
			const text = textFromContent(update.content);
			if (text.length === 0) return [];
			this.assistantThinking += text;
			return [{ type: "thinking_delta", text } as unknown as AgentEvent];
		}
		if (kind === "tool_call" || kind === "tool_call_update") {
			return this.mapToolUpdate(update as AcpToolCallUpdate);
		}
		if (kind === "plan") {
			return [{ type: "clio_plan_update", payload: update } as unknown as AgentEvent];
		}
		return [];
	}

	finalEvents(response: AcpPromptResponse | null): AgentEvent[] {
		const stopReason = typeof response?.stopReason === "string" ? response.stopReason : "end_turn";
		const agentStopReason = stopReasonForAgent(stopReason);
		const content: Array<Record<string, unknown>> = [];
		if (this.assistantThinking.length > 0) {
			content.push({ type: "thinking", text: this.assistantThinking });
		}
		if (this.assistantText.length > 0 || content.length === 0) {
			content.push({ type: "text", text: this.assistantText });
		}
		const message = {
			role: "assistant",
			content,
			timestamp: Date.now(),
			stopReason: agentStopReason,
			...(errorMessageForStopReason(stopReason) !== undefined
				? { errorMessage: errorMessageForStopReason(stopReason) }
				: {}),
			...(response?.usage !== undefined ? { usage: response.usage } : {}),
		} as unknown as AgentMessage;
		return [{ type: "message_end", message } as AgentEvent, { type: "agent_end", messages: [message] } as AgentEvent];
	}

	private mapToolUpdate(update: AcpToolCallUpdate): Array<AgentEvent | ClioWorkerEvent> {
		const toolCallId = update.toolCallId ?? update.title ?? `acp-tool-${this.toolStarts.size + 1}`;
		const title = update.title ?? update.kind ?? "ACP tool";
		const status = update.status ?? "pending";
		const out: Array<AgentEvent | ClioWorkerEvent> = [];
		if (!this.toolStarts.has(toolCallId) && (status === "pending" || status === "in_progress")) {
			this.toolStarts.set(toolCallId, Date.now());
			out.push({
				type: "clio_tool_start",
				payload: {
					tool: update.kind ?? title,
					mode: this.mode,
					startedAt: this.toolStarts.get(toolCallId) ?? Date.now(),
				},
			});
			out.push({
				type: "tool_execution_start",
				toolCallId,
				toolName: title,
				args: update.rawInput ?? {},
			} as unknown as AgentEvent);
		}
		if (status === "completed" || status === "failed" || status === "cancelled") {
			const startedAt = this.toolStarts.get(toolCallId) ?? Date.now();
			this.toolStarts.delete(toolCallId);
			const isError = status !== "completed";
			const result = toolContentText(update.content) || update.rawOutput || status;
			out.push({
				type: "tool_execution_end",
				toolCallId,
				toolName: title,
				result,
				isError,
			} as unknown as AgentEvent);
			out.push({
				type: "clio_tool_finish",
				payload: {
					tool: update.kind ?? title,
					mode: this.mode,
					durationMs: Math.max(0, Date.now() - startedAt),
					outcome: isError ? "error" : "ok",
					decision: "allowed",
				},
			});
		}
		return out;
	}
}
