/**
 * Auto-compaction trigger (Phase 12 slice 12d).
 *
 * Pure predicate + in-flight-debounced runner used by the chat-loop before
 * every assistant request. `shouldCompact` answers the question "is the
 * session over its compaction threshold?"; `AutoCompactionTrigger` wraps the
 * actual compaction task so two concurrent chat submissions cannot spawn two
 * overlapping compaction runs on the same session.
 *
 * Ported from pi-coding-agent's runtime compaction gate. Kept deliberately
 * small so the chat-loop can call it on the hot path without new allocations
 * per turn. No I/O here — the caller injects the work via `fire(task)`.
 */

/**
 * True when the estimated `contextTokens` has crossed
 * `threshold * contextWindow`. Defensive clamps:
 *   - non-positive or NaN contextWindow ⇒ false. A zero window means we
 *     cannot make a ratio, so we never fire auto-compaction; manual
 *     `/compact` still works in that case.
 *   - threshold ≤ 0 ⇒ false. A disabled threshold never fires.
 *   - threshold > 1 ⇒ clamped to 1 so a misconfigured settings value
 *     falls back to "at-or-above contextWindow" rather than tripping
 *     eagerly.
 */
export function shouldCompact(contextTokens: number, threshold: number, contextWindow: number): boolean {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	if (!Number.isFinite(threshold) || threshold <= 0) return false;
	const clamped = Math.min(threshold, 1);
	return contextTokens >= clamped * contextWindow;
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
	 * task is running under — callers always get the eventual result of the
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
