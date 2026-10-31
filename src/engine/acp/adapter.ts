import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { Value } from "typebox/value";
import { watchCredentialExpiry } from "../../core/credential-expiry.js";
import {
	DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS,
	DEFAULT_DELEGATION_TURN_TIMEOUT_MS,
	type DelegationAgentConfig,
} from "../../core/defaults.js";
import { processBirthToken } from "../../core/process-identity.js";
import type { WorkerTelemetryContext } from "../../core/telemetry/context.js";
import { withTelemetryContext } from "../../core/telemetry/context.js";
import type { Quantity } from "../../core/telemetry/dto.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { createTelemetryForwarder } from "../../core/telemetry/forwarder.js";
import type { RunUsage } from "../../core/telemetry/schemas.js";
import type { HeartbeatStamp } from "../../domains/dispatch/heartbeat.js";
import { isBuiltinClaudeAcp } from "../../domains/providers/auth/index.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import { findExecutableOnPath } from "../../domains/toolchain/resolve.js";
import { externalUsageFacts } from "../external-call-telemetry.js";
import type { AgentEvent } from "../types.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import { withInstalledCodex } from "./codex-launch.js";
import { AcpTimeoutError } from "./errors.js";
import { AcpEventMapper } from "./event-mapper.js";
import { AcpToolMediator } from "./tool-mediator.js";
import {
	type AcpForceTerminationResult,
	type AcpJsonRpcTransport,
	createStdioTransport,
	type StdioTransportOptions,
} from "./transport.js";
import type { AcpDelegationResult, AcpInitializeResponse, AcpPromptResponse, AcpUsageMeta } from "./types.js";
import { ACP_SESSION_META_KEY, ACP_USAGE_META_KEY, AcpUsageMetaSchema } from "./types.js";

type AcpRunEvent = AgentEvent | ClioWorkerEvent;

export const DEFAULT_CANCEL_GRACE_MS = 1_000;

export interface AcpDelegationRunInput {
	telemetry?: { context: WorkerTelemetryContext; target: RunUsage["target"] };
	agent: DelegationAgentConfig;
	/** Resolved launch secrets are separate from the persisted agent recipe. */
	environment?: Record<string, string>;
	credentialExpiresAt?: number;
	task: string;
	/** Explicit peer model requested for this run. */
	model?: string;
	/** Explicit effort for a peer model that advertises effort variants. */
	thinkingLevel?: string;
	systemPrompt?: string;
	dynamicPromptMessages?: ReadonlyArray<{ body: string }>;
	cwd: string;
	safety: SafetyContract;
	readOnly?: boolean;
	/**
	 * Canonical tools this delegation may use, handed to the mediator as a hard
	 * scope. Absent leaves the peer's own surface to the safety net: an ACP
	 * delegation carries no recipe, so dispatch has no admitted list to supply
	 * and an empty one would deny every call.
	 */
	allowedTools?: ReadonlyArray<string>;
	signal?: AbortSignal;
	clientVersion?: string;
	/** Testable SIGTERM grace used by hard termination. */
	terminationGraceMs?: number;
	/** Testable post-SIGKILL exit-observation bound. */
	terminationWaitMs?: number;
	/** Grace for session/cancel before abort escalates into hard termination. */
	cancelGraceMs?: number;
	/** Wall clock for the persisted heartbeat anchor. */
	now?: () => number;
	/** Monotonic clock for event-inactivity spans. */
	monotonicNow?: () => number;
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
	heartbeatAt: HeartbeatStamp;
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
	// Stable ACP v1 peers advertise session/close in sessionCapabilities.
	const sessionCaps = caps.sessionCapabilities;
	if (isRecord(sessionCaps) && isRecord(sessionCaps.close)) return true;
	// Older Clio peers announced close through _meta. Keep that path for peers
	// whose sessions predate the stable capability.
	const meta = isRecord(caps._meta) ? caps._meta[ACP_SESSION_META_KEY] : undefined;
	return isRecord(meta) && meta.close === true;
}

interface PeerSelectOption {
	id: string;
	currentValue: string | null;
	values: string[];
}

/**
 * The `select` config option in a category, preferring the one whose id is
 * `preferId` and otherwise the first. ACP v1 uses session config options for
 * model and thinking level; their values may be grouped. A 0.6.2 Clio peer
 * announced its `target` option in the `model` category ahead of `model`.
 */
