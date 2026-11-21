import { performance } from "node:perf_hooks";
import { ToolNames } from "../../core/tool-names.js";
import { describeCallAction } from "../../domains/safety/call-target.js";
import type { AgentEvent, AgentMessage } from "../types.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import { mapAcpToolCall } from "./tool-mediator.js";
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

export interface AcpEventMapperOptions {
	/** The run's workspace, against which a peer's relative tool targets resolve; defaults to this process's cwd. */
	cwd?: string;
	/** A peer shim's rewrite of its own tool shape into one the mediator maps, the same one its approvals take. */
	normalizeToolCall?: (toolCall: AcpToolCallUpdate) => AcpToolCallUpdate;
}

/** A tool frame as the merge keeps it: ACP's fields plus a peer's own tool `name` and `args` (agy sends both). */
type MergedToolCall = AcpToolCallUpdate & { name?: string; args?: Record<string, unknown> };

/** Whether a mapped call names what it acts on yet: a known Clio tool with its target, or bash with its command. */
function resolvesCall(mapped: ReturnType<typeof mapAcpToolCall>): boolean {
	if (!mapped.known || mapped.validationError !== undefined) return false;
	// An argument-free mapping (a search before its pattern arrives) names nothing yet.
	if (mapped.tool !== ToolNames.Bash) return Object.keys(mapped.args).length > 0;
	return typeof mapped.args.command === "string" && mapped.args.command.trim().length > 0;
}

export class AcpEventMapper {
	constructor(private readonly options: AcpEventMapperOptions = {}) {}

	private messageStarted = false;
	private assistantText = "";
	private assistantThinking = "";
	/** Tool-call id to its `performance.now()` start mark; spans only, never an instant. */
	private readonly toolStarts = new Map<string, number>();
	/** ACP updates may omit kind after the first frame; titles can change. */
	private readonly toolKinds = new Map<string, string>();
	/** Each open call's frames merged so far, since a peer may send its input only on a later update. */
	private readonly toolCalls = new Map<string, MergedToolCall>();
	/** The Clio tool name each call's `tool_execution_start` carried, which its end repeats. */
	private readonly executionNames = new Map<string, string>();
	/** Calls that already settled: a repeated or late frame for one emits nothing, so each call starts and ends once. */
	private readonly settledCalls = new Set<string>();

