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

/**
 * User-facing retry configuration. Mirrors pi-coding-agent's RetrySettings
 * so settings migrated from pi-mono retain their meaning.
 */
export interface RetrySettings {
	/** When false, `/compact`-on-overflow still runs but transient retries are skipped. */
	enabled: boolean;
	/** Upper bound on retry attempts. Attempt 1 is the first retry after the initial failure. */
	maxRetries: number;
	/** Starting delay in milliseconds. Subsequent attempts double this until `maxDelayMs`. */
	baseDelayMs: number;
	/** Cap for the per-attempt wait. Prevents `2 ** N` blowout on long retry chains. */
	maxDelayMs: number;
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
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
 * True when an error message looks like a transient provider failure worth
 * retrying. Context-overflow errors are intentionally excluded: those route
 * through compaction + one-shot recovery, not this retry loop.
 *
 * Callers pass `assistantMessage.errorMessage` directly; an empty string
 * returns false so a missing provider error never triggers an unnecessary
 * retry.
 */
export function isRetryableErrorMessage(errorMessage: string | null | undefined): boolean {
	if (!errorMessage || errorMessage.length === 0) return false;
	return RETRYABLE_PATTERN.test(errorMessage);
}

/**
 * Compute the delay before attempt `attempt` (1-indexed). Matches pi-mono's
 * formula `baseDelayMs * 2 ** (attempt - 1)`, then clamps to `maxDelayMs` so
 * the 4th retry never stalls for minutes. Attempt < 1 is normalized to 1 so
 * callers that miscount still get a sane first delay.
 */
export function computeRetryDelayMs(attempt: number, settings: RetrySettings = DEFAULT_RETRY_SETTINGS): number {
	const safeAttempt = Math.max(1, Math.floor(attempt));
	const raw = settings.baseDelayMs * 2 ** (safeAttempt - 1);
	if (!Number.isFinite(raw) || raw <= 0) return Math.max(0, settings.baseDelayMs);
	return Math.min(raw, settings.maxDelayMs);
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
	/** Source of "now" in milliseconds. Defaults to `Date.now`. */
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
	const now = options.now ?? (() => Date.now());

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
