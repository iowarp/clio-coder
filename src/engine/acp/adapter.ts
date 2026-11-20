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
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import { createTelemetryForwarder } from "../../core/telemetry/forwarder.js";
import { sumFacts } from "../../core/telemetry/pricing.js";
import type { RunUsage } from "../../core/telemetry/schemas.js";
import type { HeartbeatStamp } from "../../domains/dispatch/heartbeat.js";
import { isBuiltinClaudeAcp } from "../../domains/providers/auth/index.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import { findExecutableOnPath } from "../../domains/toolchain/resolve.js";
import { externalUsageFacts, reportedUsageSums } from "../external-call-telemetry.js";
import type { AgentEvent } from "../types.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import { isAntigravityAcp, prepareAntigravityLaunch } from "./antigravity-launch.js";
import { createAntigravityShims } from "./antigravity-shims.js";
import { withInstalledCodex } from "./codex-launch.js";
import { AcpAuthRequiredError, AcpTimeoutError, acpErrorMessage } from "./errors.js";
import { AcpEventMapper } from "./event-mapper.js";
import { legacyModelRequest, offeredChoices, peerSelectOption } from "./peer-config-options.js";
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
	/**
	 * Mid-turn guidance for a peer that takes it as another `session/prompt` (agy 1.5.0 and later), never
	 * `session/cancel`. False when the peer has no such channel or no turn is running.
	 */
	steer?(text: string): boolean;
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

function flattenPrompt(input: AcpDelegationRunInput, systemPromptSent = false): string {
	const parts = [
		systemPromptSent ? "" : (input.systemPrompt?.trim() ?? ""),
		...(input.dynamicPromptMessages ?? []).map((message) => message.body.trim()),
		"# Delegated Task",
		input.task.trim(),
	].filter((part) => part.length > 0);
	return parts.join("\n\n");
}

type QuantityFact = Quantity["fact"];
const notReported: Fact<number> = { kind: "unknown", reason: "provider-omitted" };

/** A peer's quantity as the sum it reported, coverage included, so an unknown part never erases the known (#434). */
function peerSum(fact: QuantityFact | undefined): FactSum {
	if (fact === undefined) return sumFacts([notReported]);
	if ("kind" in fact) return sumFacts([fact]);
	return { ...fact, coverage: { ...fact.coverage } };
}

/** The unknown contributions of a peer's count: how many of its calls reported no usage. */
function unreportedCalls(fact: QuantityFact | undefined): FactSum {
	if (fact === undefined) return sumFacts([notReported]);
	const count = "kind" in fact ? (fact.kind === "unknown" ? 1 : 0) : fact.unknownCount;
	return sumFacts([{ kind: "measured", value: count, source: "provider" }]);
}

/**
 * A Clio peer's `_meta["clio-coder/usage"]`, read as the sums it states (#434). The session block covers the peer's
 * helpers and workers; the turn block covers what this delegation asked for. Its pricing is the peer's own claim.
 */
function clioPeerUsageSums(meta: AcpUsageMeta, coverage: RunUsage["coverage"]): AcpUsageSums {
	const session = meta.session;
	const q = session?.quantities ?? meta.quantities;
	const usd = peerSum(q?.usd.fact);
	const free =
		session !== undefined &&
		session.pricedBy.free > 0 &&
		session.pricedBy.provider + session.pricedBy["target-rates"] + session.pricedBy.catalog + session.pricedBy.none === 0;
	const priced = usd.coverage.measured > 0 || usd.coverage.estimated > 0;
	return {
		usage: {
			input: peerSum(q?.input.fact),
			output: peerSum(q?.output.fact),
			cacheRead: peerSum(q?.cacheRead.fact),
			cacheWrite: peerSum(q?.cacheWrite.fact),
			cacheWrite1h: sumFacts([notReported]),
			reasoning: peerSum(q?.reasoning.fact),
		},
		totalTokens: peerSum(q?.total.fact),
		apiCalls: peerSum(q?.calls.fact),
		unmeteredCalls: unreportedCalls(q?.total.fact),
		pricing: { usd, pricedBy: !priced ? "none" : free ? "free" : "provider" },
		coverage,
	};
}

