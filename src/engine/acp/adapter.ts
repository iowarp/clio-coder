import {
	DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS,
	DEFAULT_DELEGATION_TURN_TIMEOUT_MS,
	type DelegationAgentConfig,
} from "../../core/defaults.js";
import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import type { AgentEvent } from "../types.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import { AcpTimeoutError } from "./errors.js";
import { AcpEventMapper } from "./event-mapper.js";
import { AcpToolMediator } from "./tool-mediator.js";
import {
	type AcpForceTerminationResult,
	type AcpJsonRpcTransport,
	createStdioTransport,
	type StdioTransportOptions,
} from "./transport.js";
import type { AcpDelegationResult, AcpDelegationUsage, AcpInitializeResponse, AcpPromptResponse } from "./types.js";
import { ACP_SESSION_META_KEY, ACP_USAGE_META_KEY } from "./types.js";

type AcpRunEvent = AgentEvent | ClioWorkerEvent;

const DEFAULT_CANCEL_GRACE_MS = 1_000;

export interface AcpDelegationRunInput {
	agent: DelegationAgentConfig;
	task: string;
	systemPrompt?: string;
	dynamicPromptMessages?: ReadonlyArray<{ body: string }>;
	cwd: string;
	safety: SafetyContract;
	/** Session autonomy level applied by the mediator under clio-policy governance. */
	autonomy?: AutonomyLevel;
	signal?: AbortSignal;
	clientVersion?: string;
	/** Testable SIGTERM grace used by hard termination. */
	terminationGraceMs?: number;
	/** Testable post-SIGKILL exit-observation bound. */
	terminationWaitMs?: number;
	/** Grace for session/cancel before abort escalates into hard termination. */
	cancelGraceMs?: number;
}