	/** Some ACP bridges stream a provider error as text, then report `end_turn`. */
	reportedFailure(): string | null {
		const lastLine = this.assistantText.trim().split(/\r?\n/u).at(-1);
		if (!lastLine?.startsWith("{")) return null;
		let value: unknown;
		try {
			value = JSON.parse(lastLine);
		} catch {
			return null;
		}
		if (!isRecord(value) || value.type !== "error") return null;
		const error = isRecord(value.error) ? value.error : null;
		if (typeof error?.message !== "string" || error.message.length === 0) return null;
		if (value.status !== undefined && (typeof value.status !== "number" || value.status < 400)) return null;
		return typeof value.status === "number"
			? `ACP peer reported HTTP ${value.status}: ${error.message}`
			: `ACP peer reported error: ${error.message}`;
	}

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
			return [{ type: "clio_coder_plan_update", payload: update } as unknown as AgentEvent];
		}
		return [];
	}

	/** Tool calls the peer started and has not yet settled; one still running after the prompt is background work. */
	openToolCalls(): number {
		return this.toolStarts.size;
	}

	finalEvents(response: AcpPromptResponse | null, reportedFailure: string | null = null): AgentEvent[] {
		const missingStopReason = typeof response?.stopReason !== "string" || response.stopReason.length === 0;
		const stopReason = missingStopReason ? "error" : (response?.stopReason ?? "error");
		const failure = reportedFailure ?? (missingStopReason ? "ACP prompt response missing stopReason" : null);
		const agentStopReason = failure === null ? stopReasonForAgent(stopReason) : "error";
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
			...(failure !== null || errorMessageForStopReason(stopReason) !== undefined
				? { errorMessage: failure ?? errorMessageForStopReason(stopReason) }
				: {}),
			...(response?.usage !== undefined ? { usage: response.usage } : {}),
		} as unknown as AgentMessage;
		return [{ type: "message_end", message } as AgentEvent, { type: "agent_end", messages: [message] } as AgentEvent];
	}

	private mapToolUpdate(update: AcpToolCallUpdate): Array<AgentEvent | ClioWorkerEvent> {
		const toolCallId = update.toolCallId ?? update.title ?? `acp-tool-${this.toolStarts.size + 1}`;
		// Only a peer-given id identifies one call; a title stand-in may name the next call too.
		if (update.toolCallId !== undefined && this.settledCalls.has(update.toolCallId)) return [];
		if (!this.toolKinds.has(toolCallId)) this.toolKinds.set(toolCallId, update.kind ?? "other");
		const tool = this.toolKinds.get(toolCallId) ?? "other";
		const status = update.status ?? "pending";
		const out: Array<AgentEvent | ClioWorkerEvent> = [];
		if (!this.toolStarts.has(toolCallId) && (status === "pending" || status === "in_progress")) {
			// The wall read anchors the instant the start event reports; the map
			// keeps the monotonic twin, which is what the duration below spans.
			const startedAt = Date.now();
			this.toolStarts.set(toolCallId, performance.now());
			// A peer's `rawInput` is its own argument object and never reaches an
			// operator surface. The descriptor composed from it here does.
			const action = describeCallAction(tool, update.rawInput);
			out.push({
				type: "clio_coder_tool_start",
				payload: {
					tool,
					toolCallId,
					posture: "operating",
					startedAt,
					...(action !== null ? { action } : {}),
				},
			});
		}
		const settling = status === "completed" || status === "failed" || status === "cancelled";
		const merged = this.mergeToolCall(toolCallId, update);
		// The execution events feed the finish contract and run effects, which judge Clio tools, so they carry the
		// mapped Clio call (edit and its path, bash and its command), never the peer's display title or raw input.
		// The start waits until the mapping names a target or command, which a peer may send only on a later frame,
		// and a call first seen settled still gets its start before its end (C-15).
		if (!this.executionNames.has(toolCallId)) {
			const mapped = this.mapCall(merged);
			if (settling || resolvesCall(mapped)) {
				const toolName = mapped.known ? mapped.tool : "unknown";
				this.executionNames.set(toolCallId, toolName);
				out.push({
					type: "tool_execution_start",
					toolCallId,
					toolName,
					args: mapped.known ? mapped.args : {},
				} as unknown as AgentEvent);
			}
		}
		if (settling) {
			const startedAtClock = this.toolStarts.get(toolCallId) ?? performance.now();
			this.toolStarts.delete(toolCallId);
			const isError = status !== "completed";
			const result = toolContentText(update.content) || update.rawOutput || status;
			// The outcome leads the end event, as it does for an in-process tool,
			// because run effects judge a failed check by it when the call settles.
			out.push({
				type: "clio_coder_tool_finish",
				payload: {
					tool,
					toolCallId,
					posture: "operating",
					durationMs: Math.round(performance.now() - startedAtClock),
					outcome: isError ? "error" : "ok",
				},
			});
			out.push({
				type: "tool_execution_end",
				toolCallId,
				toolName: this.executionNames.get(toolCallId) ?? "unknown",
				result,
				isError,
			} as unknown as AgentEvent);
			this.toolKinds.delete(toolCallId);
			this.toolCalls.delete(toolCallId);
			this.executionNames.delete(toolCallId);
			if (update.toolCallId !== undefined) this.settledCalls.add(update.toolCallId);
		}
		return out;
	}

	/**
	 * The Clio call a merged frame amounts to: through the peer's shim (agy's `run_command` and `run_workflow` become
	 * the command they run), then the mediator's mapping, reading a peer's `args` when it sent no `rawInput`, as the
	 * shim does.
	 */
	private mapCall(merged: MergedToolCall): ReturnType<typeof mapAcpToolCall> {
		const normalized: MergedToolCall = this.options.normalizeToolCall?.(merged) ?? merged;
		const input =
			isRecord(normalized.rawInput) && Object.keys(normalized.rawInput).length > 0
				? normalized
				: isRecord(normalized.args)
					? { ...normalized, rawInput: normalized.args }
					: normalized;
		return mapAcpToolCall(input, this.options.cwd ?? process.cwd());
	}

	/**
	 * The call's frames so far: the first kind and tool name stand, and a later title, input, args or locations
	 * replaces an earlier one.
	 */
	private mergeToolCall(toolCallId: string, update: MergedToolCall): MergedToolCall {
		const prior = this.toolCalls.get(toolCallId) ?? {};
		const merged: MergedToolCall = { ...prior, toolCallId };
		const kind = prior.kind ?? update.kind;
		if (kind !== undefined) merged.kind = kind;
		const name = prior.name ?? (typeof update.name === "string" ? update.name : undefined);
		if (name !== undefined) merged.name = name;
		if (update.title !== undefined) merged.title = update.title;
		if (isRecord(update.rawInput)) merged.rawInput = update.rawInput;
		if (isRecord(update.args)) merged.args = update.args;
		if (Array.isArray(update.locations)) merged.locations = update.locations;
		this.toolCalls.set(toolCallId, merged);
		return merged;
	}
}