type AcpUsageSums = Pick<RunUsage, "usage" | "totalTokens" | "apiCalls" | "unmeteredCalls" | "pricing" | "coverage">;

/** ACP reports describe a delegated scope; omitted call counts and pricing stay unknown (#434). */
export function acpUsageSums(value: unknown, coverage: RunUsage["coverage"] = "complete"): AcpUsageSums {
	if (Value.Check(AcpUsageMetaSchema, value) && (value.quantities !== undefined || value.session !== undefined))
		return clioPeerUsageSums(value, coverage);
	// Another agent's usage carries plain counts and, at most, a cost it put no source on.
	const raw = isRecord(value) ? value : {};
	return reportedUsageSums(
		externalUsageFacts({
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
		}),
	);
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
	const antigravity = isAntigravityAcp(input.agent) ? prepareAntigravityLaunch(input.agent, transportOptions.env) : null;
	if (antigravity) transportOptions.env = antigravity.env;
	const agy = antigravity
		? createAntigravityShims({
				command: input.agent.command,
				launchArgs: antigravity.args,
				toolGovernance: input.agent.toolGovernance ?? "clio-coder-policy",
			})
		: null;
	if (agy) Object.assign(transportOptions, agy.transportHooks);
	if (input.terminationGraceMs !== undefined) transportOptions.terminationGraceMs = input.terminationGraceMs;
	if (input.terminationWaitMs !== undefined) transportOptions.terminationWaitMs = input.terminationWaitMs;
	const transport = (() => {
		try {
			return createStdioTransport(input.agent.command, antigravity?.args ?? input.agent.args ?? [], transportOptions);
		} catch (error) {
			// No run will reach the finally below, so the launch dir goes now (spawn rejects, e.g., a NUL in an arg).
			antigravity?.discard();
			throw error;
		}
	})();
	antigravity?.recordChild(transport.pid);
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
			data: { ...acpUsageSums(raw, coverage), source: "acp", scope, revision: 0, target: telemetry.target },
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
			const question = agy?.question(params) ?? null;
			if (agy !== null && question !== null) {
				const { answer, ...asked } = question;
				emit({ type: "clio_coder_peer_question", payload: { ...asked, answer } });
				return agy.questionResponse();
			}
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

	// Wakes the turn's wait on pending steer prompts once the run is aborted or killed.
	let wakeOnAbort = (): void => {};
	const abortWake = new Promise<"aborted">((resolve) => {
		wakeOnAbort = () => resolve("aborted");
	});
	const abort = (): void => {
		if (finished) return;
		aborted = true;
		wakeOnAbort();
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
	const promptTimeoutMs = turnTimeoutMs === 0 ? undefined : turnTimeoutMs;
	// Steer prompts sent into the running turn, and every prompt response of the turn in the order it settled.
	const steerPrompts: Array<Promise<AcpPromptResponse>> = [];
	const settledTurn: AcpPromptResponse[] = [];
	// True from the turn's first session/prompt until its response lands; a steer after that would open a new turn.
	let promptInFlight = false;
	const steer = (text: string): boolean => {
		const body = text.trim();
		if (finished || aborted || forceTermination !== null || transport.closed || !promptInFlight) return false;
		if (sessionId === null || body.length === 0 || agy?.steersByPrompt() !== true) return false;
		let sent: Promise<AcpPromptResponse>;
		try {
			sent = transport.request<AcpPromptResponse>(
				"session/prompt",
				{ sessionId, prompt: [{ type: "text", text: body }] },
				promptTimeoutMs,
			);
		} catch {
			return false;
		}
		const tracked = sent.then((response) => {
			settledTurn.push(response);
			return response;
		});
		// Awaited after the turn's own prompt; this only keeps an early rejection from going unhandled.
		tracked.catch(() => {});
		steerPrompts.push(tracked);
		return true;
	};
	const promise = (async (): Promise<AcpDelegationResult> => {
		let selectedModelId: string | null = null;
		const requireActive = () => {
			if (aborted) throw new Error("the delegation was cancelled before its prompt");
		};
		try {
			emit({ type: "agent_start" } as AgentEvent);
			requireActive();
			initialized = await transport.request<AcpInitializeResponse>(
				"initialize",
				{
					protocolVersion: 1,
					// Clio serves no client-side method (fs/*, terminal/*) to a peer,
					// so it advertises no client capability; an omitted capability
					// means unsupported. agy needs the refusals spelled out.
					clientCapabilities: agy?.clientCapabilities ?? {},
					clientInfo: {
						name: "clio-coder",
						title: "CLIO Coder",
						version: input.clientVersion ?? "0.0.0-dev",
					},
				},
				connectTimeoutMs,
			);
			requireActive();
			if (initialized.protocolVersion !== undefined && initialized.protocolVersion !== 1) {
				throw new Error(`ACP protocol version ${initialized.protocolVersion} is not supported`);
			}
			agy?.admit(initialized);
			const sessionNew = agy?.sessionNew(input.cwd, input.systemPrompt) ?? {
				params: { cwd: input.cwd, mcpServers: [] },
				systemPromptSent: false,
			};
			const session = await transport
				.request<unknown>("session/new", sessionNew.params, connectTimeoutMs)
				.catch((error: unknown) => {
					throw agy?.authFailure(error) ?? error;
				});
			sessionId = sessionIdFrom(session);
			requireActive();
			if (!sessionId) throw new Error("ACP session/new response did not include sessionId");
			const modeReset = agy?.defaultMode(sessionId, session) ?? null;
			if (modeReset !== null) {
				const reset = await transport.request<unknown>(modeReset.method, modeReset.params, connectTimeoutMs);
				requireActive();
				if (modeReset.method === "session/set_config_option") agy?.confirmMode(reset);
			}
			const configOptions = isRecord(session) ? session.configOptions : undefined;
			const modelOption = peerSelectOption(configOptions, "model", "model");
			let thoughtOption = peerSelectOption(configOptions, "thought_level");
			// agy also names a model with its effort as one legacy `<model>-<level>` id.
			const { model: requestedModel, thinkingLevel } = isAntigravityAcp(input.agent)
				? legacyModelRequest(input, modelOption, thoughtOption)
				: input;
			if (requestedModel !== undefined) {
				const ids = modelOption?.values ?? [];
				const current = modelOption?.currentValue ?? null;
				const matches = (id: string): boolean => id === requestedModel || id.startsWith(`${requestedModel}[`);
				const matching = ids.filter(matches);
				const effortInModel = thinkingLevel !== undefined && thoughtOption === null;
				const requested =
					effortInModel && !requestedModel.endsWith("]") ? `${requestedModel}[${thinkingLevel}]` : requestedModel;
				const selected = ids.includes(requested)
					? requested
					: effortInModel || requestedModel.endsWith("]")
						? undefined
						: current !== null && matching.includes(current)
							? current
							: matching.length === 1
								? matching[0]
								: undefined;
				if (selected === undefined || modelOption === null) {
					throw new Error(
						matching.length > 1 && thinkingLevel === undefined
							? `ACP peer offers multiple efforts for requested model '${requestedModel}'; specify thinkingLevel${offeredChoices(matching)}`
							: `ACP peer does not offer requested model '${requested}'${offeredChoices(ids)}`,
					);
				}
				if (selected !== current) {
					const updated = await transport.request<unknown>(
						"session/set_config_option",
						{ sessionId, configId: modelOption.id, value: selected },
						connectTimeoutMs,
					);
					requireActive();
					// The response carries the complete option state; a peer that
					// kept another model must not be recorded as running this one.
					const updatedOptions = isRecord(updated) ? updated.configOptions : undefined;
					const applied = peerSelectOption(updatedOptions, "model", "model")?.currentValue;
					if (typeof applied === "string" && applied !== selected) {
						throw new Error(`ACP peer kept model '${applied}' after Clio selected '${selected}'`);
					}
					// Thinking levels can differ per model (agy offers each model its own), so check the new model's list.
					thoughtOption = peerSelectOption(updatedOptions, "thought_level") ?? thoughtOption;
				}
				selectedModelId = selected;
			} else if (modelOption?.currentValue) {
				selectedModelId = modelOption.currentValue;
			}
			if (thinkingLevel !== undefined && thoughtOption !== null) {
				if (!thoughtOption.values.includes(thinkingLevel)) {
					throw new Error(
						`ACP peer does not offer requested thinking level '${thinkingLevel}'${offeredChoices(thoughtOption.values)}`,
					);
				}
				if (thoughtOption.currentValue !== thinkingLevel) {
					const updated = await transport.request<unknown>(
						"session/set_config_option",
						{ sessionId, configId: thoughtOption.id, value: thinkingLevel },
						connectTimeoutMs,
					);
					requireActive();
					const applied = peerSelectOption(
						isRecord(updated) ? updated.configOptions : undefined,
						"thought_level",
					)?.currentValue;
					if (typeof applied === "string" && applied !== thinkingLevel) {
						throw new Error(`ACP peer kept thinking level '${applied}' after Clio selected '${thinkingLevel}'`);
					}
				}
			}
			requireActive();
			promptInFlight = true;
			const turnPrompt = transport.request<AcpPromptResponse>(
				"session/prompt",
				{
					sessionId,
					prompt: [{ type: "text", text: flattenPrompt(input, sessionNew.systemPromptSent) }],
				},
				promptTimeoutMs,
			);
			// Registered before the await below, so steers are refused as soon as the turn's answer lands.
			turnPrompt.then(
				(response) => {
					promptInFlight = false;
					settledTurn.push(response);
				},
				() => {
					promptInFlight = false;
				},
			);
			let promptResponse = await turnPrompt;
			// A steer continues the same turn: wait for every steer prompt, stop waiting on abort, and keep a steer
			// that failed after the turn answered as a record rather than the run's failure.
			for (let index = 0; index < steerPrompts.length && !aborted; index++) {
				const steered = steerPrompts[index];
				if (steered === undefined) continue;
				const outcome = await Promise.race([
					steered.then(
						() => "settled" as const,
						(error: unknown) => ({ error }),
					),
					abortWake,
				]);
				if (outcome === "aborted") break;
				if (outcome !== "settled")
					emit({ type: "clio_coder_peer_steer_failed", payload: { reason: acpErrorMessage(outcome.error) } });
			}
			if (agy !== null && steerPrompts.length > 0) promptResponse = agy.settleTurn(settledTurn);
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
			// An abort that lands after the turn answered (a steer still pending, say) is the run's outcome: report it
			// as cancelled, as the peer would, rather than an end_turn with a failing exit code.
			if (aborted && reportedFailure === null) promptResponse = { ...promptResponse, stopReason: "cancelled" };
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
			promptInFlight = false;
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
				...(err instanceof AcpAuthRequiredError ? { authRequired: { loginCommand: err.loginCommand } } : {}),
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
			// The child is gone (or past the kill bound), so its unpacked runtime can go.
			await antigravity?.cleanup();
			if (!usageRecorded) recordUsage(undefined, "run", "unknown");
			forwarder?.close();
			queue.close();
			finished = true;
		}
	})();

	const kill = (): void => {
		if (finished) return;
		aborted = true;
		wakeOnAbort();
		clearCancelTimer();
		void beginForceTermination();
	};

	return {
		pid: transport.pid,
		events: queue,
		promise,
		abort,
		kill,
		...(agy !== null ? { steer } : {}),
		heartbeatAt,
		toolCallLog: () => mediator.snapshot().toolCallLog,
	};
}

export type { AcpJsonRpcTransport };
