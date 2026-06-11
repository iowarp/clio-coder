/**
 * Auto-compaction trigger.
 *
 * Pure pressure check + in-flight-debounced runner used by the chat-loop
 * before every assistant request. `shouldCompact` reports whether the current
 * context pressure crossed the single compaction threshold; the
 * `AutoCompactionTrigger` wraps the actual task so two concurrent chat
 * submissions cannot spawn overlapping compaction runs on the same session.
 *
 * Kept deliberately small so the chat-loop can call it on the hot path
 * without new allocations per turn. No I/O here. The caller injects the work
 * via `fire(task)`.
 */

export interface ContextCompactionVerdict {
	shouldCompact: boolean;
	pressure: number | null;
	contextTokens: number;
	contextWindow: number;
	threshold: number;
}

export const DEFAULT_COMPACTION_THRESHOLD = 0.8;

/**
 * Report whether `contextTokens / contextWindow` crossed `threshold`.
 * Defensive behavior:
 *   - non-positive or NaN contextWindow returns a no-op verdict.
 *   - thresholds outside (0, 1] disable the trigger.
 */
export function shouldCompact(
	contextTokens: number,
	threshold: number,
	contextWindow: number,
): ContextCompactionVerdict {
	const base: ContextCompactionVerdict = {
		shouldCompact: false,
		pressure: null,
		contextTokens,
		contextWindow,
		threshold,
	};
	if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return base;
	if (!Number.isFinite(contextTokens) || contextTokens <= 0) return base;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return base;

	const pressure = contextTokens / contextWindow;
	return {
		shouldCompact: pressure >= threshold,
		pressure,
		contextTokens,
		contextWindow,
		threshold,
	};
}

/**
 * Coalesces concurrent `fire(task)` calls onto a single in-flight Promise.
 *
 * A chat session can race a threshold-driven trigger and an overflow-recovery
 * trigger inside the same tick. Both want to run compaction. The first fire
 * starts the task and stores the Promise; subsequent fires observe the same
 * Promise and await it instead of kicking off a second run. Once the task
 * settles (resolve or reject), the slot clears so the next fire starts a
 * fresh run.
 */
export class AutoCompactionTrigger<T> {
	private inFlight: Promise<T> | null = null;

	/** True while a task is in flight. Callers can short-circuit on this. */
	isBusy(): boolean {
		return this.inFlight !== null;
	}

	/**
	 * Run `task` unless one is already in flight. Returns the Promise the
	 * task is running under. Callers always get the eventual result of the
	 * first task, never a second call. Rejections clear the slot so a later
	 * fire can start fresh.
	 */
	fire(task: () => Promise<T>): Promise<T> {
		if (this.inFlight) return this.inFlight;
		const run = task().finally(() => {
			this.inFlight = null;
		});
		this.inFlight = run;
		return run;
	}
}
