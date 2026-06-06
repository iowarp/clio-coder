import type { DelegationAgentConfig } from "../../core/defaults.js";
import type { ModeName } from "../../domains/modes/matrix.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import type { AgentEvent } from "../types.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import { AcpEventMapper } from "./event-mapper.js";
import { AcpToolMediator } from "./tool-mediator.js";
import { type AcpJsonRpcTransport, createStdioTransport } from "./transport.js";
import type { AcpDelegationResult, AcpDelegationUsage, AcpInitializeResponse, AcpPromptResponse } from "./types.js";
import { ACP_SESSION_META_KEY, ACP_USAGE_META_KEY } from "./types.js";

type AcpRunEvent = AgentEvent | ClioWorkerEvent;

export interface AcpDelegationRunInput {
	agent: DelegationAgentConfig;
	task: string;
	systemPrompt?: string;
	dynamicPromptMessages?: ReadonlyArray<{ body: string }>;
	cwd: string;
	mode: ModeName;
	safety: SafetyContract;
	signal?: AbortSignal;
	clientVersion?: string;
}

export interface AcpDelegationRunHandle {
	pid: number | null;
	events: AsyncIterableIterator<AcpRunEvent>;
	promise: Promise<AcpDelegationResult>;
	abort(): void;
	heartbeatAt: { current: number };
	toolCallLog(): ReturnType<AcpToolMediator["snapshot"]>["toolCallLog"];
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
	private done = false;

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	next(): Promise<IteratorResult<T>> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve({ done: false, value });
		if (this.done) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	push(value: T): void {
		if (this.done) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value });
			return;
		}
		this.values.push(value);
	}

	close(): void {
		if (this.done) return;
		this.done = true;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.({ done: true, value: undefined });
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdFrom(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (!isRecord(value)) return null;
	const sessionId = value.sessionId ?? value.id;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function supportsSessionClose(init: AcpInitializeResponse | null): boolean {
	const caps = init?.agentCapabilities;
	if (!isRecord(caps)) return false;
	// session/close is a documented ACP RFD, not part of the stable schema, so a
	// peer announces support through the _meta extension slot.
	const meta = isRecord(caps._meta) ? caps._meta[ACP_SESSION_META_KEY] : undefined;
	if (isRecord(meta) && meta.close === true) return true;
	// Legacy Clio servers advertised close via a non-spec sessionCapabilities.close
	// field; honour it so older peers still get a graceful close.
	const sessionCaps = caps.sessionCapabilities;
	return isRecord(sessionCaps) && isRecord(sessionCaps.close);
}

function flattenPrompt(input: AcpDelegationRunInput): string {
	const parts = [
		input.systemPrompt?.trim() ?? "",
		...(input.dynamicPromptMessages ?? []).map((message) => message.body.trim()),
		"# Delegated Task",
		input.task.trim(),
	].filter((part) => part.length > 0);
	return parts.join("\n\n");
}

function emptyUsage(): AcpDelegationUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
	};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeUsage(into: AcpDelegationUsage, raw: unknown): void {
	if (!isRecord(raw)) return;
	into.inputTokens += finite(raw.input) + finite(raw.inputTokens) + finite(raw.input_tokens);
	into.outputTokens += finite(raw.output) + finite(raw.outputTokens) + finite(raw.output_tokens);
	into.cacheReadTokens += finite(raw.cacheRead) + finite(raw.cacheReadTokens) + finite(raw.cache_read_tokens);
	into.cacheWriteTokens += finite(raw.cacheWrite) + finite(raw.cacheWriteTokens) + finite(raw.cache_write_tokens);
	into.reasoningTokens += finite(raw.reasoning) + finite(raw.reasoningTokens) + finite(raw.reasoning_tokens);
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function errorEvents(messageText: string): AgentEvent[] {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: messageText }],
		timestamp: Date.now(),
		stopReason: "error",
		errorMessage: messageText,
	};
	return [{ type: "message_end", message } as AgentEvent, { type: "agent_end", messages: [message] } as AgentEvent];
}

