/**
 * Turn recovery: the transient retry chain, overflow compact-and-retry, and
 * the retry countdown. The interrupt/cancel semantics these paths respect
 * (`state.activeInterruptReason`) are owned by the loop's cancel entry point;
 * this module owns everything that happens after a run settles with a
 * terminal failure.
 */

import { toContextOverflowError } from "../domains/providers/errors.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { RecoveryFailure, RetryCountdownHandle, RetrySettings } from "../domains/session/retry.js";
import {
	classifyRecoveryFailure,
	createRetryCountdown,
	failureRetryAfterMs,
	formatStatedWait,
	isRateLimitErrorMessage,
	isRetryableRecoveryFailure,
	RATE_LIMIT_WAIT_BUDGET_MS,
	type RetryWaitCause,
	recoveryRetryDelayMs,
	retryWaitCause,
	statedRetryWaitMs,
} from "../domains/session/retry.js";
import { LOCAL_CONTEXT_OVERFLOW_PREFIX } from "../engine/apis/output-budget.js";
import type { AgentMessage, ImageContent, MutableAgentState } from "../engine/types.js";
import type { TerminalAssistantFailure } from "./chat-loop-messages.js";
import {
	detectOverflowFromState,
	detectTerminalFailureFromState,
	isEmptyAbortedAssistantMessage,
	pruneFailedAssistantFromContext,
	terminalFailureFromAssistantMessage,
} from "./chat-loop-messages.js";
import { boundRefusedPrompt } from "./session-replay-messages.js";
import type { TurnContext } from "./turn-context.js";
import type { TurnPersistence } from "./turn-persistence.js";
import type { AgentRuntime, StallAbortReadState, StallAbortState, TurnRecoveryState } from "./turn-state.js";

export type RetryStatusPhase = "scheduled" | "waiting" | "retrying" | "moved" | "cancelled" | "exhausted" | "recovered";

/** One route as a status row names it. */
export interface MovedRoute {
	targetId: string;
	modelId: string;
}

export interface RetryStatusPayload {
	phase: RetryStatusPhase;
	attempt: number;
	maxAttempts: number;
	errorMessage?: string;
	delayMs?: number;
	seconds?: number;
	/** The wait the provider itself named, which `delayMs` sits out in full. */
	retryAfterMs?: number;
	/** The chain stopped without another attempt, because `retryAfterMs` would take it past this much waiting. */
	waitBudgetMs?: number;
	/** What the chain had already waited when it stopped on `waitBudgetMs`. */
	waitedMs?: number;
	/** What the refusal this wait answers said the target is waiting on. */
	cause?: RetryWaitCause;
	/** On `moved`: the route the request left, which may still bill the call it aborted. */
	movedFrom?: MovedRoute;
	/** On `moved`: the route the request is going to now. */
	movedTo?: MovedRoute;
	/** On `moved`: whether a call was out on the old route, as opposed to a wait between attempts. */
	movedAborted?: boolean;
	/** Of `attempt`, how many sat out a provider's wait and so spent no retry. Absent when none did. */
	providerWaits?: number;
	/** This attempt is one of `providerWaits`, so `maxAttempts` says nothing about it. */
	onProviderWait?: boolean;
}

/** The attempt that follows a failure the recovery ladder has already decided to retry. */
export interface RetryForecast {
	attempt: number;
	maxAttempts: number;
	providerWaits?: number;
	onProviderWait?: boolean;
}

export interface RetryStatusEvent {
	type: "retry_status";
	status: RetryStatusPayload;
}

export interface TurnRecoveryDeps {
	auth?: ProvidersContract["auth"];
	turnSignal?: () => AbortSignal | undefined;
	turnIdentity?: () => unknown;
	state: TurnRecoveryState;
	persistence: TurnPersistence;
	context: TurnContext;
	retrySettings: () => RetrySettings;
	/** Put the agent on `state.routeMove` for its next call. Null when no move is pending or the turn stopped owning it. */
	applyRouteMove?: (agentRuntime: AgentRuntime) => Promise<{ from: MovedRoute; to: MovedRoute } | null>;
	/** Autonomy yolo waits out a rate limit, because nobody is there to send the turn again (#445). */
	isYolo?: () => boolean;
	markPersistedUserEcho: (text: string, prompt: () => Promise<void>) => Promise<void>;
	emitRetryStatus: (status: RetryStatusPayload) => void;
	emitFailureMessage: (message: AgentMessage) => void;
	emitNotice: (text: string) => void;
}