function peerSelectOption(
	configOptions: unknown,
	category: "model" | "thought_level",
	preferId?: string,
): PeerSelectOption | null {
	if (!Array.isArray(configOptions)) return null;
	let first: PeerSelectOption | null = null;
	for (const option of configOptions) {
		if (!isRecord(option) || option.category !== category || option.type !== "select") continue;
		if (typeof option.id !== "string" || option.id.length === 0) continue;
		const values: string[] = [];
		for (const entry of Array.isArray(option.options) ? option.options : []) {
			if (!isRecord(entry)) continue;
			if (typeof entry.value === "string") values.push(entry.value);
			else if (Array.isArray(entry.options)) {
				for (const grouped of entry.options) {
					if (isRecord(grouped) && typeof grouped.value === "string") values.push(grouped.value);
				}
			}
		}
		const parsed = {
			id: option.id,
			currentValue: typeof option.currentValue === "string" ? option.currentValue : null,
			values,
		};
		if (option.id === preferId) return parsed;
		first ??= parsed;
	}
	return first;
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

type QuantityFact = Quantity["fact"];
const notReported: Fact<number> = { kind: "unknown", reason: "provider-omitted" };

/** A peer's quantity as one fact: a sum with an unknown part is unknown, an estimated part makes it a peer estimate. */
function peerFact(fact: QuantityFact | undefined, source: "provider" | "local-count" = "provider"): Fact<number> {
	if (fact === undefined) return notReported;
	if ("kind" in fact) {
		if (fact.kind === "estimated") return { kind: "estimated", value: fact.value, method: "peer-report" };
		return fact.kind === "measured" ? { kind: "measured", value: fact.value, source } : notReported;
	}
	if (fact.unknownCount > 0) return notReported;
	if (fact.coverage.estimated > 0)
		return { kind: "estimated", value: fact.measured + fact.estimated, method: "peer-report" };
	if (fact.coverage.measured > 0) return { kind: "measured", value: fact.measured, source };
	return fact.absentCount > 0 ? { kind: "absent", reason: "not-applicable" } : notReported;
}

/** The unknown contributions of a peer's count: how many of its calls reported no usage. */
function unreportedCalls(fact: QuantityFact | undefined): Fact<number> {
	if (fact === undefined) return notReported;
	if ("kind" in fact) return fact.kind === "unknown" ? { kind: "measured", value: 1, source: "provider" } : notReported;
	return { kind: "measured", value: fact.unknownCount, source: "provider" };
}

/**
 * A Clio peer's `_meta["clio-coder/usage"]`, read as the facts it states (#434). The session block covers the peer's
 * helpers and workers; the turn block covers what this delegation asked for. Its pricing is the peer's own claim.
 */
function clioPeerUsageFacts(meta: AcpUsageMeta, coverage: RunUsage["coverage"]) {
	const session = meta.session;
	const q = session?.quantities ?? meta.quantities;
	const facts = {
		input: peerFact(q?.input.fact),
		output: peerFact(q?.output.fact),
		cacheRead: peerFact(q?.cacheRead.fact),
		cacheWrite: peerFact(q?.cacheWrite.fact),
		cacheWrite1h: notReported,
		reasoning: peerFact(q?.reasoning.fact),
	};
	const usd = peerFact(q?.usd.fact);
	const free =
		session !== undefined &&
		session.pricedBy.free > 0 &&
		session.pricedBy.provider + session.pricedBy["target-rates"] + session.pricedBy.catalog + session.pricedBy.none === 0;
	const usdFact = q?.usd.fact;
	const usdUnknown = usdFact !== undefined && !("kind" in usdFact) && usdFact.unknownCount > 0;
	const callsFact = q?.calls.fact;
	return {
		usage: facts,
		totalTokens: peerFact(q?.total.fact),
		apiCalls: peerFact(callsFact, "local-count"),
		missingTokenCalls: unreportedCalls(q?.total.fact),
		pricing: {
			usd,
			pricedBy:
				usd.kind === "unknown" || usd.kind === "absent"
					? ("none" as const)
					: free
						? ("free" as const)
						: ("provider" as const),
		},
		coverage,
		pricingCoverage: usdUnknown
			? usdFact.measured + usdFact.estimated > 0
				? ("partial" as const)
				: ("unknown" as const)
			: usd.kind === "unknown"
				? ("unknown" as const)
				: ("complete" as const),
		callCountCoverage:
			callsFact !== undefined && !("kind" in callsFact) && callsFact.unknownCount > 0
				? ("partial" as const)
				: ("complete" as const),
	};
}

/** ACP reports describe a delegated scope; omitted call counts and pricing stay unknown (#434). */
export function acpUsageFacts(value: unknown, coverage: RunUsage["coverage"] = "complete") {
	if (Value.Check(AcpUsageMetaSchema, value) && (value.quantities !== undefined || value.session !== undefined))
		return clioPeerUsageFacts(value, coverage);
	// Another agent's usage carries plain counts and, at most, a cost it put no source on.
	const raw = isRecord(value) ? value : {};
	return externalUsageFacts({
		coverage,
		usage: {
			input: raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens,
			output: raw.output ?? raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens,
			cacheRead: raw.cacheRead ?? raw.cacheReadTokens ?? raw.cache_read_tokens,
			cacheWrite: raw.cacheWrite ?? raw.cacheWriteTokens ?? raw.cache_write_tokens,
			reasoning: raw.reasoning ?? raw.reasoningTokens ?? raw.reasoning_tokens,
			totalTokens: raw.totalTokens ?? raw.total_tokens,
			pricedBy: "none",
			clioExternal: { tokenUsage: raw.estimated === true ? "unverified" : "provider-reported", cost: "unverified" },
		},
	});
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function cancelGraceMs(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CANCEL_GRACE_MS;
}

function errorEvents(messageText: string): AgentEvent[] {
	// The marker lets dispatch tell this fault from a real usage-less ACP reply, which looks identical otherwise.
	const message = {
		role: "assistant",
		clioSyntheticFault: true,
		content: [{ type: "text", text: messageText }],
		timestamp: Date.now(),
		stopReason: "error",
		errorMessage: messageText,
	};
	return [{ type: "message_end", message } as AgentEvent, { type: "agent_end", messages: [message] } as AgentEvent];
}

export function startAcpDelegationRun(input: AcpDelegationRunInput): AcpDelegationRunHandle {
	// Connection faults stay bounded. Elapsed turn time is not a progress signal;
	// only an explicit positive timeout stops a healthy turn. Dispatch owns its
	// event-inactivity watchdog and cancellation/process cleanup.
	const connectTimeoutMs = input.agent.connectTimeoutMs ?? DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS;
	const turnTimeoutMs = input.agent.turnTimeoutMs ?? DEFAULT_DELEGATION_TURN_TIMEOUT_MS;
	const now = input.now ?? Date.now;
	const monotonicNow = input.monotonicNow ?? (() => performance.now());
	const heartbeatWallAnchor = now();
	const heartbeatMonotonicAnchor = monotonicNow();
	const heartbeatAt: HeartbeatStamp = {
		current: heartbeatWallAnchor,
		monotonic: heartbeatMonotonicAnchor,
	};
	const queue = new AsyncEventQueue<AcpRunEvent>();
	const mapper = new AcpEventMapper();
	const transportOptions: StdioTransportOptions = { cwd: input.agent.cwd ?? input.cwd };
	if (input.environment) transportOptions.env = input.environment;
	if (input.agent.env !== undefined) {
		// The safe child environment omits provider credentials. An explicitly
		// configured reference passes only the named value to this ACP peer,
		// while settings and receipts retain the reference rather than the key.
		transportOptions.env = {
			...transportOptions.env,
			...Object.fromEntries(
				Object.entries(input.agent.env).map(([name, value]) => {
					const reference = /^\{env:([A-Z_][A-Z0-9_]*)\}$/u.exec(value);
					if (reference === null) return [name, value];
					const sourceName = reference[1];
					const resolved = sourceName === undefined ? undefined : process.env[sourceName];
					if (resolved === undefined || resolved.length === 0)
						throw new Error(`ACP agent environment reference '${sourceName}' is unavailable`);
					return [name, resolved];
				}),
			),
		};
	}
	transportOptions.env = withInstalledCodex(input.agent, transportOptions.cwd ?? input.cwd, transportOptions.env);
	if (isBuiltinClaudeAcp(input.agent) && !input.agent.env?.PATH && !transportOptions.env?.CLAUDE_CODE_EXECUTABLE) {
		const installed = findExecutableOnPath("claude");
		if (installed) transportOptions.env = { ...transportOptions.env, CLAUDE_CODE_EXECUTABLE: installed };
	}
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
	let authFailure: string | null = null;
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
		const stamp = monotonicNow();
		heartbeatAt.monotonic = stamp;
		heartbeatAt.current = heartbeatWallAnchor + (stamp - heartbeatMonotonicAnchor);
		queue.push(event);
	};
	const telemetry = input.telemetry;
	const forwarder = telemetry
		? createTelemetryForwarder(
				telemetry.context,
				{ host: hostname(), pid: process.pid, birthToken: processBirthToken(), monoEpochWallMs: performance.timeOrigin },
				emit,
				4096,
				false,
			)
		: undefined;
	if (telemetry) {
		forwarder?.enqueue({
			kind: "process.started",
			data: {},
			ctx: telemetry.context,
			wallMs: Date.now(),
			mono: performance.now(),
		});
		forwarder?.flush();
	}
	let usageRecorded = false;
	const recordUsage = (raw: unknown, scope: RunUsage["scope"], coverage: RunUsage["coverage"]) => {
		if (!telemetry) return;
		forwarder?.enqueue({
			kind: "run.usage_reported",
			data: { ...acpUsageFacts(raw, coverage), source: "acp", scope, revision: 0, target: telemetry.target },
			ctx: telemetry.context,
			wallMs: Date.now(),
			mono: performance.now(),
		});
		usageRecorded = true;
	};
	const mediator = new AcpToolMediator({
		safety: input.safety,
		cwd: input.cwd,
		toolGovernance: input.agent.toolGovernance ?? "clio-coder-policy",
		...(input.readOnly === true ? { readOnly: true } : {}),
		...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
		onPermissionResolved: (event) =>
			emit({
				type: "clio_coder_permission_resolved",
				payload: event,
			} as ClioWorkerEvent),
	});

	const unregisters = [
		transport.onNotification("session/update", (params) => {
			for (const event of mapper.mapUpdate(params)) emit(event);
		}),
		transport.onRequest("session/request_permission", (params) => {
			if (!telemetry) return mediator.handle(params);
			const toolCall = isRecord(params) && isRecord(params.toolCall) ? params.toolCall : undefined;
			return withTelemetryContext(
				{
					...telemetry.context,
					...(typeof toolCall?.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
				},
				() => mediator.handle(params),
			);
		}),
		transport.onStderr((chunk) => {
			if (process.env.CLIO_CODER_INTERACTIVE !== "1") {
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

	const stopExpiryWatch = watchCredentialExpiry(input.credentialExpiresAt, () => {
		authFailure =
			"Clio's Claude subscription access token expired. Start a new delegation to refresh it; this run was stopped without replaying its work.";
		void beginForceTermination();
	});
	const promise = (async (): Promise<AcpDelegationResult> => {
		let selectedModelId: string | null = null;
		try {
			emit({ type: "agent_start" } as AgentEvent);
			initialized = await transport.request<AcpInitializeResponse>(
				"initialize",
				{
					protocolVersion: 1,
					// Clio serves no client-side method (fs/*, terminal/*) to a peer,
					// so it advertises no client capability; an omitted capability
					// means unsupported.
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
			const configOptions = isRecord(session) ? session.configOptions : undefined;
			const modelOption = peerSelectOption(configOptions, "model", "model");
			const thoughtOption = peerSelectOption(configOptions, "thought_level");
			if (input.model !== undefined) {
				const ids = modelOption?.values ?? [];
				const current = modelOption?.currentValue ?? null;
				const matches = (id: string): boolean => id === input.model || id.startsWith(`${input.model}[`);
				const matching = ids.filter(matches);
				const effortInModel = input.thinkingLevel !== undefined && thoughtOption === null;
				const requested =
					effortInModel && !input.model.endsWith("]") ? `${input.model}[${input.thinkingLevel}]` : input.model;
				const selected = ids.includes(requested)
					? requested
					: effortInModel || input.model.endsWith("]")
						? undefined
						: current !== null && matching.includes(current)
							? current
							: matching.length === 1
								? matching[0]
								: undefined;
				if (selected === undefined || modelOption === null) {
					throw new Error(
						matching.length > 1 && input.thinkingLevel === undefined
							? `ACP peer offers multiple efforts for requested model '${input.model}'; specify thinkingLevel`
							: `ACP peer does not offer requested model '${requested}'`,
					);
				}
				if (selected !== current) {
					const updated = await transport.request<unknown>(
						"session/set_config_option",
						{ sessionId, configId: modelOption.id, value: selected },
						connectTimeoutMs,
					);
					// The response carries the complete option state; a peer that
					// kept another model must not be recorded as running this one.
					const applied = peerSelectOption(
						isRecord(updated) ? updated.configOptions : undefined,
						"model",
						"model",
					)?.currentValue;
					if (typeof applied === "string" && applied !== selected) {
						throw new Error(`ACP peer kept model '${applied}' after Clio selected '${selected}'`);
					}
				}
				selectedModelId = selected;
			} else if (modelOption?.currentValue) {
				selectedModelId = modelOption.currentValue;
			}
			if (input.thinkingLevel !== undefined && thoughtOption !== null) {
				if (!thoughtOption.values.includes(input.thinkingLevel)) {
					throw new Error(`ACP peer does not offer requested thinking level '${input.thinkingLevel}'`);
				}
				if (thoughtOption.currentValue !== input.thinkingLevel) {
					const updated = await transport.request<unknown>(
						"session/set_config_option",
						{ sessionId, configId: thoughtOption.id, value: input.thinkingLevel },
						connectTimeoutMs,
					);
					const applied = peerSelectOption(
						isRecord(updated) ? updated.configOptions : undefined,
						"thought_level",
					)?.currentValue;
					if (typeof applied === "string" && applied !== input.thinkingLevel) {
						throw new Error(`ACP peer kept thinking level '${applied}' after Clio selected '${input.thinkingLevel}'`);
					}
				}
			}
			if (aborted) {
				transport.notify("session/cancel", { sessionId });
			}
			const promptResponse = await transport.request<AcpPromptResponse>(
				"session/prompt",
				{
					sessionId,
					prompt: [{ type: "text", text: flattenPrompt(input) }],
				},
				turnTimeoutMs === 0 ? undefined : turnTimeoutMs,
			);
			// ACP v1 has no usage field on PromptResponse. Clio servers report it in
			// _meta; other agents (Copilot/Codex/OpenCode) report nothing here, so usage
			// is best-effort. Fall back to legacy top-level fields for older peers.
			const metaUsage = isRecord(promptResponse?._meta)
				? (promptResponse._meta as Record<string, unknown>)[ACP_USAGE_META_KEY]
				: undefined;
			if (Value.Check(AcpUsageMetaSchema, metaUsage)) {
				// This adapter creates one fresh peer session and submits one prompt. Clio's session block covers that
				// peer's helpers and workers, so it is the delegation's scope when present (#434).
				recordUsage(metaUsage, metaUsage.session ? "peer-session" : "run", "complete");
			} else {
				recordUsage(promptResponse?.usage ?? promptResponse?.tokenUsage, "run", "complete");
			}
			const reportedFailure =
				authFailure ??
				mapper.reportedFailure() ??
				(typeof promptResponse?.stopReason === "string" && promptResponse.stopReason.length > 0
					? null
					: "ACP prompt response missing stopReason");
			for (const event of mapper.finalEvents(promptResponse ?? null, reportedFailure)) emit(event);
			const stopReason =
				reportedFailure !== null
					? "error"
					: typeof promptResponse?.stopReason === "string"
						? promptResponse.stopReason
						: "error";
			const toolSnapshot = mediator.snapshot();
			return {
				messages: [],
				exitCode: aborted || reportedFailure !== null || stopReason === "cancelled" ? 1 : stopReason === "end_turn" ? 0 : 1,
				stopReason,
				...(reportedFailure !== null || (stopReason !== "end_turn" && stopReason !== "cancelled")
					? { failureMessage: reportedFailure ?? `ACP stopReason=${stopReason}` }
					: {}),
				delegation: {
					acpSessionId: sessionId,
					...(selectedModelId !== null ? { selectedModelId } : {}),
					initialize: initialized,
					toolCallsRequested: toolSnapshot.toolCallsRequested,
					toolCallsApproved: toolSnapshot.toolCallsApproved,
					toolCallsDenied: toolSnapshot.toolCallsDenied,
				},
			};
		} catch (err) {
			const termination = await beginForceTermination();
			const baseMessage = `ACP delegation failed: ${authFailure ?? errorMessage(err)}`;
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
				delegation: {
					acpSessionId: sessionId,
					...(selectedModelId !== null ? { selectedModelId } : {}),
					initialize: initialized,
					toolCallsRequested: toolSnapshot.toolCallsRequested,
					toolCallsApproved: toolSnapshot.toolCallsApproved,
					toolCallsDenied: toolSnapshot.toolCallsDenied,
				},
			};
		} finally {
			stopExpiryWatch();
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
			if (!usageRecorded) recordUsage(undefined, "run", "unknown");
			forwarder?.close();
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
