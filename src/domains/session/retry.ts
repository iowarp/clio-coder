/**
 * Retry settings and countdown helper (Phase 12 / Phase 22 seam).
 *
 * pi-agent-core surfaces provider failures as a terminal assistant message
 * with `stopReason: "error"` + `errorMessage: <provider text>`. It does not
 * schedule retries itself; application wrappers decide whether to treat the
 * error as transient, wait, and call `agent.continue()`. pi-mono's
 * coding-agent implements that in `core/agent-session.ts` via an exponential
 * backoff, a countdown UI, and an abort handle.
 *
 * This module is the pure building block for the Clio equivalent. It:
 *   1. Declares the RetrySettings shape and sensible defaults.
 *   2. Exposes a deterministic heuristic (`isRetryableErrorMessage`) that
 *      matches the transient error strings pi-ai providers actually emit.
 *   3. Computes the backoff delay for a given attempt (`computeRetryDelayMs`)
 *      with the cap the settings declare; callers schedule the wait.
 *   4. Provides `createRetryCountdown` so the TUI can show seconds remaining
 *      and cancel a pending retry on `Esc` without coupling to a specific
 *      timer abstraction.
 *
 * No I/O, no pi-agent-core/pi-ai imports. The chat-loop wiring (which decides
 * whether an agent_end with stopReason "error" triggers a retry) lives in
 * `src/interactive/chat-loop.ts` and consumes this module; keeping the two
 * split so the countdown can be exercised in unit tests without spinning up a
 * runtime.
 */

import { performance } from "node:perf_hooks";
import type { RetrySettings } from "../../core/defaults.js";

export type { RetrySettings } from "../../core/defaults.js";

/**
 * User-facing retry configuration lives in core defaults so settings and the
 * session retry helper share one structural type.
 */
export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	streamStallMs: 180000,
};

/**
 * Pattern list built from pi-mono's `_isRetryableError` regex (agent-session.ts).
 * Kept as a plain RegExp so the check is `O(1)` per assistant error message.
 * The match is case-insensitive: providers phrase the same error in mixed
 * case (Anthropic: "Overloaded", OpenRouter: "rate limited", Fireworks:
 * "connection error"), and we want all of them classified as transient.
 */
const RETRYABLE_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed? out|timeout|terminated|retry delay/i;

/**
 * A self-hosted server refusing a request because the model is not resident.
 *
 * Measured against LM Studio, which answers a request for an evicted model
 * with `500 Internal Server Error` on the first attempt and the bare string
 * `Model is unloaded.` on the next, while it loads. llama.cpp behind
 * llama-swap and Ollama phrase the same condition differently, so the pattern
 * covers the family rather than one vendor's wording.
 *
 * Deliberately not folded into {@link RETRYABLE_PATTERN}: this is transient in
 * a different unit. A rate limit clears in a second or two; a 35B model loads
 * off disk in twenty to sixty, and retrying it on a rate limit's backoff burns
 * every attempt before the server is ready. `clio-coder run --target dynamo --model
 * qwopus3.6-35b-a3b-coder-mtp` failed exactly this way: two attempts, six
 * seconds, "Model is unloaded." on stdout, while the load was still running.
 */
const MODEL_LOADING_PATTERN =
	/model is unloaded|model is (?:still )?loading|model not loaded|no model (?:is )?loaded|loading model|model_?load(?:ing)?_?in_?progress|is not loaded/i;

/** Floor for a retry that is waiting on a model load rather than on a provider. */
const MODEL_LOADING_MIN_DELAY_MS = 15000;

/**
 * True when the error says the target is loading the model, so the wait should
 * be sized for disk and VRAM rather than for a provider backing off.
 */
export function isModelLoadingErrorMessage(errorMessage: string | null | undefined): boolean {
	if (!errorMessage || errorMessage.length === 0) return false;
	return MODEL_LOADING_PATTERN.test(errorMessage);
}

/**
 * True when an error message looks like a transient failure worth retrying:
 * a provider backing off, or a self-hosted target loading the model.
 * Context-overflow errors are intentionally excluded: those route through
 * compaction + one-shot recovery, not this retry loop.
 *
 * Callers pass `assistantMessage.errorMessage` directly; an empty string
 * returns false so a missing provider error never triggers an unnecessary
 * retry.
 */
export function isRetryableErrorMessage(errorMessage: string | null | undefined): boolean {
	if (!errorMessage || errorMessage.length === 0) return false;
	return RETRYABLE_PATTERN.test(errorMessage) || MODEL_LOADING_PATTERN.test(errorMessage);
}

