/**
 * Turn recovery: the transient retry chain, overflow compact-and-retry, and
 * the retry countdown. The interrupt/cancel semantics these paths respect
 * (`state.activeInterruptReason`) are owned by the loop's cancel entry point;
 * this module owns everything that happens after a run settles with a
 * terminal failure.
 */

import type { toContextOverflowError } from "../domains/providers/errors.js";
import {
	computeRetryDelayMs,
	createRetryCountdown,
	isRetryableErrorMessage,
	type RetryCountdownHandle,
	type RetrySettings,
} from "../domains/session/retry.js";
import type { AgentMessage, ImageContent, MutableAgentState } from "../engine/types.js";
import {
	detectOverflowFromState,
	detectTerminalFailureFromState,
	isEmptyAbortedAssistantMessage,
	pruneFailedAssistantFromContext,
	type TerminalAssistantFailure,
} from "./chat-loop-messages.js";
import type { TurnContext } from "./turn-context.js";
import type { TurnPersistence } from "./turn-persistence.js";
import type { AgentRuntime, ChatTurnState } from "./turn-state.js";

export type RetryStatusPhase = "scheduled" | "waiting" | "retrying" | "cancelled" | "exhausted" | "recovered";

export interface RetryStatusPayload {
	phase: RetryStatusPhase;
	attempt: number;
	maxAttempts: number;
	errorMessage?: string;
	delayMs?: number;
	seconds?: number;
}

export interface RetryStatusEvent {
	type: "retry_status";
	status: RetryStatusPayload;
}

export interface TurnRecoveryDeps {
	state: ChatTurnState;
	persistence: TurnPersistence;
	context: TurnContext;
	retrySettings: () => RetrySettings;
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
	): Promise<boolean>;
	ensureFailureVisibleAndPersisted(failure: TerminalAssistantFailure): void;
	cancelRetryCountdown(): void;
}

/**
 * Rewrite a stall-driven abort as a transient error so the retry ladder takes
 * it. `agent.abort()` always settles the run as `stopReason: "aborted"`, and
 * both gates below refuse that on purpose: an operator who pressed Esc must
 * never have the turn restarted under them. The stall watchdog in
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
	state: ChatTurnState,
	failure: TerminalAssistantFailure,
): TerminalAssistantFailure {
	const reason = state.streamStallReason;
	state.streamStallReason = null;
	if (reason === null || failure.stopReason !== "aborted" || state.activeInterruptReason !== null) return failure;
	if (failure.message) rewriteStallAbortMessage(state, failure.message, reason);
	return { ...failure, stopReason: "error", errorMessage: reason };
}

/** Rewrite the provider's terminal abort object before its event is emitted and persisted. */
export function rewriteStallAbortMessage(
	state: ChatTurnState,
	message: AgentMessage,
	reason = state.streamStallReason,
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
	failure.stopReason = "error";
	failure.errorMessage = reason;
	return true;
}

