/**
 * Degraded-inference watchdog for local runtimes.
 *
 * A local server whose weights or KV cache spilled to CPU does not fail: it
 * answers, at roughly a hundredth of the speed, and the operator sees only a
 * spinner. The observed case was 2m18s of streaming for 25 tokens with no
 * indication that anything was wrong. This watchdog turns that silence into a
 * notice: once a prediction has run past a grace period, a sustained token rate
 * below the floor is reported once per turn, along with what is resident on the
 * target so the cause is visible in the same line.
 *
 * The watchdog observes; it never cancels a turn. A slow model is still a
 * working model, and the operator decides whether to abort.
 */

/** Wall-clock a prediction gets before its rate is judged. */
export const DEGRADED_GRACE_MS = 30_000;
/** Sustained output tokens per second below which inference is reported as degraded. */
export const DEGRADED_FLOOR_TOKENS_PER_SECOND = 2;

export interface DegradedInferenceReport {
	elapsedMs: number;
	tokens: number;
	tokensPerSecond: number;
}

export interface DegradedInferenceOptions {
	/** Called at most once, when the observed rate stays under the floor past the grace period. */
	onDegraded: (report: DegradedInferenceReport) => void;
	graceMs?: number;
	floorTokensPerSecond?: number;
	/** Sampling interval; the watchdog checks the rate this often. */
	pollMs?: number;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface DegradedInferenceWatchdog {
	/** Record generated tokens (output plus reasoning; both are work the server did). */
	addTokens: (count: number) => void;
	/** Test seam: evaluate the rate now instead of waiting for the next poll. */
	check: () => void;
	stop: () => void;
}

function defaultTimer(fn: () => void, ms: number): { cancel: () => void } {
	const handle = setInterval(fn, ms);
	handle.unref?.();
	return { cancel: () => clearInterval(handle) };
}

/**
 * Start watching a prediction's token rate. Call {@link
 * DegradedInferenceWatchdog.addTokens} as fragments arrive and `stop()` when the
 * turn ends, in a `finally`, so a failed turn never leaves a timer behind.
 */
export function startDegradedInferenceWatchdog(options: DegradedInferenceOptions): DegradedInferenceWatchdog {
	const now = options.now ?? Date.now;
	const graceMs = options.graceMs ?? DEGRADED_GRACE_MS;
	const floor = options.floorTokensPerSecond ?? DEGRADED_FLOOR_TOKENS_PER_SECOND;
	const pollMs = options.pollMs ?? 5_000;
	const startedAt = now();
	let tokens = 0;
	let reported = false;
	let stopped = false;

	const check = (): void => {
		if (reported || stopped) return;
		const elapsedMs = now() - startedAt;
		if (elapsedMs < graceMs) return;
		const tokensPerSecond = tokens / (elapsedMs / 1000);
		if (tokensPerSecond >= floor) return;
		reported = true;
		timer.cancel();
		try {
			options.onDegraded({ elapsedMs, tokens, tokensPerSecond });
		} catch {
			// A notice sink failure must never escape into the turn it describes.
		}
	};

	const timer = (options.setTimer ?? defaultTimer)(check, pollMs);

	return {
		addTokens: (count) => {
			if (Number.isFinite(count) && count > 0) tokens += count;
		},
		check,
		stop: () => {
			if (stopped) return;
			stopped = true;
			timer.cancel();
		},
	};
}