export interface TurnRecovery {
	runCompactAndRetry(
		agentRuntime: AgentRuntime,
		text: string,
		overflow: NonNullable<ReturnType<typeof toContextOverflowError>>,
		images?: ReadonlyArray<ImageContent>,
	): Promise<void>;
	runTransientRetryChain(
		agentRuntime: AgentRuntime,
		text: string,
		initialFailure: TerminalAssistantFailure,
		attemptMessages?: ReadonlyArray<AgentMessage>,
		classification?: RecoveryFailure,
	): Promise<boolean>;
	ensureFailureVisibleAndPersisted(failure: TerminalAssistantFailure): void;
	/**
	 * Whether the ladder will try again after this settled assistant message, decided before the message is published:
	 * an attempt that will be retried is not a settled turn, and surfaces must not read it as one.
	 */
	forecastRetry(agentRuntime: AgentRuntime, message: AgentMessage): RetryForecast | null;
	/** Where the current attempt's messages begin, which `forecastRetry` reads for attempt output. */
	noteAttemptStart(messageIndex: number): void;
	/** Close a forecast no ladder went on to settle, so nothing keeps waiting on a retry that never came. */
	settleOpenForecast(): void;
	cancelRetryCountdown(): void;
	/** Whether the ladder is sitting out a wait between attempts, when no request is live. */
	inRetryWait(): boolean;
	/** A rate limit litellm reads as terminal is still worth waiting for at yolo, however the failure arrived (#445). */
	waitsOutRateLimit(failure: RecoveryFailure): boolean;
	/** Sit out a failed turn's delay before its yolo continuation, in the countdown Esc already cancels (#445). */
	waitBeforeContinuation(
		delayMs: number,
		attempt: number,
		maxAttempts: number,
		reason: string,
	): Promise<"done" | "cancelled">;
}

/**
 * Rewrite an invoked stream stall as a transient error for provider recovery.
 * A pre-invocation timeout keeps its aborted stop reason and names the local
 * stage without consuming a transient retry (#424).
 *
 * `agent.abort()` always settles the run as `stopReason: "aborted"`, and both
 * gates below refuse that on purpose: an operator who pressed Esc must never
 * have the turn restarted under them. The stall watchdog in
 * `turn-runtime.ts` is the one caller that aborts with no operator behind it,
 * and `state.streamStallReason` is the flag that says so. An operator cancel
 * that landed in the same window wins: `activeInterruptReason` is set only by
 * `ChatLoop.cancel`, so the stall reason is dropped rather than retried.
 *
 * The runtime event seam calls `rewriteStallAbortMessage` before publishing or
 * persisting `message_end`, so the provider's one terminal message becomes the
 * corrected ledger row. This post-settlement pass covers engines that settle
 * without emitting that event and consumes the watchdog reason in either case.
 */
export function reclassifyStallAbort(
	state: StallAbortState,
	failure: TerminalAssistantFailure,
): TerminalAssistantFailure {
	const reason = state.streamStallReason;
	const stage = state.streamStallStage;
	state.streamStallReason = null;
	state.streamStallStage = null;
	if (reason === null || failure.stopReason !== "aborted" || state.activeInterruptReason !== null) return failure;
	if (failure.message) rewriteStallAbortMessage(state, failure.message, reason, stage);
	// Local preparation timeouts must not consume provider retries (#424).
	return {
		...failure,
		stopReason: stage !== null ? "aborted" : "error",
		errorMessage: reason,
	};
}

/** Rewrite the provider's terminal abort object before its event is emitted and persisted. */
export function rewriteStallAbortMessage(
	state: StallAbortReadState,
	message: AgentMessage,
	reason = state.streamStallReason,
	stage = state.streamStallStage,
): boolean {
	if (
		reason === null ||
		state.activeInterruptReason !== null ||
		message.role !== "assistant" ||
		(message as { stopReason?: unknown }).stopReason !== "aborted"
	) {
		return false;
	}
	const failure = message as { stopReason?: unknown; errorMessage?: unknown };
	failure.stopReason = stage !== null ? "aborted" : "error";
	failure.errorMessage = reason;
	return true;
}