export function createTurnRecovery(deps: TurnRecoveryDeps): TurnRecovery {
	const { state, persistence, context } = deps;
	let retryCountdown: RetryCountdownHandle | null = null;

	const appendRetryStatusSafe = (status: RetryStatusPayload): void => {
		persistence.appendRetryStatus(status);
	};

	const recordRetryStatus = (status: RetryStatusPayload, durable = true): void => {
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
		return new Promise((resolve) => {
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
					resolve("done");
				},
				onCancel: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					resolve("cancelled");
				},
			});
			currentHandle = handle;
			retryCountdown = settled ? null : handle;
		});
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
		let compacted = false;
		try {
			pruneFailedAssistantFromContext(agentRuntime.agent);
			const mutableState = agentRuntime.agent.state as MutableAgentState;
			mutableState.errorMessage = undefined;
			compacted = await context.runAutoCompact(agentRuntime, true, undefined, "overflow");
		} catch (compactErr) {
			deps.emitNotice(
				`[Clio Coder] compact-on-overflow failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
			);
		}
		if (!compacted) {
			deps.emitNotice(`[Clio Coder] context overflow: ${overflow.message}`);
			return;
		}
		try {
			await deps.markPersistedUserEcho(text, () => agentRuntime.agent.prompt(text, images ? [...images] : undefined));
			const stillOverflowed = detectOverflowFromState(agentRuntime.agent);
			if (stillOverflowed) {
				deps.emitNotice(`[Clio Coder] context overflow persisted after compaction: ${stillOverflowed.message}`);
			}
		} catch (retryErr) {
			deps.emitNotice(
				`[Clio Coder] context overflow persisted after compaction: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
			);
		}
	};

	const runTransientRetryChain = async (
		agentRuntime: AgentRuntime,
		text: string,
		initialFailure: TerminalAssistantFailure,
	): Promise<boolean> => {
		// A LiteLLM model id can be a deliberate physical route. Retrying it in
		// Clio obscures the failure, delays operator recovery, and can multiply
		// attempts beneath a gateway. Preserve and emit the one terminal failure;
		// the operator can choose another advertised route with /model.
		if (agentRuntime.runtimeId === "litellm") {
			ensureFailureVisibleAndPersisted(initialFailure);
			return true;
		}
		const settings = deps.retrySettings();
		if (!settings.enabled || settings.maxRetries <= 0) return false;
		if (initialFailure.stopReason === "aborted" || !isRetryableErrorMessage(initialFailure.errorMessage)) return false;

		let failure = initialFailure;
		for (let attempt = 1; attempt <= settings.maxRetries; attempt += 1) {
			ensureFailureVisibleAndPersisted(failure);
			pruneFailedAssistantFromContext(agentRuntime.agent);

			const scheduled: RetryStatusPayload = {
				phase: "scheduled",
				attempt,
				maxAttempts: settings.maxRetries,
				delayMs: computeRetryDelayMs(attempt, settings, failure.errorMessage),
				errorMessage: failure.errorMessage,
			};
			recordRetryStatus(scheduled);
			const countdown = await waitForRetryCountdown(scheduled);
			if (countdown === "cancelled") {
				recordRetryStatus({
					phase: "cancelled",
					attempt,
					maxAttempts: settings.maxRetries,
					errorMessage: failure.errorMessage,
				});
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}

			recordRetryStatus(
				{
					phase: "retrying",
					attempt,
					maxAttempts: settings.maxRetries,
					errorMessage: failure.errorMessage,
				},
				false,
			);

			try {
				await agentRuntime.agent.continue();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!isRetryableErrorMessage(message) || attempt >= settings.maxRetries) {
					recordRetryStatus({
						phase: "exhausted",
						attempt,
						maxAttempts: settings.maxRetries,
						errorMessage: message,
					});
					deps.emitNotice(message);
					pruneFailedAssistantFromContext(agentRuntime.agent);
					return true;
				}
				failure = { stopReason: "error", errorMessage: message };
				continue;
			}

			const overflow = detectOverflowFromState(agentRuntime.agent);
			if (overflow) {
				await runCompactAndRetry(agentRuntime, text, overflow);
				return true;
			}

			const settled = detectTerminalFailureFromState(agentRuntime.agent);
			if (!settled) {
				recordRetryStatus({
					phase: "recovered",
					attempt,
					maxAttempts: settings.maxRetries,
				});
				return true;
			}
			// This attempt can stall exactly like the first one did, so the same
			// reclassification runs here; otherwise the ladder would read the
			// watchdog's abort as an operator cancel and stop one rung in.
			const nextFailure = reclassifyStallAbort(state, settled);
			ensureFailureVisibleAndPersisted(nextFailure);
			if (nextFailure.stopReason === "aborted" || !isRetryableErrorMessage(nextFailure.errorMessage)) {
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}
			failure = nextFailure;
		}

		recordRetryStatus({
			phase: "exhausted",
			attempt: settings.maxRetries,
			maxAttempts: settings.maxRetries,
			errorMessage: failure.errorMessage,
		});
		pruneFailedAssistantFromContext(agentRuntime.agent);
		return true;
	};

	return {
		runCompactAndRetry,
		runTransientRetryChain,
		ensureFailureVisibleAndPersisted,
		cancelRetryCountdown(): void {
			retryCountdown?.cancel();
		},
	};
}