export function startAcpDelegationRun(input: AcpDelegationRunInput): AcpDelegationRunHandle {
	const heartbeatAt = { current: Date.now() };
	const queue = new AsyncEventQueue<AcpRunEvent>();
	const usage = emptyUsage();
	const mapper = new AcpEventMapper(input.mode);
	const transportOptions: { cwd?: string; env?: Record<string, string> } = { cwd: input.agent.cwd ?? input.cwd };
	if (input.agent.env !== undefined) transportOptions.env = input.agent.env;
	const transport = createStdioTransport(input.agent.command, input.agent.args ?? [], transportOptions);
	let sessionId: string | null = null;
	let initialized: AcpInitializeResponse | null = null;
	let aborted = false;
	const mediator = new AcpToolMediator({
		safety: input.safety,
		mode: input.mode,
		cwd: input.cwd,
		toolGovernance: input.agent.toolGovernance ?? "clio-policy",
	});

	const emit = (event: AcpRunEvent): void => {
		heartbeatAt.current = Date.now();
		queue.push(event);
	};

	const unregisters = [
		transport.onNotification("session/update", (params) => {
			for (const event of mapper.mapUpdate(params)) emit(event);
		}),
		transport.onRequest("session/request_permission", (params) => mediator.handle(params)),
	];

	const abort = (): void => {
		aborted = true;
		if (sessionId) {
			try {
				transport.notify("session/cancel", { sessionId });
			} catch {
				// best effort
			}
		}
	};
	if (input.signal) {
		if (input.signal.aborted) abort();
		else input.signal.addEventListener("abort", abort, { once: true });
	}

	const promise = (async (): Promise<AcpDelegationResult> => {
		try {
			emit({ type: "agent_start" } as AgentEvent);
			initialized = await transport.request<AcpInitializeResponse>(
				"initialize",
				{
					protocolVersion: 1,
					clientCapabilities: {},
					clientInfo: {
						name: "clio-coder",
						title: "Clio Coder",
						version: input.clientVersion ?? "0.0.0-dev",
					},
				},
				input.agent.connectTimeoutMs,
			);
			if (initialized.protocolVersion !== undefined && initialized.protocolVersion !== 1) {
				throw new Error(`ACP protocol version ${initialized.protocolVersion} is not supported`);
			}
			const session = await transport.request<unknown>(
				"session/new",
				{ cwd: input.cwd, mcpServers: [] },
				input.agent.connectTimeoutMs,
			);
			sessionId = sessionIdFrom(session);
			if (!sessionId) throw new Error("ACP session/new response did not include sessionId");
			const promptResponse = await transport.request<AcpPromptResponse>(
				"session/prompt",
				{
					sessionId,
					prompt: [{ type: "text", text: flattenPrompt(input) }],
				},
				input.agent.turnTimeoutMs,
			);
			// ACP v1 has no usage field on PromptResponse. Clio servers report it in
			// _meta; other agents (Copilot/Codex/OpenCode) report nothing here, so usage
			// is best-effort. Fall back to legacy top-level fields for older peers.
			const metaUsage = isRecord(promptResponse?._meta)
				? (promptResponse._meta as Record<string, unknown>)[ACP_USAGE_META_KEY]
				: undefined;
			if (metaUsage !== undefined) {
				mergeUsage(usage, metaUsage);
			} else {
				mergeUsage(usage, promptResponse?.usage);
				mergeUsage(usage, promptResponse?.tokenUsage);
			}
			for (const event of mapper.finalEvents(promptResponse ?? null)) emit(event);
			const stopReason = typeof promptResponse?.stopReason === "string" ? promptResponse.stopReason : "end_turn";
			const toolSnapshot = mediator.snapshot();
			return {
				messages: [],
				exitCode: aborted || stopReason === "cancelled" ? 1 : stopReason === "end_turn" ? 0 : 1,
				stopReason,
				...(stopReason !== "end_turn" && stopReason !== "cancelled"
					? { failureMessage: `ACP stopReason=${stopReason}` }
					: {}),
				usage,
				delegation: {
					acpSessionId: sessionId,
					initialize: initialized,
					toolCallsRequested: toolSnapshot.toolCallsRequested,
					toolCallsApproved: toolSnapshot.toolCallsApproved,
					toolCallsDenied: toolSnapshot.toolCallsDenied,
				},
			};
		} catch (err) {
			const message = `ACP delegation failed: ${errorMessage(err)}`;
			for (const event of errorEvents(message)) emit(event);
			const toolSnapshot = mediator.snapshot();
			return {
				messages: [],
				exitCode: 1,
				stopReason: aborted ? "cancelled" : "error",
				failureMessage: message,
				usage,
				delegation: {
					acpSessionId: sessionId,
					initialize: initialized,
					toolCallsRequested: toolSnapshot.toolCallsRequested,
					toolCallsApproved: toolSnapshot.toolCallsApproved,
					toolCallsDenied: toolSnapshot.toolCallsDenied,
				},
			};
		} finally {
			for (const unregister of unregisters) unregister();
			if (sessionId && supportsSessionClose(initialized)) {
				try {
					await transport.request("session/close", { sessionId }, 1000);
				} catch {
					// session close is best effort during teardown
				}
			}
			transport.close();
			queue.close();
		}
	})();

	return {
		pid: transport.pid,
		events: queue,
		promise,
		abort,
		heartbeatAt,
		toolCallLog: () => mediator.snapshot().toolCallLog,
	};
}

export type { AcpJsonRpcTransport };