/**
 * Compute the delay before attempt `attempt` (1-indexed). Matches pi-mono's
 * formula `baseDelayMs * 2 ** (attempt - 1)`, then clamps to `maxDelayMs` so
 * the 4th retry never stalls for minutes. Attempt < 1 is normalized to 1 so
 * callers that miscount still get a sane first delay.
 */
export function computeRetryDelayMs(
	attempt: number,
	settings: RetrySettings = DEFAULT_RETRY_SETTINGS,
	errorMessage?: string | null,
): number {
	const safeAttempt = Math.max(1, Math.floor(attempt));
	const raw = settings.baseDelayMs * 2 ** (safeAttempt - 1);
	const base =
		!Number.isFinite(raw) || raw <= 0 ? Math.max(0, settings.baseDelayMs) : Math.min(raw, settings.maxDelayMs);
	// A model load does not finish faster because the retry schedule was
	// written for a rate limit. `maxDelayMs` still caps it, so an operator who
	// wants short waits keeps them.
	if (!isModelLoadingErrorMessage(errorMessage)) return base;
	return Math.min(Math.max(base, MODEL_LOADING_MIN_DELAY_MS), settings.maxDelayMs);
}

/**
 * Runtime state for a single retry wait. `seconds` counts down from the
 * initial delay; `done` flips true when the deadline is reached; `cancelled`
 * flips true when a caller aborts via `cancel()` before the deadline.
 */
export interface RetryCountdownState {
	attempt: number;
	maxAttempts: number;
	seconds: number;
	done: boolean;
	cancelled: boolean;
}

export interface RetryCountdownOptions {
	/** 1-indexed attempt id displayed to the user, e.g. "Retrying (1/3)". */
	attempt: number;
	/** Upper bound displayed alongside `attempt`. */
	maxAttempts: number;
	/** Total wait in milliseconds. Callers usually pass `computeRetryDelayMs(attempt, settings)`. */
	delayMs: number;
	/** Fires on every tick with the latest state so the TUI can redraw. */
	onTick: (state: RetryCountdownState) => void;
	/** Fires once when the countdown reaches zero naturally. */
	onDone: () => void;
	/** Fires once when `cancel()` runs before the deadline. */
	onCancel?: () => void;
	/**
	 * Schedule a callback after `ms` milliseconds. Defaults to `setTimeout`.
	 * Tests swap this for a deterministic clock so the countdown advances
	 * without wall-clock waits.
	 */
	setTimer?: (cb: () => void, ms: number) => unknown;
	/** Mirror of `clearTimeout`. Paired with `setTimer`. */
	clearTimer?: (id: unknown) => void;
	/**
	 * Monotonic millisecond source for the countdown. Defaults to
	 * `performance.now`: the remaining wait is a span, so a clock correction
	 * mid-countdown must not shorten or extend it.
	 */
	now?: () => number;
}

export interface RetryCountdownHandle {
	/** Latest state snapshot. Useful for tests that inspect without subscribing. */
	getState(): RetryCountdownState;
	/** Abort the countdown before the deadline; fires `onCancel` if registered. */
	cancel(): void;
}

/**
 * One-second-resolution countdown loop that drives a TUI retry indicator.
 * The first `onTick` fires synchronously so the caller can paint an initial
 * frame without waiting a whole second; subsequent ticks fire every 1000ms
 * until the deadline is reached or `cancel()` is called. All state lives in
 * the returned handle; the function itself has no module-level mutable
 * state, which keeps parallel retry counters safe under concurrent tests.
 */
export function createRetryCountdown(options: RetryCountdownOptions): RetryCountdownHandle {
	const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
	const now = options.now ?? (() => performance.now());

	const start = now();
	const deadline = start + Math.max(0, options.delayMs);

	const state: RetryCountdownState = {
		attempt: options.attempt,
		maxAttempts: options.maxAttempts,
		seconds: Math.max(0, Math.ceil(options.delayMs / 1000)),
		done: false,
		cancelled: false,
	};

	let timer: unknown = null;
	let settled = false;

	const emit = (): void => {
		options.onTick({ ...state });
	};

	const schedule = (): void => {
		if (settled) return;
		const remaining = deadline - now();
		if (remaining <= 0) {
			state.seconds = 0;
			state.done = true;
			settled = true;
			emit();
			options.onDone();
			return;
		}
		state.seconds = Math.max(0, Math.ceil(remaining / 1000));
		emit();
		timer = setTimer(schedule, 1000);
	};

	schedule();

	return {
		getState() {
			return { ...state };
		},
		cancel() {
			if (settled) return;
			settled = true;
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			state.cancelled = true;
			state.seconds = 0;
			emit();
			options.onCancel?.();
		},
	};
}