export interface AcpDelegationRunHandle {
	pid: number | null;
	events: AsyncIterableIterator<AcpRunEvent>;
	promise: Promise<AcpDelegationResult>;
	abort(): void;
	/**
	 * Hard-terminate a stalled peer: reject pending RPCs, SIGTERM the owned
	 * process scope, escalate to SIGKILL after a bounded grace, and keep
	 * `promise` pending until process/stdio closure has been observed or the
	 * final observation bound expires.
	 */
	kill(): void;
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

function cancelGraceMs(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CANCEL_GRACE_MS;
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
	// Validated settings always populate these values. Keep the public runtime
	// boundary safe for direct callers too: omission must not turn a silent ACP
	// peer into an unbounded request.
	const connectTimeoutMs = input.agent.connectTimeoutMs ?? DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS;
	const turnTimeoutMs = input.agent.turnTimeoutMs ?? DEFAULT_DELEGATION_TURN_TIMEOUT_MS;
	const heartbeatAt = { current: Date.now() };
	const queue = new AsyncEventQueue<AcpRunEvent>();
	const usage = emptyUsage();
	const mapper = new AcpEventMapper();
	const transportOptions: StdioTransportOptions = { cwd: input.agent.cwd ?? input.cwd };
	if (input.agent.env !== undefined) transportOptions.env = input.agent.env;
	if (input.terminationGraceMs !== undefined) transportOptions.terminationGraceMs = input.terminationGraceMs;
	if (input.terminationWaitMs !== undefined) transportOptions.terminationWaitMs = input.terminationWaitMs;
	const transport = createStdioTransport(input.agent.command, input.agent.args ?? [], transportOptions);
	let sessionId: string | null = null;
	let initialized: AcpInitializeResponse | null = null;
	let aborted = false;
	let finished = false;
	let cancelTimer: ReturnType<typeof setTimeout> | null = null;
	let forceTermination: Promise<AcpForceTerminationResult> | null = null;
	let unregisterAbortSignal = (): void => {};
	const beginForceTermination = (): Promise<AcpForceTerminationResult> => {
		forceTermination ??= transport.forceTerminate();
		return forceTermination;
	};
	const clearCancelTimer = (): void => {
		if (cancelTimer === null) return;
		clearTimeout(cancelTimer);
		cancelTimer = null;
	};
	const emit = (event: AcpRunEvent): void => {
		heartbeatAt.current = Date.now();
		queue.push(event);
	};
	const mediator = new AcpToolMediator({
		safety: input.safety,
		cwd: input.cwd,
		toolGovernance: input.agent.toolGovernance ?? "clio-policy",
		...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
		onPermissionResolved: (event) =>
			emit({
				type: "clio_permission_resolved",
				payload: event,
			} as ClioWorkerEvent),
	});

	const unregisters = [
		transport.onNotification("session/update", (params) => {
			for (const event of mapper.mapUpdate(params)) emit(event);
		}),
		transport.onRequest("session/request_permission", (params) => mediator.handle(params)),
		transport.onStderr((chunk) => {
			if (process.env.CLIO_INTERACTIVE !== "1") {
				process.stderr.write(chunk);
			}
		}),
	];

	const abort = (): void => {
		if (finished) return;
		aborted = true;
		if (sessionId) {
			try {
				transport.notify("session/cancel", { sessionId });
			} catch {
				// best effort
			}
		}
		if (cancelTimer === null && forceTermination === null) {
			cancelTimer = setTimeout(() => {
				cancelTimer = null;
				void beginForceTermination();
			}, cancelGraceMs(input.cancelGraceMs));
		}
	};
	if (input.signal) {
		if (input.signal.aborted) abort();
		else {
			input.signal.addEventListener("abort", abort, { once: true });
			unregisterAbortSignal = () => input.signal?.removeEventListener("abort", abort);
		}
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
				connectTimeoutMs,
			);
			if (initialized.protocolVersion !== undefined && initialized.protocolVersion !== 1) {
				throw new Error(`ACP protocol version ${initialized.protocolVersion} is not supported`);
			}
			const session = await transport.request<unknown>(
				"session/new",
				{ cwd: input.cwd, mcpServers: [] },
				connectTimeoutMs,
			);
			sessionId = sessionIdFrom(session);
			if (!sessionId) throw new Error("ACP session/new response did not include sessionId");
			if (aborted) {
				transport.notify("session/cancel", { sessionId });
			}
			const promptResponse = await transport.request<AcpPromptResponse>(
				"session/prompt",
				{
					sessionId,
					prompt: [{ type: "text", text: flattenPrompt(input) }],
				},
				turnTimeoutMs,
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
			const termination = await beginForceTermination();
			const baseMessage = `ACP delegation failed: ${errorMessage(err)}`;
			const message = termination.exited
				? baseMessage
				: `${baseMessage}; ACP ${termination.scope} exit was not observed within the force-termination bound`;
			for (const event of errorEvents(message)) emit(event);
			const toolSnapshot = mediator.snapshot();
			return {
				messages: [],
				exitCode: 1,
				stopReason: aborted ? "cancelled" : "error",
				...(err instanceof AcpTimeoutError ? { timedOut: true } : {}),
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
			unregisterAbortSignal();
			for (const unregister of unregisters) unregister();
			clearCancelTimer();
			let gracefulCloseFailed = false;
			if (forceTermination === null && !aborted && sessionId && supportsSessionClose(initialized)) {
				try {
					await transport.request("session/close", { sessionId }, 1000);
				} catch {
					gracefulCloseFailed = true;
				}
			}
			if (gracefulCloseFailed || aborted) {
				await beginForceTermination();
			} else if (forceTermination !== null) {
				await forceTermination;
			} else {
				transport.close();
				// A successful prompt still owns the external process. Give a peer
				// that does not advertise session/close a bounded EOF grace, then use
				// the same hard lifetime bound as abort/stall rather than returning a
				// successful run while the child remains alive.
				if (!(await transport.waitForExit(cancelGraceMs(input.cancelGraceMs)))) {
					await beginForceTermination();
				}
			}
			queue.close();
			finished = true;
		}
	})();

	const kill = (): void => {
		if (finished) return;
		aborted = true;
		clearCancelTimer();
		void beginForceTermination();
	};

	return {
		pid: transport.pid,
		events: queue,
		promise,
		abort,
		kill,
		heartbeatAt,
		toolCallLog: () => mediator.snapshot().toolCallLog,
	};
}

export type { AcpJsonRpcTransport };