export function recoveryAttemptHasOutput(messages: ReadonlyArray<AgentMessage>): boolean {
	return messages.some((message) => {
		if (message.role === "toolResult") return true;
		if (message.role !== "assistant") return false;
		return message.content.some(
			(block) =>
				block.type === "toolCall" ||
				(block.type === "text" && block.text.length > 0) ||
				(block.type === "thinking" && block.thinking.length > 0),
		);
	});
}

export function createTurnRecovery(deps: TurnRecoveryDeps): TurnRecovery {
	const { state, persistence, context } = deps;
	let retryCountdown: RetryCountdownHandle | null = null;
	/** Every request this chain has sent again, which the rail and the receipt count. */
	let chainAttempt = 0;
	/** Those Clio chose to send on its own backoff, which `maxRetries` limits. A wait the provider stated spends none. */
	let chainOwnRetries = 0;
	/** Those the provider's rate limit made Clio sit out. No limit counts them, so nothing may show them against one. */
	let chainProviderWaits = 0;
	let chainWaitedMs = 0;
	let attemptStart = 0;
	let refreshingAuth = false;
	let openForecast: RetryForecast | null = null;
	let inLadderWait = false;

	const appendRetryStatusSafe = (status: RetryStatusPayload): void => {
		persistence.appendRetryStatus(status);
	};

	const recordRetryStatus = (status: RetryStatusPayload, durable = true): void => {
		if (
			status.phase === "cancelled" ||
			status.phase === "exhausted" ||
			status.phase === "recovered" ||
			status.phase === "moved"
		)
			openForecast = null;
		if (durable) appendRetryStatusSafe(status);
		deps.emitRetryStatus(status);
	};

	const ensureFailureVisibleAndPersisted = (failure: TerminalAssistantFailure): void => {
		const message = failure.message;
		if (!message || typeof message !== "object" || persistence.wasPersisted(message)) return;
		// After a loop-guard interrupt the closing turn already says why the run
		// stopped; the empty aborted failure message the abort leaves behind
		// would only add "[aborted] Request was aborted." noise on top of it.
		if (state.activeInterruptReason !== null && isEmptyAbortedAssistantMessage(message)) return;
		persistence.appendAssistantTurn(message);
		deps.emitFailureMessage(message);
	};

	const waitForRetryCountdown = async (status: RetryStatusPayload): Promise<"done" | "cancelled"> => {
		const signal = deps.turnSignal?.();
		if (signal?.aborted) return "cancelled";
		return new Promise((resolve) => {
			const onAbort = (): void => {
				currentHandle?.cancel();
			};
			const finish = (result: "done" | "cancelled"): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			let settled = false;
			let currentHandle: RetryCountdownHandle | null = null;
			const handle = createRetryCountdown({
				attempt: status.attempt,
				maxAttempts: status.maxAttempts,
				delayMs: status.delayMs ?? 0,
				onTick: (tickState) => {
					deps.emitRetryStatus({
						...status,
						phase: "waiting",
						seconds: tickState.seconds,
					});
				},
				onDone: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					finish("done");
				},
				onCancel: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					finish("cancelled");
				},
			});
			currentHandle = handle;
			retryCountdown = settled ? null : handle;
			if (!settled) {
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) handle.cancel();
			}
		});
	};

	const waitsOutRateLimitMessage = (errorMessage: string | null | undefined): boolean =>
		deps.isYolo?.() === true && isRateLimitErrorMessage(errorMessage);
	const waitsOutRateLimit = (failure: RecoveryFailure): boolean =>
		failure.kind === "terminal-provider" && waitsOutRateLimitMessage(failure.message);
	// A stated wait is worth sitting out in every mode, whatever the failure's own class would have said about retrying.
	const retryableFailure = (failure: RecoveryFailure, message?: unknown): boolean =>
		isRetryableRecoveryFailure(failure) ||
		waitsOutRateLimit(failure) ||
		(failure.kind === "terminal-provider" && statedRetryWaitMs(message, failure.message) !== null);
	/** Whether the next attempt can happen at all: a stated wait spends the chain's time, anything else its attempts. */
	const mayAttempt = (attempt: number, errorMessage: string | null | undefined, message?: unknown): boolean => {
		if (statedRetryWaitMs(message, errorMessage) !== null) return true;
		return waitsOutRateLimitMessage(errorMessage)
			? chainWaitedMs < RATE_LIMIT_WAIT_BUDGET_MS
			: attempt <= deps.retrySettings().maxRetries;
	};
	const pastWaitBudget = (statedMs: number): boolean => chainWaitedMs + statedMs > RATE_LIMIT_WAIT_BUDGET_MS;
	/** Whether this failure's retry sits out a provider's wait instead of spending one of `maxRetries`. */
	const isProviderWait = (message: unknown, errorMessage: string | null | undefined): boolean =>
		statedRetryWaitMs(message, errorMessage) !== null || waitsOutRateLimitMessage(errorMessage);
	const waitFacts = (waits: number, onWait: boolean): Pick<RetryForecast, "providerWaits" | "onProviderWait"> => ({
		...(waits > 0 ? { providerWaits: waits } : {}),
		...(onWait ? { onProviderWait: true } : {}),
	});
	/** The chain's retry limit as a status states it: never below what Clio has spent of its own. */
	const retryLimit = (attempt: number, waits: number): number =>
		Math.max(attempt - waits, deps.retrySettings().maxRetries);
	const refreshesAuth = (agentRuntime: AgentRuntime): boolean => {
		const rejected = agentRuntime.lastAuthResolution;
		return deps.auth !== undefined && rejected?.source === "stored-oauth" && rejected.apiKey !== undefined;
	};

	const forecastRetry = (agentRuntime: AgentRuntime, message: AgentMessage): RetryForecast | null => {
		openForecast = null;
		const failure = terminalFailureFromAssistantMessage(message);
		if (!failure || refreshingAuth) return null;
		// A moved request goes out again at once and owes nothing to the retry settings. An operator's cancel still wins.
		if (state.routeMove != null) {
			if (deps.turnSignal?.()?.aborted === true || state.activeInterruptReason !== null) return null;
			openForecast = { attempt: 1, maxAttempts: 1 };
			return openForecast;
		}
		const attempted = agentRuntime.agent.state.messages.slice(attemptStart);
		const classified = classifyRecoveryFailure({
			message: failure.errorMessage,
			runtimeId: agentRuntime.runtimeId,
			...(agentRuntime.lastProviderStatus !== undefined ? { status: agentRuntime.lastProviderStatus } : {}),
			cancelled:
				deps.turnSignal?.()?.aborted === true || state.activeInterruptReason !== null || failure.stopReason === "aborted",
			hasAttemptOutput: recoveryAttemptHasOutput(attempted.includes(message) ? attempted : [...attempted, message]),
		});
		if (classified.kind === "auth") {
			openForecast = refreshesAuth(agentRuntime) ? { attempt: 1, maxAttempts: 1 } : null;
			return openForecast;
		}
		const settings = deps.retrySettings();
		if (!settings.enabled || settings.maxRetries <= 0 || !retryableFailure(classified, message)) return null;
		const statedMs = statedRetryWaitMs(message, failure.errorMessage);
		if (statedMs !== null && pastWaitBudget(statedMs)) return null;
		if (!mayAttempt(chainOwnRetries + 1, failure.errorMessage, message)) return null;
		const onWait = isProviderWait(message, failure.errorMessage);
		const waits = chainProviderWaits + (onWait ? 1 : 0);
		openForecast = {
			attempt: chainAttempt + 1,
			maxAttempts: retryLimit(chainAttempt + 1, waits),
			...waitFacts(waits, onWait),
		};
		return openForecast;
	};

	/**
	 * Shared compact-and-retry worker used by both the post-resolve
	 * (state-based) and catch (throw-based) overflow paths in `submit`.
	 * Emits the "context overflow" notice when compaction is a no-op,
	 * the "compact-on-overflow failed" notice when compaction itself
	 * throws, and a "persisted" notice when the retry still surfaces an
	 * overflow.
	 */
	const runCompactAndRetry = async (
		agentRuntime: AgentRuntime,
		text: string,
		overflow: NonNullable<ReturnType<typeof toContextOverflowError>>,
		images?: ReadonlyArray<ImageContent>,
	): Promise<void> => {
		const signal = deps.turnSignal?.();
		const identity = deps.turnIdentity?.();
		const cancelled = (): boolean => signal?.aborted === true || identity !== deps.turnIdentity?.();
		// Set only once the server has taken the request's size. Every other way out, cancel included, must not leave the
		// refused prompt to be resent whole on the next turn.
		let sizeAccepted = false;
		try {
			if (cancelled()) return;
			const windowUnknown = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow <= 0;
			const refusedLocally = overflow.message.startsWith(LOCAL_CONTEXT_OVERFLOW_PREFIX);
			deps.emitNotice(
				refusedLocally
					? "[Clio Coder] Clio refused this request before sending it: it would leave too little of the context window for a reply; compacting and retrying once."
					: windowUnknown
						? "[Clio Coder] Server rejected this request for exceeding its context window. The serving limit is unknown; compacting and retrying once. Probe the target or configure its deployment limit to enable proactive compaction."
						: "[Clio Coder] Server rejected this request for exceeding its context window; compacting and retrying once.",
			);
			let compacted = false;
			try {
				pruneFailedAssistantFromContext(agentRuntime.agent);
				const mutableState = agentRuntime.agent.state as MutableAgentState;
				mutableState.errorMessage = undefined;
				compacted = await context.runAutoCompact(agentRuntime, true, undefined, "overflow");
			} catch (compactErr) {
				if (cancelled()) return;
				state.continuation.recordStop({
					cause: "compaction",
					reason: compactErr instanceof Error ? compactErr.message : String(compactErr),
				});
				deps.emitNotice(
					`[Clio Coder] compact-on-overflow failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
				);
			}
			if (cancelled()) return;
			if (!compacted) {
				deps.emitNotice(
					`[Clio Coder] context overflow could not be compacted: ${overflow.message}. Use /context compact or reduce the request.`,
				);
				return;
			}
			try {
				// The rebuild from the ledger already carries a committed request (and any tool batch it started), so the
				// retry continues it rather than sending the request a second time.
				const tail = agentRuntime.agent.state.messages.at(-1)?.role;
				const replayed = context.activeTurnCommitted?.() === true && (tail === "user" || tail === "toolResult");
				if (replayed) {
					if (!cancelled()) await agentRuntime.agent.continue();
				} else {
					await deps.markPersistedUserEcho(text, () =>
						cancelled() ? Promise.resolve() : agentRuntime.agent.prompt(text, images ? [...images] : undefined),
					);
				}
				if (cancelled()) return;
				const stillOverflowed = detectOverflowFromState(agentRuntime.agent);
				if (stillOverflowed) {
					deps.emitNotice(`[Clio Coder] context overflow persisted after compaction: ${stillOverflowed.message}`);
				} else {
					sizeAccepted = true;
				}
			} catch (retryErr) {
				if (cancelled()) return;
				sizeAccepted = toContextOverflowError(retryErr) === null;
				deps.emitNotice(
					`[Clio Coder] context overflow persisted after compaction: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
				);
			}
		} finally {
			// A reset swaps in another session's messages, and those are not this refusal's to bound.
			if (!sizeAccepted && identity === deps.turnIdentity?.()) boundRefusedPrompt(agentRuntime.agent);
		}
	};

	const runLadder = async (
		agentRuntime: AgentRuntime,
		text: string,
		initialFailure: TerminalAssistantFailure,
		attemptMessages?: ReadonlyArray<AgentMessage>,
		classification?: RecoveryFailure,
	): Promise<boolean> => {
		const signal = deps.turnSignal?.();
		const identity = deps.turnIdentity?.();
		const cancelled = (): boolean => signal?.aborted === true || identity !== deps.turnIdentity?.();
		if (cancelled()) return true;
		// Retry only a client connection failure before output on this exact
		// route. Keep HTTP gateway/backend failures terminal and never substitute
		// a model. The SDK itself still performs no hidden gateway retries.
		const classify = (failure: TerminalAssistantFailure, messages: ReadonlyArray<AgentMessage>): RecoveryFailure =>
			classifyRecoveryFailure({
				message: failure.errorMessage,
				runtimeId: agentRuntime.runtimeId,
				...(agentRuntime.lastProviderStatus !== undefined ? { status: agentRuntime.lastProviderStatus } : {}),
				cancelled: cancelled() || state.activeInterruptReason !== null || failure.stopReason === "aborted",
				hasAttemptOutput: recoveryAttemptHasOutput(messages),
			});
		let classified =
			classification ??
			classify(initialFailure, attemptMessages ?? (initialFailure.message ? [initialFailure.message] : []));
		const retryAuth = async (failure: TerminalAssistantFailure): Promise<boolean> => {
			const rejected = agentRuntime.lastAuthResolution;
			if (!deps.auth || rejected?.source !== "stored-oauth" || rejected.apiKey === undefined) return false;
			refreshingAuth = true;
			const { target, runtime } = agentRuntime.runtimeResolution;
			const persistFailure = (errorMessage: string): void => {
				const model = agentRuntime.agent.state.model;
				const message = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						callInvoked: false,
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage,
					timestamp: Date.now(),
				} as AgentMessage;
				(agentRuntime.agent.state as MutableAgentState).errorMessage = errorMessage;
				agentRuntime.agent.state.messages.push(message);
				ensureFailureVisibleAndPersisted({ stopReason: "error", errorMessage, message });
				recordRetryStatus({ phase: "exhausted", attempt: 1, maxAttempts: 1, errorMessage }, false);
			};
			ensureFailureVisibleAndPersisted(failure);
			recordRetryStatus({
				phase: "retrying",
				attempt: 1,
				maxAttempts: 1,
				errorMessage: `Refreshing OAuth authentication for target '${target.id}' and retrying once.`,
			});
			pruneFailedAssistantFromContext(agentRuntime.agent);
			try {
				const refreshed = await deps.auth.resolveForTarget(target, runtime, {
					rejectedApiKey: rejected.apiKey,
					...(signal ? { signal } : {}),
				});
				if (cancelled()) return true;
				if (!refreshed.available || refreshed.apiKey === undefined) {
					throw new Error(refreshed.detail ?? "OAuth credential could not be refreshed.");
				}
			} catch {
				if (cancelled()) return true;
				// Reuse the CLI login syntax, and keep refresh-provider diagnostics out of the remedy (#427).
				const errorMessage = `OAuth credential for target '${target.id}' could not be refreshed. Run clio-coder auth login ${rejected.providerId} again.`;
				persistFailure(errorMessage);
				return true;
			}
			if (cancelled()) return true;
			(agentRuntime.agent.state as MutableAgentState).errorMessage = undefined;
			try {
				// Continue the failed round with its existing user and tool messages (#427).
				await agentRuntime.agent.continue();
			} catch (error) {
				if (!cancelled()) persistFailure(error instanceof Error ? error.message : String(error));
				return true;
			} finally {
				refreshingAuth = false;
			}
			if (cancelled()) return true;
			const settled = detectTerminalFailureFromState(agentRuntime.agent);
			if (settled) ensureFailureVisibleAndPersisted(settled);
			recordRetryStatus(
				{
					phase: settled ? "exhausted" : "recovered",
					attempt: 1,
					maxAttempts: 1,
					...(settled ? { errorMessage: settled.errorMessage } : {}),
				},
				false,
			);
			return true;
		};
		const moving = (): boolean => state.routeMove != null;
		// Auth recovery has its own one-shot budget even when transient retries are disabled (#427).
		if (!moving() && classified.kind === "auth") return retryAuth(initialFailure);
		const retryable = retryableFailure;
		const recordRetriesExhausted = (errorMessage: string | null | undefined, message?: unknown): void => {
			const retryAfterMs = failureRetryAfterMs(message, errorMessage);
			state.continuation.recordStop({
				cause: "retries_exhausted",
				reason: errorMessage ?? "provider retries ran out",
				...(retryAfterMs === null ? {} : { retryAfterMs }),
			});
		};
		if (!moving() && agentRuntime.runtimeId === "litellm" && !retryable(classified, initialFailure.message)) {
			ensureFailureVisibleAndPersisted(initialFailure);
			return true;
		}
		const settings = deps.retrySettings();
		if (!moving() && (!settings.enabled || settings.maxRetries <= 0)) return false;
		if (!moving() && !retryable(classified, initialFailure.message)) return false;

		let failure = initialFailure;
		chainWaitedMs = 0;
		chainAttempt = 0;
		chainOwnRetries = 0;
		chainProviderWaits = 0;
		while (moving() || mayAttempt(chainOwnRetries + 1, failure.errorMessage, failure.message)) {
			ensureFailureVisibleAndPersisted(failure);
			pruneFailedAssistantFromContext(agentRuntime.agent);

			let attempt = 0;
			let maxAttempts = 0;
			let onWait = false;
			let cause: RetryWaitCause | null = null;
			const movedAborted = moving();
			if (!moving()) {
				const statedMs = statedRetryWaitMs(failure.message, failure.errorMessage);
				if (statedMs !== null && pastWaitBudget(statedMs)) {
					recordRetryStatus({
						phase: "exhausted",
						attempt: chainAttempt,
						maxAttempts: retryLimit(chainAttempt, chainProviderWaits),
						...waitFacts(chainProviderWaits, false),
						errorMessage: failure.errorMessage,
						retryAfterMs: statedMs,
						waitBudgetMs: RATE_LIMIT_WAIT_BUDGET_MS,
						waitedMs: chainWaitedMs,
					});
					state.continuation.recordStop({
						cause: "wait_past_budget",
						reason: `the provider asked to wait ${formatStatedWait(statedMs)}, past the ${formatStatedWait(RATE_LIMIT_WAIT_BUDGET_MS)} Clio waits on one request`,
						retryAfterMs: statedMs,
					});
					return true;
				}
				chainAttempt += 1;
				attempt = chainAttempt;
				const backoffMs = recoveryRetryDelayMs(chainOwnRetries + 1, settings, classified);
				// Going back when told to is not the retry a count limits.
				if (statedMs === null) chainOwnRetries += 1;
				onWait = isProviderWait(failure.message, failure.errorMessage);
				if (onWait) chainProviderWaits += 1;
				const retryAfterMs = failureRetryAfterMs(failure.message, failure.errorMessage);
				// `chat.retry.maxDelayMs` limits Clio's own backoff. It has no say over a wait the provider stated.
				const delayMs =
					statedMs !== null
						? Math.max(backoffMs, statedMs)
						: waitsOutRateLimitMessage(failure.errorMessage)
							? Math.min(backoffMs, RATE_LIMIT_WAIT_BUDGET_MS - chainWaitedMs)
							: backoffMs;
				chainWaitedMs += delayMs;
				maxAttempts = retryLimit(attempt, chainProviderWaits);
				cause = retryWaitCause(classified);
				const scheduled: RetryStatusPayload = {
					phase: "scheduled",
					attempt,
					maxAttempts,
					delayMs,
					...waitFacts(chainProviderWaits, onWait),
					errorMessage: failure.errorMessage,
					...(retryAfterMs === null ? {} : { retryAfterMs }),
					...(cause === null ? {} : { cause }),
				};
				recordRetryStatus(scheduled);
				inLadderWait = true;
				const countdown = await waitForRetryCountdown(scheduled).finally(() => {
					inLadderWait = false;
				});
				if (identity !== deps.turnIdentity?.()) return true;
				// A pick ends the countdown the way Esc does, but only Esc aborts the turn.
				if ((countdown === "cancelled" && !moving()) || cancelled()) {
					recordRetryStatus({
						phase: "cancelled",
						attempt,
						maxAttempts,
						...waitFacts(chainProviderWaits, onWait),
						errorMessage: failure.errorMessage,
					});
					pruneFailedAssistantFromContext(agentRuntime.agent);
					return true;
				}
			}

			const movingNow = moving();
			if (movingNow) {
				if (cancelled()) return true;
				// What the old route said about waiting, and what it used of the retries, is not the new route's to inherit.
				chainAttempt = 0;
				chainOwnRetries = 0;
				chainProviderWaits = 0;
				chainWaitedMs = 0;
				attempt = 1;
				maxAttempts = Math.max(1, settings.maxRetries);
				const moved = await deps.applyRouteMove?.(agentRuntime);
				state.routeMove = null;
				if (identity !== deps.turnIdentity?.()) return true;
				if (cancelled()) return true;
				if (moved) {
					recordRetryStatus({
						phase: "moved",
						attempt: 1,
						maxAttempts: 1,
						movedFrom: moved.from,
						movedTo: moved.to,
						movedAborted,
					});
				}
			} else {
				recordRetryStatus(
					{
						phase: "retrying",
						attempt,
						maxAttempts,
						...waitFacts(chainProviderWaits, onWait),
						errorMessage: failure.errorMessage,
						...(cause === null ? {} : { cause }),
					},
					false,
				);
			}

			if (cancelled()) return true;
			attemptStart = agentRuntime.agent.state.messages.length;
			try {
				state.routeMoveSeat = true;
				await agentRuntime.agent.continue();
			} catch (err) {
				if (cancelled()) return true;
				const message = err instanceof Error ? err.message : String(err);
				classified = classifyRecoveryFailure({
					message,
					runtimeId: agentRuntime.runtimeId,
					hasAttemptOutput: recoveryAttemptHasOutput(agentRuntime.agent.state.messages.slice(attemptStart)),
					cause: err,
					...(typeof err === "object" && err !== null && "status" in err ? { status: err.status } : {}),
				});
				if (classified.kind === "auth") {
					if (await retryAuth({ stopReason: "error", errorMessage: message })) return true;
				}
				if (!retryable(classified) || !mayAttempt(chainOwnRetries + 1, message)) {
					recordRetryStatus({
						phase: "exhausted",
						attempt,
						maxAttempts,
						...waitFacts(chainProviderWaits, false),
						errorMessage: message,
					});
					if (retryable(classified)) recordRetriesExhausted(message);
					// The exhausted status already exposes this failure and retains its full
					// diagnostic. A second raw notice bypasses bounded error presentation.
					pruneFailedAssistantFromContext(agentRuntime.agent);
					return true;
				}
				failure = { stopReason: "error", errorMessage: message };
				continue;
			} finally {
				state.routeMoveSeat = false;
			}

			if (cancelled()) return true;
			const overflow = detectOverflowFromState(agentRuntime.agent);
			if (overflow) {
				await runCompactAndRetry(agentRuntime, text, overflow);
				return true;
			}

			const settled = detectTerminalFailureFromState(agentRuntime.agent);
			if (!settled) {
				// A moved request answering is no recovery of anything: the row that moved it already said what happened.
				if (!movingNow) {
					recordRetryStatus({
						phase: "recovered",
						attempt,
						maxAttempts,
						...waitFacts(chainProviderWaits, false),
					});
				}
				return true;
			}
			// This attempt can stall exactly like the first one did, so the same
			// reclassification runs here; otherwise the ladder would read the
			// watchdog's abort as an operator cancel and stop one rung in.
			const nextFailure = reclassifyStallAbort(state, settled);
			ensureFailureVisibleAndPersisted(nextFailure);
			classified = classify(nextFailure, agentRuntime.agent.state.messages.slice(attemptStart));
			if (moving()) {
				failure = nextFailure;
				continue;
			}
			if (classified.kind === "auth" && (await retryAuth(nextFailure))) return true;
			if (!retryable(classified, nextFailure.message)) {
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}
			failure = nextFailure;
		}

		recordRetryStatus({
			phase: "exhausted",
			attempt: chainAttempt,
			maxAttempts: retryLimit(chainAttempt, chainProviderWaits),
			...waitFacts(chainProviderWaits, false),
			errorMessage: failure.errorMessage,
		});
		recordRetriesExhausted(failure.errorMessage, failure.message);
		pruneFailedAssistantFromContext(agentRuntime.agent);
		return true;
	};

	const runTransientRetryChain: TurnRecovery["runTransientRetryChain"] = async (...args) => {
		try {
			return await runLadder(...args);
		} finally {
			chainAttempt = 0;
			chainOwnRetries = 0;
			chainProviderWaits = 0;
			chainWaitedMs = 0;
			refreshingAuth = false;
		}
	};

	return {
		runCompactAndRetry,
		runTransientRetryChain,
		ensureFailureVisibleAndPersisted,
		forecastRetry,
		noteAttemptStart(messageIndex): void {
			attemptStart = messageIndex;
		},
		settleOpenForecast(): void {
			if (openForecast === null) return;
			recordRetryStatus({ phase: "cancelled", ...openForecast }, false);
		},
		cancelRetryCountdown(): void {
			retryCountdown?.cancel();
		},
		inRetryWait: () => inLadderWait && retryCountdown !== null,
		waitsOutRateLimit,
		waitBeforeContinuation(delayMs, attempt, maxAttempts, reason) {
			const status: RetryStatusPayload = { phase: "scheduled", attempt, maxAttempts, delayMs, errorMessage: reason };
			recordRetryStatus(status);
			return waitForRetryCountdown(status).then((outcome) => {
				recordRetryStatus({ ...status, phase: outcome === "cancelled" ? "cancelled" : "retrying" }, false);
				return outcome;
			});
		},
	};
}
